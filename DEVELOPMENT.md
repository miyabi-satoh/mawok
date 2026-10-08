# 開発

## 技術スタック

- アプリ: Tauri 2 + SvelteKit（静的出力の SPA）+ Tailwind CSS 4 + shadcn-svelte + Paraglide JS（日本語 / 英語）
- 窓口（`account-server/`）: Cloudflare Workers + Hono + D1
- 紹介・規約類（`site/`）: Astro。窓口と同じ Worker の静的アセットで出す

ディレクトリ:

- `src/`: テキストウィンドウと設定の画面（SvelteKit）
- `src/lib/bindings/`: 画面との境目の型・定数・イベント名。Rust 側から `cargo test`（`just test`）が書き出す生成物なので、手で直さない。境目の型や定数を変えたら、書き出し直した結果もコミットする。
- `messages/`: 画面の文言（Paraglide JS）
- `src-tauri/`: 常駐、ホットキー、クリップボード、フォーカス復帰などのネイティブ側（Rust）。トレイメニューとエラーの文言は `src-tauri/src/i18n.rs` で翻訳する。
- `src-tauri/assets/`: アイコンの元の SVG。アプリのアイコン、タスクトレイ用、macOS のメニューバー用（モノクロ）がある。変えたら `just icons` で `src-tauri/icons/` を作り直す。
- `e2e/`: Windows 向けの E2E テスト（`tauri-driver` + WebdriverIO）と、macOS の自動の確認（`e2e/macos/`。アクセシビリティで動かす）。依存はここだけ別に持つので、`e2e/` で `pnpm install` を流して入れる。

技術の説明:

- [アクションの実行](docs/actions.md)
- [同じ LAN の自分の機器へ送る](docs/lan.md)
- [設定ファイル](docs/config.md)
- [OS ごとの作り](docs/platform.md)
- [第三者のソフトウェア](docs/third-party-licenses.md)
- [窓口（mawok.amiiby.com）](docs/account-server.md)

## セットアップ

必要なもの:

- [Tauri 2 の前提環境](https://v2.tauri.app/start/prerequisites/)（Rust と、OS ごとのビルドツール）
- Node.js と pnpm
- [cargo-about](https://github.com/EmbarkStudios/cargo-about)（`cargo install --locked cargo-about@0.9.2 --features cli`。`just ci` の中でライセンス表示を作り直すのに使う）
- [just](https://github.com/casey/just) と [lefthook](https://github.com/evilmartians/lefthook)

```sh
pnpm install
(cd account-server && pnpm install) && (cd site && pnpm install)   # 窓口と紹介・規約類 (just ci が検査する)
just hooks-install   # push 時に整形を確かめるフックを入れる
pnpm exec playwright install chromium   # 画面の部品テストで使うブラウザーを入れる
```

## 開発

```sh
just dev        # 開発版を起動する（起動時にはウィンドウを出さないので、ホットキーで表示する）
just fmt        # Rust（cargo fmt）と画面側（Prettier）をまとめて整形する
just ci         # CI と同じチェック一式（整形の確認・lint・型チェック・ライセンス表示が最新か・テスト・画面との境目の生成物が最新か）
just licenses   # Rust の依存のライセンス表示を作り直す（依存を変えたとき。要: cargo-about）
```

開発版では、ログイン時の自動起動を登録しません。

## テスト

`just test`（`just ci` にも含まれます）で次の3つを実行します。

- Rust の単体テスト（`cargo test`）: 文字列の加工、設定ファイルの読み書き、ウィンドウの位置決めなど。
- 画面のロジックのテスト（vitest の `node` プロジェクト）: キーの判定など、DOM の要らないもの。
- 画面の部品のテスト（vitest の `client` プロジェクト）: Chromium（Playwright）で実際に描いて操作する。`pnpm exec playwright install chromium` が要ります。

Windows では、これらに加えて E2E テスト（`just e2e`）があります。`tauri-driver` + WebdriverIO で、`just bundle` でビルドしたリリース版そのものを操作し、ホットキー・フォーカスの戻り・貼り付け・IME・トレイ・設定・画面の描かれ方などを通しで見ます。何を見ているかは `e2e/tests/` の各ファイルにあります。全部を回すと、ビルドし直す分を入れて15分ほどかかります。`just e2e draft-clipboard` のように回すテストファイルを選べ、コードを変えずに続けて回すときは `just e2e --no-build` でビルドを飛ばせます。始めるときに画面が点いていてロックされていなければ、その後は画面を点けたままにするので、離席してもかまいません（始めるときに画面が消えているかロック中なら、テストを始めずに失敗します）。`tauri-driver` と `msedgedriver` が要るので `just ci` には含めず、機能がまとまったときに手で回します。macOS は WKWebView に外部ドライバーがなく `tauri-driver` を直接使えないため対象外です。前提と注意点は [e2e/README.md](e2e/README.md) にあります。

MSIX 版だけの作り（StartupTask でのログイン時の起動、ファイアウォールの規則、通知の差出人、タスクバーのアイコンの下地、設定とログの置き場所とアンインストールでの消え方）は、`just msix-check` で見ます。`just msix` で作り直した MSIX を常用版と入れ替えて入れ、パッケージの中から起動して、画面と同じコマンドを送り、結果をレジストリ・エクスプローラー・通知の履歴・タスクバーの画素などで読みます。ビルドし直す分を入れて5分ほどです。元から MSIX 版が入っていれば、終わると試した版が常用版として残ります（入っていなければ外します）。詳しくは [e2e/README.md](e2e/README.md) の「MSIX 版の確認」にあります。

macOS では、OS ごとに作りが分かれているところの macOS の側（フォーカスの戻り、クリップボードへの書き込み、ほかのアプリのクリックで隠れること、初めての起動など）を、`just macos-check` がアクセシビリティで確かめます。ビルドはせず、入れてある `/Applications/Mawok.app` を動かします。キーボードとフォーカスを使い、設定・履歴・クリップボードは控えて戻します。回す端末にアクセシビリティの許可が要ります。詳しくは [e2e/README.md](e2e/README.md) の「macOS の確認」にあります。

## ビルド

```sh
just bundle   # 配布用にビルドする（macOS の DMG は、開いたときのアイコンの並びを整えない）
```

## 配布

```sh
# Windows で、Microsoft Store 向けの MSIX を作る（要: Windows SDK と、試しに入れるための証明書。→ docs/platform.md「Windows の MSIX 版」）
just msix

# macOS で、署名・公証したユニバーサル版を作り、GitHub Releases に出す（要: Developer ID の証明書と更新の鍵。→ docs/platform.md「Mac 版の配る版」）
just release-mac build
just release-mac publish
```

## デプロイ

窓口（`account-server/`）と紹介・規約類（`site/`）は、同じ Cloudflare Worker で出す（→ [窓口](docs/account-server.md)）。コマンドは `account-server/` で打つ。

- 手元で動かす: `just dev-account-server`。メールは送らず、サインインのリンクをログに出す。
- 本番に置く: `pnpm run deploy`（`site/` をビルドしてから置く）。
- staging に置く: `pnpm run deploy --env staging`（`site/` をビルドしてから置く）。
- 秘密の値: `pnpm exec wrangler secret put <名前>`（staging は `--env staging` を付ける）。
- 表を変えたら、置く前に `pnpm exec wrangler d1 migrations apply DB --remote`（staging は `--env staging` も）。

## 設定とデータの置き場所

設定ファイルの形と置き場所は [設定ファイル](docs/config.md)、Microsoft Store（MSIX）版の置き場所は [OS ごとの作り](docs/platform.md)「Windows の MSIX 版」にあります。

## その他のコマンド

```sh
just   # コマンドの一覧
```
