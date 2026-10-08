import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { DRAFT_TITLE } from './app-conf.mjs';
import { readBackupRecord, recordPath, writeJsonAtomic } from './files.mjs';

/**
 * PowerShell に `script` を渡す引数を作る。
 *
 * 素朴に `-Command <script>` で日本語を渡すと、コンソールのコードページ (既定では
 * Shift_JIS のことが多い) 経由でエンコードが化ける。`-EncodedCommand` (UTF-16LE を
 * Base64 にしたもの) で渡し、標準出力のエンコーディングも明示的に UTF-8 にすることで避ける。
 * 進捗の表示 (Add-Type などが出す) は、標準エラーを繋いだままだと CLIXML として流れ込み、
 * 本来のエラーの文言を埋もれさせるので止める。
 * 終わるまで待たずに動かし続けるプロセス (spawn) にも使う
 */
export function powerShellArgs(script) {
	const wrapped = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ProgressPreference = 'SilentlyContinue'\n$ErrorActionPreference = 'Stop'\n${script}`;
	const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
	return ['-NoProfile', '-EncodedCommand', encoded];
}

// 呼ぶたびに PowerShell を起動すると、起動だけで 0.4 秒ほどかかり、Add-Type の C# のコンパイルも毎回やり直しになる
// (draft-buttons では、これが合計の 9 割近くを占めていた)。PowerShell を1つ立ち上げたままにし、スクリプトを標準入力へ
// 1行ずつ流して、結果を標準出力の1行で受け取る。読み込んだ型はプロセスに残り、同じ定義の Add-Type は2回目から何もしない
// (定義が違うとエラーになるので、同じ名前の型を別の中身で定義し直さないこと)。
// **ハンドルや座標など毎回変わる値は、スクリプトに埋め込まず `args` で渡す** (スクリプトの中では `$args[0]` などで読む)。
// スクリプトは中身ごとに検査され、C# のソースを含むスクリプトは中身が変わるたびに 0.5〜1 秒かかる (同じ中身なら覚えていて数 ms。
// Windows の AMSI と見られる)。値を埋め込むと、クリックのたびに検査し直しになる。
// スクリプトと `args` は JSON にし、UTF-8 を Base64 にして渡す。結果は「@@e2e」の印、「ok か error」、UTF-8 を Base64 にした本文を1行で返す
// (改行や日本語を1行に収めるため)。
// 結果は標準出力を使って返すので、スクリプトの中で Write-Host や [Console]::Out に書かないこと (印のない行は、読み飛ばして警告を出す)。
// スクリプトは呼ぶたびに子のスコープで動くので、変数は次の呼び出しに残らない。
// 立ち上げたプロセスは標準入力が閉じると終わる。テストのプロセスが落ちたり強制終了されたりしてもパイプが閉じるので、残らない
const HOST_SCRIPT = `
# 警告などは、出力をパイプにしていると標準出力に混ざり、応答の行と取り違えるので出さない
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$blocks = @{}
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try {
        $request = $utf8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
        if (-not $blocks.ContainsKey($request.script)) { $blocks[$request.script] = [ScriptBlock]::Create($request.script) }
        $arguments = @($request.args)
        $items = @(& $blocks[$request.script] @arguments)
        $text = ($items | ForEach-Object { if ($_ -is [string]) { $_ } else { ($_ | Out-String -Width 4096).TrimEnd() } }) -join "\`n"
        if ($items.Count -gt 0) { $text += "\`n" }
        $status = 'ok'
    } catch {
        $text = $_ | Out-String -Width 4096
        $status = 'error'
    }
    [Console]::Out.WriteLine('@@e2e ' + $status + ' ' + [Convert]::ToBase64String($utf8.GetBytes($text)))
    [Console]::Out.Flush()
}
`;

/** 立ち上げたままの PowerShell。まだ起動していないか、終わった後は null */
let host = null;
/** 1つのプロセスに1つずつ流すための順番待ち */
let queue = Promise.resolve();

function startHost() {
	const child = spawn('powershell', powerShellArgs(HOST_SCRIPT), {
		stdio: ['pipe', 'pipe', 'inherit'],
		windowsHide: true
	});
	const self = { child, pending: [] };
	let buffered = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		buffered += chunk;
		for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
			const line = buffered.slice(0, index).trim();
			buffered = buffered.slice(index + 1);
			const [marker, status, payload = ''] = line.split(' ');
			if (marker !== '@@e2e') {
				// スクリプトが標準出力に直接書いた行。応答と取り違えて、以降の対応がずれないよう読み飛ばす
				if (line) console.warn(`[e2e] PowerShell が応答以外の行を出しました: ${line}`);
				continue;
			}
			const request = self.pending.shift();
			if (self.pending.length === 0) child.stdout.unref();
			if (!request) continue;
			const text = Buffer.from(payload, 'base64').toString('utf8');
			if (status === 'ok') request.resolve(text);
			else request.reject(new Error(`PowerShell のスクリプトが失敗しました: ${text.trim()}`));
		}
	});
	const fail = (error) => {
		if (host === self) host = null;
		for (const request of self.pending.splice(0)) request.reject(error);
	};
	child.once('error', fail);
	child.once('exit', (code, signal) =>
		fail(new Error(`立ち上げたままの PowerShell が終わりました (code=${code}, signal=${signal})`))
	);
	// 待っている間に ref しているのは標準出力だけなので、落ちたときは exit より先に閉じたことで気づく
	// (unref した child の exit を待っていると、届く前にイベントループが空になってテストのプロセスが終わることがある)
	child.stdout.once('close', () =>
		fail(new Error('立ち上げたままの PowerShell の標準出力が閉じました'))
	);
	// Ctrl+C は同じコンソールの PowerShell にも届き、先に終わっていることがある。そのとき書き込もうとして落ちないようにする
	child.stdin.on('error', () => {});
	// 待っている結果がないときは、テストのプロセスがこの子を待たずに終われるようにする (終わればパイプが閉じ、PowerShell も終わる)
	child.unref();
	child.stdin.unref();
	child.stdout.unref();
	return self;
}

function send(script, args) {
	host ??= startHost();
	const current = host;
	return new Promise((resolve, reject) => {
		current.pending.push({ resolve, reject });
		current.child.stdout.ref();
		const request = Buffer.from(JSON.stringify({ script, args }), 'utf8').toString('base64');
		current.child.stdin.write(`${request}\n`);
	});
}

/**
 * PowerShell でスクリプトを実行し、出力を文字列で返す (出力があれば、末尾に改行が1つ付く)。失敗したら、PowerShell のエラーの文言で失敗させる。
 * 毎回変わる値は `args` (文字列か数値の配列) で渡し、スクリプトの中では `$args[0]` などで読む (上の HOST_SCRIPT の説明を参照)
 *
 * @param {string} script
 * @param {(string | number)[]} [args]
 */
export function runPowerShell(script, args = []) {
	const result = queue.then(() => send(script, args));
	queue = result.catch(() => {});
	return result;
}

/**
 * 立ち上げたままの PowerShell を手放し、次の `runPowerShell` で立ち上げ直させる (終わるのは待たない)。
 * Ctrl+C は同じコンソールの PowerShell にも届き、中断の書き戻しを始めた時点では、まだ終わりきっていないことがある。
 * そのまま使うと、書き戻しの途中で標準出力が閉じて失敗するので、書き戻しの前に呼ぶ
 */
export function discardPowerShell() {
	const current = host;
	host = null;
	current?.child.stdin.end();
}

/** 立ち上げたままの PowerShell を終わらせ、終わるまで待つ (テストファイルの後始末で呼ぶ。呼ばなくても、テストのプロセスが終われば終わる) */
export async function stopPowerShell() {
	const current = host;
	if (!current) return;
	host = null;
	const { child } = current;
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.ref();
	child.stdin.end();
	await exited;
}

/** OS のグローバルホットキーとして Ctrl+Shift+Space を送る (SendKeys 経由。RegisterHotKey はフォーカスに関係なく反応する) */
export async function sendGlobalHotkey() {
	await runPowerShell(
		`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+ ')`
	);
}

/** OS のクリップボードを読む */
export async function getClipboard() {
	const stdout = await runPowerShell('Get-Clipboard -Raw');
	// Get-Clipboard -Raw は末尾に改行を付けない想定だが、PowerShell 側の出力に
	// 余計な改行が付くことがあるため、末尾の改行だけ落とす (中身の改行は保持する)
	return stdout.replace(/\r?\n$/, '');
}

/**
 * OS のクリップボードに値をセットする (テスト前の初期化用)。
 * 立ち上げたままの PowerShell で書くと、そのプロセスがクリップボードの持ち主のまま残り、メッセージを処理しないので、
 * ほかのプロセス (アプリのコピーも) がクリップボードに書くときに数秒待たされる。書くたびに PowerShell を起動し、
 * 書き終えたら終わらせる (値は -EncodedCommand で渡すので、日本語も化けない)
 */
export async function setClipboard(value) {
	const escaped = value.replace(/'/g, "''");
	await promisify(execFile)('powershell', powerShellArgs(`Set-Clipboard -Value '${escaped}'`));
}

/** mawok.exe が動いているか */
export async function isMawokRunning() {
	const stdout = await runPowerShell(
		`if (Get-Process -Name mawok -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`
	);
	return stdout.trim() === 'yes';
}

/**
 * mawok.exe が動いていないことを確認する。動いていたら、はっきり失敗させる。
 *
 * 常用のアプリが起動中の可能性がある (書きかけの下書きがメモリ上にあるかもしれない) ので、
 * ここで黙って `taskkill` するとユーザーの入力が消える。E2E は single-instance のため
 * 動かせないのは事実だが、対処は「先に閉じてもらう」以外に安全な方法がない。
 *
 * `deleteSession()` 直後などは終了が一瞬遅れることがあるため、すぐに諦めず少し待ってから
 * 判定する (それでも動いていれば、常用のアプリと区別が付かないので同じ扱いで失敗させる)。
 * `isMawokRunning()` 自体が失敗した場合 (powershell が見つからない等) は、それを
 * 「動いている」に読み替えず、元のエラーをそのまま投げる (原因が分からなくなるため)
 */
export async function ensureMawokNotRunning() {
	const deadline = Date.now() + 3000;
	for (;;) {
		if (!(await isMawokRunning())) return;
		if (Date.now() > deadline) {
			throw new Error(
				'mawok.exe が既に起動しています。E2E は single-instance のため、' +
					'常用のアプリを (下書きが書きかけなら確定させてから) 手動で終了して再実行してください。'
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

// EnumWindows で mawok.exe の各ウィンドウの実際の表示状態 (IsWindowVisible) を見る。
// WebDriver はウィンドウが非表示でも DOM を操作できてしまうため、ネイティブウィンドウが
// 本当に表示・非表示になったかは Win32 API で別途確認する必要がある
const WIN32_HELPER_TYPE = `
if (-not ([System.Management.Automation.PSTypeName]'E2EWin32').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class E2EWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
}
`;

/**
 * mawok.exe が持つトップレベルウィンドウそれぞれの { hwnd, title, visible, isForeground } を返す
 * (hwnd は 10 進の文字列)。
 * 下書きウィンドウは常に title === DRAFT_TITLE (tauri.conf.json の既定) で、設定ウィンドウは
 * 表示言語に応じた文言 ("設定" / "Settings") になる (src-tauri/src/i18n.rs の settings_title)
 */
async function getMawokWindowStates() {
	const script = `${WIN32_HELPER_TYPE}
$procIds = @(Get-Process -Name mawok -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$fg = [E2EWin32]::GetForegroundWindow()
$results = New-Object System.Collections.Generic.List[Object]
$callback = {
	param($hWnd, $lParam)
	$procId = 0
	[E2EWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
	if ($procIds -contains $procId) {
		$sb = New-Object System.Text.StringBuilder 256
		[E2EWin32]::GetWindowText($hWnd, $sb, 256) | Out-Null
		$results.Add([PSCustomObject]@{
			hwnd = $hWnd.ToInt64().ToString()
			title = $sb.ToString()
			visible = [bool]([E2EWin32]::IsWindowVisible($hWnd))
			isForeground = ($hWnd -eq $fg)
		})
	}
	return $true
}
[E2EWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
, $results | ConvertTo-Json -Compress
`;
	const stdout = await runPowerShell(script);
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed);
	return Array.isArray(parsed) ? parsed : [parsed];
}

/** 前面のウィンドウのハンドル (10進の文字列。ウィンドウがなければ '0') */
export async function getForegroundWindowHandle() {
	const stdout = await runPowerShell(
		`${WIN32_HELPER_TYPE}\n[E2EWin32]::GetForegroundWindow().ToInt64()`
	);
	return stdout.trim();
}

/** 下書きウィンドウが実際に (ネイティブウィンドウとして) 表示されているか */
export async function isDraftWindowVisible() {
	const windows = await getMawokWindowStates();
	return windows.some((w) => w.title === DRAFT_TITLE && w.visible);
}

/**
 * mawok.exe と、その子孫のプロセス (WebView2 の msedgewebview2.exe など) が持つ、表示中のトップレベルウィンドウの
 * タイトルの一覧。キーで WebView2 の別の画面 (検索や印刷など) が開いていないかを見るのに使う。
 * `includeChildren` を付けると、表示中の子ウィンドウも「クラス名:タイトル」で並べる (WebView2 の中に出る
 * ダウンロードの一覧のような、トップレベルのウィンドウを作らない画面も拾うため)
 */
export async function listVisibleMawokTreeWindows({ includeChildren = false } = {}) {
	const stdout = await runPowerShell(
		`${WIN32_HELPER_TYPE}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$tree = New-Object System.Collections.Generic.HashSet[uint32]
Get-Process -Name mawok -ErrorAction SilentlyContinue | ForEach-Object { [void]$tree.Add([uint32]$_.Id) }
do {
    $added = $false
    foreach ($p in $processes) {
        if ($tree.Contains([uint32]$p.ParentProcessId) -and $tree.Add([uint32]$p.ProcessId)) { $added = $true }
    }
} while ($added)
$titles = New-Object System.Collections.Generic.List[string]
$callback = {
    param($hWnd, $lParam)
    $procId = 0
    [E2EWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
    if ($tree.Contains([uint32]$procId) -and [E2EWin32]::IsWindowVisible($hWnd)) {
        $sb = New-Object System.Text.StringBuilder 256
        [E2EWin32]::GetWindowText($hWnd, $sb, 256) | Out-Null
        $titles.Add($sb.ToString())
        if ($includeChildren) {
            [E2EWin32]::EnumChildWindows($hWnd, $childCallback, [IntPtr]::Zero) | Out-Null
        }
    }
    return $true
}
$includeChildren = $args[0] -eq 'children'
$childCallback = {
    param($hWnd, $lParam)
    if ([E2EWin32]::IsWindowVisible($hWnd)) {
        $cls = New-Object System.Text.StringBuilder 256
        [E2EWin32]::GetClassName($hWnd, $cls, 256) | Out-Null
        $sb = New-Object System.Text.StringBuilder 256
        [E2EWin32]::GetWindowText($hWnd, $sb, 256) | Out-Null
        $titles.Add('  ' + $cls.ToString() + ':' + $sb.ToString())
    }
    return $true
}
[E2EWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
ConvertTo-Json -InputObject @($titles) -Compress
`,
		[includeChildren ? 'children' : 'top']
	);
	return JSON.parse(stdout);
}

// クリップボードに載っている形式の一覧を読む。履歴に残さない印は、本文とは別の「形式」として
// 同じクリップボードに載る (arboard の exclude_from_monitoring が
// `ExcludeClipboardContentFromMonitorProcessing` を登録して置く) ので、印が付いたかどうかは
// 形式の名前で見る。標準の形式 (CF_UNICODETEXT など) には名前がなく、GetClipboardFormatName が
// 0 を返すので、その場合は番号を文字列にして返す
const CLIPBOARD_FORMATS_TYPE = `
if (-not ([System.Management.Automation.PSTypeName]'E2EClipboardFormats').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class E2EClipboardFormats {
    [DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] public static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClipboardFormatName(uint format, StringBuilder lpszFormatName, int cchMaxCount);
}
"@
}
`;

/**
 * 今クリップボードに載っている形式の名前の一覧。登録された形式は名前 (例:
 * `ExcludeClipboardContentFromMonitorProcessing`)、標準の形式は番号の文字列で返す。
 * ほかのアプリがクリップボードを開いている間は開けないので、少し待って数回試す
 */
export async function getClipboardFormats() {
	const stdout = await runPowerShell(`${CLIPBOARD_FORMATS_TYPE}
$opened = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ([E2EClipboardFormats]::OpenClipboard([IntPtr]::Zero)) { $opened = $true; break }
    Start-Sleep -Milliseconds 50
}
if (-not $opened) { throw 'クリップボードを開けませんでした' }
try {
    $names = New-Object System.Collections.Generic.List[string]
    $format = [E2EClipboardFormats]::EnumClipboardFormats(0)
    while ($format -ne 0) {
        $sb = New-Object System.Text.StringBuilder 256
        $length = [E2EClipboardFormats]::GetClipboardFormatName($format, $sb, 256)
        if ($length -gt 0) { $names.Add($sb.ToString()) } else { $names.Add([string]$format) }
        $format = [E2EClipboardFormats]::EnumClipboardFormats($format)
    }
    ConvertTo-Json -InputObject @($names) -Compress
} finally {
    [void][E2EClipboardFormats]::CloseClipboard()
}
`);
	return JSON.parse(stdout.trim());
}

// Win+V のクリップボードの履歴は、WinRT の Clipboard.GetHistoryItemsAsync で読める。
// Windows PowerShell では WinRT の非同期の結果を AsTask で Task にして待つ
const CLIPBOARD_HISTORY_PRELUDE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Wait-WinRt($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    [void]$task.Wait(10000)
    $task.Result
}
function Get-HistoryItems {
    $result = Wait-WinRt ([Windows.ApplicationModel.DataTransfer.Clipboard]::GetHistoryItemsAsync()) ([Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult])
    if ([string]$result.Status -ne 'Success') { throw "クリップボードの履歴を読めませんでした: $($result.Status)" }
    @($result.Items)
}
function Get-HistoryText($item) {
    if (-not $item.Content.Contains('Text')) { return $null }
    Wait-WinRt ($item.Content.GetTextAsync()) ([string])
}
`;

// Windows の外観 (「設定 → 個人用設定 → 色」のアプリのモード)。1 がライト、0 がダーク。
// 書き換えたら WM_SETTINGCHANGE ("ImmersiveColorSet") を全体に送ると、WebView2 の prefers-color-scheme も変わる
const PERSONALIZE_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
// 控えた外観。中断されても次の実行が書き戻せるよう、ログイン時の起動の登録と同じくテストのプロセスの外に置く
const APPS_THEME_BACKUP_PATH = recordPath('.apps-theme-backup.json');

/** アプリのモードを書き、全体に知らせる。`value` が null なら値を消す (はじめから無かったとき) */
async function writeAppsUseLightTheme(value) {
	await runPowerShell(
		`
if (-not ([System.Management.Automation.PSTypeName]'E2ESettingChange').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E2ESettingChange {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
    public static void Broadcast(string area) {
        IntPtr result;
        SendMessageTimeout(new IntPtr(0xffff), 0x001A, IntPtr.Zero, area, 0x0002, 5000, out result);
    }
}
"@
}
if ($args[1] -eq 'null') { Remove-ItemProperty -Path $args[0] -Name AppsUseLightTheme -ErrorAction SilentlyContinue }
else { Set-ItemProperty -Path $args[0] -Name AppsUseLightTheme -Value ([int]$args[1]) -Type DWord }
[E2ESettingChange]::Broadcast('ImmersiveColorSet')
`,
		[PERSONALIZE_KEY, value === null ? 'null' : String(value)]
	);
}

/**
 * Windows の外観 (アプリのモード) を控え、`set(light)` で切り替えられるようにする。返ってきた `restore` で元に戻す。
 * 控えはファイルにも残し、中断されたときは `recoverStaleAppsThemeIfAny` が書き戻す
 *
 * @returns {Promise<{ set: (light: boolean) => Promise<void>, restore: () => Promise<void> }>}
 */
export async function snapshotAppsTheme() {
	const stdout = await runPowerShell(
		`$value = (Get-ItemProperty -Path $args[0] -ErrorAction SilentlyContinue).AppsUseLightTheme
if ($null -eq $value) { 'null' } else { [string]$value }`,
		[PERSONALIZE_KEY]
	);
	const original = stdout.trim() === 'null' ? null : Number(stdout.trim());
	await writeJsonAtomic(APPS_THEME_BACKUP_PATH, {
		savedAt: new Date().toISOString(),
		value: original
	});
	return {
		set: (light) => writeAppsUseLightTheme(light ? 1 : 0),
		async restore() {
			await writeAppsUseLightTheme(original);
			await fs.rm(APPS_THEME_BACKUP_PATH, { force: true });
		}
	};
}

/** 前回の実行が中断されて、Windows の外観の控えが残っていれば書き戻す */
export async function recoverStaleAppsThemeIfAny() {
	const record = await readBackupRecord(
		APPS_THEME_BACKUP_PATH,
		isValidAppsThemeRecord,
		`${APPS_THEME_BACKUP_PATH} が読めません。「設定 → 個人用設定 → 色」のアプリのモードを確かめてから、このファイルを消してください`
	);
	if (record === null) return false;
	console.warn(`[e2e] 前回の実行 (${record.savedAt}) で切り替えた Windows の外観を書き戻します。`);
	await writeAppsUseLightTheme(record.value);
	await fs.rm(APPS_THEME_BACKUP_PATH, { force: true });
	return true;
}

function isValidAppsThemeRecord(record) {
	return [null, 0, 1].includes(record?.value);
}

/** Win+V のクリップボードの履歴がオンか (「設定 → システム → クリップボード」) */
export async function isClipboardHistoryEnabled() {
	const stdout = await runPowerShell(
		`[string](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Clipboard' -ErrorAction SilentlyContinue).EnableClipboardHistory`
	);
	return stdout.trim() === '1';
}

/**
 * Win+V のクリップボードの履歴に、本文が `text` の項目があるか。新しいほうから `depth` 件だけ見る。
 * 利用者の履歴の中身は読むだけで、返すのはあるかどうかだけ
 */
export async function isInClipboardHistory(text, depth = 10) {
	const stdout = await runPowerShell(
		`${CLIPBOARD_HISTORY_PRELUDE}
$found = $false
foreach ($item in @(Get-HistoryItems | Select-Object -First ([int]$args[1]))) {
    if ((Get-HistoryText $item) -eq $args[0]) { $found = $true; break }
}
[string]$found
`,
		[text, String(depth)]
	);
	return stdout.trim() === 'True';
}

/** Win+V のクリップボードの履歴から、本文が `text` の項目を消す (テストがコピーした分の後始末) */
export async function removeFromClipboardHistory(text) {
	await runPowerShell(
		`${CLIPBOARD_HISTORY_PRELUDE}
foreach ($item in @(Get-HistoryItems)) {
    if ((Get-HistoryText $item) -eq $args[0]) { [void][Windows.ApplicationModel.DataTransfer.Clipboard]::DeleteItemFromHistory($item) }
}
`,
		[text]
	);
}

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// タスクマネージャーの「スタートアップ アプリ」でのオン・オフ。登録するとき (auto-launch の enable) は、ここにもオンを書く
const STARTUP_APPROVED_KEY =
	'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

// 控えたログイン時の起動の登録。config.toml の控え (config.mjs) と同じく、中断されても次の実行が書き戻せるよう、
// テストのプロセスの外 (e2e/ 直下) に置く
const AUTOSTART_BACKUP_PATH = recordPath('.autostart-backup.json');

async function applyAutostartRecord({ name, run, approved }) {
	const remove = (key) =>
		`Remove-ItemProperty -Path '${key}' -Name '${name}' -ErrorAction SilentlyContinue`;
	const restoreRun =
		run === null
			? remove(RUN_KEY)
			: `Set-ItemProperty -Path '${RUN_KEY}' -Name '${name}' -Value '${String(run).replace(/'/g, "''")}'`;
	const restoreApproved =
		approved === null
			? remove(STARTUP_APPROVED_KEY)
			: `if (-not (Test-Path '${STARTUP_APPROVED_KEY}')) { New-Item -Path '${STARTUP_APPROVED_KEY}' -Force | Out-Null }
New-ItemProperty -Path '${STARTUP_APPROVED_KEY}' -Name '${name}' -PropertyType Binary -Value ([Convert]::FromBase64String('${approved}')) -Force | Out-Null`;
	await runPowerShell(`${restoreRun}\n${restoreApproved}`);
}

// PowerShell のコマンドにそのまま埋め込むので、登録の名前は英数字と _ . - だけに限る
const AUTOSTART_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * ログイン時の起動の登録を、2か所 (HKCU の Run と、タスクマネージャーでのオン・オフ) まとめて読む PowerShell。
 * 控える側 (`snapshotAutostartEntry`) と読む側 (`readAutostartEntry`) がずれると、
 * 控えと見比べても意味がなくなるので、同じ文を使う
 */
const readAutostartScript = (name) => `
$run = (Get-ItemProperty -Path '${RUN_KEY}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'
$approved = (Get-ItemProperty -Path '${STARTUP_APPROVED_KEY}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'
[PSCustomObject]@{
    run = $run
    approved = $(if ($null -eq $approved) { $null } else { [Convert]::ToBase64String([byte[]]$approved) })
} | ConvertTo-Json -Compress
`;

/**
 * 書き戻すときに PowerShell の Convert.FromBase64String が必ず読める Base64 か。文字の種類だけでなく、
 * 長さが4の倍数で、デコードしてエンコードし直すと同じ文字列に戻ることまで見る
 * (読めない値だと、Run だけ書き戻した後に失敗して、登録が半端に戻ったまま控えが残る)
 */
function isCanonicalBase64(value) {
	return (
		typeof value === 'string' &&
		/^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
		value.length % 4 === 0 &&
		Buffer.from(value, 'base64').toString('base64') === value
	);
}

function isValidAutostartRecord(record) {
	return (
		record !== null &&
		typeof record === 'object' &&
		typeof record.savedAt === 'string' &&
		typeof record.name === 'string' &&
		AUTOSTART_NAME_PATTERN.test(record.name) &&
		(record.run === null || typeof record.run === 'string') &&
		(record.approved === null || isCanonicalBase64(record.approved))
	);
}

function assertAutostartName(name) {
	if (!AUTOSTART_NAME_PATTERN.test(name)) {
		throw new Error(`ログイン時の起動の登録の名前は英数字と _ . - だけで渡してください: ${name}`);
	}
}

/**
 * ログイン時の起動の登録 (HKCU の Run の値と、タスクマネージャーでのオン・オフ) を控え、返ってきた `restore` で元に戻す。
 * アプリは起動時に設定に合わせて登録を揃える。既定の設定 (オン) で起動したとき、ユーザーが登録を切っていたり、
 * タスクマネージャーで無効にしていたりすると、登録し直して (E2E が起動した実行ファイルのパスで) オンにしてしまう。
 * 控えはファイルにも残し、Ctrl+C などで中断されたときや強制終了された後の次の実行で、
 * `recoverStaleAutostartBackupIfAny` が書き戻す
 *
 * @returns {Promise<{ restore: () => Promise<void> }>}
 */
export async function snapshotAutostartEntry(name = 'Mawok') {
	assertAutostartName(name);
	const stdout = await runPowerShell(readAutostartScript(name));
	const { run, approved } = JSON.parse(stdout.trim());
	const record = { savedAt: new Date().toISOString(), name, run, approved };
	await writeJsonAtomic(AUTOSTART_BACKUP_PATH, record);
	return {
		async restore() {
			await applyAutostartRecord(record);
			await fs.rm(AUTOSTART_BACKUP_PATH, { force: true });
		}
	};
}

/**
 * run.mjs が、テスト全体の前後で1度だけログイン時の起動の登録を控えて戻していることを、テストのプロセスに伝える環境変数。
 * テストファイルごとに控えて戻すと、常用版の登録を外す・書き戻すが1回の E2E で何十回も起き、
 * Windows Defender が Behavior:Win32/Persistence.A!ml と見て常用版を取り除く
 */
export const AUTOSTART_HELD_ENV = 'MAWOK_E2E_AUTOSTART_HELD';

/** ログイン時の起動の登録 (HKCU の Run の値と、タスクマネージャーでのオン・オフ) を外す。先に `snapshotAutostartEntry` で控えること */
export async function clearAutostartEntry(name = 'Mawok') {
	assertAutostartName(name);
	await applyAutostartRecord({ name, run: null, approved: null });
}

/**
 * 今のログイン時の起動の登録を読む。`run` は HKCU の Run に書かれた値 (登録がなければ null)、
 * `approved` はタスクマネージャーの「スタートアップ アプリ」でのオン・オフの値を Base64 にしたもの
 * (値がなければ null)。控えと書き戻し (`snapshotAutostartEntry`) と同じ2か所を見る
 *
 * @returns {Promise<{ run: string | null, approved: string | null }>}
 */
export async function readAutostartEntry(name = 'Mawok') {
	assertAutostartName(name);
	const stdout = await runPowerShell(readAutostartScript(name));
	return JSON.parse(stdout.trim());
}

/**
 * `readAutostartEntry` の `approved` が、タスクマネージャーの「スタートアップ アプリ」で
 * 有効を指しているか。auto-launch (tauri-plugin-autostart の中身) が書く 12 バイトのうち、
 * 後ろ8バイトが無効にした時刻で、すべて 0 なら有効。値がなければ、同じく有効とみなす
 * (auto-launch の `is_enabled` が `unwrap_or(true)` としているのに合わせる)
 */
export function isAutostartApprovedEnabled(approved) {
	if (approved === null) return true;
	const bytes = Buffer.from(approved, 'base64');
	if (bytes.length < 8) return true;
	return bytes.subarray(bytes.length - 8).every((byte) => byte === 0);
}

/**
 * 前回の実行が中断されて、ログイン時の起動の登録の控えが残っていれば書き戻す。
 * 控えが壊れているときは、誤って書き換えないよう、書き戻さずにはっきり失敗させる
 */
export async function recoverStaleAutostartBackupIfAny() {
	const record = await readBackupRecord(
		AUTOSTART_BACKUP_PATH,
		isValidAutostartRecord,
		`${AUTOSTART_BACKUP_PATH} の内容が読めないため、ログイン時の起動の登録を書き戻せません。` +
			'HKCU の Run と Explorer\\StartupApproved\\Run の Mawok の値を確かめ、問題なければこのファイルを削除してから再実行してください。'
	);
	if (record === null) return false;
	console.warn(
		`[e2e] 前回の実行 (${record.savedAt}) のログイン時の起動の登録の控えが残っていたので書き戻します。`
	);
	await applyAutostartRecord(record);
	await fs.rm(AUTOSTART_BACKUP_PATH, { force: true });
	return true;
}

/** 動いている mawok.exe のプロセス ID の一覧 */
async function listMawokProcessIds() {
	const stdout = await runPowerShell(
		'ConvertTo-Json -InputObject @(@(Get-Process -Name mawok -ErrorAction SilentlyContinue).Id) -Compress'
	);
	return JSON.parse(stdout.trim() || '[]');
}

/** mawok.exe のプロセスの数 */
export async function countMawokProcesses() {
	return (await listMawokProcessIds()).length;
}

/**
 * 動いている mawok.exe のプロセス ID。E2E は single-instance で1つしか動かさないので、
 * 2つ以上あればテストの前提が崩れている。動いていなければ null
 */
export async function getMawokProcessId() {
	const ids = await listMawokProcessIds();
	if (ids.length > 1)
		throw new Error(`mawok.exe が ${ids.length} 個動いています: ${ids.join(', ')}`);
	return ids[0] ?? null;
}

/**
 * mawok.exe の子孫の WebView2 の描画プロセス (`msedgewebview2.exe --type=renderer`) を、すべて強制終了する。
 * 描画プロセスが落ちたときの立て直しを見るのに使う。終了させた数を返す
 */
export async function killMawokRenderers() {
	const stdout = await runPowerShell(`
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine)
$tree = New-Object System.Collections.Generic.HashSet[uint32]
Get-Process -Name mawok -ErrorAction SilentlyContinue | ForEach-Object { [void]$tree.Add([uint32]$_.Id) }
do {
    $added = $false
    foreach ($p in $all) {
        if ($tree.Contains([uint32]$p.ParentProcessId) -and $tree.Add([uint32]$p.ProcessId)) { $added = $true }
    }
} while ($added)
$renderers = @($all | Where-Object { $tree.Contains([uint32]$_.ProcessId) -and $_.CommandLine -like '*--type=renderer*' })
$renderers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$renderers.Count`);
	return Number(stdout.trim());
}

/**
 * 前面のウィンドウを、ハンドル・タイトル・プロセス名で言い表す (思わぬウィンドウが前面に出て落ちたときの手がかり)
 */
export async function describeForegroundWindow() {
	const stdout = await runPowerShell(`${WIN32_HELPER_TYPE}
$fg = [E2EWin32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[E2EWin32]::GetWindowText($fg, $sb, 256) | Out-Null
$procId = 0
[E2EWin32]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
$name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
"hwnd=$($fg.ToInt64()) title=$($sb.ToString()) process=$name"`);
	return stdout.trim();
}

/** 表示中で、タイトルが `title` の Mawok のウィンドウのハンドル (10 進の文字列)。なければ null */
export async function findVisibleMawokWindow(title) {
	const windows = await getMawokWindowStates();
	return windows.find((w) => w.title === title && w.visible)?.hwnd ?? null;
}

/** 表示中の下書きウィンドウのハンドル (10 進の文字列)。表示されていなければ失敗させる */
export async function getDraftWindowHandle() {
	const windows = await getMawokWindowStates();
	const draft = windows.find((w) => w.title === DRAFT_TITLE && w.visible);
	if (!draft) throw new Error('表示中の下書きウィンドウが見つかりません');
	return draft.hwnd;
}
