// 2AIO Dashboard — SDK 疎通検証スパイク
//
// 目的はひとつ: Claude Agent SDK と Codex SDK が、ブラウザから対話できるかを確かめる。
// それ以外は作らない。承認UI・ジョブキュー・複数repo制御は、これが動いてから。
//
// 依存は2つのSDKだけ。ビルド工程なし (node server.mjs で起動)。
// 書き込みを伴うのでバインドは 127.0.0.1 固定。

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { Codex } from '@openai/codex-sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PORT = Number(process.env.PORT || 7801)

// ---------------------------------------------------------------- 入力ストリーム

// query() には「あとから伸びる AsyncIterable」を渡す必要がある。
// ブラウザからの POST がここに push され、SDK 側が for-await で引き取る。
function createQueue() {
  const buf = []
  const waiters = []
  let closed = false
  return {
    push(value) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else buf.push(value)
    },
    close() {
      closed = true
      while (waiters.length) waiters.shift()({ value: undefined, done: true })
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buf.length) {
          yield buf.shift()
          continue
        }
        if (closed) return
        const next = await new Promise((resolve) => waiters.push(resolve))
        if (next.done) return
        yield next.value
      }
    },
  }
}

// ---------------------------------------------------------------- セッション

const sessions = new Map()

function createSession(lane) {
  const session = {
    id: randomUUID(),
    lane,
    clients: new Set(),
    history: [],
  }
  session.emit = (event) => {
    const stamped = { ...event, at: new Date().toISOString() }
    session.history.push(stamped)
    const line = `data: ${JSON.stringify(stamped)}\n\n`
    for (const res of session.clients) res.write(line)
  }
  sessions.set(session.id, session)
  if (lane === 'claude') startClaude(session)
  else startCodex(session)
  return session
}

// ---------------------------------------------------------------- Claude レーン

function startClaude(session) {
  const input = createQueue()

  session.send = (text) => {
    input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
  }
  session.close = () => input.close()

  const run = query({
    prompt: input,
    options: {
      cwd: REPO,
      maxTurns: 20,
      permissionMode: 'default',
      // 検証スパイクなので全ツールを拒否し、純粋な会話に限定する。
      // 同時に「承認コールバックがプロセス内で発火する」ことの実地確認も兼ねる。
      // 本番ではここがブラウザの承認カードに繋がる — タイムアウトが無いので
      // 人間が答えるまで SDK 側は本当に停止する (fail-closed)。
      canUseTool: async (toolName) => {
        session.emit({ kind: 'gate', text: `canUseTool 発火 → ${toolName} を拒否` })
        return {
          behavior: 'deny',
          message: '検証中はツールを使いません。会話だけで答えてください。',
        }
      },
    },
  })
  session.run = run

  ;(async () => {
    try {
      for await (const msg of run) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          session.emit({
            kind: 'ready',
            text: `model=${msg.model} / 認証元=${msg.apiKeySource} / v${msg.claude_code_version}`,
          })
        } else if (msg.type === 'assistant') {
          const text = (msg.message?.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
          if (text.trim()) session.emit({ kind: 'assistant', text })
        } else if (msg.type === 'result') {
          session.emit({
            kind: 'turn-end',
            text: msg.is_error
              ? `エラー終了 (${msg.subtype})`
              : `${msg.num_turns} turn / ${msg.duration_ms}ms / $${(msg.total_cost_usd ?? 0).toFixed(4)}`,
          })
        }
      }
      session.emit({ kind: 'note', text: 'Claude ストリーム終了' })
    } catch (err) {
      session.emit({ kind: 'error', text: String(err?.stack ?? err?.message ?? err) })
    }
  })()
}

// ---------------------------------------------------------------- Codex レーン

function startCodex(session) {
  const codex = new Codex()
  const thread = codex.startThread({
    workingDirectory: REPO,
    // 検証中は読み取り専用。書かせるのは隔離ワークツリーを用意してから。
    sandboxMode: 'read-only',
    skipGitRepoCheck: true,
  })

  // Codex には Claude のような入力ストリームが無く、ターンは厳密に直列。
  // 走行中の発言は拒否せずキューに積み、順に流す。
  const pending = []
  let draining = false

  session.send = (text) => {
    pending.push(text)
    if (!draining) drain()
  }

  async function drain() {
    draining = true
    try {
      while (pending.length) await runTurn(pending.shift())
    } finally {
      draining = false
    }
  }

  async function runTurn(text) {
    try {
      const { events } = await thread.runStreamed(text)
      for await (const event of events) {
        switch (event.type) {
          case 'thread.started':
            session.emit({ kind: 'ready', text: `thread=${event.thread_id}` })
            break
          case 'item.completed': {
            const item = event.item
            if (item.type === 'agent_message') session.emit({ kind: 'assistant', text: item.text })
            else if (item.type === 'reasoning') session.emit({ kind: 'note', text: item.text })
            else if (item.type === 'command_execution') session.emit({ kind: 'gate', text: `$ ${item.command}` })
            else if (item.type === 'file_change')
              session.emit({ kind: 'gate', text: item.changes.map((c) => `${c.kind} ${c.path}`).join('\n') })
            else if (item.type === 'error') session.emit({ kind: 'error', text: item.message })
            break
          }
          case 'turn.completed':
            session.emit({
              kind: 'turn-end',
              text: `in ${event.usage.input_tokens} / out ${event.usage.output_tokens} tokens`,
            })
            break
          case 'turn.failed':
            session.emit({ kind: 'error', text: event.error.message })
            break
          case 'error':
            session.emit({ kind: 'error', text: event.message })
            break
        }
      }
    } catch (err) {
      session.emit({ kind: 'error', text: String(err?.stack ?? err?.message ?? err) })
    }
  }

  session.close = () => {}
  session.emit({ kind: 'note', text: 'Codex スレッド準備完了 (sandbox: read-only)' })
}

// ---------------------------------------------------------------- HTTP

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

  try {
    if (url.pathname === '/') {
      const html = await readFile(path.join(HERE, 'public', 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // セッション開始 — レーンを選んで SDK を起動する
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const { lane } = await readJsonBody(req)
      if (lane !== 'claude' && lane !== 'codex') return json(res, 400, { error: 'lane は claude か codex' })
      const session = createSession(lane)
      return json(res, 200, { id: session.id, lane })
    }

    // SSE — セッションのイベントをブラウザへ中継
    if (url.pathname === '/api/stream') {
      const session = sessions.get(url.searchParams.get('id'))
      if (!session) return json(res, 404, { error: 'unknown session' })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.flushHeaders?.()
      // 再接続時に取りこぼさないよう、既存のイベントを先に流す
      for (const event of session.history) res.write(`data: ${JSON.stringify(event)}\n\n`)
      session.clients.add(res)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        clearInterval(heartbeat)
        session.clients.delete(res)
      })
      return
    }

    // 発言
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const { id, text } = await readJsonBody(req)
      const session = sessions.get(id)
      if (!session) return json(res, 404, { error: 'unknown session' })
      if (!text?.trim()) return json(res, 400, { error: 'empty' })
      session.emit({ kind: 'user', text })
      // ターンの完了は待たない。進捗も結果も SSE 側で流れる。
      Promise.resolve(session.send(text)).catch((err) =>
        session.emit({ kind: 'error', text: String(err?.message ?? err) }),
      )
      return json(res, 200, { ok: true })
    }

    res.writeHead(404).end('not found')
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[2aio-dashboard] http://127.0.0.1:${PORT}  (cwd: ${REPO})`)
})
