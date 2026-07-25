---
description: 2AIO 高速レーン。取締役会・PRD・WBS なしで spec→デザイン方針→実装→QA→公開を最短で通す
argument-hint: <作るもの> [--auto] [--local] [--platform=vercel|firebase|gh-pages] [--stack=html|next|spa]
---

> **表記の読み替え:** 本文中の `/2aio-<name>` は旧スラッシュコマンド表記。`~/.claude/2aio/lanes/2aio-<name>.md` を Read し、後続テキストを $ARGUMENTS としてその指示に従う意味に読み替える。

「いつもの実装」用の **2AIO 高速レーン**。取締役会・PRD・WBS・コスト試算を行わず、最短で「作って・検証して・公開」まで通す軽量オーケストレーターです。

> `output/` の正本は環境変数 `TWOAIO_OUTPUT_DIR`（設定時のみ）。未設定なら対象プロジェクト直下の `output/` を使う。以下の `output/{project}/...` は全てこの配下を指す。

**作るもの:** $ARGUMENTS

## 引数

```
/2aio-build {作るもの} [--auto] [--local] [--platform=vercel|firebase|gh-pages] [--stack=html|next|spa] [--finish=deploy|pr|commit]
```

| パターン | 意味 |
|---|---|
| `{作るもの}` | 1行のテーマ（例: 「水を飲んだ量を記録するPWA」） |
| `--auto` | fail-forward（既定は interactive）。デプロイ承認のバイパスは、起動時に「auto モードはデプロイ承認をバイパスします。よろしいですか?」と 1 回確認して肯定を得た場合のみ `auto_approve: true`。それ以外は false（--local 時は確認せず false のまま — 公開しないので不要） |
| `--local` | 公開せずローカルプレビュー手順まで（外部公開しない） |
| `--platform=` | 公開先（既定: gh-pages） |
| `--stack=` | 技術（既定: html＝単一HTML/PWA） |
| `--finish=` | 終端（既定: deploy＝従来どおり公開）。`pr` = devops platform=pr で Step 2.5→push→gh pr create・pr_url 記録。`commit` = ローカルコミット（ブランチ `2aio/build-{project}`）までで完了・push しない |
| `resume {project}` | `output/{project}/state.md` から再開 |

## 役割と絶対制約

2AIO の **軽量実装パイプライン**。`2aio-engineer → 2aio-qa → 2aio-devops` を最小手数で回す。

```
重量フロー: /2aio-start-project → /2aio-plan-project → /2aio-implement-project （取締役会つき）
高速フロー: /2aio-build （取締役会なし・スペック1枚→実装→QA→公開）
```

- **本コマンドはコードを書かない**（実装は 2aio-engineer）。
- **市場/戦略/財務調査・PRD・人日工数・コスト試算・スプリント分割は行わない**（冗長排除の核）。
- **リサーチサブエージェント（2aio-r-*）は使わない**。
- 状態は `output/{project}/state.md` を正本とし resume 可。
- **絶対の安全線（モード問わず）:** ハードコード秘密検出 / 対応外プラットフォーム / state.md I/O 障害。

## 実行フロー

### Phase 1: 軽量スペック（コード生成なし）
テーマから「スペックカード」を1枚生成する。重い調査はしない。Claude 本体が直接生成してよい（エージェント起動不要）。

`output/{project}/spec.md` に保存:

```markdown
---
project: {略称}
type: spec
stack: {html|next|spa}
platform: {gh-pages|...}
created_at: {ISO 8601}
---
# Spec: {作るもの}
## 目的
{1〜2行}
## 主要機能
- {3〜7個の箇条書き}
## 技術
- {単一HTML / localStorage / 必要ライブラリ等}
## 受け入れ条件（QAの正本）
- [ ] {検証可能な条件をいくつか}
## スコープ外（やらないこと）
- {今回やらない範囲}
```

`project` 略称はテーマから生成（例: water-log）。`output/{project}/` を作成。

### Phase 1.5: デザイン方針 ★必須（路線選択 → トークン確定）
実装前に「設計路線を1つ選ぶ → トークン確定」を必ず行う。これを飛ばして実装に入らない。

#### 1. 設計路線を1つ選ぶ
| 路線 | 参照スキル | 向くアプリ |
|---|---|---|
| A. オリジナル個性 | `anti-ai-design` | 遊び・ブランド感・写真主役（コラージュ/エディトリアル/和インク/水彩/大人可愛い 等から1つ具体化） |
| B. Material 3 | `material-design-3` | Android的・体系的・動的カラー |
| C. Apple HIG | `apple-hig` | iOS/Apple的・上品・コンテンツ主役 |
| D. デジタル庁 DADS | `digital-agency-design-system` | 日本語・公共/行政・万人向け堅実 |

- **interactive**: 題材に合う推奨1つ＋他を短く提示し、ユーザーに選んでもらう（テーマに雰囲気指定があればそれを優先）。
- **auto**: テーマに最適な路線を自動選択し、理由を design.md に記す。

#### 2. 選んだ路線スキルを読み、トークンを確定 → `output/{project}/design.md` に保存
紙/地色・文字色・アクセント・フォント2種・角丸/影・テクスチャ・「色は何に担わせるか」。各スキルのトークン/CSSをそのまま使う。
- **路線A（anti-ai-design）の場合は `anti-ai-design/references/` の該当レシピカード（12路線: editorial / neo-brutalism / swiss / luxury / retro-future-y2k / riso-zine / japanese-modern / watercolor-craft / otona-kawaii / collage-scrapbook / tech-minimal / organic-natural）を必ず読み、その色値・書体名を使う**（即興しない）。

#### 2.5. ★常時必須: 構図を1つ選ぶ（`layout-composition`）
路線（色・書体）とは独立に、**構図**（ベント/エディトリアル/broken grid/ヒーローの型/余白リズム/スクロールテリング/大型タイポ）を1つ選んで design.md に記録。「均一カードグリッド＋中央寄せヒーロー」への収束を構造で止める。1画面1主役。

#### 3. ★常時必須: アクセシビリティ（`wcag-accessibility`・目標 AA）
**路線に関わらず必ず適用**: コントラスト 4.5:1（UI/大文字 3:1）・キーボード全操作・`:focus-visible`・タップ標的 最小24px(推奨44)・`lang` 指定・`prefers-reduced-motion`・適切な aria/ラベル。design.md に「アクセシビリティ方針: WCAG AA」と明記。

#### 4. ★常時必須: 量産感回避（`anti-ai-design`）
B/C/D を選んでも **`anti-ai-design` を併用**して「デフォルト感」を消す（シード色を既定から変える／見出しを別書体／シェイプ・余白で“顔”を作る）。**純黒・純白・紫青グラデ・デフォルトフォント無加工は禁止**。

（記録は Phase 2 の state.md 初期化時にまとめて行う）。**このトークンが Phase 3 の正本**。

### Phase 2: state.md 初期化（簡易）
```markdown
---
project: {略称}
phase: implementing
mode: {auto|interactive}
auto_approve: {true|false}
local: {true|false}
stack: {...}
platform: {...}
spec_file: output/{project}/spec.md
deploy_approved: false
current_task: null
tasks_completed: 0
tasks_failed: 0
deployed_url: null
created_at: {ISO 8601}
updated_at: {ISO 8601}
tags: [2aio, build, {略称}]
---
# State: [[{略称}]]
## 次のアクション
- 2aio-engineer 実装
## タイムライン
| 時刻 | フェーズ | イベント |
|---|---|---|
| {ISO} | spec | spec.md 生成 |
| {ISO} | design | design 方針確定（路線: {路線名}） |
```

### Phase 3: 実装（2aio-engineer）
入力: `spec.md` ＋ **`design.md`（デザイン正本）** ＋ `state.md`。出力: 実装コード ＋ `output/{project}/build-log.md`。
- spec の受け入れ条件・スコープを厳守（スコープ外は作らない）。
- **design.md のトークンを厳守**（紙/文字色・アクセント・フォント2種・テクスチャ・角丸/影/傾き）。CSS変数に落として全要素が参照。純黒/純白/紫青グラデ・デフォルトフォント無加工は禁止。
- engineer 起動プロンプトに **design.md 全文 ＋ 選んだ路線スキル名（anti-ai-design / material-design-3 / apple-hig / digital-agency-design-system。路線Aはレシピカードのパスも）＋ layout-composition（選んだ構図）＋ modern-css ＋ wcag-accessibility** を渡し、次を自己確認してから完了報告させる:
  - **modern-css の採用判断マトリクス**（Baseline外機能は @supports ゲート／`opacity:0` をベーススタイルに置かない／clamp()の固定部はrem／text-wrap: balance・pretty は無条件で入れる）
  - **layout-composition の出力前チェック**（1画面1主役・非対称は12カラム上で・余白2段階以上・モバイルは再構図）
  - 路線スキルの「出力前チェックリスト」
  - **wcag-accessibility の出力前チェック（AA：コントラスト・キーボード・focus-visible・標的24px+・lang・reduced-motion・ラベル/aria）**
  - anti-ai-design の禁則（純黒/純白/紫青グラデ/デフォルトフォント無加工なし／絵文字ロゴなし）
  - **インタラクションの質**: anti-ai-design「気づき→行為→反応」＝**無反応な要素を作らない**（全操作に手応え）／motion-design「5つの黄金律」＝構造(IA)を伝える・Ease-out基調・操作に即時同期フィードバック・行為の重みに応じた反応
- interactive: 詰まったら停止 / auto: fail-forward。
- **修復ラウンド（`--stack=next|spa` のみ・1回）**: engineer が3回自己修正に失敗し、build-log のエラー分類が
  build|type|dep の場合に限り、メインスレッドが ECC `build-error-resolver` を1回だけ起動する
  （既定 stack=html はビルドシステムが無いため本段を起動しない）。修復成功なら engineer を該当タスク限定で
  再起動、失敗なら従来フロー（interactive 停止 / auto fail-forward）へ。

#### Phase 3.5: デザインレビューゲート（実装直後・フロントエンドがある場合のみ・CRITICAL のみブロック）
- Phase 3 完了後、フロントエンド（UI）を含む場合のみ、メインスレッドが `2aio-design-reviewer` を Task で1回起動する。UI を持たない純バックエンド/CLI等は自動スキップ。
- **可能なら実レンダリング（スクリーンショット）を確認させる**（`browser-testing-with-devtools` 等、環境で使えるブラウザ手段があれば使用）。コード読解だけでは検出できない不具合（装飾的タイポグラフィが実データで破綻する・視線誘導の読み順が崩れる等、レンダリングして初めて分かる類）があるため、可能な限りスクショ確認を優先し、確認できなかった場合は出力に「コード読解のみで実施・レンダリング未確認」と明記させる（無言でコード読解のみの判定をスクショ確認と同等に見せない）。
- **CRITICAL のみ** 2aio-engineer 差し戻し（1回）。HIGH 以下は build-log に記録のみで非ブロック（本レーンの高速性を守る）。
- `--local`（非公開プロトタイプ）ではこのゲートをスキップ可。

### Phase 4: 軽量QA（2aio-qa・1往復）
入力: `spec.md`（受け入れ条件正本）＋ 実装コード ＋ `state.md`（モード判定の正本）。
- 受け入れ条件のチェックと明らかな不具合のみ確認（重厚なテスト計画は不要）。
- **省略不可の全体検証（該当ツールチェーンが存在する範囲で。非交渉ゲート）**:
  1. ビルドスクリプトが存在すればビルド exit 0
  2. TS プロジェクトなら `tsc --noEmit` exit 0 ／ lint 設定があれば error 0（warning は記録のみ・非ブロック）
  3. テストが存在すれば全実行
  - 既定 stack=html（ビルド工程なし）では該当ツールがある項目のみ実行。**検出と記録の省略は不可**。
  - 判定は既存モード意味論に従う: interactive は Fail→修正往復→Stuck、auto は DEGRADED 続行可。
    ただし DEGRADED で公開する場合は deploy-report に build/型/lint の未達を必ず明記（新たな絶対の安全線には昇格させない）。
- 本レーンではカバレッジ計測と E2E は任意（spec に明記された場合のみ必須）。
- qa-report は `output/{project}/qa-report.md` 単一で可（Sprint 概念なし）。
- Fail なら 2aio-engineer に1回だけ修正指示 → 再確認。auto は2往復目 Fail で DEGRADED 続行。

#### Phase 4.5: 軽量レビューゲート（QA Pass 後・CRITICAL のみブロック）
- QA Pass 後、メインスレッドが `code-reviewer`（TS なら `typescript-reviewer`）を Task で1回起動する。入力は変更ファイル一覧に限定（全コード読み禁止）。
- **CRITICAL のみ** 2aio-engineer 差し戻し（1回）。HIGH 以下は qa-report に記録のみで非ブロック（本レーンの高速性を守る）。
- `--local`（非公開プロトタイプ）ではこのゲートをスキップ可。
- security-reviewer は起動しない（機械スキャンは devops Step 2.5 / --local 時は Phase 5-pre が担当）。

### Phase 5: 公開（2aio-devops）/ または ローカル

#### Phase 5-pre: 公開前セキュリティゲート ★必須（外部公開時）
**正本ゲートは 2aio-devops の Step 2.5**（devops 起動時に必ず実行される。gitleaks 未導入時のフォールバック規定も Step 2.5 側に定義済み）。本コマンドでは重複実行しない。
- **`--local` で devops を起動しない場合のみ**、`security-review` スキル準拠で本節をメインスレッドで直接実施: (1) gitleaks（未導入なら `git log -p --all | grep -niE "(api[_-]?key|secret|service_role|token|password)\s*[:=]"` で代替） (2) 環境変数 `SECURITY_SCAN_MJS` があれば `node $SECURITY_SCAN_MJS <project>`（無ければスキップ） (3) CSP/frame-busting 確認。
- **ブロック条件（絶対の安全線・auto でも停止）**: gitleaks leak>0 / SAST CRITICAL>0。→ 修正するまで公開しない。
- HIGH/MEDIUM は精査（誤検知＝アプリ定数/blob URL 等なら記録の上で許容、実入力なら esc() を確認）。

#### Phase 5-deploy
- `--local`（state.md の `local: true`。resume 時もこのフィールドで判定し、--local の意図を失わない）: 公開せず、ローカルプレビュー手順（serve＋トンネル等）を提示して完了。セキュリティゲートは Phase 5-pre 準拠でメインスレッドが直接実施（未公開のため結果は記録のみ・ブロックしない）。公開に切り替えるにはユーザーが明示的に指示し、通常の承認手順を踏む。
- それ以外: 2aio-devops で `--platform` にデプロイ（セキュリティゲートは devops の Step 2.5 が実行）。
  - **外部公開は安全線**: interactive はユーザー承認必須 / auto は `auto_approve: true` のとき実行。
  - interactive の承認、および auto かつ `auto_approve` が true 以外の場合の承認は、メインスレッド（本コマンド）がデプロイ計画を提示して取得し、state.md に `deploy_approved: true` / `deploy_approved_at` を記録してから 2aio-devops を起動する（devops 内での対話承認は不可）。
  - **ヘッドレス実行時（対話でユーザーに承認を求められない場合）**: 承認待ちで return する直前に、標準出力へ機械可読マーカー **`[APPROVAL_WAITING] {project}`** を1行出力する（control plane がこれを検知して `waiting_approval` 状態＋通知に変換する。マーカーなしの正常終了は「完了」と区別できない — #15。`2aio-implement-project` Phase 5 と逐語同一の契約）。
  - DEGRADED 完走時は deploy-report に未達の受け入れ条件を明記した上で公開可（fail/stuck はデプロイ不可）。
  - 公開＝外向きアクションのため、auto でも秘密検出時は停止。
  - 公開リポは `.gitignore` で `output/`・`.env`・バックアップJSON を除外。

### Phase 6: 完了
`output/{project}/state.md` を `phase: completed` 更新、`deployed_url` 記録。簡潔に「完成／URL／受け入れ条件の達成状況」を報告。
- **失敗パターン記録（#13）**: build-log / qa-report にタグ付き失敗があれば、/2aio-implement-project Phase 5 と同スキーマで `output/_memory/failures.jsonl` に追記（メインスレッド責務・JSONL追記）。

## モデル指針（コスト最適化）
- サブエージェントのモデルは各 agent frontmatter が正本（実装3体 engineer/qa/devops は sonnet 固定＝セッション継承しない。未指定 agent のみセッション継承。2aio-r-* は haiku 固定だが本レーンでは使わない）。
- Phase 1 スペックと Phase 1.5 デザイン方針は本体セッションで実行される。ルーチン案件はセッションを sonnet のまま使う（opus セッションでの /2aio-build 実行は非推奨）。

## ガードレール
- 取締役会・PRD・WBS・コストを**復活させない**（冗長排除がこのコマンドの存在意義）。
- **Phase 1.5 のデザイン方針（路線選択）は省略しない**。spec だけ作って実装に入らない。
- **wcag-accessibility（AA）と anti-ai-design は路線に関わらず常時適用**（省略不可）。
- **フロントエンドがある場合、Phase 3.5 のデザインレビューゲートを省略しない**（`--local` のみ例外）。コード生成しただけで「見た目が本番品質か」を一度も確認せず完了報告しない。
- **外部公開の前にセキュリティゲート（2aio-devops の Step 2.5。--local 時のみ Phase 5-pre を直接実行）を必ず通す**。gitleaks leak>0 / SAST CRITICAL>0 は絶対の安全線（auto でも停止）。
- 書き込みは Edit 部分更新を基本に。
- 各フェーズ進捗を state.md に追記しつつ簡潔報告。
