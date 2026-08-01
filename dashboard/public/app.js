// 2AIO Dashboard — クライアント
//
// 画面が持つ責務は3つだけ:
//   ① いまどのフェーズにいて、そこで何が許されているかを常に見せる
//   ② 承認カードを出し、人間が答えるまで待つ（勝手に閉じない・タイムアウトしない）
//   ③ フェーズを進める / 戻す / push する — 遷移の入口をゲートバー1箇所に集める

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

const ICON = {
  check: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6.4 4.6 9 10 3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  call: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 2.5 7.5 6 3 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

const LANE_NAME = { claude: 'claude', codex: 'codex' }

let PHASES = []
let runId = null
let state = null
let source = null
let following = true
const cards = new Map()

// ---------------------------------------------------------------- 起動

async function boot() {
  PHASES = await (await fetch('/api/phases')).json()
  renderRail()
  renderEmpty()
  refreshBranch()
}

async function refreshBranch() {
  try {
    const info = await (await fetch('/api/git')).json()
    $('branch').textContent = info.branch ? `${info.branch}${info.dirty.length ? ` · ${info.dirty.length} 変更` : ''}` : ''
  } catch {}
}

function renderEmpty() {
  const box = el('div', 'empty')
  box.append(el('h2', null, '目的を1行で書くと、5フェーズを通す'))
  box.append(el('p', null, '調査が事実を確定させ、計画が手順書を書き、Codex が実装し、テストが判定し、最後にコミットまで進む。'))
  box.append(el('p', null, 'フェーズは自動では進まない。各段の終わりで必ず止まり、あなたが成果物を見て判断する。'))
  $('thread').replaceChildren(box)
}

// ---------------------------------------------------------------- フェーズレール

function renderRail() {
  const steps = $('steps')
  steps.replaceChildren()
  for (const phase of PHASES) {
    const status = state?.phases?.[phase.id]?.status ?? 'idle'
    const step = el('button', 'step')
    step.type = 'button'
    step.dataset.status = status
    step.dataset.phase = phase.id
    if (state?.phase === phase.id) step.setAttribute('aria-current', 'step')

    step.append(el('span', 'dot'))
    const top = el('div', 'step-top')
    top.append(el('span', 'step-name', `${phase.order}. ${phase.label}`))
    const lane = el('span', 'lane', LANE_NAME[phase.lane])
    lane.dataset.lane = phase.lane
    top.append(lane)
    step.append(top)
    step.append(el('div', 'policy', phase.policy))

    const written = status !== 'idle'
    step.disabled = !runId || !written
    step.title = written ? `${phase.artifact} を開く` : phase.produces
    step.onclick = () => openArtifact(phase.artifact)
    steps.append(step)
  }
}

// ---------------------------------------------------------------- イベント描画

function push(node) {
  const thread = $('thread')
  if (thread.querySelector('.empty')) thread.replaceChildren()
  thread.append(node)
  if (following) node.scrollIntoView({ block: 'end' })
}

function metaLine(text, failed) {
  const node = el('div', 'ev ev-meta' + (failed ? ' is-failed' : ''), text)
  return node
}

// 呼び出しの表示は3態: 拒否(×) / 実行済み(✓) / 呼び出しただけ(›)。
// Claude 側は結果を観測しないので、勝手に ✓ を付けない。
function traceLine(event, denied) {
  const node = el('div', 'ev trace' + (denied ? ' is-denied' : event.ok ? '' : ' is-call'))
  const mark = el('span', 'mark')
  mark.innerHTML = denied ? ICON.cross : event.ok ? ICON.check : ICON.call
  node.append(mark)
  const body = el('div', 'cmd')
  body.append(el('div', null, event.text))
  if (event.note) body.append(el('div', 'why', event.note))
  node.append(body)
  return node
}

function bubble(kind, who, text) {
  const node = el('div', `ev ev-${kind}`)
  if (who) node.append(el('div', 'who', who))
  node.append(el('div', 'body', text))
  return node
}

function approvalCard(event) {
  const card = el('div', 'ev card')
  card.append(el('h3', null, `${event.tool} の実行を求めています`))
  card.append(el('div', 'why', event.note ?? ''))
  card.append(el('pre', null, event.text))

  const acts = el('div', 'acts')
  const allow = el('button', 'btn btn-sm btn-ok', '許可する')
  const deny = el('button', 'btn btn-sm btn-danger', '拒否する')
  allow.type = deny.type = 'button'
  allow.onclick = () => resolveApproval(event.requestId, true)
  deny.onclick = () => resolveApproval(event.requestId, false)
  acts.append(allow, deny)
  acts.append(el('span', 'hint', '答えるまでエージェントは停止している'))
  card.append(acts)

  cards.set(event.requestId, card)
  queueMicrotask(() => allow.focus())
  return card
}

function phaseRule(event) {
  const node = el('div', 'ev phase-rule')
  node.append(el('span', 'name', `${event.text} フェーズ`))
  node.append(el('span', 'pol', event.note ?? ''))
  return node
}

function onEvent(event) {
  switch (event.kind) {
    case 'state':
      state = event.state
      renderRail()
      renderGate()
      return
    case 'idle':
      renderGate()
      return
    case 'phase':
      return push(phaseRule(event))
    case 'user':
      return push(bubble('user', 'あなた', event.text))
    case 'assistant':
      return push(bubble('assistant', 'AI', event.text))
    case 'tool':
      return push(traceLine(event, false))
    case 'denied':
      return push(traceLine(event, true))
    case 'approval':
      return push(approvalCard(event))
    case 'approval-resolved': {
      const card = cards.get(event.requestId)
      if (!card) return
      card.classList.add('is-resolved')
      const verdict = el('div', 'verdict', event.allowed ? '許可した' : `拒否した${event.note ? ` — ${event.note}` : ''}`)
      verdict.dataset.allowed = String(event.allowed)
      card.append(verdict)
      cards.delete(event.requestId)
      return
    }
    case 'artifact':
      return push(metaLine(`成果物: ${event.text}${event.note ? ` — ${event.note}` : ''}`))
    case 'gate-passed':
      return push(metaLine(`ゲート通過: ${event.text}`))
    case 'push':
      return push(metaLine(`$ ${event.text}`))
    case 'push-done':
      push(metaLine(event.text))
      return refreshBranch()
    case 'error':
      return push(bubble('assistant', 'エラー', event.text))
    case 'turn-end':
      return push(metaLine(event.text, event.failed))
    default:
      return push(metaLine(event.text ?? ''))
  }
}

// ---------------------------------------------------------------- ゲートバー

function renderGate() {
  const gate = $('gate')
  if (!state) return void (gate.hidden = true)

  const phase = PHASES.find((p) => p.id === state.phase)
  const status = state.phases[phase.id].status
  gate.replaceChildren()
  gate.hidden = false

  if (status === 'running') {
    gate.classList.remove('is-open')
    const label = el('div', 'label')
    label.innerHTML = `<b>${phase.label}</b> を実行中 — 割り込んで指示を足せます`
    gate.append(label)
    return
  }

  gate.classList.add('is-open')
  const next = PHASES.find((p) => p.order === phase.order + 1)
  const label = el('div', 'label')
  label.innerHTML = `<b>${phase.label}</b> のターンが終わりました`
  gate.append(label, el('div', 'spacer'))

  const artifact = el('button', 'btn btn-sm', '成果物を見る')
  artifact.type = 'button'
  artifact.onclick = () => openArtifact(phase.artifact)
  gate.append(artifact)

  const redo = el('button', 'btn btn-sm btn-quiet', 'やり直す')
  redo.type = 'button'
  redo.onclick = () => gateAction('redo')
  gate.append(redo)

  // テストが FAIL なら実装へ差し戻す — 直すのはテスト担当の仕事ではない
  if (phase.id === 'test') {
    const back = el('button', 'btn btn-sm', '実装へ差し戻す')
    back.type = 'button'
    back.onclick = () => gateAction('back', 'implement')
    gate.append(back)
  }

  if (next) {
    const advance = el('button', 'btn btn-sm btn-primary', `${next.label}へ進む`)
    advance.type = 'button'
    advance.onclick = () => gateAction('advance')
    gate.append(advance)
  } else {
    const open = el('button', 'btn btn-sm btn-primary', state.pushedAt ? 'push 済み' : 'push を確認')
    open.type = 'button'
    open.disabled = Boolean(state.pushedAt)
    open.onclick = openPushPanel
    gate.append(open)
  }
}

async function gateAction(action, to) {
  const res = await fetch('/api/gate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: runId, action, to }),
  })
  if (!res.ok) push(metaLine(`ゲート失敗: ${(await res.json()).error}`, true))
}

async function resolveApproval(requestId, allow) {
  await fetch('/api/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: runId, requestId, allow }),
  })
}

// ---------------------------------------------------------------- 成果物パネル

async function openArtifact(name) {
  $('push-box').replaceChildren()
  $('panel-name').textContent = name
  const body = $('panel-body')
  $('panel').hidden = false
  body.className = 'panel-body'
  body.textContent = '読み込み中…'
  const res = await fetch(`/api/artifact?id=${runId}&name=${encodeURIComponent(name)}`)
  if (res.ok) {
    body.textContent = (await res.json()).text
  } else {
    body.className = 'panel-body is-empty'
    body.textContent = 'まだ書き出されていません。'
  }
}

const REMOTE_STATE = {
  present: (i) => `${i.remote}/${i.branch} は ${i.remoteSha?.slice(0, 7)} にある`,
  absent: (i) => `${i.remote} に ${i.branch} はまだ無い（初回 push）`,
  unreachable: () => 'リモートに接続できない',
  unknown: () => 'リモートとの差分を計算できない',
}

async function openPushPanel() {
  $('panel').hidden = false
  $('panel-name').textContent = 'push'
  const body = $('panel-body')
  body.className = 'panel-body is-empty'
  body.textContent = ''
  $('push-box').replaceChildren(el('div', 'push-box', 'リモートに問い合わせ中…'))

  // 手元の remote-tracking ref は古いことがあるので、サーバがリモートに直接聞く
  const info = await (await fetch('/api/push-preview')).json()
  const box = el('div', 'push-box')

  box.append(el('h4', null, 'リモートの状態'))
  box.append(el('code', null, (REMOTE_STATE[info.remoteState] ?? (() => info.remoteState))(info)))

  const blocked = !info.command || !info.ahead.length || info.remoteState === 'unreachable' || info.remoteState === 'unknown'

  if (blocked) {
    // 「押せない理由」を必ず言う。無言の disabled が一番わからない。
    const note = el('div', 'blocked')
    note.append(el('strong', null, 'いま push できるものがありません'))
    if (info.error) {
      note.append(el('p', null, info.error))
    } else if (info.dirty.length) {
      note.append(
        el('p', null,
          `作業ツリーに未コミットの変更が ${info.dirty.length} 件あります。` +
          'Push フェーズはコミットを1つも作らなかったため、送るものがありません。'),
      )
      note.append(el('p', null, 'テストが FAIL のままだと、Push フェーズは規定どおりコミットを拒否します。成果物 05-push.md に理由が書かれています。'))
    } else {
      note.append(el('p', null, 'リモートと同じ内容です。送るものがありません。'))
    }
    box.append(note)

    const acts = el('div', 'blocked-acts')
    const seePush = el('button', 'btn btn-sm', '05-push.md を読む')
    seePush.type = 'button'
    seePush.onclick = () => openArtifact('05-push.md')
    const redo = el('button', 'btn btn-sm btn-primary', 'Push フェーズをやり直す')
    redo.type = 'button'
    redo.onclick = () => {
      $('panel').hidden = true
      gateAction('redo')
    }
    const back = el('button', 'btn btn-sm', '実装へ差し戻す')
    back.type = 'button'
    back.onclick = () => {
      $('panel').hidden = true
      gateAction('back', 'implement')
    }
    acts.append(seePush, redo, back)
    box.append(acts)
  }

  if (info.dirty.length) {
    box.append(el('h4', null, `未コミットの変更 (${info.dirty.length}) — push には含まれない`))
    const dirty = el('ul')
    for (const line of info.dirty.slice(0, 12)) dirty.append(el('li', null, line))
    if (info.dirty.length > 12) dirty.append(el('li', null, `… 他 ${info.dirty.length - 12} 件`))
    box.append(dirty)
  }

  if (!blocked) {
    box.append(el('h4', null, `push されるコミット (${info.ahead.length})`))
    const list = el('ul')
    for (const line of info.ahead) list.append(el('li', null, line))
    box.append(list)

    box.append(el('h4', null, 'これから実行されるコマンド'))
    box.append(el('code', null, info.command))

    const run = el('button', 'btn btn-danger', 'push を実行')
    run.type = 'button'
    let armed = false
    run.onclick = async () => {
      if (!armed) {
        armed = true
        run.textContent = `本当に実行: ${info.command}`
        return
      }
      run.disabled = true
      run.textContent = '実行中…'
      const res = await fetch('/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: runId, confirm: true }),
      })
      const out = await res.json()
      run.textContent = out.ok ? `push 完了 (${out.pushed} コミット)` : 'push できなかった'
      body.className = 'panel-body'
      body.textContent = out.output || out.error || ''
    }
    box.append(run)
  }

  $('push-box').replaceChildren(box)
}

$('panel-close').onclick = () => ($('panel').hidden = true)

// ---------------------------------------------------------------- 送信

async function startRun(goal) {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal }),
  })
  const out = await res.json()
  if (!res.ok) return push(metaLine(out.error, true))

  runId = out.id
  state = out.state
  $('goal').innerHTML = ''
  $('goal').append(el('strong', null, goal))
  $('thread').replaceChildren()
  $('send').textContent = '送信'
  $('input').placeholder = '割り込んで指示を足す… (Enter で送信 / Shift+Enter で改行)'
  renderRail()

  source = new EventSource(`/api/stream?id=${runId}`)
  source.onmessage = (e) => onEvent(JSON.parse(e.data))
  source.onerror = () => push(metaLine('ストリームが切れました。サーバの状態を確認してください。', true))
}

async function interject(text) {
  const res = await fetch('/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: runId, text }),
  })
  if (!res.ok) push(metaLine((await res.json()).error, true))
}

$('composer').onsubmit = (e) => {
  e.preventDefault()
  const input = $('input')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  input.style.height = 'auto'
  if (runId) interject(text)
  else startRun(text)
}

$('input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
}
$('input').oninput = (e) => {
  e.target.style.height = 'auto'
  e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.3) + 'px'
}

// 読み返している間は自動スクロールを止める
$('stream').onscroll = (e) => {
  const box = e.target
  following = box.scrollHeight - box.scrollTop - box.clientHeight < 60
}

boot()
