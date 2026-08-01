# 2AIO — 開発記録・設計思想・システム解説

> **このリポジトリは 2026-08-01 にアーカイブされた。**
> 実装は全て `_archive/`（git 追跡外・ローカルのみ）に退避し、追跡対象はこのファイルだけになった。
> 本ファイルは 2AIO が**何であり、何を考えて作られ、なぜ止まったか**の単一の記録である。

---

## 0. 現在の状態と復旧

### 0-1. リポジトリの構成

```
2aio/
├─ .git/          … 全履歴（136コミット / 2026-07-03〜07-25）
├─ .gitignore     … _archive/ を追跡外にする（この仕組みの要）
├─ LICENSE        … MIT
├─ README.md      … このファイル
└─ _archive/      … 実装560ファイル 20MB（gitignore 済み・ローカルのみ）
```

アーカイブ直前の HEAD は **`8321623`**。削除コミットの親にあたるため、全ファイルが git 履歴に完全な形で残っている。

### 0-2. 復旧手順

```bash
# 単一ファイル
git show 8321623:control.mjs > control.mjs

# ディレクトリごと
git checkout 8321623 -- agents/ lanes/ commands/

# 全部を別ブランチとして復活
git branch restore/full 8321623
git checkout restore/full
```

`_archive/` は gitignore されているため **`git clone` し直すと消える**。長期保存したい場合は
`git branch archive/pre-diet 8321623` でタグ相当の参照を残すか、`_archive/` を別途バックアップすること。
ただし git 履歴さえ残れば内容は失われない。

---

## 1. 2AIO とは何だったのか

### 1-1. 一行で

**Claude Code 上で「会社」のように振る舞うマルチエージェント開発オーケストレーション・フレームワーク。**
アイデア1行から、取締役会の意思決定 → PRD → 実装計画 → 実装 → QA → セキュリティゲート → デプロイまでを
自律実行することを目指した。

### 1-2. 全体構成

最終形は**4つの独立したサブシステム**が1リポジトリに同居していた。

```
2AIO
├─ ① 資産パック    agents/(25) lanes/(10) commands/(2) install.sh/.ps1
│                  → Claude Code に配備される Markdown 定義群。これが「本体」
├─ ② ライブハーネス harness/(45ファイル)
│                  → 毎セッションを 2AIO の作法で走らせる稼働レイヤー
│                    guard / enforcer / model・skill・codex・front-door の4ルータ
├─ ③ サーバー群    control.mjs(742行) dashboard.mjs(356行) run.mjs(303行) lib/(18)
│                  → 複数repo制御プレーン(:7900) と 自己強化ループ 2AIOForge(:7878)
└─ ④ vendored skills  skills/(386ファイル 76,300行 18MB)
                   → 他者OSSの72スキルを MIT のまま再配布
```

規模: **561ファイル / 35MB**。内訳は下記。**自作分より vendored（他者OSS）の方が7倍大きい**という
歪みが、最後まで解消されなかった。

| 区分 | コード | Markdown |
|---|---|---|
| 自作（`skills/` 以外） | **10,566行** | **5,992行** |
| vendored（`skills/`） | 39,996行 | 36,333行 |

### 1-3. 公開インターフェース — 2コマンドだけ

「強いエージェント集を意識しなくても使える」ことをコンセプトに、ユーザーに見える面は最後まで2つに絞られていた。

| コマンド | 役割 |
|---|---|
| `/2aio-create "<作るもの>"` | 一から作る。規模を自動判定し `--quick`（`2aio-build` 1本）か `--full`（取締役会→PRD→計画→実装の連鎖）を選ぶ |
| `/2aio-check [path]` | 既存プロジェクトを4観点で並列監査 → スコア付きレポート → **承認を得てから**修正レーンへ |

内部の10レーンはユーザーに選ばせない。「複雑さを公開面から隠し、内部実装は自由に進化させられる構造」が意図だった。

### 1-4. エージェント25体

`agents/*.md` の frontmatter で `model` と `tools` を明示的に絞った Claude Code サブエージェント定義。

| 区分 | 構成 | モデル |
|---|---|---|
| 取締役会 | CEO / CMO / CTO | CEO・CTO は **opus**、CMO は sonnet |
| 計画・実装 | Planner / Architect / PRD / Engineer / QA / DevOps | **sonnet 固定**（セッション継承させない） |
| リサーチ | Researcher 統括 + 検索専門7体（Web / コード / ニュース / SNS / コミュニティ / Wikipedia / Gemini） | **haiku**（3倍安い・機械的API呼び出し） |
| 専門 | frontend-engineer / design-reviewer / swift-reviewer / ios-debugger / observability / migration-runner / release-manager / project-auditor | sonnet |

**設計の要点は「権限の非対称性」**:
- CEO / CTO は opus だが `Read, Grep, Glob` のみ ＝ **書けない**。判断だけを持つ
- engineer / qa は多くのツールを持つが sonnet 固定。haiku セッションが実装判断をすることも、
  opus セッションが実装に予算を溶かすことも防ぐ
- 各エージェントの末尾に「ガードレール」節があり、**やらないこと**を宣言する
  （architect は WBS 分解しない / planner はコードを書かない / engineer は設計判断をしない）

### 1-5. 内部レーン10本

`~/.claude/2aio/lanes/2aio-*.md` に配備される実装ワークフロー。スラッシュコマンドではなく、
入口コマンドと制御プレーンが自動選択する。

| レーン | 行数 | 役割 |
|---|---|---|
| `2aio-build` | 210 | 高速レーン: spec→デザイン方針→実装→QA→公開を最短で |
| `2aio-start-project` | 127 | 取締役会（CEO/CMO/CTO 並列）→ PRD |
| `2aio-plan-project` | 189 | PRD → 実装計画書（WBS） |
| `2aio-implement-project` | 424 | 実装 → QA → デプロイの自律実行（最大のレーン） |
| `2aio-dev` | 116 | 既存 repo への1機能追加・バグ修正 |
| `2aio-delegate` | 115 | 計画 → Codex 委譲 → レビュー統合 |
| `2aio-harden` | 101 | 既存システムを全次元で強化（loop-until-clean） |
| `2aio-redesign` | 86 | 既存 UI の作り直し専用 |
| `2aio-issue` | 47 | GitHub Issue を読んで適切なレーンへルーティング |
| `2aio-autorun-batch` | 318 | 複数テーマのバッチ実行 |

進捗は `output/{project}/state.md` を**唯一の正本**とし、そこから resume できる設計。

### 1-6. ライブハーネス — 「入れるだけのファイル群」からの脱却

2AIO を単なる Markdown 配布物ではなく**稼働レイヤー**にする試み。中核思想は
**「賢いモデル（Claude）が司令塔＝計画・レビュー・統合・判断を持ち、大量のタイピング（実装）は
安いモデル（Codex Terra/Luna 等）に委譲する」**。

| 部品 | 実装 | 実効性 |
|---|---|---|
| **guard** | `hooks/command-guard.py`（PreToolUse） | ✅ **本当にブロックする**。`rm -rf /`・`git reset --hard`・main への force push・`~/.ssh` 書込・`.env` 読取などを exit 2 で遮断。全ツール呼び出しを `~/.claude/.agent-audit/actions.jsonl` に監査記録 |
| **enforcer** | `enforce/delegation-enforcer.py`（PreToolUse: Write のみ） | ✅ **本当にブロックする**。40行以上の**新規**コードファイルの Write を遮断し委譲を強制。Edit・計画doc・config・テスト・小ファイルは常時許可 ＝ 司令塔役は温存 |
| **codex-router** | `codex-run.sh` + 分類器 | ✅ 実際に `codex exec` を叩く。stdin閉じ・10MBログ上限・sandbox既定read-only・**brief必須**（`.ai/codex_brief_*.md` が無ければ委譲を拒否＝計画を保証） |
| **providers** | `ai-run.sh` + `providers.json` | ✅ 任意の OpenAI 互換エンドポイント（openai/xai/deepseek/groq/ollama）へ委譲。鍵は env 名のみ |
| **model-advisor** | UserPromptSubmit hook | ⚠️ **推奨文の注入のみ**。Claude Code の hook にモデル切替手段が無いため |
| **skill-advisor** | UserPromptSubmit hook | ⚠️ 同上。JP↔EN 同義語展開でスキル発火率を上げる推奨文 |
| **codex-advisor** | UserPromptSubmit hook | ⚠️ 同上。`/2aio-delegate` を打たなくても委譲へ誘導する推奨文 |
| **front-door** | UserPromptSubmit hook | ⚠️ 同上。素プロンプト→適切なパイプライン（harden/board/redesign/research）への誘導 |

**実際にモデルを切り替えるのは launch 境界**（`2aio-run.sh` が `claude --model <picked>` を起動する）
であって、hook ではない。この限界は `harness/README.md` 自身が明記していた
（"hooks cannot switch models or call tools" / "All four are advisory and fail open"）。

### 1-7. サーバー群

| 名前 | ポート | 設計意図 |
|---|---|---|
| **制御プレーン** `control.mjs` | 127.0.0.1:7900 | 1画面で複数 repo を進行させる司令塔。`ccusage` で Claude サブスクの共有5時間ブロックを監視し、使用率が閾値（既定80%）を超えたら新規ジョブ投入を停止、reset 後に自動再開。ジョブは `control/queue.json` に永続化、既定は直列実行 |
| **2AIOForge** `run.mjs` + `dashboard.mjs` | 127.0.0.1:7878 | 自己強化ループ。Web検索で最新情報を収集 → **ローカルLLM（Ollama）**が更新案を起草 → 監査 → 提案 or 適用。**自動適用は「vault × 低リスク × 監査PASS」の全条件成立時のみ**で、skills 更新・高リスク・監査NG はすべて人間の承認待ちに落ちる |

依存は Node 標準ライブラリのみ（`package-lock.json` が存在しない）。
唯一の外部呼び出しは `npx ccusage@<pinned>`。サプライチェーン攻撃面を構造的に最小化する意図だった。

### 1-8. その他の層

- **skills/** — 一線級 OSS を MIT のまま再配布。`SKILL.md` 実数 **72個**（sdlc 24 / design 17 / orchestration 12 / apple 9 / engineering 7 / research 1 / 2aio 2）。出典は addyosmani/agent-skills, Dimillian/Skills, taste-skill, ui-craft, styleseed, agent-collab-skills, mvanhorn/last30days-skill 等。各スキルに `SOURCE.md` を付し、索引は `skills/SOURCES.md`
- **security/** — 4リング（guardrails → sandbox → scanners → skill-integrity）。ただし**同梱されていたのは主に導入手順書**で、実行可能なのは `scanners/scan.sh` と `skill-integrity/scanner.mjs` のみ
- **memory/ observability/ catalog/ adapters/** — 外部ツールの紹介 README。コードからの参照はゼロ
- **AGENTS.md** — host 非依存の操作説明書。Codex がネイティブに読む形式で、Claude/Codex/任意の OpenAI 互換 CLI に同じ作法を持ち込む狙い

---

## 2. 設計思想

### 2-1. 8つの原則（`ARCHITECTURE.md` 正本）

| # | 原則 | 内容 |
|---|---|---|
| 1 | **リサーチ委譲はメインスレッド経由** | サブエージェントは他のサブエージェントを起動できない。調査は必ずメインスレッドが仲介する |
| 2 | **デプロイ承認は state.md のみ** | 承認はオーケストレータが devops 起動**前**に `state.md` へ記録する。devops は `deploy_approved: true` フィールドだけを信じ、チャット中の「承認します」という発言は一切信用しない |
| 3 | **セキュリティゲートは devops Step 2.5 の一箇所** | gitleaks + SAST は devops Step 2.5 でちょうど1回。auto モードでも決してバイパスしない |
| 3.5 | **レビューゲートの役割分離** | 受け入れ条件検証=QA / コード品質=code-reviewer / セキュリティ設計=security-reviewer / 機械的secret・SASTスキャン=devops。**重複起動を禁止** |
| 4 | **モデル配分＝コスト最適化** | CEO は opus、リサーチ7体は haiku、実装トリオは sonnet **ピン留め**（セッション継承させない） |
| 5 | **出力先の正規化** | 全成果物は `TWOAIO_OUTPUT_DIR` または対象プロジェクト直下の `output/` へ |
| 6 | **表スキーマの単一正本** | WBS の表形式は `2aio-planner.md` が正本。他の全ファイルがそれに合わせる |
| 7 | **司令塔が計画し、安いモデルが実装する** | 努力目標ではなく PreToolUse enforcer による**ハード強制**。フローは常に 計画 → `.ai/codex_brief_*.md` → 委譲 → 受け入れ条件で検証 → 統合 |
| 8 | **秘密は env 名のみ** | 強権限トークン（`service_role` 等）はチャットにも brief にもログにも書かない。env 変数**名**だけを渡す（過去に PAT 流出の経緯あり） |

### 2-2. その根にある考え方

**① 権限の最小化でエージェントを分割する**
役割ごとに `model` と `tools` を絞り、`description` に「いつ起動され、いつ起動されないか」まで書く。
CEO が opus なのに読み取り専用ツールしか持たないのは象徴的で、**判断力とアクセス権を意図的に分離**している。

**② 単一の正本を持ち、口約束を信じない**
承認・モード・進捗は `state.md` のフィールドだけが正本。会話中の言質、エージェントの自己申告、
「もう承認されているはず」という推測はすべて無効。**ファイルの状態だけを信じる。**

**③ 境界を明文化する — 「できないこと」を書く**
各エージェント定義の末尾に「ガードレール」節を置き、相互不可侵を宣言する。
これは AI レビュアーの越権・幻覚判定を防ぐ実践パターンでもあった。

**④ 入口を単純化し、内部を隠蔽する**
ユーザー向けは2コマンドだけ。10レーンは選ばせない。公開面を小さく保つことで内部を自由に進化させる。

**⑤ 強制力の差を隠さない**
「Claude Code は hook があるので強、Codex は指示＋sandbox で中、その他 CLI は指示ベースで弱」と
**正直に表で書く**。`SECURITY.md` は冒頭で「**敵対的に振る舞う LLM に対する本当のセキュリティ境界は
ホスト OS だけ**であり、プロセス内フックは境界ではなくヒューリスティックである」と宣言していた。
過大な安心を与えないことを文書の目的に据えていた点は、この設計の最も誠実な部分である。

---

## 3. 開発史

### 3-1. タイムライン

| 日付 | 出来事 |
|---|---|
| **2026-07-03** | **Initial commit — CCC (Claude Code Company)** として誕生。マルチエージェント・オーケストレーション |
| 2026-07-07 | 制御プレーン Phase 1。複数repo進行 × サブスク枠ガバナー × ジョブキュー（7コミット） |
| **2026-07-11** | **"unify into AGENT ALL IN ONE"** — 66スキル・4リングセキュリティ・memory/observability/catalog を統合。**同じ日に**ライブハーネス、model-router、skill-router、codex-router、監査ログ、auto-delegate advisor、front-door、ハード強制 enforcer、専門8エージェント、harden レーンを全部追加（15コミット） |
| **2026-07-12** | **47コミット — 開発のピーク。** P0〜P4 の Issue バッチを一気に消化。eval ハーネス、キュー堅牢化、ジョブ観測性、repo単位メモリ、失敗パターンDB、通知、Forge 第1〜3弾 |
| 2026-07-13 | 19コミット。**CCC → 2AIO へ全面リブランド**。10スラッシュコマンドを**2モードに集約**しレーンを内部化。インストーラにマニフェスト方式の更新機構。取締役会を5役員→**3役員に縮小**（CFO・CSO 削除）。私物の絶対パスを配布物から全排除 |
| **2026-07-14** | **41コミット。** Linear 連携を全削除（GitHub 一本化）、監査指摘バッチ p2/p3/p4、Wave A/B/C セキュリティ強化（秘密の墨消し、サーキットブレーカ、env スクラブ、webhook SSRF ガード、スキル整合スキャナ） |
| 2026-07-15 | 2コミット。新規ビルドにもデザインレビューゲートを追加 |
| 2026-07-18 | 1コミット。設計思想ドキュメントを nyo-n-knowledge から移設 |
| 2026-07-19 | 1コミット。`chore: snapshot before archiving (ikki-life consolidation)` — **この時点で既にアーカイブが意識されていた** |
| 2026-07-25 | 1コミット（マージ）。**以後、開発停止** |
| **2026-08-01** | 全実装を `_archive/` へ退避。本ファイルを作成 |

### 3-2. 速度の記録

- 総コミット **136本**、期間 **22日間**
- うち **124本（91%）が 7月11日〜15日の5日間**に集中
- ピークの 7月12日は**単日47コミット**
- コミット者は全て同一人物 + Claude（`itiwoja` 99 / `IKKI MURAKAMI` 28 / `Claude` 9 / `村上壱基` 2）

**5日間で 561ファイル・4サブシステムが組み上がった。**

### 3-3. 縮小方向の変更も繰り返されていた

肥大の一方で、**削る判断も何度も下されていた**点は記録しておく価値がある。

| 削除 | 日付 | 理由 |
|---|---|---|
| 取締役会 5役員 → 3役員（CFO・CSO 削除） | 07-13 | 過剰な役割分割 |
| 10スラッシュコマンド → 2モード | 07-13 | 公開面の単純化 |
| Linear 連携を全削除 | 07-13〜14 | Issue 駆動を GitHub 一本化 |
| Gemini 廃止の伝播 | 07-14 | 上流の提供終了 |
| 未使用 export の削除（`claudeReady()` / `briefToBuildPrompt()`） | 07-14 | デッドコード除去 |

つまり **「作りすぎ」と「削る」が同時に走っていた。** 削る速度が作る速度に追いつかなかった。

---

## 4. 検証で判明した実態（2026-08-01 実測）

アーカイブ前に、このマシン上での稼働実績を全て実測した。結果は明快だった。

### 4-1. 一度もインストールされていない

| 期待されるもの | 実測 |
|---|---|
| `~/.claude/2aio/lanes/`（レーン配備先） | **存在しない** |
| `~/.claude/2aio/scripts/` | **存在しない** |
| `~/.claude/commands/`（`/2aio-create` の実体） | **存在しない** |
| `~/.claude/agents/` | **存在しない** |
| `~/.claude/.2aio-manifest`（skill 管理台帳） | **存在しない** |
| `~/.claude/skills/` の中身 | 自作10個のみ。**2AIO の72スキルは1つも無い** |
| `~/.claude/settings.json` | 207バイト・`hooks` キー無し → **guard / enforcer / advisor 4種は一度も発火していない** |
| `~/.claude/logs/` | **存在しない** |

`install.sh` も `harness/install-harness.sh` も、このマシンでは実行された形跡が無い。

### 4-2. サーバー群も一度も走っていない

ランタイム生成物が**すべて未生成**だった。

| ディレクトリ | 生成主体 | 実測 |
|---|---|---|
| `runs/` `proposals/` `vault/` | `run.mjs`（Forge） | 無し |
| `control/` `workspaces/` `repos.json` | `control.mjs`（制御プレーン） | 無し |
| `history/` `eval/results/` | 各サブシステム | 無し |

1回でも起動していれば残るファイルが、1つも残っていない。

### 4-3. ドキュメントと実体の乖離

| ドキュメントの記述 | 実測 |
|---|---|
| README「66 スキル」 | **72個** |
| README「orchestration 8個」 | **12個** |
| README「専門8体が description に PROACTIVELY を持ち自動起動」 | `PROACTIVELY` を持つのは **3体のみ** |
| README「model / skill ルーティング … launch 時に実切替」 | advisor 経路は切替不能。launch 経路と hook 経路が1行に混ざっていた |
| `tui/`（15ファイル 1,570行 + 独自 lockfile） | **どこからも参照されていない完全な孤児** |
| `skills/design-references/`（5ファイル 1,121行） | `SKILL.md` が0個 → 両インストーラの必須チェックで**構造的に配備されない** |
| `2aio-migration-runner` / `2aio-release-manager` | 明示参照ゼロ かつ `PROACTIVELY` なし ＝ **起動経路が存在しない** |

### 4-4. なぜ止まったのか

証拠から言えることは1つに集約される。

> **実装速度が検証速度を追い越した。**

- 5日間で4サブシステムを積み上げたが、**一度も配備していない**ため、実使用からのフィードバックが
  設計にまったく戻ってこなかった
- 7月12日と14日の「監査指摘バッチ p0〜p4」「Wave A/B/C セキュリティ強化」は、
  **一度も動いていないコードのバグを修正する作業**だった。品質は上がったが、その品質が
  誰かの役に立ったかを確かめる手段が無かった
- ドキュメントが常に実装の先を走っていた（66 vs 72、PROACTIVELY 8体 vs 3体）。
  これは怠慢ではなく、**書いた時点では正しかったものが、次の日の47コミットで置き去りにされた**結果である
- 4つのサブシステムはそれぞれ独立して価値があったが、**互いを必要としていなかった**。
  制御プレーンは資産パックを呼ぶだけ、Forge はどれとも繋がらず、skills は他者のコード。
  1リポジトリに置く必然性が最後まで無かった

**設計思想そのものに欠陥があったわけではない。**
権限最小化・単一正本・境界の明文化・強制力の正直な開示は、いずれも今も正しい。
失敗したのは思想ではなく、**思想を検証可能な最小単位で確かめる前に全部作ったこと**である。

---

## 5. 残す価値のある知見

他プロジェクトへそのまま転用できるもの。

**① 状態ファイルを唯一の正本にする**
承認・モード・進捗はファイルのフィールドだけを信じ、チャット中の発言を一切信用しない。
常駐エージェント全般に効く。「口約束ではなくファイル/DBの状態だけを信じる」設計。

**② エージェントは権限の最小化で分割する**
役割ごとに model/tools を絞る。CEO に opus を与えつつ書き込みツールを与えない、というような
**判断力とアクセス権の意図的な分離**。「計画者は DB 操作禁止」「実行者は仕様変更禁止」という
相互不可侵の宣言は小規模なマルチエージェントでも有効。

**③ 「できないこと」を定義に書く**
各エージェントの末尾に「やらないこと」節を置く。AI レビュアーの越権と幻覚判定を実際に減らす。

**④ ゲートは1箇所に置き、重複させない**
セキュリティスキャンは devops Step 2.5 の一箇所だけ、と決める。
複数のレビュアーがいるなら「受け入れ条件」「コード品質」「セキュリティ設計」「機械的スキャン」を
表で明確に分離し、重複起動を禁止する。

**⑤ 強制力の差を正直な表で書く**
「hook がある host は強、無い host は弱」と明記する。`SECURITY.md` の
「プロセス内フックは境界ではなくヒューリスティックである」という宣言は、
セキュリティ文書が持つべき誠実さの見本。

**⑥ 委譲には計画を必須にする**
`codex-run.sh` が `.ai/codex_brief_*.md` の無い委譲を**拒否**した設計。
「計画してから投げよ」を推奨ではなくゲートにすると、計画が確実に存在するようになる。

**⑦ ポータブルパスチェック**
`git grep` で `/Users/<name>` `/home/<name>` や開発者個人名を検出し、配布前の個人情報漏洩を防ぐ
40行のスクリプト（`check-portable-paths.mjs`）。プレースホルダ許可リストで誤検知を抑制。
依存ゼロでどのプロジェクトにも流用できる。

**⑧ そして最大の教訓 — 作る前に、動かす**
配備1回・実使用1回を挟まずに次の層を積まない。
**「動いていないコードの品質を上げる作業」は、進捗に見えるが進捗ではない。**

---

## 6. アーカイブの地図

`_archive/` の中身と、それぞれの復旧価値。

| パス | 規模 | 復旧価値 |
|---|---|---|
| `agents/` | 25ファイル 2,037行 | **高**。権限最小化の設計例として単体で読む価値がある |
| `lanes/` | 10ファイル 1,733行 | **高**。特に `2aio-implement-project.md`(424行) `2aio-build.md`(210行) |
| `commands/` | 2ファイル 67行 | **高**。入口の単純化の実例 |
| `harness/hooks/` `harness/enforce/` | guard + enforcer | **高**。実際にブロックする唯一の部品 |
| `harness/codex-router/` | 委譲の実体 | 中。brief 必須ゲートの実装が参考になる |
| `harness/{model,skill,front-door}-router/` | advisor 3種 | 低。推奨文の注入のみ |
| `control.mjs` + `lib/` | 約2,200行 | 中。ccusage 連動のトークン予算ガバナーは再利用可能 |
| `run.mjs` + `dashboard.mjs` | 約660行 | 低。Ollama 前提の自己強化ループ。一度も稼働せず |
| `test/` | 19ファイル 1,868行 | 中。`lib/` を復活させる場合のみ |
| `skills/` | 386ファイル 76,300行 18MB | 低。**全て他者の OSS**。上流から取り直せる（出典は `skills/SOURCES.md`） |
| `tui/` | 15ファイル 1,570行 | なし。参照ゼロの孤児 |
| `catalog/` `memory/` `observability/` `adapters/` | 208行 | なし。未統合ツールの紹介 README |
| `check-portable-paths.mjs` | 40行 | **高**。単体でどのプロジェクトにも流用できる |
| `ARCHITECTURE.md` `AGENTS.md` `SECURITY.md` | — | **高**。本ファイルの元。原文にあたる価値がある |
| `DIET-PLAN.md` | — | 中。アーカイブ前の詳細な依存関係調査記録 |

---

## ライセンス

2AIO 本体: MIT（`LICENSE`）。
`_archive/skills/` に含まれる各スキルは各アップストリームのライセンス（大半 MIT、一部 Apache-2.0 / Elastic-2.0）に従う。
出典の完全な索引は `_archive/skills/SOURCES.md`、各スキルの `SOURCE.md`。
