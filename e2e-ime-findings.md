# E2E の IME のテストが落ちた件の調べ (Aero、2026-10-23)

Nano への報告。直しは同じブランチの e2e の変更で、この文書はマージの前に消す。

## 2つの別の失敗

| 回 | 落ち方 | 原因 | 再現 |
| --- | --- | --- | --- |
| 16:09〜16:24 (前任の mawok-72) | IME を使う9件が `IME をオンにできませんでした` | 入力言語が ENG (英語) になっていて、`VK_IME_ON` が効かなかったとみる | 17:20 以降は再現しない (前面の入力言語は日本語のまま) |
| 17:22 (全体の回) | draft-buttons:119・settings-ime:101/129 が `変換した文字 がタイムアウト (最後の値: "にほん")` | Google 日本語入力の学習で、`nihon` の第一候補が「にほん」になった | 毎回 (draft-buttons を単独で流しても落ちた) |

## ENG の出どころ

- 言語の一覧は ja だけで、入力方法は Google 日本語入力だけ (`Get-WinUserLanguageList` の TIP `{D5A86FD5-…}{773EB24E-…}` は Google Japanese Input。Microsoft IME ではない)。`Get-WinDefaultInputMethodOverride` は空。
- それでもセッションには US 配列が読み込まれている (`GetKeyboardLayoutList` = `0x4110411, 0x4090409`)。
- 読み込んでいるのは msedgedriver。`msedgedriver.exe` (155.0.4283.62) は `LoadKeyboardLayoutW` と `00000409` を持ち、Chromium の `chrome/test/chromedriver/chrome_launcher.cc` は `LaunchDesktopChrome` のたびに `SwitchToUSKeyboardLayout()` (`LoadKeyboardLayout("00000409", KLF_SETFORPROCESS | KLF_ACTIVATE)`) を呼ぶ。
- 時刻も合う: Deskflow のログの `local layouts` が 10/21 15:03 の `ja` から 16:14 に `ja, en` へ変わり、その間の 15:11 が今の `msedgedriver.exe` の日付。
- 未確認: 前任の回で何が ENG へ切り替えたか。見張り (前面のスレッドのレイアウトを 100ms ごとに記録) を付けて E2E を単独と全体で回した間は、一度も ENG にならなかった。msedgedriver の読み込みは、フォーカスのある窓を持たないので、ふつうは前面を切り替えない。残った ENG に Win+Space (Deskflow 越しの Omarchy の Super+Space を含む) などで切り替わった、とみている。
- 0:43 の Google 日本語入力の入れ直し (`winget install --id Google.JapaneseIME`) は、失敗の回より16時間前で、切り替えとの関係は確かめていない。

## 学習の仕組み (実測)

- 候補の一覧を出すテスト (draft-ime の「変換候補の一覧を出しても」、draft-history の「変換候補を選んでいる間の ↑ ↓」) が、2番目の候補を選んだまま終わる。後始末で IME をオフにしても、アプリを閉じても、その候補で確定し、Google 日本語入力が学習する。
- 回すたびに第一候補が「日本」と「にほん」で入れ替わった (全体の回の順で、draft-buttons は「にほん」が先、draft-ime がまた入れ替え、settings-ime は「にほん」が先)。
- 後始末の順 (アプリを閉じてから IME をオフ) を替えても止まらなかった。Esc で変換を取り消してから終えると止まった (2回続けて回し、第一候補が「にほん」のまま動かないことを見た)。

## 直したこと (e2e だけ)

- `convertComposition`: 「にほ」で始まらなくなるまで待つのをやめ、読みの `にほｎ` から変わったかで見る。第一候補が「にほん」でも通る。
- `startComposingNihon`: 読みが `にほｎ` になるまで待つ (「にほ」だけで返すと、続く「ｎ」を変換と取り違える)。
- `cancelComposition` を足し、候補を選ぶ2つのテストの終わりで呼ぶ。
- `turnImeOn`: 入力欄のスレッドのキーボードレイアウトを読み、日本語でなければ待たずに `入力言語が日本語ではないので…` で落とす (ENG の状態での動きは確かめていない。入力言語を切り替えるのは止めたため)。
- README の IME の節と、テストの冒頭の「Microsoft IME が前提」を直した。

## 残り

- Aero の Google 日本語入力の辞書は、`nihon` の第一候補が「にほん」のまま残っている (E2E が学習させたもの)。使う人が一度「日本」を選べば戻る。
- 残った US 配列 (ENG) は、サインアウトするまでセッションに残る。msedgedriver はセッションのたびに読み込み直すので、消しても E2E のたびに戻る。
