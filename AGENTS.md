# AGENTS.md

## プロジェクトルール

- 開発の手順は [DEVELOPMENT.md](DEVELOPMENT.md)、コードだけでは分からない技術の説明は `docs/<テーマ>.md`。
- コミット・PR 本文・issue は公開されるものとして書く (`public-repo-writing` skill)。
- 要件・仕様・運用の決まりはこのリポジトリに置いていない。

## コードの規約

整形・lint・型検査（まとめて `just ci`）が見る項目は書かない。ここには、検査が見ないが、このコードで揃えている書き方を書く。新しく書くときは、似た処理を探してその書き方に合わせる。

### 画面と Rust の境目

- 画面との境目の型・定数・イベント名は Rust 側が持ち、`cargo test`（`just test`）が `src/lib/bindings/` に書き出す（型は ts-rs、定数は `src-tauri/src/bindings.rs`）。`src/lib/bindings/` は手で直さない。境目の型や定数を変えたら、書き出し直した結果もコミットする（`just bindings-check` が見る）。
- 既定のキー・既定のアクションのように両側で要る値は、Rust 側に置いて画面へ渡す。

### OS で分けるコード

- OS ごとの作りは `#[cfg(windows)]`・`#[cfg(target_os = "macos")]` で分ける。片方の OS でしか使わない変数や import は、もう片方で使われないものになり、その OS の clippy で落ちる。分けたコードを変えたら、両方の OS で `just ci` を通す（CI が PR ごとに両方で流す）。

### 文言

- 画面と文書で「テキストウィンドウ」「テキスト」（英語は text window・text）と呼ぶものを、コード（識別子・イベント名・メッセージの ID・E2E のファイル名）では draft と呼ぶ。設定ファイルの項目名と、同じ名前で結ぶ Rust・画面との境目の型（SettingsView）のフィールドは、画面に合わせて text の側にする（`text_window_keys`・`textFontFamily` など）。その値を扱う関数・変数・コマンドは draft のままにする（`draftFontFamily`・`set_draft_text_color` など）。コメント・テストの見出しで設定の項目名や画面の文言を挙げるときは、その名前のとおりに書く。
- 画面の文言は `messages/ja.json`・`messages/en.json`（Paraglide JS）に置く。トレイメニューとエラーの文言は `src-tauri/src/i18n.rs` に置く。
- 日本語の文言（マニュアルの `docs/manual/ja.md` も含む）で、数字（数が入るプレースホルダーを含む）と、その後の単位の間は、半角の空白でなくノーブレークスペース（U+00A0）にする。見えない文字で、書き直すとふつうの空白に戻りやすいので、`src/lib/messages.test.ts` が見張る。

### マニュアル

- 使い方の窓に出すマニュアルは `docs/manual/ja.md`（原典）と `en.md`。動き・文言・設定の項目を変えたら、両方を同じ変更の中で直す（節の数が揃っていることは `src/lib/manual.test.ts` が見る）。
- マニュアルには、使う人が次にすることに要ることだけを、手順を先にして書く。正確でも、仕組み・例外・各社の規約の細目まで書くと情報が多すぎて読まれない。そうした説明は `docs/<テーマ>.md` や、その場で読む画面（AI の了解の画面など）に任せる。
- 画面の文言（「」で囲む名前）は、`messages/*.json` と `src-tauri/src/i18n.rs` の文言に合わせる。
- OS で違う所（キー・メニューバーとタスクトレイ・置き場所・片方の OS だけの説明）は、併記せずに書き分ける。窓は開いた OS の分だけを出す（`src/lib/manual.ts` の `selectPlatform`）。アプリの中のヘルプは開いた OS の書き方だけを出すのが多数派で、読み手が括弧の中を読み替えずに済むため。
  - 文の中は `{macos:…}{windows:…}`。中に波かっこは書けない。片方の OS では何も出さないなら、その側を空にする。
  - 段落・箇条書きの項目・表は、`::: macos` か `::: windows` の行から `:::` の行までで囲む。印の行は字下げしない。
  - どちらの OS で描いても印が残らないことと、節の数が揃っていることは `src/lib/manual.test.ts` が見る。

### 画面

- 入力欄には、原則としてプレースホルダーを置かない。薄い文字で値が入っているように見え、入力済みか未入力かが分かりにくくなるため。欄の意味はラベル（見えるラベル、または `aria-label`）で示す。例外は下書きの入力欄の操作の案内で、使い方を伝える場所がほかにないので意図して置き、色の系統と書体の傾きで入力した文字と見分ける。
- 日本語の文を語の途中で折り返さない（`src/routes/layout.css`）。Windows では `word-break: auto-phrase` で文節の切れ目で折る（効くのは WebView2 だけ）。
  - `text-wrap: pretty` は付けない。WKWebView では段落全体の行の長さを揃えるので、説明文の右端がでこぼこになり、語の途中で切れる所も出る。
  - 部品（shadcn-svelte の nova）が説明文に付ける `text-balance`・`md:text-pretty` も、日本語では外す。行の長さを揃えようとして、右端を空けたまま語の途中で折り返すため。
  - 打っている欄（下書き・設定の入力欄）は、打つたびに行の切れ目が動かないよう、ふつうの折り返しのままにする。

### テストの置き場

共通の「テストの層」（決まりの中身は単体テストで場合ごとに、入口を通すテストは代表1件）を、このリポジトリでは次の置き場で守る。

- 画面の決まりの中身は `src/lib/<名前>.ts` に置き、`src/lib/<名前>.test.ts`（node で動く。DOM や runes が要るものは Chromium で動く `src/lib/<名前>.svelte.test.ts`）で確かめる。画面のテスト（`src/routes/**/*.svelte.test.ts`）と E2E（`e2e/tests/`）は、つながりの代表と、画面でしか決まらないこと（出し分け・フォーカス・キー操作・イベントの流れ）だけを見る。
- 窓口は、`account-server/test/<モジュール>.test.ts` が `src/` の関数の単体テスト、`account-server/test/http/<機能>.test.ts` が HTTP 越しのテスト（機能は `docs/account-server.md` の節）。
- 窓口の入口にかかる守り（トークン・サインイン・CSRF・上限など）は、`account-server/test/http/guards.test.ts` の表で回す。入口を足したら表にも足す（足さないと表のテストが落ちる）。

### 生成物と取得物

- `src/lib/components/ui/` は shadcn-svelte の registry から取得したもので、整形と lint の対象から外している。直すときは、取得し直しで消えないかを考える。
- `src-tauri/icons/` は `just icons` が `src-tauri/assets/` の SVG から作る。
- Rust の依存のライセンス表示（`static/third-party-licenses/rust.json`）は `just licenses` が作る。npm の分はビルドのとき（`scripts/third-party-licenses.ts`）に作り、リポジトリには入れない（→ docs/third-party-licenses.md）。

## レビューの観点

共通の観点に、このリポジトリでは次を足す。

- 仕組み (標準入力・環境変数・シェルの扱いなど)・OS ごとの例外の網羅は、画面の説明文だけでなくマニュアルにも載せず、`docs/<テーマ>.md` に置く。
- 例: アクションの設定の各項目の下に、標準入力・環境変数 `MAWOK_TEXT`・cmd の遅延展開まで書いた説明を出すのは、ロジックが正しくても指摘の対象。

## Codex レビューの依頼

`codex-review` skill の手順で依頼する。依頼文で対象から外す生成物は `src/lib/components/ui/**`・ロックファイル・`src-tauri/icons/**`・`src-tauri/gen/**`。

## マージまでの基本フロー

共通の指示の「git の運用」の流れに、このリポジトリでは次を足す。

- 実機の確認を受けた直しも、二重のレビューに出してから積む。
- push のとき、lefthook の pre-push フック (→ `just hooks-install`) が整形 (`just fmt-check`) を確かめる。
- PR を作ると、GitHub Actions の CI が macOS と Windows で `just ci` を流す。
- OS で分けたコード (`#[cfg(windows)]` だけでなく `#[cfg(target_os = "macos")]` も) の動きを変えた場合と、ユーザーに見える変更 (画面・動き・文言) を含む場合は、push した後、PR をマージする前に、もう片方の OS での E2E・確認を頼む。テストや文書だけの変更では頼まない。
