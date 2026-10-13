import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, PROFILE, PROFILE_ENV, PROFILE_IDENTIFIER } from './app-conf.mjs';
import { APP_DATA_DIRS } from './config.mjs';
import { readBackupRecordSync, recordPath, writeJsonAtomicSync } from './files.mjs';
import { describeForegroundWindow, isMawokRunning, powerShellArgs, runPowerShell } from './os.mjs';
import { waitFor } from './wait.mjs';
import { readTaskbarButtons, WINDOW_TYPE } from './window.mjs';

// MSIX 版の確認 (`just msix-check`) で使う、パッケージの出し入れと読み取り。
//
// MSIX 版は tauri-driver で動かせない (パッケージの中の mawok.exe を WebDriver から起動できない) ので、
// パッケージの中から WebView2 の開発者ツールの口 (CDP) を開けて起動し、画面が呼ぶのと同じコマンドを
// `window.__TAURI_INTERNALS__.invoke` で送る。結果は OS の側 (レジストリ・エクスプローラー・ファイアウォール・
// 通知の履歴・タスクバーの画素・ファイル) で読む。
//
// ここのスクリプトは、立ち上げたままの PowerShell (`os.mjs` の runPowerShell) の中で動く。`exit` は書かない

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** scripts/msix.mjs の IDENTITY.name と、AppxManifest.xml の Application の Id */
const PACKAGE_NAME = 'amiiby.Mawok';
const APPLICATION_ID = 'Mawok';
/** AppxManifest.xml の StartupTask の TaskId */
const STARTUP_TASK_ID = 'Mawok';

/** `just msix` が作る MSIX のパス (版番号は tauri.conf.json から) */
export function builtMsixPath() {
	return path.join(
		repoRoot,
		'src-tauri',
		'target',
		'release',
		'bundle',
		'msix',
		`Mawok_${APP_VERSION}_x64.msix`
	);
}

/**
 * 入っている MSIX 版。入っていなければ null
 *
 * @returns {Promise<{ familyName: string, installLocation: string, version: string } | null>}
 */
export async function readPackage() {
	const stdout = await runPowerShell(
		`
$p = Get-AppxPackage -Name $args[0]
if ($null -eq $p) { return 'null' }
ConvertTo-Json -Compress -InputObject @{ familyName = $p.PackageFamilyName; installLocation = $p.InstallLocation; version = [string]$p.Version }
`,
		[PACKAGE_NAME]
	);
	return JSON.parse(stdout.trim());
}

/** パッケージの AUMID (通知の差出人・スタートメニューからの起動に使う名前) */
export function appUserModelId(pkg) {
	return `${pkg.familyName}!${APPLICATION_ID}`;
}

/** MSIX を入れる。同じ版番号のまま上から入れられないので、先に `removePackage` で外しておく */
export async function addPackage(msixPath) {
	await runPowerShell('Add-AppxPackage -Path $args[0]', [msixPath]);
}

/** MSIX 版を外す。入っていなければ何もしない */
export async function removePackage() {
	await runPowerShell('Get-AppxPackage -Name $args[0] | Remove-AppxPackage', [PACKAGE_NAME]);
}

/** 動いている mawok.exe を終わらせ、いなくなるまで待つ */
export async function stopMawok() {
	await runPowerShell('Stop-Process -Name mawok -Force -ErrorAction SilentlyContinue');
	await waitFor(isMawokRunning, (running) => !running, {
		label: 'mawok.exe の終了',
		timeout: 10000
	});
}

/**
 * mawok.exe を、同期で終わらせる。待たない。中断のシグナルを受けたときに、非同期の後始末より先に止めるのに使う
 * (パッケージの中から起動した Mawok はコンソールの外で動いているので、Ctrl+C では止まらない)
 */
export function stopMawokSync() {
	try {
		execFileSync('taskkill', ['/F', '/IM', 'mawok.exe'], { stdio: 'ignore' });
	} catch {
		// 動いていなければ失敗するが、それでよい
	}
}

/** 動いている mawok.exe の実行ファイルのパスの一覧 (パッケージの版か EXE 版かを見分けるのに使う) */
export async function listRunningMawokPaths() {
	const stdout = await runPowerShell(
		'ConvertTo-Json -Compress -InputObject @(@(Get-Process -Name mawok -ErrorAction SilentlyContinue).Path)'
	);
	return JSON.parse(stdout.trim() || '[]');
}

/** EXE 版を、実行ファイルのパスから起動する */
export async function launchExecutable(exePath) {
	await runPowerShell('Start-Process -FilePath $args[0]', [exePath]);
}

/**
 * パッケージの中から、CDP を `port` で開けて mawok.exe を起動し、下書きの画面が読み込まれるまで待つ。
 * WebView2 は環境変数 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` を読むので、それを付けた cmd を
 * `Invoke-CommandInDesktopPackage` でパッケージの中に起こし、そこから mawok.exe を始める。
 * `env` は、mawok.exe に足して渡す環境変数 (値に空白や cmd の記号を入れない)
 */
export async function launchInPackage(pkg, port, env = {}) {
	env = { [PROFILE_ENV]: PROFILE, ...env };
	const exe = path.join(pkg.installLocation, 'mawok.exe');
	const extra = Object.entries(env)
		.map(([name, value]) => `set ${name}=${value}&& `)
		.join('');
	await runPowerShell(
		`
Invoke-CommandInDesktopPackage -PackageFamilyName $args[0] -AppId $args[1] -Command 'cmd.exe' -Args ('/c set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=' + $args[2] + '&& ' + $args[4] + 'start "" "' + $args[3] + '"')
`,
		[pkg.familyName, APPLICATION_ID, String(port), exe, extra]
	);
	await waitFor(
		() =>
			evaluate(
				port,
				"document.readyState === 'complete' && !!document.querySelector('textarea')"
			).catch(() => false),
		(ready) => ready === true,
		{ label: 'パッケージの中から起動した下書きの画面の読み込み', timeout: 30000, interval: 500 }
	);
}

/** ふつうの起動 (スタートメニューから開くのと同じ) */
export async function launchNormally(pkg) {
	await runPowerShell('Start-Process ("shell:AppsFolder\\" + $args[0])', [appUserModelId(pkg)]);
}

/** CDP の口に出ているページの一覧 */
async function listPages(port) {
	const response = await fetch(`http://127.0.0.1:${port}/json`);
	const targets = await response.json();
	return targets.filter((target) => target.type === 'page');
}

/** 画面ごとの URL のパス (下書きは `/`、設定は `/settings`) */
export const PAGE = Object.freeze({ draft: '/', settings: '/settings' });

/** ページの中で式を評価し、値を返す。Promise は待つ。例外は投げ直す。`page` は `PAGE` のどれか */
export async function evaluate(port, expression, { page = PAGE.draft } = {}) {
	const pages = await listPages(port);
	const target = pages.find((candidate) => new URL(candidate.url).pathname === page);
	if (!target) throw new Error(`CDP (${port}) に ${page} のページがありません`);
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	try {
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = () => reject(new Error(`CDP (${port}) につなげません`));
		});
		const reply = await new Promise((resolve, reject) => {
			socket.onmessage = (event) => {
				const message = JSON.parse(event.data);
				if (message.id === 1) resolve(message);
			};
			socket.onerror = () => reject(new Error(`CDP (${port}) が切れました`));
			socket.send(
				JSON.stringify({
					id: 1,
					method: 'Runtime.evaluate',
					params: { expression, awaitPromise: true, returnByValue: true }
				})
			);
		});
		if (reply.error) throw new Error(`CDP の評価に失敗しました: ${JSON.stringify(reply.error)}`);
		if (reply.result.exceptionDetails) {
			const details = reply.result.exceptionDetails;
			throw new Error(details.exception?.description ?? details.text);
		}
		return reply.result.result.value;
	} finally {
		socket.close();
	}
}

/**
 * 画面が呼ぶのと同じコマンドを送る。コマンドの失敗 (Rust の Err) は、`{ error }` で返す
 *
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: unknown }>}
 */
async function invokeCommand(port, command, args = {}) {
	const expression = `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))`;
	return evaluate(port, expression);
}

/** `invokeCommand` で、失敗したら投げる */
export async function invokeOrThrow(port, command, args = {}) {
	const result = await invokeCommand(port, command, args);
	if (!result.ok) throw new Error(`${command} が失敗しました: ${JSON.stringify(result.error)}`);
	return result.value;
}

// StartupTask の状態は、パッケージのデータの下のレジストリに置かれる。
// 値は Windows.ApplicationModel.StartupTaskState と同じ (0: Disabled、1: DisabledByUser、2: Enabled)
function startupTaskKey(pkg) {
	return `HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\${pkg.familyName}\\${STARTUP_TASK_ID}`;
}

export const STARTUP_TASK_STATE = Object.freeze({ disabled: 0, disabledByUser: 1, enabled: 2 });

/** StartupTask の状態。まだ一度も読み書きされていなければ null */
export async function readStartupTaskState(pkg) {
	const stdout = await runPowerShell(
		`
$item = Get-ItemProperty -LiteralPath $args[0] -ErrorAction SilentlyContinue
if ($null -eq $item -or $null -eq $item.State) { return 'null' }
[string]$item.State
`,
		[startupTaskKey(pkg)]
	);
	return JSON.parse(stdout.trim());
}

/** StartupTask の状態の値を消す (まだ一度も読み書きされていない状態に戻す) */
export async function clearStartupTaskState(pkg) {
	await runPowerShell(
		'Remove-ItemProperty -LiteralPath $args[0] -Name State -ErrorAction SilentlyContinue',
		[startupTaskKey(pkg)]
	);
}

/**
 * StartupTask の状態を書き換える。Windows の設定の「スタートアップ アプリ」で切った状態 (DisabledByUser) を
 * 作るのに使う (State を 1 にすると RequestEnableAsync が DisabledByUser を返すことを、Windows 11 の実機で確かめた)
 */
export async function writeStartupTaskState(pkg, state) {
	await runPowerShell(
		`
if (-not (Test-Path -LiteralPath $args[0])) { New-Item -Path $args[0] -Force | Out-Null }
Set-ItemProperty -LiteralPath $args[0] -Name State -Value ([int]$args[1]) -Type DWord
`,
		[startupTaskKey(pkg), String(state)]
	);
}

/**
 * Windows の設定を閉じ、その窓が前面から消えるまで待つ。
 * 止めた後も窓 (ApplicationFrameHost) はしばらく残り、消えるときに前面が替わる。待たずにトレイのメニューを出すと、
 * 出たばかりのメニューがその前面の入れ替わりで閉じ、項目を読めない
 */
export async function closeSystemSettings() {
	await runPowerShell(`
$settings = @(Get-Process -Name SystemSettings -ErrorAction SilentlyContinue)
if ($settings.Count -gt 0) {
    $settings | Stop-Process -Force -ErrorAction SilentlyContinue
    $settings | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
}
`);
	await waitFor(
		describeForegroundWindow,
		(text) => !/title=(設定|Settings) process=ApplicationFrameHost/.test(text),
		{ label: 'Windows の設定が前面から消える' }
	);
}

// 通知の履歴は、差出人の AUMID ごとに OS が持っている。パッケージの外からも AUMID を渡せば読めるので、
// 集中モードでポップアップが出ない時間帯でも、差出人がパッケージとして受け付けられたかを見られる
const TOAST_TYPE = `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`;

/** AUMID の差出人で届いている通知の、見出しの一覧 */
export async function readToastTitles(aumid) {
	const stdout = await runPowerShell(
		`${TOAST_TYPE}
$titles = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($args[0]) | ForEach-Object {
    $_.Content.GetElementsByTagName('text') | Select-Object -First 1 | ForEach-Object { $_.InnerText }
})
ConvertTo-Json -Compress -InputObject $titles
`,
		[aumid]
	);
	return JSON.parse(stdout.trim() || '[]');
}

/** AUMID の差出人の通知を、通知センターから消す */
export async function clearToasts(aumid) {
	await runPowerShell(
		`${TOAST_TYPE}
[Windows.UI.Notifications.ToastNotificationManager]::History.Clear($args[0])
`,
		[aumid]
	);
}

/** 開いているエクスプローラーの窓 (Shell.Application の Windows) の、ハンドル・場所・選ばれた項目 */
async function listExplorerWindows() {
	const stdout = await runPowerShell(`
$shell = New-Object -ComObject Shell.Application
$windows = @($shell.Windows() | ForEach-Object {
    $folder = $null
    $selected = @()
    try { $folder = $_.Document.Folder.Self.Path } catch {}
    try { $selected = @($_.Document.SelectedItems() | ForEach-Object { $_.Path }) } catch {}
    @{ hwnd = [string]$_.HWND; folder = $folder; selected = $selected }
})
ConvertTo-Json -Compress -Depth 3 -InputObject $windows
`);
	return JSON.parse(stdout.trim() || '[]');
}

/**
 * エクスプローラーの窓を閉じる。Shell.Application の窓の `Quit()` は、Windows 11 のタブのあるエクスプローラーでは
 * 閉じない (Windows 11 の実機で確かめた) ので、窓に WM_CLOSE を送る
 */
async function closeExplorerWindow(hwnd) {
	await runPowerShell(
		`
if (-not ([System.Management.Automation.PSTypeName]'E2EMsixWindow').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E2EMsixWindow {
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
}
[void][E2EMsixWindow]::PostMessage([IntPtr][long]$args[0], 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
`,
		[hwnd]
	);
	await waitFor(
		async () => (await listExplorerWindows()).some((window) => window.hwnd === hwnd),
		(open) => !open,
		{ label: 'エクスプローラーの窓が閉じる' }
	);
}

/**
 * `command` (reveal_config_file・reveal_log_file) を送り、新しく開いたエクスプローラーの窓の場所と選ばれた項目を返す。
 * 開いた窓は閉じる。選ばれた項目は、窓が開いてから少し遅れて付くので、付くまで待つ
 *
 * @returns {Promise<{ folder: string | null, selected: string[] }>}
 */
export async function revealAndRead(port, command) {
	const before = new Set((await listExplorerWindows()).map((window) => window.hwnd));
	await invokeOrThrow(port, command);
	const opened = await waitFor(
		async () => (await listExplorerWindows()).find((window) => !before.has(window.hwnd)) ?? null,
		(window) => window !== null && window.folder !== null && window.selected.length > 0,
		{ label: `${command} で開いたエクスプローラーの窓`, timeout: 15000, interval: 300 }
	);
	await closeExplorerWindow(opened.hwnd);
	return { folder: opened.folder, selected: opened.selected };
}

/**
 * 受信の規則のうち、`program` を指すものの向き・可否・ネットワークの種類・通信の種類
 *
 * @returns {Promise<Array<{ direction: string, action: string, profile: string, protocol: string, enabled: string }>>}
 */
export async function readFirewallRules(program) {
	const stdout = await runPowerShell(
		`
$rules = @(Get-NetFirewallApplicationFilter -Program $args[0] -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Get-NetFirewallRule | ForEach-Object {
    $port = $_ | Get-NetFirewallPortFilter
    @{ direction = [string]$_.Direction; action = [string]$_.Action; profile = [string]$_.Profile; protocol = [string]$port.Protocol; enabled = [string]$_.Enabled }
})
ConvertTo-Json -Compress -InputObject $rules
`,
		[program]
	);
	return JSON.parse(stdout.trim() || '[]');
}

/**
 * 出ている、ファイアウォールの「Windows セキュリティの重要な警告」の窓のタイトルの一覧。
 * 受信の規則が無いアプリが初めて待ち受けたときに出る
 */
export async function listFirewallAlertWindows() {
	const stdout = await runPowerShell(`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$names = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) |
    ForEach-Object { $_.Current.Name } |
    Where-Object { $_ -like '*セキュリティの重要な警告*' -or $_ -like '*Security Alert*' })
ConvertTo-Json -Compress -InputObject $names
`);
	return JSON.parse(stdout.trim() || '[]');
}

/**
 * タスクバーの、名前が `name` で始まるボタンを撮り、アイコンがアクセントカラーの下地に載っているかを見る。
 * 下地は、アクセントの色の一覧 (Explorer\\Accent の AccentPalette の8色) のどれかで塗られる
 * (Windows 11 の実機では palette[3])。ボタンの下の4分の1は、動いている印の線 (これもアクセントの色) なので数えない。
 * タスクバーの背景もアクセントの色 (暗いほう) に染まることがあるので、ボタンの隅の背景に近い色は数えない。
 * 下地に載ったボタンでは13%ほど、下地なしのアイコンでは (背景が染まっていても) 0だった
 *
 * @returns {Promise<{ name: string, width: number, height: number, counted: number, accent: number }>}
 */
export async function measureTaskbarIconPlate(name = 'Mawok') {
	const button = (await readTaskbarButtons()).find((candidate) => candidate.name.startsWith(name));
	if (!button) throw new Error(`タスクバーに「${name}」のボタンがありません`);
	const { x, y, width, height } = button.rect;
	const stdout = await runPowerShell(
		`${WINDOW_TYPE}
Add-Type -AssemblyName System.Drawing
$x = [int]$args[0]; $y = [int]$args[1]; $width = [int]$args[2]; $height = [int]$args[3]
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
$graphics.Dispose()
$palette = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent').AccentPalette
$rows = [int]($height * 0.75)
$background = $bitmap.GetPixel([int]($width * 0.15), [int]($height * 0.15))
$accent = 0
for ($py = 0; $py -lt $rows; $py++) {
    for ($px = 0; $px -lt $width; $px++) {
        $c = $bitmap.GetPixel($px, $py)
        if ([math]::Abs($c.R - $background.R) + [math]::Abs($c.G - $background.G) + [math]::Abs($c.B - $background.B) -le 40) { continue }
        for ($i = 0; $i -lt 8; $i++) {
            if ([math]::Abs($c.R - $palette[$i * 4]) + [math]::Abs($c.G - $palette[$i * 4 + 1]) + [math]::Abs($c.B - $palette[$i * 4 + 2]) -lt 30) { $accent++; break }
        }
    }
}
$bitmap.Dispose()
ConvertTo-Json -Compress -InputObject @{ counted = $width * $rows; accent = $accent }
`,
		[x, y, width, height].map(String)
	);
	return { name: button.name, width, height, ...JSON.parse(stdout.trim()) };
}

// 待ち受けを始めさせるための、仮の共有の鍵。待ち受けは、共有の鍵を持つときにだけ始まる (docs/lan.md)。
// 鍵だけの項目 (トークンが無い = サインインしていない) を資格情報マネージャーに置いて起動する。
// トークンが無いので窓口へはつながらず、Pro の状態 (pro-state.json) も要らない
/** account_credentials.rs の項目名 (CREDENTIAL_USER) と、secrets.rs のサービス名 */
const SHARED_KEY_USER = 'mawok-account';
const SHARED_KEY_VALUE = JSON.stringify({ key: 'ab'.repeat(32) });
const credentialTarget = (user) => `${user}.${PROFILE_IDENTIFIER}`;

// 資格情報を、Mawok の読み書き (windows-native-keyring-store) に合わせて UTF-16LE で読み書きする。
// cmdkey の `/pass:` は二重引用符を含む値 (JSON) を受け取れず、中身も読めないので、CredWrite・CredRead を直接呼ぶ。
// 型の定義は呼ぶたびに同じ中身で流す (同じ定義の Add-Type は2回目から何もしない)
const CREDENTIAL_TYPE = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MawokE2eCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
        public int Persist; public int AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref CREDENTIAL credential, int flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);
    public static void Write(string target, string user, string value) {
        byte[] blob = System.Text.Encoding.Unicode.GetBytes(value);
        // Type 1 は CRED_TYPE_GENERIC、Persist 3 は CRED_PERSIST_ENTERPRISE (Mawok が書くときと同じ)。
        // CRED_PERSIST_LOCAL_MACHINE で置いた項目を Mawok が書き換えると、消した数分後に、置いたときの項目がまた現れる
        CREDENTIAL credential = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, Persist = 3, CredentialBlobSize = blob.Length };
        credential.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
            if (!CredWrite(ref credential, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            Marshal.FreeHGlobal(credential.CredentialBlob);
        }
    }
    // 無ければ null。読めなかったときは例外にする (無いものとして扱うと、利用者の資格情報を仮の鍵で上書きする)
    public static string Read(string target) {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            // 1168 は ERROR_NOT_FOUND
            if (error == 1168) return null;
            throw new System.ComponentModel.Win32Exception(error);
        }
        try {
            CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
            byte[] blob = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
            return System.Text.Encoding.Unicode.GetString(blob);
        } finally {
            CredFree(pointer);
        }
    }
}
"@
`;

async function writeCredential(target, user, value) {
	await runPowerShell(
		`${CREDENTIAL_TYPE}\n[MawokE2eCredential]::Write($args[0], $args[1], $args[2])`,
		[target, user, value]
	);
}

/** 無ければ null */
async function readCredential(target) {
	const stdout = await runPowerShell(
		`${CREDENTIAL_TYPE}\n$value = [MawokE2eCredential]::Read($args[0])\nif ($null -ne $value) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }`,
		[target]
	);
	const encoded = stdout.trim();
	return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null;
}

// 仮の鍵を置いている間の印。中断されて残ったら、中断のシグナルの処理か次の回が片付ける
const SHARED_KEY_RECORD_PATH = recordPath('.msix-shared-key.json');

/**
 * 仮の鍵を片付ける。置いたままの値のときだけ消す。
 * 中断の後に利用者が確認コードでデバイスを追加していれば、鍵は本物に替わっているので、触らない
 * (印だけ消す)。同期なので、中断のシグナルを受けたときにも呼べる
 */
function removeSharedKey() {
	const target = credentialTarget(SHARED_KEY_USER);
	try {
		const script = `${CREDENTIAL_TYPE}\n$value = [MawokE2eCredential]::Read('${target}')\nif ($value -ceq '${SHARED_KEY_VALUE}') { 'yes' }`;
		const remains = execFileSync('powershell', powerShellArgs(script), { encoding: 'utf8' }).trim();
		if (remains === 'yes') execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' });
	} catch {
		// 読めなかった・消せなかったときは、仮のものか見分けられないので置いたままにする。
		// 印も残し、次の回の始めにもう一度片付ける (印を消すと、仮の鍵が残ったまま誰も片付けなくなる)
		return;
	}
	fs.rmSync(SHARED_KEY_RECORD_PATH, { force: true });
}

/**
 * 置いたままの仮の鍵があれば、片付ける。Mawok を止めてから呼ぶ。
 * 同期なので、中断のシグナルを受けたときにも呼べる
 */
export function recoverSharedKeyIfAny() {
	if (fs.existsSync(SHARED_KEY_RECORD_PATH)) removeSharedKey();
}

/**
 * 待ち受けを始めさせる仮の鍵を置く。Mawok を止めた状態で呼ぶ。
 * この機にアカウントの資格情報が前からあれば (サインインしている・デバイスを追加済み)、触らずに null を返す
 *
 * @returns {Promise<{ restore: () => void } | null>}
 */
export async function beginSharedKey() {
	const target = credentialTarget(SHARED_KEY_USER);
	if ((await readCredential(target)) !== null) return null;
	writeJsonAtomicSync(SHARED_KEY_RECORD_PATH, { savedAt: new Date().toISOString() });
	await writeCredential(target, SHARED_KEY_USER, SHARED_KEY_VALUE);
	return { restore: removeSharedKey };
}

/** パッケージごとの場所 (`%LOCALAPPDATA%\Packages\<ファミリー名>`) */
export function packageDataDir(pkg) {
	return path.join(process.env.LOCALAPPDATA, 'Packages', pkg.familyName);
}

/** パッケージの LocalCache (AppData の下に作ったファイルが回される先) */
function localCacheDir(pkg) {
	return path.join(packageDataDir(pkg), 'LocalCache');
}

/** AppData の下に作られたファイルが回される先 (EXE 版のファイルが無い環境。docs/platform.md「Windows の MSIX 版」) */
export function redirectedDataDirs(pkg) {
	const cache = localCacheDir(pkg);
	return {
		roaming: path.join(cache, 'Roaming', PROFILE_IDENTIFIER),
		local: path.join(cache, 'Local', PROFILE_IDENTIFIER)
	};
}

// 試す前の状態 (入っていたか・StartupTask・動いていた Mawok) の記録。後始末が最後まで済むまで残す。
// Ctrl+C では config.mjs の後始末が process.exit で終わらせ、テストの後始末 (after) は走らないので、
// 次の回は、そのとき見える状態 (試した版が入ったまま、など) ではなく、この記録を元の状態として使う
const ORIGINAL_RECORD_PATH = recordPath('.msix-original.json');
// 元から入っていた MSIX 版の LocalCache の控え。EXE 版のファイルが無い環境の利用者は、設定・履歴・ログがここにあり、
// パッケージを外すとまるごと消えるので、外す前に写し、入れ直した後に戻す
const LOCAL_CACHE_BACKUP_DIR = recordPath('.msix-localcache');

/** 前の回が残した、試す前の状態の記録。なければ null */
export function readOriginalRecord() {
	return readBackupRecordSync(
		ORIGINAL_RECORD_PATH,
		(record) => record !== null && typeof record === 'object' && !Array.isArray(record),
		`${ORIGINAL_RECORD_PATH} が読めません。中身を確かめ、元の状態に戻してから消してください`
	);
}

export function writeOriginalRecord(original) {
	writeJsonAtomicSync(ORIGINAL_RECORD_PATH, { savedAt: new Date().toISOString(), ...original });
}

export function clearOriginalRecord() {
	fs.rmSync(ORIGINAL_RECORD_PATH, { force: true });
}

/**
 * 入っている MSIX 版の LocalCache を、e2e/ の下に写す。写したら `'copied'`、中身が無ければ `'empty'` を返す
 * (どちらも試す前の状態の記録に残し、後始末はそれを見て戻す)。
 * 前の控えが残っていれば、上書きせずに落とす (戻し損ねた利用者のデータかもしれない)。
 * 写す途中で落ちたら、写しかけの控えは消す (元の LocalCache はそのままなので、残すと次の回を止めるだけになる)
 *
 * @returns {Promise<'copied' | 'empty'>}
 */
export async function backupLocalCache(pkg) {
	if (fs.existsSync(LOCAL_CACHE_BACKUP_DIR)) {
		throw new Error(
			`前の回の LocalCache の控えが残っています: ${LOCAL_CACHE_BACKUP_DIR}。` +
				`${localCacheDir(pkg)} へ戻すか要らないことを確かめてから、消してください`
		);
	}
	const source = localCacheDir(pkg);
	if (!fs.existsSync(source) || fs.readdirSync(source).length === 0) return 'empty';
	// mawok.exe を止めた直後は、WebView2 の描画プロセスがまだ EBWebView の下のファイルを消していて、
	// 一覧に載ったファイルが写す前に消える (ENOENT)。つかまれているときと同じく、収まるまで試し直す
	await retryWhileLocked(
		`${source} を写す`,
		() => {
			try {
				fs.cpSync(source, LOCAL_CACHE_BACKUP_DIR, { recursive: true });
			} catch (error) {
				fs.rmSync(LOCAL_CACHE_BACKUP_DIR, { recursive: true, force: true });
				throw error;
			}
		},
		[...LOCKED_CODES, 'ENOENT']
	);
	return 'copied';
}

/**
 * 入れ直したパッケージの LocalCache を、試す前の中身にする。テスト中にできたものは消し、
 * `backup` が `'copied'` なら控えを写す (`'empty'` なら空にするだけ)。控えは消さない (後始末が全部済んでから
 * `clearLocalCacheBackup` で消す。途中で落ちたときに、次の回がもう一度戻せるように)
 */
export async function restoreLocalCache(pkg, backup) {
	const target = localCacheDir(pkg);
	if (backup === 'copied' && !fs.existsSync(LOCAL_CACHE_BACKUP_DIR)) {
		throw new Error(`LocalCache の控えがありません: ${LOCAL_CACHE_BACKUP_DIR}`);
	}
	await retryWhileLocked(`${target} を戻す`, () => {
		fs.rmSync(target, { recursive: true, force: true });
		if (backup === 'copied') fs.cpSync(LOCAL_CACHE_BACKUP_DIR, target, { recursive: true });
		else fs.mkdirSync(target, { recursive: true });
	});
}

// ファイルがつかまれているときのエラー。消せる形でつかまれたファイルは放されるまで残るので、
// 入れ物のフォルダーを消すところで ENOTEMPTY になる
const LOCKED_CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'];

/**
 * `step` を、ファイルがつかまれている間は試し直す。mawok.exe が終わっても、WebView2 の描画プロセスが
 * しばらく中のファイルをつかんでいることがあるため
 */
async function retryWhileLocked(label, step, codes = LOCKED_CODES) {
	await waitFor(
		() => {
			try {
				step();
				return null;
			} catch (error) {
				if (codes.includes(error.code)) return error.message;
				throw error;
			}
		},
		(failure) => failure === null,
		{ label, timeout: 15000, interval: 500 }
	);
}

/** LocalCache の控えを消す。後始末が全部済んでから呼ぶ */
export function clearLocalCacheBackup() {
	fs.rmSync(LOCAL_CACHE_BACKUP_DIR, { recursive: true, force: true });
}

// EXE 版のファイルが無い環境を作るため、常用の設定・履歴のフォルダーを別の名前に変えて退かす。
// 退かしている間に中断されても次の実行で戻せるよう、何をどこへ退かしたかを e2e/ の下に残す (e2e/.gitignore 済み)
const HELD_RECORD_PATH = recordPath('.msix-held.json');
const HELD_SUFFIX = '.msix-check-held';

/**
 * 常用の設定・履歴のフォルダー (`APP_DATA_DIRS`) を、名前を変えて退かす。返ってきた `restore` で戻す。
 * 中身には触らない (写さず、名前を変えるだけ)。mawok.exe を止めた直後は、WebView2 の描画プロセスが
 * まだ %LOCALAPPDATA% の下のファイルをつかんでいて名前を変えられない (EPERM) ので、放すまで試し直す
 *
 * @returns {Promise<{ restore: () => void }>}
 */
export async function holdAppData() {
	if (fs.existsSync(HELD_RECORD_PATH)) {
		throw new Error(`前に退かしたフォルダーの記録が残っています: ${HELD_RECORD_PATH}`);
	}
	const moves = Object.values(APP_DATA_DIRS)
		.filter((dir) => fs.existsSync(dir))
		.map((dir) => ({ from: dir, to: dir + HELD_SUFFIX }));
	for (const move of moves) {
		if (fs.existsSync(move.to)) throw new Error(`退かす先がすでにあります: ${move.to}`);
	}
	writeJsonAtomicSync(HELD_RECORD_PATH, { savedAt: new Date().toISOString(), moves });
	const done = [];
	try {
		for (const move of moves) {
			await retryWhileLocked(`${move.from} を退かす`, () => fs.renameSync(move.from, move.to));
			done.push(move);
		}
	} catch (error) {
		restoreMoves(done);
		fs.rmSync(HELD_RECORD_PATH, { force: true });
		throw error;
	}
	return {
		restore() {
			restoreMoves(moves);
			fs.rmSync(HELD_RECORD_PATH, { force: true });
		}
	};
}

/**
 * 退かしたフォルダーを元の名前に戻す。元の場所に、退かしている間にできたフォルダーがあれば、
 * 消さずに `.msix-check-leftover-<時刻>` の名前にして横へ置く (MSIX 版は回された先に書くので、ふつうはできない)
 */
function restoreMoves(moves) {
	for (const move of moves) {
		if (!fs.existsSync(move.to)) continue;
		if (fs.existsSync(move.from)) {
			const aside = `${move.from}.msix-check-leftover-${Date.now()}`;
			fs.renameSync(move.from, aside);
			console.warn(`[msix] 退かしている間に ${move.from} ができていたので、${aside} に移しました`);
		}
		fs.renameSync(move.to, move.from);
	}
}

/**
 * 前回の実行が中断されて、退かしたフォルダーが残っていれば戻す。同期で動くので、中断のシグナルを受けたときにも呼べる
 */
export function recoverHeldAppDataIfAny() {
	const record = readBackupRecordSync(
		HELD_RECORD_PATH,
		isValidHeldAppDataRecord,
		`${HELD_RECORD_PATH} の内容が読めません。${Object.values(APP_DATA_DIRS).join('・')} と、` +
			`その名前に ${HELD_SUFFIX} を付けたフォルダーを確かめ、戻してからこのファイルを消してください`
	);
	if (record === null) return false;
	console.warn(`[msix] 前回の実行 (${record.savedAt}) で退かしたフォルダーを戻します`);
	restoreMoves(record.moves);
	fs.rmSync(HELD_RECORD_PATH, { force: true });
	return true;
}

function isValidHeldAppDataRecord(record) {
	return (
		record !== null &&
		typeof record === 'object' &&
		Array.isArray(record.moves) &&
		record.moves.every(
			(move) =>
				typeof move.from === 'string' &&
				typeof move.to === 'string' &&
				move.to === move.from + HELD_SUFFIX
		)
	);
}
