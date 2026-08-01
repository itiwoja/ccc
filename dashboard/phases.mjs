// 2AIO Dashboard — フェーズ定義
//
// このファイルが「どのフェーズで何が許され、何が許されないか」の**単一の正本**である。
// server.mjs も UI も、ここに書かれた policy をそのまま表示する。
// 権限をコードの奥に隠さないのが狙い — 画面に出ている文字列が、実際に効いている規則そのもの。
//
// 5フェーズ: 調査 → 計画 → 実装 → テスト → Push
//   ・調査/計画/テスト/Push は Claude(司令塔)、実装だけ Codex に委譲する
//   ・フェーズ間の遷移は人間の承認ゲートを必ず通る (自動では進まない)
//   ・引き継ぎは会話ではなく成果物ファイル。次フェーズは前フェーズの .md を読んで始まる

import path from 'node:path'

// ---------------------------------------------------------------- Bash の分類

// どのフェーズでも無条件に拒否する。承認カードにも出さない。
// 「人間が押せば何でも通る」なら、フェーズ分けは飾りになる。
const HARD_DENY = [
  [/\bgit\s+push\b/, 'push は人間がボタンで実行する。エージェントからは行わない'],
  [/\brm\s+-[a-zA-Z]*[rf]/, '再帰・強制削除'],
  [/\bgit\s+reset\s+--hard\b/, '作業ツリーの破壊的リセット'],
  [/\bgit\s+clean\b/, '未追跡ファイルの破棄'],
  [/\bgit\s+checkout\s+--\s/, '変更の破棄'],
  [/--force\b|-f\b.*\bpush\b/, '強制操作'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(ba|z|p?w)?sh\b/i, 'ネットワーク経由のスクリプト実行'],
  [/\.env\b/, '秘密ファイルへのアクセス (原則⑧: 秘密は env 名のみ)'],
  [/[\\/]\.ssh\b/, '鍵ディレクトリへのアクセス'],
  [/\bsudo\b|\bRunAs\b/i, '権限昇格'],
  [/\bnode\s+-e\b|\bnode\s+--eval\b/, '任意コード実行 (分類を迂回できるため)'],
  [/\bsed\s+(-[a-zA-Z]*i\b|--in-place)/, 'sed によるファイルの直接書き換え'],
]

// リダイレクトは「読むだけ」を「書く」に変える。許可リストは先頭の動詞しか見ないので、
// `git status > any/file` のような形を素通ししないよう、ここで別に捕まえる。
// `2>&1` のようなディスクリプタ間の複製は書き込みではないので除外する。
function hasRedirect(command) {
  return /(^|[^0-9&])>>?/.test(command.replace(/\d?>&\d/g, ''))
}

// フェーズが許すコマンドの種別。先頭の動詞だけを見る単純な許可リスト。
const SCOPES = {
  readonly:
    /^(ls|dir|pwd|cd|cat|type|head|tail|wc|find|tree|stat|file|rg|grep|sed|awk|sort|uniq|cut|nl|basename|dirname|which|where|echo|printf|diff|git\s+(status|log|diff|show|branch|ls-files|remote|rev-parse|describe|blame|config\s+--get)|npm\s+(ls|view|outdated)|(node|npm|git)\s+(-v|--version))\b/,
  test:
    /^(npm\s+(test|run)|pnpm\s+(test|run)|yarn\s+(test|run)|npx\s+(vitest|jest|playwright|tsc|eslint)|node\s+--(test|check)|pytest|go\s+test|cargo\s+test)\b/,
  git:
    /^git\s+(add|commit|switch\s+-c|checkout\s+-b|restore\s+--staged|stash\s+(list|show))\b/,
}

// パイプ・連結で分割し、**全ての区間**が許可リストを通ることを求める。
// `git log | head` は両方 readonly なので通り、`ls && rm -rf x` は落ちる。
function segmentsOf(command) {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function classifyBash(command, allowedScopes) {
  for (const [re, why] of HARD_DENY) {
    if (re.test(command)) return { decision: 'deny', why }
  }
  if (!allowedScopes.length) {
    return { decision: 'ask', why: 'このフェーズはコマンド実行を前提にしていない' }
  }
  if (hasRedirect(command)) {
    return { decision: 'ask', why: 'ファイルへのリダイレクトを含む（書き込みになる）' }
  }
  const segments = segmentsOf(command)
  const patterns = allowedScopes.map((name) => SCOPES[name])
  const unmatched = segments.find((seg) => !patterns.some((re) => re.test(seg)))
  if (unmatched) {
    return { decision: 'ask', why: `許可リスト外のコマンド: ${unmatched.slice(0, 60)}` }
  }
  return { decision: 'allow', why: `${allowedScopes.join('+')} の範囲内` }
}

// ---------------------------------------------------------------- 書き込み先の判定

function withinDir(target, dir) {
  const rel = path.relative(dir, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// ---------------------------------------------------------------- 判定の本体

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * ツール呼び出し1件に対する判定。
 * allow = 自動許可 / deny = 問答無用で拒否 / ask = 承認カードを出して人間に聞く(タイムアウト無し)
 */
export function decide(phase, toolName, input, ctx) {
  if (toolName === 'Bash' || toolName === 'BashOutput') {
    const command = String(input?.command ?? '')
    return classifyBash(command, phase.bash)
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (!phase.write) {
      return { decision: 'deny', why: `${phase.label}フェーズは書き込みを行わない` }
    }
    const target = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? '')
    if (!target) return { decision: 'ask', why: '書き込み先が読み取れない' }
    const abs = path.resolve(ctx.cwd, target)
    if (phase.write === 'artifact') {
      if (withinDir(abs, ctx.artifactDir)) {
        return { decision: 'allow', why: '成果物ディレクトリ内' }
      }
      return { decision: 'deny', why: `${phase.label}フェーズが書けるのは成果物だけ (${toolName} → ${target})` }
    }
    if (phase.write === 'repo') {
      if (withinDir(abs, ctx.cwd)) return { decision: 'allow', why: 'リポジトリ内' }
      return { decision: 'deny', why: 'リポジトリ外への書き込み' }
    }
  }

  if (phase.autoAllow.includes(toolName)) {
    return { decision: 'allow', why: `${phase.label}フェーズの許可ツール` }
  }
  return { decision: 'ask', why: `${phase.label}フェーズの許可リストに無いツール` }
}

/** UI とプロンプトの両方に出す、1行の権限表記。 */
export function policyLine(phase) {
  const parts = []
  parts.push(phase.autoAllow.length ? phase.autoAllow.join(' ') : 'ツール無し')
  parts.push(`bash:${phase.bash.length ? phase.bash.join('+') : 'なし'}`)
  parts.push(`write:${phase.write ?? 'なし'}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------- 共通のガードレール文

function guardrails(phase) {
  return [
    '',
    '## このフェーズの権限（実際に強制されている）',
    `  ${policyLine(phase)}`,
    '',
    'この範囲外のツールを呼ぶと、ブラウザ側に承認カードが出て**人間が答えるまで停止する**。',
    'タイムアウトは無い。勝手に許可されることも無い。',
    'git push・rm -rf・秘密ファイルへのアクセスは、どのフェーズでも承認カードすら出ずに拒否される。',
  ].join('\n')
}

// ---------------------------------------------------------------- フェーズ定義

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'TodoWrite']

export const PHASES = [
  {
    id: 'investigate',
    label: '調査',
    order: 1,
    lane: 'claude',
    artifact: '01-investigate.md',
    produces: '現状の事実。関係するファイル、いまの挙動、制約。',
    autoAllow: [...READ_TOOLS],
    bash: ['readonly'],
    write: 'artifact',
    role: [
      'あなたは調査担当である。目的はひとつ: **いまどうなっているかを事実として確定させること。**',
      '',
      '## やること',
      '- 関係するファイルを実際に読む。推測で書かない。',
      '- 参照は必ず `path/to/file.ts:42` の形式で、行番号まで書く。',
      '- 分からなかったこと・確認できなかったことは「未確認」として明示的に残す。',
      '',
      '## ガードレール（やらないこと）',
      '- **解決策を設計しない。** それは計画フェーズの仕事。',
      '- **コードを1行も書かない。** 変更は実装フェーズまで発生しない。',
      '- 「〜すべき」と書かない。「〜になっている」だけを書く。',
      guardrails({ label: '調査', autoAllow: READ_TOOLS, bash: ['readonly'], write: 'artifact' }),
    ].join('\n'),
    brief: ({ goal, artifactPath }) =>
      [
        `# 目的`,
        goal,
        '',
        `# 依頼`,
        'この目的に取りかかる前に、現状を調査してほしい。',
        '調べ終わったら、次の構成で `' + artifactPath + '` に書き出すこと。',
        '',
        '```markdown',
        '# 調査: <目的の一行要約>',
        '',
        '## 関係する箇所',
        '| ファイル:行 | いま何をしているか |',
        '',
        '## いまの挙動',
        '## 制約・既存の決まり',
        '## 未確認のこと',
        '```',
        '',
        '書き出したら、要点を3行で会話にも返して終わる。',
      ].join('\n'),
  },

  {
    id: 'plan',
    label: '計画',
    order: 2,
    lane: 'claude',
    artifact: '02-plan.md',
    produces: '実装の手順書。Codex がこれだけを読んで実装できる粒度。',
    autoAllow: [...READ_TOOLS],
    bash: ['readonly'],
    write: 'artifact',
    role: [
      'あなたは計画担当である。目的は **他人がこれだけを読んで実装できる手順書を書くこと。**',
      'その「他人」は実際に別のモデル(Codex)であり、この会話を一切見ていない。',
      '',
      '## やること',
      '- 変更するファイルを1つずつ挙げ、それぞれ何をどう変えるかを書く。',
      '- 受け入れ条件を、検証可能な形で書く（「動く」ではなく「`npm test` が通る」）。',
      '- 判断に迷った箇所は、選んだ案と**選ばなかった案とその理由**を残す。',
      '',
      '## ガードレール（やらないこと）',
      '- **コードを書かない。** 実装は Codex の仕事。手順書に完成コードを貼らない。',
      '- **調査をやり直さない。** 調査成果物に無い事実が必要なら、それを「未確認」として計画に書き、人間に差し戻す。',
      '- 手順を曖昧にしない。「適切に修正する」は手順ではない。',
      guardrails({ label: '計画', autoAllow: READ_TOOLS, bash: ['readonly'], write: 'artifact' }),
    ].join('\n'),
    brief: ({ goal, priors, artifactPath }) =>
      [
        `# 目的`,
        goal,
        '',
        `# 調査フェーズの成果物`,
        priors,
        '',
        `# 依頼`,
        'この調査結果をもとに、実装手順書を `' + artifactPath + '` に書いてほしい。',
        '読むのは、この会話を見ていない別のモデルである。',
        '',
        '```markdown',
        '# 計画: <目的の一行要約>',
        '',
        '## 方針',
        '## 変更するファイル',
        '### 1. path/to/file.ts',
        '- 何を: ',
        '- どう: ',
        '- なぜ: ',
        '',
        '## 受け入れ条件',
        '- [ ] 検証可能な条件',
        '',
        '## 選ばなかった案',
        '```',
        '',
        '書き出したら、方針を3行で会話にも返して終わる。',
      ].join('\n'),
  },

  {
    id: 'implement',
    label: '実装',
    order: 3,
    lane: 'codex',
    sandbox: 'workspace-write',
    artifact: '03-implement.md',
    produces: '実際の差分。成果物には agent の要約と、git が測った実差分が併記される。',
    // Codex は自前の sandbox で権限を持つ。canUseTool は Claude 側だけの機構なので
    // ここの autoAllow/bash/write は「UI 表示用の宣言」として sandbox の内容と揃える。
    autoAllow: ['Codex sandbox'],
    bash: ['sandbox'],
    write: 'repo',
    role: null,
    brief: ({ goal, priors }) =>
      [
        `# 目的`,
        goal,
        '',
        `# 実装手順書`,
        priors,
        '',
        `# 依頼`,
        'この手順書のとおりに実装してほしい。',
        '',
        '## ガードレール',
        '- 手順書に無い変更をしない。必要だと判断したら、実装せずに理由を報告する。',
        '- テストの実行と修正判断は次のフェーズの担当。ここでは実装だけを終わらせる。',
        '- git commit はしない。コミットは Push フェーズの担当。',
        '- `.2aio/` 配下には書かない（成果物はダッシュボードが記録する）。',
        '',
        '終わったら、変更したファイルと「手順書から外れた点があればその理由」を報告すること。',
      ].join('\n'),
  },

  {
    id: 'test',
    label: 'テスト',
    order: 4,
    lane: 'claude',
    artifact: '04-test.md',
    produces: '受け入れ条件が満たされたかの判定。直しはしない。',
    autoAllow: [...READ_TOOLS],
    bash: ['readonly', 'test'],
    write: 'artifact',
    role: [
      'あなたは検証担当である。目的は **受け入れ条件が満たされたかを判定すること。**',
      '',
      '## やること',
      '- 計画の受け入れ条件を1つずつ、実際にコマンドを走らせて確認する。',
      '- 実際の差分を読み、手順書との食い違いを探す。',
      '- 出力は貼り付ける。「通った」ではなく、通った証跡を残す。',
      '',
      '## ガードレール（やらないこと）',
      '- **失敗しても直さない。** 直すのは実装フェーズの仕事であり、あなたは書き込み権限を持たない。',
      '  失敗を見つけたら、原因と再現手順を成果物に書き、人間に実装フェーズへの差し戻しを促す。',
      '- **受け入れ条件を勝手に緩めない。** 満たせないなら「満たせない」と書く。',
      '- 自分が書いたコードではないので、擁護も弁解もしない。事実だけ。',
      guardrails({ label: 'テスト', autoAllow: READ_TOOLS, bash: ['readonly', 'test'], write: 'artifact' }),
    ].join('\n'),
    brief: ({ goal, priors, artifactPath }) =>
      [
        `# 目的`,
        goal,
        '',
        `# これまでの成果物`,
        priors,
        '',
        `# 依頼`,
        '実装が終わっている。受け入れ条件を1つずつ検証し、`' + artifactPath + '` に書き出してほしい。',
        '差分は `git diff` で確認できる。',
        '',
        '```markdown',
        '# 検証: <目的の一行要約>',
        '',
        '## 判定: PASS / FAIL',
        '',
        '## 受け入れ条件',
        '| 条件 | 結果 | 証跡 |',
        '',
        '## 実行したコマンド',
        '## 手順書との食い違い',
        '## FAIL の場合: 原因と再現手順',
        '```',
        '',
        '書き出したら、判定(PASS/FAIL)と理由を会話にも返して終わる。',
      ].join('\n'),
  },

  {
    id: 'push',
    label: 'Push',
    order: 5,
    lane: 'claude',
    artifact: '05-push.md',
    produces: 'ブランチとコミット。push そのものは人間がボタンで実行する。',
    autoAllow: [...READ_TOOLS],
    bash: ['readonly', 'git'],
    write: 'artifact',
    role: [
      'あなたは公開準備担当である。目的は **人間が push ボタンを押せる状態まで整えること。**',
      '',
      '## やること',
      '- main / master にいるなら、作業ブランチを切る。',
      '- 意味のある単位でステージし、コミットする。',
      '- コミットメッセージは「何を」ではなく「なぜ」を書く。1行目は72文字以内。',
      '',
      '## ガードレール（やらないこと）',
      '- **`git push` は実行しない。** 実行しようとしても拒否される。押すのは人間。',
      '- **コードを直さない。** 書き込み権限は成果物ディレクトリにしか無い。',
      '  コミット直前に修正が必要だと気づいたら、コミットせずに人間へ差し戻す。',
      '- テストが FAIL のままコミットしない。判定は検証成果物にある。',
      guardrails({ label: 'Push', autoAllow: READ_TOOLS, bash: ['readonly', 'git'], write: 'artifact' }),
    ].join('\n'),
    brief: ({ goal, priors, artifactPath }) =>
      [
        `# 目的`,
        goal,
        '',
        `# これまでの成果物`,
        priors,
        '',
        `# 依頼`,
        '検証が終わっている。ブランチを整え、コミットまで進めてほしい。',
        'push はダッシュボードのボタンで人間が実行するので、あなたは実行しない。',
        '',
        `終わったら \`${artifactPath}\` に、ブランチ名・コミットメッセージ・含めた変更の要約・`,
        'レビュアーに見てほしい点を書き出すこと。',
      ].join('\n'),
  },
]

export const PHASE_IDS = PHASES.map((p) => p.id)
export const phaseById = (id) => PHASES.find((p) => p.id === id)
export const nextPhaseOf = (id) => PHASES[PHASES.findIndex((p) => p.id === id) + 1] ?? null
