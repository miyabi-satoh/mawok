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

[doc('コードを整形する (cargo fmt・prettier)')]
[group('開発')]
fmt:
    cargo fmt --manifest-path {{ cargo_manifest }}
    pnpm run format

# CI (.github/workflows/ci.yml) が PR ごとに macOS・Windows・Linux で流す
[doc('CI と同じ検査をまとめて流す (整形・lint・型検査・生成物・テスト)')]
[group('検査')]
ci: fmt-check lint check licenses-check pinned-deps-check test bindings-check

[doc('Rust の整形の崩れを見る (書き換えない)')]
[group('検査')]
fmt-check:
    cargo fmt --manifest-path {{ cargo_manifest }} --check

[doc('lint を流す (clippy・prettier・eslint・文言の括弧と長音・画面の説明文)')]
[group('検査')]
lint:
    cargo clippy --manifest-path {{ cargo_manifest }} --all-targets -- -D warnings
    pnpm run lint
    node scripts/check-parentheses.mjs
    node scripts/check-long-vowel.mjs
    node scripts/check-screen-descriptions.mjs

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

# 依存を変えたら `just licenses` の結果をコミットする。入力 (依存・数え方の設定・作る手順) と結果が
# 前に作ったときのままなら、作り直さずに通す (scripts/rust-licenses-stamp.mjs)
[doc('Rust の依存のライセンス表示が最新か見る')]
[group('検査')]
licenses-check:
    node scripts/check-rust-licenses.mjs

# tauri-driver + WebdriverIO。既定では、インストーラー抜き・LTO なしでビルドし直してから回す
# (e2e/run.mjs が、画面を点けたままビルドとテストを続けて行う)。
# --no-build を付けるとビルドだけを飛ばし、前に作った実行ファイルで回す (例: just e2e --no-build tray)。
# 引数でテストファイルを選べる (例: just e2e draft-clipboard)。省略すると全部回す。
# tauri-driver と msedgedriver が要るため just ci には含めない。機能がまとまったときに手動で回す運用。
# 詳細は e2e/README.md を参照
[doc('Windows の E2E を流す (引数でテストファイルを選べる)')]
[group('実機の確認')]
[windows]
e2e *tests:
    cd e2e && node run.mjs {{ tests }}

# ログイン時の起動・タスクバーのアイコン・データの置き場所を見る。
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

# 引数でテストファイルを選べる (例: just linux-check tray)。キーボードとフォーカスを使い、常用の Mawok・
# ログイン時の起動・クリップボード・ホットキーの割り当てを控えて戻す。詳細は e2e/README.md の「Linux の確認」を参照
[doc('Linux の自動の確認を手元のデスクトップ (Hyprland か GNOME) で流す (入れてある /usr/bin/mawok を動かす)')]
[group('実機の確認')]
[linux]
linux-check *tests:
    cd e2e && node linux-run.mjs {{ tests }}

# VM (e2e/vm/vm.sh) の中で回すので、手元の画面と入力を使わない。今のビルド (src-tauri/target/release/mawok) を写して回す。
# ビルドの後にソースが変わっていれば止まるので、pnpm tauri build --no-bundle で作り直してから回す。
# 例: just linux-check-vm arch-hyprland tray。詳細は e2e/README.md の「Linux の確認」を参照
[doc('Linux の自動の確認を VM の中で流す (arch-hyprland・ubuntu-2404・ubuntu-2604)')]
[group('実機の確認')]
[linux]
linux-check-vm vm *tests:
    cd e2e && node linux-vm-run.mjs {{ vm }} {{ tests }}

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

# ユニバーサル版を署名・公証し、DMG を src-tauri/target/release-mac/<版>/ に置く。
# 要: Developer ID の証明書と環境変数 APPLE_ID (→ docs/platform.md「Mac 版の配る版」)
[doc('Mac 版の配る版を作る')]
[group('ビルド')]
[macos]
release-mac:
    node scripts/release-mac.mjs

# デスクトップ専用なので Android・iOS 用は消す
[doc('アイコンを src-tauri/assets の SVG から作り直す')]
[group('生成')]
icons:
    pnpm tauri icon src-tauri/assets/app-icon.svg
    # MSIX 版のタスクバーのアイコン。Microsoft の文書が Required とする大きさの全部 (scripts/msix.mjs が並べる)
    pnpm tauri icon src-tauri/assets/app-icon.svg --png 16,20,24,30,32,36,40,48,60,64,72,80,96,256 -o src-tauri/icons/msix
    pnpm tauri icon src-tauri/assets/tray.svg --png 32 -o src-tauri/icons/tray
    pnpm tauri icon src-tauri/assets/tray-template.svg --png 36 -o src-tauri/icons/tray-template
    node -e "for (const dir of ['android', 'ios']) require('fs').rmSync('src-tauri/icons/' + dir, { recursive: true, force: true })"

# 要: cargo-about。→ docs/third-party-licenses.md「第三者のソフトウェア」
[doc('配布物に入る Rust の依存のライセンス表示を作る')]
[group('生成')]
licenses:
    node scripts/generate-rust-licenses.mjs
