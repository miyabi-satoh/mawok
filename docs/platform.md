# OS ごとの作り

常駐・ログ・クリップボードと、検証して分かった OS ごとの注意。

## 常駐

- Windows と Linux はタスクトレイ、macOS はメニューバーに常駐する。
- ログイン時に自動起動する（既定でオン）。設定画面でオフにできる。
  - 初めての起動では、設定のとおりに OS のログイン項目へ登録する。2回目からは、起動のたびに設定を OS へ書き込み直さず、設定か OS のどちらかがオフならオフにそろえる。
  - Windows のタスクマネージャー・macOS のシステム設定・Linux のデスクトップの設定で切ったら、切ったままにし、設定もオフとして扱う。利用者が OS で選んだ状態を、アプリが断りなく有効に戻さないため。
  - 設定がオフなのに OS に登録が残っていたら（切り替えた後、登録を外す前にアプリが止まった など）、次の起動で OS の登録を外す。
  - OS へ登録し直すのは、設定画面でオンに切り替えたとき。
  - 設定がオンで登録も有効なら、登録先を今の実行ファイルにそろえる。開発用のビルドや、前に別の場所へ入れた版を指したまま残ると、ログインのたびにそちらが起動するため。Windows は起動のたびに書き直す（Run の値と、StartupApproved の「有効」を書くだけで、知らせは出ない。登録が有効なときにしか書き直さないので、タスクマネージャーで切った状態を有効に戻すことはない）。macOS はログイン項目（`SMAppService`）に登録し、登録がアプリの束に結びつくので、書き直さない。Linux は `.desktop` の `Exec` が今の実行ファイルと違うときだけ書き直す。
  - macOS のログイン項目は macOS 13 からの API なので、動作環境は macOS 13 以上。
- 多重起動はしない。2つ目を起動したら、既存のインスタンスのテキストウィンドウを表示する。macOS では、動いているアプリを Finder や `open` で開き直しても2つ目は立たず、既存のインスタンスに知らせが届く（`RunEvent::Reopen`）ので、どのウィンドウも出ていなければ同じく表示する。設定などが出ていれば、macOS のほかのアプリと同じく前に出すだけにする。
  - macOS で `open -n` や実行ファイルを直に起動して2つ目が立ったときは、テキストウィンドウを出さずにすぐ終わる。2つ目は、設定の置き場所のロックファイル（`mawok.lock`）で見分ける。Finder や `open` での開き直しは OS が2つ目を立てずに既存のインスタンスへ知らせるので、Windows のように2つ目から既存のインスタンスへ知らせる道（tauri-plugin-single-instance）は持たない。
- macOS のアプリのメニューは、編集のメニュー（取り消し・やり直し・切り取り・コピー・貼り付け・すべて選択）だけにする。メニューバーには出ないが、テキストウィンドウや設定を開いている間はキーが効く。編集のメニューは、入力欄で Cmd+C や Cmd+Z を効かせるのに要る。
  - Tauri の既定のメニューは付けない。既定のメニューの Cmd+Q は書きかけごと終了し、Cmd+H はテキストウィンドウを隠す処理（前のアプリへフォーカスを戻すなど）を通らずにアプリを隠し、Ctrl+Cmd+F はウィンドウを全画面にするため。
  - macOS では Cmd+Q で終了するのが標準だが、うっかり押して書きかけを失わないほうを採った。終了はトレイのメニューから行う。
- トレイメニュー: テキストウィンドウを表示／非表示 / 設定… / 終了。ホットキーの登録に失敗している場合は、その旨をメニューに表示する。設定画面でホットキーを登録し直せたら、その表示を消す。
  - 問題（ホットキー・設定の保存・ログイン時の起動）の項目は、⚠ を付けた短い知らせにする。選ぶと、その問題の行がある分類で設定画面を開き、パスや理由はその行に出す。メニューの項目は折り返せないので、詳しく書くと横に長く伸びる。
  - 「テキストウィンドウを表示／非表示」は、ウィンドウが隠れていれば出し、出ていれば隠す。隠すときは Esc や閉じるボタンと同じくコピーせず、クリップボードは変えず、書きかけは残る。トレイを押すのは送る操作ではないため。
    - 出ていれば、ほかのウィンドウの裏にあって見えていなくても隠す（テキストウィンドウの「常に最前面に表示」と「ほかのアプリに移ったら非表示にする」をオフにしているとき）。切り替えなので、前へ出すことはしない。見たいときはもう一度押す。
    - 出すときは、メニューを開く前に使っていたアプリを戻り先にする。Windows では、メニューを出す間はトレイの見えないウィンドウが前面になるので、それを戻り先にせず、重なり順でその下の、戻れるウィンドウ（見えていて、最小化・ツールウィンドウ・タスクバーでないもの）を戻り先にする。そうしないと、Esc で隠した後に見えないウィンドウが前面に残り、どこにも打てなくなる。
    - 隠すとき、テキストウィンドウにフォーカスがあれば、Esc と同じく出す前のアプリへフォーカスを戻す。なければ、ウィンドウを隠すだけにする。ユーザーはすでにほかのアプリを使っていて、戻すとそこから前面を奪うため（フォーカスが外れたら隠すときと同じ）。macOS はメニューを開いてもフォーカスが移らないので、テキストウィンドウで書いていれば戻すほうになる。
  - 項目の右端に、今のホットキーを OS の書き方で添える（macOS は ⌘⇧Space、Windows は Ctrl+Shift+Space の形。OS のメニューの仕組みで出すので、書き方は OS に任せる）。ホットキーを変えたら添えるキーも変わる。登録に失敗しているあいだは、押しても効かないので添えない。
  - Windows では、トレイのアイコンを押した時点でフォーカスがタスクバーへ移るので、テキストウィンドウの「ほかのアプリに移ったら非表示にする」がオンなら、テキストウィンドウはメニューを開く前に隠れる。そのため押すと出すほうになり、隠すほうが働くのは、その設定がオフのときと macOS。
  - Windows では、添えたキーは見せるためだけで、キーとして別に効くことはない（トレイのメニューがウィンドウに付かないため）。
  - macOS では、トレイのメニューを開いている間だけ、ホットキーの登録を外す。閉じたら登録し直す。開いたままホットキーを押すと、メニューの項目に添えたキーとして効き、メニューが閉じてテキストウィンドウが出し入れされる（macOS で確かめた）。
    - 登録したままだと、グローバルホットキーとメニューに添えたキーがぶつかる。メニューを開いている間は、アプリがメニューの操作だけを待つので、ホットキーは処理されずに溜まり、メニューが閉じた直後に届く。そこで項目を選ぶと、溜まったホットキーと選んだ操作が続けて効き、テキストウィンドウを出してすぐにコピーして隠してしまう。
    - Tauri にはメニューの開閉を知らせる API がないので（tauri#9138）、AppKit の NSMenuDidBeginTracking / NSMenuDidEndTracking の通知で知る（`menu_tracking.rs`）。同じ現象を、macOS のショートカットのライブラリ KeyboardShortcuts も同じ形で避けている。
    - どのメニューかは絞らない。テキストの入力欄の右クリックのメニューを開いている間も、ホットキーは効かない。サブメニューなどで開く・閉じるの通知が入れ子になっても、いちばん外のメニューを開いたときに外し、閉じたときに戻す。
    - 開いている間に設定でホットキーを変えたら、閉じたときに古いキーは戻さない（変えたときに新しいキーが登録されている）。閉じた後に登録し直せなかったときは、登録に失敗したときと同じくトレイに ⚠ を出す。

## ログ

- 不具合の原因を後から追えるように、動作をログファイルに残す。記録するのは、起動、表示、非表示、ウィンドウの破棄、終了、WebView のプロセスの異常終了、画面側で起きた想定外のエラー、CSP に止められた読み込み（止めた指令と読み込み先だけ）、設定の読み込みやホットキーの登録などの失敗の詳細。
- 入力内容はログに残さない。
- 置き場所は OS 標準のログフォルダ（macOS は `~/Library/Logs/<identifier>/` をコンテナに回した先の `~/Library/Containers/com.amiiby.mawok/Data/Library/Logs/<identifier>/`、Windows は `%LOCALAPPDATA%\<identifier>\logs\`、Linux は `~/.local/share/<identifier>/logs/`）。時刻は UTC。

## プロファイル

環境変数 `MAWOK_PROFILE` に名前（英小文字・数字・`-` の 32 文字まで）を入れて起動すると、アプリの識別子の後ろに `.<名前>` を付けて動く（`src-tauri/src/profile.rs`）。常用の Mawok と分かれるのは、識別子で決まるもの。

- 設定・履歴・ログのフォルダー（`<identifier>.<名前>`）。設定の置き場を選んでいれば、その置き場はプロファイルごとのデバイスの設定（docs/config.md「デバイスの手元に置くもの」）で決まる。
- 単一起動の見分け。

自動の確認（`e2e/`）は `e2e`、開発版（デバッグビルド）は何も付けなければ `dev` で動く。常用の設定のまま動かすと、テストの設定や履歴が常用の置き場に書かれ、置き場を同期していればほかのデバイスへも届くため。開発版を常用の置き場で動かすときは、`MAWOK_PROFILE=` と空にする。

グローバルホットキー・ログイン項目は OS の上で1つなので、分かれない。常用の Mawok と同時には動かさない。

## クリップボードの履歴に残さない

- コピーするときに、クリップボードの履歴やほかのデバイスへの同期、クリップボード管理アプリに残さないよう、印を付けて書き込む。設定で切り替えられ、既定はオン。テキストには API キーやトークンが紛れることがあり、それが履歴や同期に残るのを防ぐ。
  - コピーするときの整え（句読点・置き換え辞書など）とは別に、整えた結果を書き込むときに付ける。
  - macOS: `org.nspasteboard.ConcealedType` 形式を一緒に書き込む（[nspasteboard.org](http://nspasteboard.org/) の慣習）。効くかどうかは、履歴を持つ側がこの慣習に従うかしだい。
  - Windows: `ExcludeClipboardContentFromMonitorProcessing` 形式を一緒に書き込む。クリップボードの履歴（Win+V）にも、ほかのデバイスへの同期にも含まれず、クリップボードを監視するアプリにも処理しないよう伝わる。これを付けたら、履歴と同期だけを外す形式（`CanIncludeInClipboardHistory`・`CanUploadToCloudClipboard`）は重ねない。
  - オンのままだと、以前のテキストを履歴から貼り直すこともできない。そういう使い方をするならオフにする。
  - 印を付けられるのは、Mawok が書き込む分だけ。ほかのアプリがクリップボードへ書いた分は、Mawok からは外せない。例えば、音声入力ツールによってはテキストウィンドウへ入れるときにクリップボードへ書き、その場合はその分が履歴に残る（2026-09 に Windows 11 で、履歴に残った項目が Mawok のコピーより前の、使っている音声入力ツールが書いた分だったと確かめた。macOS やほかのツールで同じとは限らない）。ほかのアプリでコピーしてテキストウィンドウに貼り付けた場合も、そのコピーは履歴に残っている。
  - OS が定めた形式と、クリップボード管理アプリに広く通じる慣習の形式を書くだけで、特定の製品の知識は持たないので、入力元や貼り付け先の製品の知識を持たない、という線には触れない。
- 書き込みには [arboard](https://github.com/1Password/arboard) を直接使う。Tauri のクリップボードのプラグインは、この印を付けて書く手段を持たない。

## 実装上の注意

- 隠すときのフォーカス復帰は OS ごとに実装する。macOS は、ウィンドウを隠すだけでは直前のアプリにフォーカスが戻らない。Windows は隠すだけで戻ったが、試したのは1回だけなので、それに頼らない。
  - macOS: ウィンドウを隠した後に `AppHandle::hide()`。ふだんはアプリを前面にしないパネルで出すが（下の「パネル」）、設定を閉じた後はアプリを前面にするので、隠すだけではアクティブなまま残る。
  - Windows: 表示前に記録した HWND へ、隠す前に `SetForegroundWindow`。
- クリップボードへの書き込みが完了してから隠す。
- パネル: macOS のテキストウィンドウは、アプリを前面にしないパネル（`NSPanel` の nonactivating。tauri-nspanel で窓を変える）にし、今の Space に移る・フルスクリーンの Space にも入れる設定（`MoveToActiveSpace`・`FullScreenAuxiliary`）を付ける（2026-10 に macOS 26 で検証）。
  - 付けないと、窓は最後にいたデスクトップに留まり、常駐のアプリなので Space も切り替わらない。ほかのアプリをフルスクリーンにしていると、ホットキーを押しても見えない。
  - ふつうの窓のまま設定だけ付けると（`CanJoinAllSpaces` でも同じ）、フルスクリーンの Space には入らず、ほかのディスプレイの今のデスクトップに出る。出すときにアプリが前面になるためとみられる。Spotlight のような入力窓と同じく、前面にしないパネルにすると、フルスクリーンのアプリの上に出る。
  - パネルはアプリを前面にしないまま、キー入力（日本語の変換・編集のメニューの Cmd+V など）を受ける。前面のアプリは出す前のまま変わらない。
  - 設定を閉じた後だけは、アプリを前面にしてフォーカスを戻す。常駐に戻す操作でアプリが前面から外れ、パネルのままではキー入力が戻らないため。
- 画面の CSP（`tauri.conf.json` の `app.security.csp`）は、同梱の画面と IPC だけを許す。インラインのスクリプトは SvelteKit の起動用の1つだけで、Tauri がビルド時にハッシュを足す。`style-src` は `'unsafe-inline'` を許し、Tauri にナンスを足させない（`dangerousDisableAssetCspModification`）。ナンスが入ると `'unsafe-inline'` が効かなくなり、`style` 属性（`app.html` の `display: contents` や部品の配置）が止められるため。CSP のヘッダーは Tauri が同梱の画面を配るときに付けるので、ビルドした版（E2E を含む）でだけ効く。デスクトップの `tauri dev` は開発サーバーへ直接つなぐので効かない（`devCsp` も同じなので置かない）。窓ごとに呼べるアプリのコマンドは分けない（既定のまま、同梱の画面ならどの窓からも呼べる）。
- テキストウィンドウは、作成時にフォーカスを取らない設定（`tauri.conf.json` の `"focus": false`）にする。wry 0.55 系は、WebView2 の作成の最後に `MoveFocus` を呼び、失敗すると WebView の作成全体を失敗として扱う。ウィンドウがフォーカスを取れない状態（Windows の Modern Standby 中に起動した場合など）では `MoveFocus` が E_INVALIDARG を返すので、テキストウィンドウが作られず、ホットキーを押しても何も出なくなる（[wry #1798](https://github.com/tauri-apps/wry/issues/1798)）。wry 0.56.1 で修正済み（Tauri 2.12 は wry 0.57 を使う）。表示するたびに `set_focus()` を呼ぶので、作成時のフォーカスは不要。
- 変換中の Esc と Cmd+Enter（Ctrl+Enter）の判定は `KeyboardEvent.isComposing` か keyCode 229 で行う（`src/lib/keys.ts`）。
- ウィンドウの大きさ（2026-09 に macOS 26 で検証）: `set_size` に渡した高さはタイトルバーを含む外側の高さとして効き、`inner_size` もタイトルバーを含んだ値を返す。ドキュメントの説明（どちらも中身の大きさ）とは食い違う、未修正の不具合（[tauri#15136](https://github.com/tauri-apps/tauri/issues/15136)・[#6333](https://github.com/tauri-apps/tauri/issues/6333)・[#12152](https://github.com/tauri-apps/tauri/issues/12152)）。wry が `contentView` を差し替えるため、tao が持つ古いビューの大きさが当てにならないことが原因。中身の大きさに合わせる公式の API はなく、差分を自分で求めるのが Tauri のメンテナの回答（[discussion#11816](https://github.com/orgs/tauri-apps/discussions/11816)）。今は、この差分を求めて使っているところはない。
- ホットキーの重複（2026-09 に macOS 26 で検証）: `RegisterEventHotKey` は、別のプロセスが登録済みの組み合わせでも、システムのショートカット（⌘Space・⌘⇧3・⌃Space）でも成功を返す。別のプロセスと重なった場合、押すと登録したすべてのプロセスに届き、前面のアプリの keydown には届かない。システムのショートカットは `CopySymbolicHotKeys` で照合できるが、ほかのアプリのホットキーを調べる公開 API はない。Windows の `RegisterHotKey` は重複を `ERROR_HOTKEY_ALREADY_REGISTERED` で返す（PowerToys はこれで重複を見つけている）。ただし Windows でも、ほかのアプリが登録済みのキーは記録中の WebView2 に届かない（2026-09 に検証）。そのため、どちらの OS でも重複は登録の失敗としては現れない。

## Linux のホットキー

- X11 では、Windows・macOS と同じく global-shortcut プラグインで登録する。
- Wayland では、アプリがキーを奪えない。global-shortcut プラグイン（global-hotkey）は X11 にしか対応しておらず、XWayland 越しに登録は成功するが、キーは XWayland の窓が前面のときしか届かない。失敗として現れないので、Wayland（`WAYLAND_DISPLAY` があり、`GDK_BACKEND` が x11 でない）ではプラグインに登録せず、次の2つで出す。
  - デスクトップの GlobalShortcuts portal（`portal_hotkey.rs`）。設定のホットキーを希望として渡し、どのキーにするかはデスクトップが決めて利用者が確かめる。付いたキーは設定画面に出し、デスクトップの割り当ての画面（portal の version 2 の `ConfigureShortcuts`）を開ける。GNOME 48 以降と KDE が持つ。
  - `mawok --toggle`（`toggle.rs`）。portal が無い・portal でキーが付かないデスクトップ（Ubuntu 24.04 の GNOME 46、Hyprland など）では、デスクトップのキー設定でこのコマンドにキーを割り当ててもらう。設定画面のホットキーの欄も、そう案内する。2つ目のプロセスは、単一起動のプラグインと同じ D-Bus の呼び出しで動いている Mawok に知らせてすぐ終わる。プラグインに任せると GTK と WebView の準備を待つので、出るまでが遅れる。
- Wayland では、窓を前に出すのに、呼んだ側（デスクトップ）が渡す印（xdg-activation のトークン）が要る。無いと GNOME は窓を出さずに「準備ができました」と知らせるだけになる。`mawok --toggle` は `XDG_ACTIVATION_TOKEN`（X11 は `DESKTOP_STARTUP_ID`）を、portal は `Activated` の `activation_token` を受け取り、出す前に窓に渡す。
- 隠したときにフォーカスがどこへ戻るかは、デスクトップが決める。Wayland には、ほかのアプリの窓を前に出す要求が無い。

## Linux のそのほか

- クリップボード: 書いたプロセスが、求めに応じて中身を配る。arboard は最後の `Clipboard` を手放すと配るのをやめるので、プロセスの間ずっと1つ持つ。Wayland では data-control で書き、持たないデスクトップ（GNOME）は XWayland 越しに書く。履歴に残さない印は、KDE の慣習の形式（`x-kde-passwordManagerHint`）。
- 窓の位置と大きさは記録から戻さない（window-state プラグインに渡す印を空にする）。プラグインは物理ピクセルで記録して戻すが、GTK の倍率（端数の倍率のモニターでは 2 になる）がモニターや窓を作った時点で変わるため、開くたびに大きさがずれる（2026-10 に Hyprland の 1.125 倍と 1 倍のモニターで、720×567 の窓が 1544×1240 と記録され、次は 772×667 で開いた。小さい側にずれると最小の大きさに張り付く）。Wayland ではアプリが窓の位置を決められないので、位置を戻す意味も無い。
- 入力欄の案内は、placeholder でなく、入力欄の裏の置き換えのハイライトの層に描く。WebKitGTK は placeholder を入力欄より1文字ほど広い幅で折り返し、右端が見切れるため。
- ログイン時の起動は、XDG autostart の `~/.config/autostart/Mawok.desktop` を自分で読み書きする。デスクトップの設定で切ると `Hidden=true` や `X-GNOME-Autostart-enabled=false` が書かれ、tauri-plugin-autostart はそれを読まずに有効に戻してしまうため（上の「常駐」の決まり）。
- トレイは StatusNotifierItem で出し、`libayatana-appindicator3` を実行時に読み込む（無いと起動できない）。押すとメニューが出るだけで、押したことは受け取れない。メニューの項目にホットキーは添わない（muda はウィンドウに付かないメニューにキーを付けない）。GNOME は AppIndicator の拡張が要る（Ubuntu には最初から入っている）。

## Linux の配る版

- 配るのは amd64 の .deb だけ。Ubuntu には自前の apt リポジトリで、Arch Linux には .deb を展開するだけの AUR の `mawok-bin` で届ける。どちらも、更新は OS のふつうの更新で届く。
- `.github/workflows/release-linux.yml` が、版のタグの push で .deb を作り、GitHub Releases に上げ、apt リポジトリと AUR を新しい版にする。PR でこの workflow か `packaging/` を変えたときは、使い捨ての鍵で公開の手前まで流し、apt と pacman で実際に入れて確かめる。
- .deb は、支える中でいちばん古い Ubuntu（24.04）で作る。glibc などのライブラリは、古い版に合わせて作れば新しい版でも動くため。依存（WebKitGTK・GTK・トレイの `libayatana-appindicator3-1`）は Tauri が control に書く。
- apt リポジトリは GitHub Pages（`https://miyabi-satoh.github.io/mawok`）に置く（`packaging/apt/build-repo.sh`）。apt は Packages の `Filename` をリポジトリの URL からの相対で引くので、GitHub Releases の .deb は指せず、.deb も Pages に置く。置くのは今の版だけにし、前の版は GitHub Releases に残す。apt が更新に使うのは最新の版だけで、版を重ねると Pages の容量の上限（1 GB）に近づくため。
- 初めてタグを打つ前に、Pages の公開元を GitHub Actions にし、`github-pages` の環境の配備の決まりに `v*` のタグを足す（既定では main からしか配備できず、タグの push からの配備が止められる）。
- apt リポジトリの署名の鍵は GitHub の secret（`APT_SIGNING_KEY`）に置く。公開鍵は workflow がその鍵から書き出して `mawok.gpg` として Pages に置き、利用者は `signed-by` でこのリポジトリにだけ結ぶ。
- AUR へは、`packaging/aur/PKGBUILD.in` に版とハッシュを埋め、`.SRCINFO` を作って、secret（`AUR_SSH_PRIVATE_KEY`）の鍵で push する。secret が無ければ、警告を出して AUR だけを飛ばす。配るアプリはソースの `LICENSE` でなく利用規約で扱うので、ライセンスには利用規約の URL を書いたファイルを入れる。

## macOS の窓の位置と大きさ

- 窓（テキストウィンドウ・設定・ライセンス・使い方）の位置と大きさは、window-state プラグインでなく、AppKit の frame autosave（`setFrameUsingName`・`setFrameAutosaveName`。`window_frame.rs`）で記録して戻す。Mac のふつうのアプリと同じ仕組みで、記録はアプリの defaults に置かれる。
- プラグインは物理ピクセルで記録し、戻すときに窓のその時点の倍率でポイントに直す。作った直後の窓はまだ画面に載っておらず倍率が 1.0 と返ることがあり、Retina の画面では時々2倍の大きさで開いて、その大きさが記録される（[plugins-workspace#3521](https://github.com/tauri-apps/plugins-workspace/issues/3521)）。倍率の違う画面をまたいでも、同じ理由でずれる。AppKit はどの画面にも共通のポイントで記録するので、倍率に左右されない。
- 窓は Tauri に中央に置かせずに作り、記録が無いときだけ AppKit の `center` で置く。Tauri の中央に置く指定は、作った後に `tao` が後回し（メインキューへの非同期）で当てるので、先に戻した位置を上書きするため。テキストウィンドウも `tauri.conf.json` では作らせず（`create: false`）、setup でその設定から作る。
- 上流は、Windows の座標が物理ピクセルなので、ポイントで記録する直しをプラグインに入れていない。Windows はプラグインのまま。

## macOS のサンドボックス

Mac 版は Mac App Store で配るので、どのビルドもサンドボックスで動かす。権限は `src-tauri/Entitlements.plist` に置き、`tauri.conf.json` の `bundle.macOS.entitlements` で、Tauri が署名するときに付ける（`just bundle` の ad-hoc 署名と `just release-mac` の Developer ID の署名の両方）。`pnpm tauri dev` の開発版は署名しないので、サンドボックスの外で動く。

- `com.apple.security.app-sandbox`: サンドボックスで動かす。`~/Library` はコンテナ（`~/Library/Containers/com.amiiby.mawok/Data/Library/`）に回され、設定・ログ・バックアップ・ロックファイルはその中に置かれる。コンテナは署名の識別子で決まるので、プロファイル（「プロファイル」）を付けても同じコンテナの中で、フォルダー名だけが分かれる。
- `com.apple.security.files.user-selected.read-write`: フォルダーの窓で選んだ設定の保存先と、symlink の先のフォルダーを読み書きする。
- `com.apple.security.files.bookmarks.app-scope`: 選んだフォルダーの許可を、起動し直しても戻せるようにブックマークに残す（docs/config.md「macOS のサンドボックス」）。
- `com.apple.security.network.client` を付ける。アプリは外へつながないが、無いと WKWebView の中身のプロセスが起動のたびに落ち、画面が出ない（サンドボックスの版で確かめた）。
- ホットキー（`RegisterEventHotKey`）・ログイン項目（`SMAppService`）・クリップボード・パネルの窓は、サンドボックスでも権限が要らない。

## macOS の手元のビルドの署名

- 手元のビルド（`just bundle`）には、アプリ全体に ad-hoc 署名を付ける（`tauri.conf.json` の `bundle.macOS.signingIdentity` を `"-"`）。配る版は Developer ID で署名する（「Mac 版の配る版」）。付けない場合と付けた場合の違いは次のとおり（2026-09 に macOS 26.6 の実機で検証）。
- 付けない場合、実行ファイルにリンカーが付けた署名だけになり、`Info.plist` とリソースが署名に含まれない（`codesign -dv` で `Info.plist=not bound`・`Sealed Resources=none`）。ブラウザーで落とした（隔離の印 `com.apple.quarantine` の付いた）DMG からは「壊れているため開けません」となり、システム設定からも開けない。
- 付けた場合、同じように落とした DMG の中のアプリを開くと、確認できないとして止められるが、システム設定の「プライバシーとセキュリティ」に出る「このまま開く」で開ける。署名の識別子は `com.amiiby.mawok` になり、Tauri の既定で hardened runtime も付く。

## Mac 版の配る版

- Intel と Apple Silicon の両方で動くユニバーサル版（`universal-apple-darwin`）を、Developer ID で署名・公証する。手元の Mac で `just release-mac` を流す（`scripts/release-mac.mjs`）。
- ビルドし、`.app` が両方の CPU 向けを含み、公証の結果が綴じてあり Gatekeeper が通すことを確かめて、DMG を `src-tauri/target/release-mac/<版>/` に置く。
- 要るもの:
  - キーチェーンの Developer ID Application の証明書。作れるのは Apple Developer の Account Holder だけで、作り方は Apple の「Create Developer ID certificates」（https://developer.apple.com/help/account/certificates/create-developer-id-certificates/ ）。中間の認証局は G2 Sub-CA を選ぶ。
  - `APPLE_ID`: 公証に使う Apple Account のメールアドレス。パスワードは、そのアカウントのアプリ用パスワード（https://account.apple.com の「サインインとセキュリティ」で作る）を流すときに聞く。Tauri は公証のとき、このパスワードを `notarytool` の引数で渡すので、公証を待つ間は同じ Mac のほかのプロセスから見える。

## Windows の MSIX 版

- Microsoft Store 向け。`just msix` で、`pnpm tauri build --no-bundle` で作った `mawok.exe` とロゴを、`src-tauri/msix/AppxManifest.xml` と、makepri で作る `resources.pri` と一緒に makeappx で固める（`scripts/msix.mjs`）。中身は EXE 版と同じ1つのコードで、MSIX として動いているか（このアプリの AUMID が取れるか。`GetCurrentApplicationUserModelId`）で違うところだけを分ける。今分けているのはログイン時の起動。
- 試しに入れるには、先に管理者の PowerShell で `src-tauri/msix/new-test-cert.ps1` を1回実行し、自己署名の証明書を作って信頼させておく。`just msix` はその証明書で署名する。識別子（Name・Publisher・PublisherDisplayName）は、Partner Center で予約した製品の「Product identity」の値を `scripts/msix.mjs` の `IDENTITY` に書いてある。試しに入れるための証明書も、Subject をこの Publisher と揃える。Store に上げる版は `just msix --unsigned` で署名せずに作る（Store が署名する。Store の Publisher の証明書は手元に無い）。
- ログイン時の起動は、マニフェストの StartupTask（既定は無効）で行う。MSIX の中から HKCU の Run に書いても、パッケージごとの場所に回されて効かないため。アプリは EXE 版と同じ決まり（「常駐」）で、`RequestEnableAsync` で有効にし、`Disable` で外す。タスクマネージャーや Windows の設定の「スタートアップ アプリ」で切られていると（`DisabledByUser`）アプリからは戻せないので、設定でオンにしたときは Windows の設定の「スタートアップ アプリ」を開き、戻せなかったことを伝える（2026-09-27 に Windows 11 の実機で確認。利用者が切った状態は、レジストリの State を 1 にして再現した）。
- 設定・履歴・ログの置き場所（2026-09-27・28、Windows 11 の実機）: Windows 10 1903 以降、AppData の下に新しく作るファイルはパッケージごとの場所に回される（Microsoft の文書「Understanding how packaged desktop apps run on Windows」）。
  - EXE 版のファイルが無い環境では、既定の設定の保存先（設定と、その中の `history\` の履歴）は `%LOCALAPPDATA%\Packages\<パッケージ ファミリー名>\LocalCache\Roaming\com.amiiby.mawok`、デバイスの設定・ログ・WebView2 のデータは同じ `LocalCache\Local\com.amiiby.mawok` にできる。実際の AppData には何もできず、アンインストールでまるごと消える。
  - EXE 版のファイルがすでにある環境では、EXE 版と同じ場所（既定の設定の保存先は `%APPDATA%\com.amiiby.mawok`、デバイスの設定・ログ・WebView2 のデータは `%LOCALAPPDATA%\com.amiiby.mawok`）をそのまま読み書きし、EXE 版と設定・履歴を分け合う。
  - 回された先はパッケージの外のエクスプローラーからは元のパスで見えないので、「ログを表示」は、回された先にあればそのパスを渡す（元のパスを渡すと「場所が利用できません」になった）。
  - EXE 版が動いている間に MSIX 版を起動すると、多重起動の防止で MSIX 版は終わり、EXE 版のテキストウィンドウが出る。
- タスクバーに出すアイコンは、下地なし（`Square44x44Logo.targetsize-<大きさ>` の既定・`altform-unplated`・`altform-lightunplated` の3つ）で入れ、makepri で作る `resources.pri` に載せる。無いと、Windows はアクセントカラーの四角い下地に載せて出す（2026-09-27 に Windows 11 の実機で、設定のウィンドウのタスクバーのボタンを比べて確認。Alt+Tab とスタートメニューの検索は、どちらでも下地なしだった）。Windows の設定の「スタートアップ アプリ」は、これを入れても下地に載る。この画面は、下地なしの画像を持つほかのパッケージのアプリ（Claude・Microsoft Defender）も下地に載せていた。アイコンは自前の暗い下地を持つので、3つとも同じ画像にしている。大きさは Microsoft の文書（「Construct your Windows App's Icon」の App icon の節）が Required とする 16〜256 の14通りで、`just icons` が `src-tauri/icons/msix` に作る。
- WebView2 は入っている前提にする（Windows 11 には OS に含まれる。MSIX には入れる処理が無い）。
