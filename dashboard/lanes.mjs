// 2AIO Dashboard — レーン駆動
//
// フェーズ1本を、担当 SDK で走らせる。呼び出し側(server.mjs)から見た形は両レーンで同じ:
//   startPhase(ctx) → { send(text), stop() }
// ctx は { phase, brief, cwd, artifactDir, emit, ask }
//
// emit(event)  … SSE でブラウザへ流す
// ask(request) … 承認カードを出し、人間が答えるまで待つ Promise<boolean>。タイムアウトは無い。

import path from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { Codex } from '@openai/codex-sdk'

import { decide, policyLine } from './phases.mjs'

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

const userMessage = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
})

// ---------------------------------------------------------------- 承認ゲート

// ツールの引数から、画面に出す1行を作る。何が起きるかが読めないカードは承認できない。
function describeCall(toolName, input, cwd) {
  if (toolName === 'Bash') return String(input?.command ?? '')
  const rel = (value) => {
    if (typeof value !== 'string' || !value) return ''
    if (!path.isAbsolute(value)) return value
    return path.relative(cwd, value) || '.'
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    return [toolName, input?.pattern, rel(input?.path)].filter(Boolean).join(' ')
  }
  const target = rel(input?.file_path ?? input?.path ?? input?.notebook_path) || input?.url
  return target ? `${toolName} ${target}` : toolName
}

function makeGate({ phase, cwd, artifactDir, emit, ask }) {
  return async (toolName, input) => {
    const verdict = decide(phase, toolName, input, { cwd, artifactDir })
    const detail = describeCall(toolName, input, cwd)

    // allow の時は何も出さない。呼び出し自体のトレースは assistant の tool_use から
    // 必ず出るので、ここで出すと二重になる。読み取り専用ツールは canUseTool を
    // 通らずに実行されるため、tool_use 側を正本にしないと画面から消える。
    if (verdict.decision === 'allow') return { behavior: 'allow' }

    if (verdict.decision === 'deny') {
      emit({ kind: 'denied', tool: toolName, text: detail, note: verdict.why })
      return {
        behavior: 'deny',
        message:
          `${phase.label}フェーズでは実行できない: ${verdict.why}。\n` +
          `このフェーズで許されているのは「${policyLine(phase)}」だけ。\n` +
          `必要なら実行せずに、その必要性を成果物に書いて人間の判断を仰ぐこと。`,
      }
    }

    // ask — 人間が答えるまで本当に止まる (fail-closed)
    const approved = await ask({ tool: toolName, text: detail, note: verdict.why })
    if (approved) return { behavior: 'allow' }
    return {
      behavior: 'deny',
      message:
        `人間が拒否した (${detail})。\n` +
        `別の手段を探すか、なぜこれが必要かを説明して、実行せずに止まること。`,
    }
  }
}

// ---------------------------------------------------------------- Claude レーン

export function startClaudePhase(ctx) {
  const { phase, brief, cwd, artifactDir, emit, ask, onIdle } = ctx
  const input = createQueue()

  const run = query({
    prompt: input,
    options: {
      cwd,
      maxTurns: 40,
      permissionMode: 'default',
      // 既定では ~/.claude/settings.json などの許可ルールも読み込まれ、そこで許された
      // ツールは canUseTool を通らずに実行される。フェーズ権限が環境ごとに勝手に
      // 広がってしまうので、設定ファイルは一切読まない (SDK isolation mode)。
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: phase.role },
      canUseTool: makeGate({ phase, cwd, artifactDir, emit, ask }),
    },
  })

  input.push(userMessage(brief))
  let started = false

  ;(async () => {
    try {
      for await (const msg of run) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          started = true
          emit({ kind: 'ready', text: `claude / model=${msg.model} / 認証元=${msg.apiKeySource}` })
        } else if (msg.type === 'assistant') {
          // 文とツール呼び出しを、出てきた順にそのまま流す。
          // 読み取り専用ツールは canUseTool を通らないので、ここが唯一の可視化点。
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text.trim()) {
              emit({ kind: 'assistant', text: block.text })
            } else if (block.type === 'tool_use') {
              emit({ kind: 'tool', tool: block.name, text: describeCall(block.name, block.input, cwd) })
            }
          }
        } else if (msg.type === 'result') {
          emit({
            kind: 'turn-end',
            text: msg.is_error
              ? `エラー終了 (${msg.subtype}) ${String(msg.result ?? '').slice(0, 400)}`.trim()
              : `${msg.num_turns} turn · ${(msg.duration_ms / 1000).toFixed(1)}s · $${(msg.total_cost_usd ?? 0).toFixed(4)}`,
            failed: Boolean(msg.is_error),
          })
          onIdle()
        }
      }
    } catch (err) {
      emit({ kind: 'error', text: String(err?.stack ?? err?.message ?? err) })
      onIdle()
    }
  })()

  return {
    send: (text) => input.push(userMessage(text)),
    stop: () => {
      input.close()
      // 起動途中のセッションに interrupt を投げると、後続のセッションごと
      // error_during_execution で落ちることがある。init を見てからだけ投げる。
      if (started) run.interrupt?.().catch(() => {})
    },
  }
}

// ---------------------------------------------------------------- Codex レーン

export function startCodexPhase(ctx) {
  const { phase, brief, cwd, emit, onIdle } = ctx

  const codex = new Codex()
  const thread = codex.startThread({
    workingDirectory: cwd,
    sandboxMode: phase.sandbox ?? 'read-only',
    skipGitRepoCheck: true,
  })

  // Codex には Claude のような入力ストリームが無く、ターンは厳密に直列。
  // 走行中の発言は拒否せずキューに積み、順に流す。
  const pending = []
  let draining = false
  let stopped = false

  async function runTurn(text) {
    try {
      const { events } = await thread.runStreamed(text)
      for await (const event of events) {
        if (stopped) break
        switch (event.type) {
          case 'thread.started':
            emit({ kind: 'ready', text: `codex / thread=${event.thread_id} / sandbox=${phase.sandbox}` })
            break
          case 'item.completed': {
            const item = event.item
            if (item.type === 'agent_message') emit({ kind: 'assistant', text: item.text })
            else if (item.type === 'reasoning') emit({ kind: 'note', text: item.text })
            // Codex は item.completed で届くので、こちらは「実行済み」として出せる
            else if (item.type === 'command_execution')
              emit({ kind: 'tool', tool: 'Bash', text: item.command, note: 'codex sandbox', ok: true })
            else if (item.type === 'file_change')
              emit({
                kind: 'tool',
                tool: 'Edit',
                text: item.changes.map((c) => `${c.kind} ${c.path}`).join('\n'),
                note: 'codex sandbox',
                ok: true,
              })
            else if (item.type === 'error') emit({ kind: 'error', text: item.message })
            break
          }
          case 'turn.completed':
            emit({
              kind: 'turn-end',
              text: `in ${event.usage.input_tokens} / out ${event.usage.output_tokens} tokens`,
              failed: false,
            })
            break
          case 'turn.failed':
            emit({ kind: 'turn-end', text: event.error.message, failed: true })
            break
          case 'error':
            emit({ kind: 'error', text: event.message })
            break
        }
      }
    } catch (err) {
      emit({ kind: 'error', text: String(err?.stack ?? err?.message ?? err) })
    }
  }

  async function drain() {
    draining = true
    try {
      while (pending.length && !stopped) await runTurn(pending.shift())
    } finally {
      draining = false
      if (!stopped) onIdle()
    }
  }

  function send(text) {
    pending.push(text)
    if (!draining) drain()
  }

  send(brief)

  return {
    send,
    stop: () => {
      stopped = true
      pending.length = 0
    },
  }
}

export const LANES = { claude: startClaudePhase, codex: startCodexPhase }
