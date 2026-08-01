// 2AIO Dashboard — フェーズ実行サーバ
//
// 1つの「ラン」= 1つの目的が 調査 → 計画 → 実装 → テスト → Push を通ること。
//
// 設計の要点は2つだけ:
//   ① 承認は state.json のフィールドだけが正本。会話中の「承認します」は信用しない。
//      フェーズ開始時に必ずディスクから読み直して、前フェーズのゲートを確認する。
//   ② push はエージェントが実行しない。人間がボタンを押した時だけ、このサーバが実行する。
//
// 依存は2つの SDK だけ。ビルド工程なし (node server.mjs)。
// 書き込みを伴うのでバインドは 127.0.0.1 固定。

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PHASES, phaseById, nextPhaseOf, policyLine } from './phases.mjs'
import { LANES } from './lanes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const RUNS_DIR = path.join(REPO, '.2aio', 'runs')
const PORT = Number(process.env.PORT || 7801)

// ---------------------------------------------------------------- git

function git(args, cwd = REPO) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ code: -1, out: '', err: String(e.message) }))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

const gitLines = (result) => (result.code === 0 && result.out ? result.out.split('\n') : [])

/**
 * probeRemote を立てた時だけリモートに問い合わせる。
 *
 * 手元の remote-tracking ref (`origin/<branch>`) は、無い・古いことがある。
 * それを基準に「未 push のコミット」を数えると、既にリモートにあるコミットを
 * 未 push と誤判定し、実体の無い push を「成功」として通してしまう。
 * 正本はリモート自身なので `git ls-remote` で直接聞く。
 */
async function gitInfo({ probeRemote = false } = {}) {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const remote = (await git(['remote'])).out.split('\n')[0] || ''
  const hasUpstream = (await git(['rev-parse', '--abbrev-ref', '@{upstream}'])).code === 0

  const info = {
    branch,
    remote,
    hasUpstream,
    dirty: gitLines(await git(['status', '--porcelain'])),
    ahead: [],
    remoteState: 'not-probed',
    command: remote && branch ? `git push${hasUpstream ? '' : ' -u'} ${remote} ${branch}` : null,
  }
  if (!probeRemote || !remote || !branch) return info

  const ls = await git(['ls-remote', '--heads', remote, branch])
  if (ls.code !== 0) {
    info.remoteState = 'unreachable'
    info.error = ls.err || 'リモートに接続できない'
    return info
  }
  if (!ls.out) {
    // リモートにこのブランチがまだ無い = 初回 push。どのリモートにも無いコミットが対象。
    info.remoteState = 'absent'
    info.ahead = gitLines(await git(['log', '--oneline', 'HEAD', '--not', '--remotes']))
    return info
  }

  const sha = ls.out.split(/\s+/)[0]
  info.remoteSha = sha
  // リモートの先端が手元に無いと差分が引けないので、その時だけ取り寄せる (読み取りのみ)
  if ((await git(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
    await git(['fetch', remote, branch])
  }
  const log = await git(['log', '--oneline', `${sha}..HEAD`])
  if (log.code !== 0) {
    info.remoteState = 'unknown'
    info.error = log.err || 'リモートとの差分を計算できない'
    return info
  }
  info.remoteState = 'present'
  info.ahead = gitLines(log)
  info.behind = gitLines(await git(['log', '--oneline', `HEAD..${sha}`])).length
  return info
}

// ---------------------------------------------------------------- ラン状態

const runs = new Map()

const runDir = (id) => path.join(RUNS_DIR, id)
const statePath = (id) => path.join(runDir(id), 'state.json')

function freshState(id, goal) {
  const phases = {}
  for (const p of PHASES) phases[p.id] = { status: 'idle', startedAt: null, endedAt: null }
  return {
    id,
    goal,
    createdAt: new Date().toISOString(),
    phase: PHASES[0].id,
    phases,
    gates: {},
    pushedAt: null,
  }
}

async function readState(id) {
  return JSON.parse(await readFile(statePath(id), 'utf8'))
}

async function writeState(state) {
  await writeFile(statePath(state.id), JSON.stringify(state, null, 2) + '\n', 'utf8')
}

async function patchState(id, fn) {
  const state = await readState(id)
  fn(state)
  await writeState(state)
  const run = runs.get(id)
  run?.emit({ kind: 'state', state })
  return state
}

// ---------------------------------------------------------------- ラン生成

async function createRun(goal) {
  const id = 'run-' + randomBytes(4).toString('hex')
  await mkdir(runDir(id), { recursive: true })
  const state = freshState(id, goal)
  await writeState(state)

  const run = {
    id,
    goal,
    dir: runDir(id),
    clients: new Set(),
    history: [],
    driver: null,
    approvals: new Map(),
    lastAssistant: '',
  }
  run.emit = (event) => {
    const stamped = { ...event, at: new Date().toISOString() }
    run.history.push(stamped)
    const line = `data: ${JSON.stringify(stamped)}\n\n`
    for (const res of run.clients) res.write(line)
  }
  runs.set(id, run)
  return { run, state }
}

// ---------------------------------------------------------------- 成果物

async function readArtifacts(id, upTo) {
  const state = await readState(id)
  const parts = []
  for (const p of PHASES) {
    if (p.order >= upTo.order) break
    if (state.phases[p.id].status === 'idle') continue
    try {
      const text = await readFile(path.join(runDir(id), p.artifact), 'utf8')
      parts.push(`--- ${p.artifact} (${p.label}) ---\n\n${text.trim()}`)
    } catch {
      parts.push(`--- ${p.artifact} (${p.label}) --- 未生成`)
    }
  }
  return parts.join('\n\n') || '(まだ成果物は無い)'
}

// 実装フェーズの成果物だけはサーバが書く。
// エージェントの自己申告ではなく、git が測った実差分を正本にするため。
async function recordImplementResult(run) {
  const status = await git(['status', '--porcelain'])
  const stat = await git(['diff', '--stat', 'HEAD'])
  const body = [
    '# 実装',
    '',
    '## Codex の報告',
    '',
    run.lastAssistant.trim() || '(報告なし)',
    '',
    '## git が測った実差分',
    '',
    '```',
    stat.out || '(HEAD との差分なし)',
    '```',
    '',
    '## 作業ツリーの状態',
    '',
    '```',
    status.out || '(clean)',
    '```',
    '',
    `_記録: ${new Date().toISOString()} — この節はダッシュボードが git から直接生成した。_`,
  ].join('\n')
  await writeFile(path.join(run.dir, '03-implement.md'), body, 'utf8')
  run.emit({ kind: 'artifact', text: '03-implement.md', note: 'git の実測から生成' })
}

// ---------------------------------------------------------------- フェーズ起動

async function startPhase(id, phaseId) {
  const run = runs.get(id)
  const phase = phaseById(phaseId)
  if (!run || !phase) throw new Error('unknown run/phase')

  // ① 正本はディスク。前フェーズのゲートが state.json に記録されているかだけを見る。
  const state = await readState(id)
  const prev = PHASES[phase.order - 2]
  if (prev && !state.gates[prev.id]?.approvedAt) {
    throw new Error(`${prev.label}フェーズのゲートが未承認 (state.json に記録が無い)`)
  }

  if (run.driver) {
    run.driver.stop()
    // 前のセッションの後片付けと次のセッションの起動が重なると、新しい方が
    // error_during_execution で落ちることがある。ひと呼吸置いてから起動する。
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  rejectPendingApprovals(run, 'フェーズが切り替わった')
  run.lastAssistant = ''

  await patchState(id, (s) => {
    s.phase = phaseId
    s.phases[phaseId] = { status: 'running', startedAt: new Date().toISOString(), endedAt: null }
  })

  const artifactPath = path.posix.join('.2aio', 'runs', id, phase.artifact)
  const priors = await readArtifacts(id, phase)
  const brief = phase.brief({ goal: run.goal, priors, artifactPath })

  run.emit({ kind: 'phase', text: phase.label, phase: phaseId, note: policyLine(phase) })

  const emit = (event) => {
    if (event.kind === 'assistant') run.lastAssistant = event.text
    run.emit({ ...event, phase: phaseId })
  }

  const onIdle = async () => {
    if (phaseId === 'implement') await recordImplementResult(run).catch(() => {})
    await patchState(id, (s) => {
      if (s.phases[phaseId].status === 'running') s.phases[phaseId].status = 'waiting'
    }).catch(() => {})
    run.emit({ kind: 'idle', phase: phaseId })
  }

  run.driver = LANES[phase.lane]({
    phase,
    brief,
    cwd: REPO,
    artifactDir: run.dir,
    emit,
    ask: (request) => askHuman(run, phaseId, request),
    onIdle,
  })
}

// ---------------------------------------------------------------- 承認カード

function askHuman(run, phaseId, request) {
  const requestId = randomBytes(6).toString('hex')
  return new Promise((resolve) => {
    run.approvals.set(requestId, { resolve, request })
    run.emit({ kind: 'approval', requestId, phase: phaseId, ...request })
  })
}

function rejectPendingApprovals(run, why) {
  for (const [requestId, entry] of run.approvals) {
    entry.resolve(false)
    run.emit({ kind: 'approval-resolved', requestId, allowed: false, note: why })
  }
  run.approvals.clear()
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const id = url.searchParams.get('id')

  try {
    // ---- 静的ファイル
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const file = path.join(HERE, 'public', name)
      if (!file.startsWith(path.join(HERE, 'public'))) return void res.writeHead(403).end()
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      return void res.end(body)
    }

    // ---- フェーズ表 (UI が権限表記をそのまま描くのに使う)
    if (url.pathname === '/api/phases') {
      return json(
        res,
        200,
        PHASES.map((p) => ({
          id: p.id,
          label: p.label,
          order: p.order,
          lane: p.lane,
          artifact: p.artifact,
          produces: p.produces,
          policy: policyLine(p),
        })),
      )
    }

    // ---- ラン一覧 (再訪時の復帰用)
    if (url.pathname === '/api/runs') {
      let names = []
      try {
        names = await readdir(RUNS_DIR)
      } catch {}
      const list = []
      for (const name of names.reverse().slice(0, 20)) {
        try {
          const s = JSON.parse(await readFile(statePath(name), 'utf8'))
          list.push({ id: s.id, goal: s.goal, phase: s.phase, createdAt: s.createdAt, live: runs.has(s.id) })
        } catch {}
      }
      return json(res, 200, list)
    }

    // ---- ラン開始 — 目的を受け取り、調査フェーズを起動する
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const { goal } = await readJsonBody(req)
      if (!goal?.trim()) return json(res, 400, { error: '目的を入力してください' })
      const { run, state } = await createRun(goal.trim())
      // 最初のフェーズには前ゲートが無いので、そのまま起動できる
      startPhase(run.id, PHASES[0].id).catch((err) =>
        run.emit({ kind: 'error', text: String(err.message) }),
      )
      return json(res, 200, { id: run.id, state })
    }

    if (url.pathname === '/api/state') {
      if (!id) return json(res, 400, { error: 'id が必要' })
      return json(res, 200, await readState(id))
    }

    // ---- SSE
    if (url.pathname === '/api/stream') {
      const run = runs.get(id)
      if (!run) return json(res, 404, { error: 'このランはサーバ再起動で失われています' })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.flushHeaders?.()
      // 再接続時に取りこぼさないよう、既存のイベントを先に流す
      for (const event of run.history) res.write(`data: ${JSON.stringify(event)}\n\n`)
      run.clients.add(res)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        clearInterval(heartbeat)
        run.clients.delete(res)
      })
      return
    }

    // ---- 走行中のフェーズへの割り込み発言
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const { id: runId, text } = await readJsonBody(req)
      const run = runs.get(runId)
      if (!run?.driver) return json(res, 404, { error: '走行中のフェーズがありません' })
      if (!text?.trim()) return json(res, 400, { error: 'empty' })
      const state = await readState(runId)
      run.emit({ kind: 'user', text, phase: state.phase })
      await patchState(runId, (s) => {
        s.phases[s.phase].status = 'running'
      })
      run.driver.send(text)
      return json(res, 200, { ok: true })
    }

    // ---- 承認カードの応答
    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const { id: runId, requestId, allow } = await readJsonBody(req)
      const run = runs.get(runId)
      const entry = run?.approvals.get(requestId)
      if (!entry) return json(res, 404, { error: 'その承認要求は既に解決済み' })
      run.approvals.delete(requestId)
      entry.resolve(Boolean(allow))
      run.emit({ kind: 'approval-resolved', requestId, allowed: Boolean(allow) })
      return json(res, 200, { ok: true })
    }

    // ---- ゲート: 次へ進む / やり直す / 前フェーズへ戻す
    if (url.pathname === '/api/gate' && req.method === 'POST') {
      const { id: runId, action, to } = await readJsonBody(req)
      const run = runs.get(runId)
      if (!run) return json(res, 404, { error: 'unknown run' })
      const state = await readState(runId)
      const current = phaseById(state.phase)

      if (action === 'advance') {
        const next = nextPhaseOf(current.id)
        if (!next) return json(res, 400, { error: 'Push が最終フェーズ' })
        await patchState(runId, (s) => {
          s.phases[current.id].status = 'done'
          s.phases[current.id].endedAt = new Date().toISOString()
          s.gates[current.id] = { approvedAt: new Date().toISOString(), action: 'advance' }
        })
        run.emit({ kind: 'gate-passed', text: `${current.label} → ${next.label}`, phase: current.id })
        await startPhase(runId, next.id)
        return json(res, 200, { ok: true, phase: next.id })
      }

      if (action === 'redo') {
        // やり直しは前ゲートを消さない。同じフェーズを最初から流し直すだけ。
        await patchState(runId, (s) => {
          s.phases[current.id] = { status: 'idle', startedAt: null, endedAt: null }
        })
        run.emit({ kind: 'gate-passed', text: `${current.label} をやり直す`, phase: current.id })
        await startPhase(runId, current.id)
        return json(res, 200, { ok: true, phase: current.id })
      }

      if (action === 'back') {
        const target = phaseById(to)
        if (!target || target.order >= current.order) return json(res, 400, { error: '戻り先が不正' })
        // 戻る = 差し戻し。target 以降のゲートを取り消す (原則②: 承認は記録が全て)
        await patchState(runId, (s) => {
          for (const p of PHASES) {
            if (p.order < target.order) continue
            s.phases[p.id] = { status: 'idle', startedAt: null, endedAt: null }
            delete s.gates[p.id]
          }
        })
        run.emit({ kind: 'gate-passed', text: `${current.label} → ${target.label} へ差し戻し`, phase: current.id })
        await startPhase(runId, target.id)
        return json(res, 200, { ok: true, phase: target.id })
      }

      return json(res, 400, { error: 'action は advance / redo / back' })
    }

    // ---- git の実状態。ヘッダ表示用なのでローカルだけ見る (速い)
    if (url.pathname === '/api/git') {
      return json(res, 200, await gitInfo())
    }

    // ---- push パネルの表示元。リモートに問い合わせるので遅い
    if (url.pathname === '/api/push-preview') {
      return json(res, 200, await gitInfo({ probeRemote: true }))
    }

    // ---- push — 人間がボタンを押した時だけ、ここで実行される
    if (url.pathname === '/api/push' && req.method === 'POST') {
      const { id: runId, confirm } = await readJsonBody(req)
      const run = runs.get(runId)
      if (!run) return json(res, 404, { error: 'unknown run' })
      if (confirm !== true) return json(res, 400, { error: '確認されていません' })

      const state = await readState(runId)
      if (state.phase !== 'push' || state.phases.push.status === 'idle') {
        return json(res, 400, { error: 'Push フェーズを通っていません' })
      }
      const info = await gitInfo({ probeRemote: true })
      if (!info.remote) return json(res, 400, { error: 'remote がありません' })
      if (info.remoteState === 'unreachable' || info.remoteState === 'unknown') {
        return json(res, 400, { error: `リモートの状態を確認できない: ${info.error ?? ''}` })
      }
      if (!info.ahead.length) {
        // ここが以前の穴だった。手元の古い ref を信じて no-op push を「成功」にしていた。
        return json(res, 400, {
          error:
            'push するコミットがありません。' +
            (info.dirty.length
              ? `作業ツリーに未コミットの変更が ${info.dirty.length} 件あります — Push フェーズがコミットを作っていません。`
              : 'リモートと同じ内容です。'),
        })
      }

      run.emit({ kind: 'push', text: info.command })
      const args = ['push', ...(info.hasUpstream ? [] : ['-u']), info.remote, info.branch]
      const result = await git(args)
      const output = [result.out, result.err].filter(Boolean).join('\n')
      // `Everything up-to-date` は exit 0 で返る。成功と実際に送れたことは別物。
      const noop = /Everything up-to-date/i.test(output)
      const ok = result.code === 0 && !noop

      run.emit({
        kind: ok ? 'push-done' : 'error',
        text: output || (ok ? 'push 完了' : 'push できなかった'),
      })
      if (ok) {
        await patchState(runId, (s) => {
          s.pushedAt = new Date().toISOString()
          s.phases.push.status = 'done'
          s.phases.push.endedAt = new Date().toISOString()
          s.gates.push = { approvedAt: new Date().toISOString(), action: 'push' }
        })
      }
      return json(res, ok ? 200 : 500, {
        ok,
        noop,
        pushed: ok ? info.ahead.length : 0,
        output: output || (noop ? 'Everything up-to-date（送るものが無かった）' : ''),
      })
    }

    // ---- 成果物の中身
    if (url.pathname === '/api/artifact') {
      const name = url.searchParams.get('name') ?? ''
      const phase = PHASES.find((p) => p.artifact === name)
      if (!id || !phase) return json(res, 400, { error: '不正な成果物名' })
      try {
        const text = await readFile(path.join(runDir(id), name), 'utf8')
        return json(res, 200, { name, text })
      } catch {
        return json(res, 404, { error: 'まだ書き出されていません' })
      }
    }

    res.writeHead(404).end('not found')
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) })
  }
})

await mkdir(RUNS_DIR, { recursive: true })
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[2aio-dashboard] http://127.0.0.1:${PORT}`)
  console.log(`  repo:   ${REPO}`)
  console.log(`  runs:   ${RUNS_DIR}`)
  console.log(`  phases: ${PHASES.map((p) => `${p.label}(${p.lane})`).join(' → ')}`)
})
