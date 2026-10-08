set windows-shell := ["cmd.exe", "/c"]

cargo_manifest := "src-tauri/Cargo.toml"

[private]
default:
    @just --list --unsorted

# 要 lefthook (macOS は Homebrew、Windows は WinGet などで入れる)
[doc('push 前に整形を確かめるフック (lefthook) を入れる')]
[group('セットアップ')]
hooks-install:
    lefthook install

# 起動時にはウィンドウを出さないので、ホットキーで表示する。ログイン時の自動起動は登録しない
[doc('開発版を起動する')]
[group('開発')]
dev:
    pnpm tauri dev

# D1 は手元のもの (account-server/.wrangler) を使い、メールは送らずリンクをログに出す
[doc('窓口 (account-server/) を手元で起動する')]
[group('開発')]
dev-account-server:
    cd site && pnpm run build
    cd account-server && node -e "require('fs').existsSync('.dev.vars') || require('fs').copyFileSync('dev.vars.example', '.dev.vars')"
    cd account-server && pnpm exec wrangler d1 migrations apply DB --local
    cd account-server && pnpm exec wrangler dev --ip 127.0.0.1 --port 8787 --local-upstream 127.0.0.1:8787 --var MAIL_LOG_ONLY:1

[doc('コードを整形する (cargo fmt・prettier)')]
[group('開発')]
fmt:
    cargo fmt --manifest-path {{ cargo_manifest }}
    pnpm run format
    cd account-server && pnpm run format

# CI (.github/workflows/ci.yml) が PR ごとに macOS と Windows で流す
[doc('CI と同じ検査をまとめて流す (整形・lint・型検査・生成物・テスト)')]
[group('検査')]
ci: fmt-check lint check licenses-check pinned-deps-check test bindings-check account-server-check site-check

[doc('Rust の整形の崩れを見る (書き換えない)')]
[group('検査')]
fmt-check:
    cargo fmt --manifest-path {{ cargo_manifest }} --check

[doc('lint を流す (clippy・prettier・eslint)')]
[group('検査')]
lint:
    cargo clippy --manifest-path {{ cargo_manifest }} --all-targets -- -D warnings
    pnpm run lint

# Rust 側の型検査は lint の clippy が兼ねる
[doc('画面の型検査を流す (svelte-check)')]
[group('検査')]
check:
    pnpm run check

# cargo test は画面との境目の生成物 (src/lib/bindings) を書き出す。
# 型を消したときに古い生成物が残らないよう、書き出す前に消す
[doc('テストを流す (cargo test・vitest)')]
[group('検査')]
test:
    node -e "require('fs').rmSync('src/lib/bindings', { recursive: true, force: true })"
    cargo test --manifest-path {{ cargo_manifest }}
    pnpm run test

[doc('cargo test が書き出す、画面との境目の型と定数 (src/lib/bindings) が最新か見る')]
[group('検査')]
bindings-check:
    node scripts/check-generated.mjs test src/lib/bindings

[doc('Tauri の側と揃えている Rust の依存の版が揃っているか見る')]
[group('検査')]
pinned-deps-check:
    node scripts/check-pinned-deps.mjs

# 依存を変えたら `just licenses` の結果をコミットする
[doc('Rust の依存のライセンス表示が最新か見る')]
[group('検査')]
licenses-check: licenses
    node scripts/check-generated.mjs licenses static/third-party-licenses/rust.json

# 初めてのときは先に `cd account-server && pnpm install`
[doc('窓口 (account-server/) を検査する (整形・生成した型・型検査・テスト)')]
[group('検査')]
account-server-check:
    cd account-server && pnpm run lint
    cd account-server && pnpm exec wrangler types --check
    cd account-server && pnpm run check
    cd account-server && pnpm run test

# 初めてのときは先に `cd site && pnpm install`
[doc('紹介と規約類 (site/) を検査してビルドする')]
[group('検査')]
site-check:
    cd site && pnpm run check
    cd site && pnpm run build

# tauri-driver + WebdriverIO。配る物そのものを試すため、
# 既定では just bundle でビルドし直してから回す (e2e/run.mjs が、画面を点けたままビルドとテストを続けて行う)。
# --no-build を付けるとビルドだけを飛ばし、前に作った実行ファイルで回す (例: just e2e --no-build tray)。
# 引数でテストファイルを選べる (例: just e2e draft-clipboard)。省略すると全部回す。
# tauri-driver と msedgedriver が要るため just ci には含めない。機能がまとまったときに手動で回す運用。
# 詳細は e2e/README.md を参照
[doc('Windows の E2E を流す (引数でテストファイルを選べる)')]
[group('実機の確認')]
[windows]
e2e *tests:
    cd e2e && node run.mjs {{ tests }}

# ログイン時の起動・ファイアウォール・通知・タスクバーのアイコン・データの置き場所を見る。
# just msix で作り直した MSIX を常用版と入れ替え、パッケージの中から起動して見る (e2e/msix-run.mjs)。元から MSIX 版が入っていれば、試した版が常用版として残る。
# --no-build を付けると作り直さない。引数でテストファイルを選べる (例: just msix-check msix)。詳細は e2e/README.md の「MSIX 版の確認」を参照
[doc('MSIX 版だけの作りを確かめる (常用版と入れ替わる)')]
[group('実機の確認')]
[windows]
msix-check *args:
    cd e2e && node msix-run.mjs {{ args }}

# アクセシビリティで常用の /Applications/Mawok.app を動かす。ビルドはしない。
# 引数でテストファイルを選べる (例: just macos-check draft)。キーボードとフォーカスを使い、
# 設定・履歴・クリップボードは控えて戻す。詳細は e2e/README.md の「macOS の確認」を参照
[doc('macOS の自動の確認を流す (常用の Mawok.app を動かす)')]
[group('実機の確認')]
[macos]
macos-check *tests:
    cd e2e && node macos-run.mjs {{ tests }}

# DMG を開いたときのアイコンの並びを整えるには AppleScript で Finder を操作し、
# ターミナルに Finder のオートメーション許可が要る (ないと DMG の作成が失敗する)。Tauri は CI=true のときにこの操作を飛ばす。
[doc('配布用にビルドする')]
[group('ビルド')]
[macos]
bundle:
    CI=true pnpm tauri build

[doc('配布用にビルドする')]
[group('ビルド')]
[windows]
bundle:
    pnpm tauri build

# 出力は src-tauri/target/release/bundle/msix/Mawok_<版>_x64.msix、要: Windows SDK。
# 試しに入れるための自己署名の証明書で署名する。証明書は先に src-tauri/msix/new-test-cert.ps1 で作っておく
# (→ docs/platform.md「Windows の MSIX 版」)。Store に上げる版は `just msix --unsigned` で、署名せずに作る
[doc('Microsoft Store 向けの MSIX を作る')]
[group('ビルド')]
[windows]
msix *args:
    pnpm tauri build --no-bundle
    node scripts/msix.mjs {{ args }}

# build でユニバーサル版を署名・公証し、確認先の JSON と一緒に src-tauri/target/release-mac/<版>/ に並べる。
# 版の番号の変更を main に入れてから、main で publish を流す。GitHub Releases に上げ、JSON を site/ に置いて窓口ごと置き直す。
# 要: Developer ID の証明書と環境変数 TAURI_SIGNING_PRIVATE_KEY・APPLE_ID (→ docs/platform.md「Mac 版の配る版」)
[doc('Mac 版の配る版を作る (build) ・出す (publish)')]
[group('ビルド')]
[macos]
release-mac step:
    node scripts/release-mac.mjs {{ step }}

# デスクトップ専用なので Android・iOS 用は消す
[doc('アイコンを src-tauri/assets の SVG から作り直す')]
[group('生成')]
icons:
    pnpm tauri icon src-tauri/assets/app-icon.svg
    # MSIX 版のタスクバーのアイコン。Microsoft の文書が Required とする大きさの全部 (scripts/msix.mjs が並べる)
    pnpm tauri icon src-tauri/assets/app-icon.svg --png 16,20,24,30,32,36,40,48,60,64,72,80,96,256 -o src-tauri/icons/msix
    pnpm tauri icon src-tauri/assets/tray.svg --png 32 -o src-tauri/icons/tray
    pnpm tauri icon src-tauri/assets/tray-template.svg --png 36 -o src-tauri/icons/tray-template
    pnpm tauri icon src-tauri/assets/tray-received.svg --png 32 -o src-tauri/icons/tray-received
    pnpm tauri icon src-tauri/assets/tray-template-received.svg --png 36 -o src-tauri/icons/tray-template-received
    node -e "for (const dir of ['android', 'ios']) require('fs').rmSync('src-tauri/icons/' + dir, { recursive: true, force: true })"

# 要: cargo-about。→ docs/third-party-licenses.md「第三者のソフトウェア」
[doc('配布物に入る Rust の依存のライセンス表示を作る')]
[group('生成')]
licenses:
    node scripts/generate-rust-licenses.mjs
