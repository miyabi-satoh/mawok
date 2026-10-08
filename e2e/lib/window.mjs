import assert from 'node:assert/strict';
import { runPowerShell } from './os.mjs';

// ウィンドウの位置・大きさ・スタイル・重なり順を Win32 で読む・変える。WebDriver からはネイティブウィンドウの
// 枠やスタイルが見えないので、人が目で見るもの (最小の大きさ、最小化・最大化のボタン、最前面、
// タスクバーに出るか) はこちらで見る。座標は物理ピクセル (Per-Monitor V2) で扱う
export const WINDOW_TYPE = `
Add-Type @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class E2EWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    public static void BeDpiAware() {
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    }

    // 前面にせず、重なり順も変えずに、位置と大きさだけを変える (SWP_NOZORDER | SWP_NOACTIVATE)
    public static void Move(IntPtr hWnd, int x, int y, int width, int height) {
        BeDpiAware();
        if (!SetWindowPos(hWnd, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0010)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    // 前面にはせず、重なり順だけを通常のウィンドウの一番上に上げる。いったん最前面にしてから外すと、
    // 最前面のウィンドウのすぐ下 (通常のウィンドウの一番上) に残る
    public static void Raise(IntPtr hWnd) {
        const uint flags = 0x0001 | 0x0002 | 0x0010; // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
        if (!SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, flags)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!SetWindowPos(hWnd, new IntPtr(-2), 0, 0, 0, 0, flags)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    // オーナーのウィンドウ (GW_OWNER)。なければ IntPtr.Zero
    public static IntPtr Owner(IntPtr hWnd) { return GetWindow(hWnd, 4); }

    // upper が lower より重なり順で上にあるか (GW_HWNDPREV で上へたどる)
    public static bool IsAbove(IntPtr upper, IntPtr lower) {
        for (IntPtr h = GetWindow(lower, 3); h != IntPtr.Zero; h = GetWindow(h, 3)) {
            if (h == upper) return true;
        }
        return false;
    }
}
"@
[E2EWindow]::BeDpiAware()
`;

/** `actual` が `expected` の前後 2 ピクセルに収まることを確かめる (位置や大きさを比べるときに使う) */
export const near = (actual, expected, label) =>
	assert.ok(
		Math.abs(actual - expected) <= 2,
		`${label}: ${actual} (期待は ${expected} の前後 2 ピクセル)`
	);

/**
 * ウィンドウの枠の矩形 (`window`)、クライアント領域の大きさ (`client`)、拡大率 (`scale`。96 dpi を 1 とする)、
 * スタイル (`minimizeBox`・`maximizeBox`・`topmost`・`toolWindow`・`appWindow`・`noActivate`)、オーナーがあるか (`owned`) を読む
 */
export async function readWindow(hwnd) {
	const stdout = await runPowerShell(
		`${WINDOW_TYPE}
$h = [IntPtr][long]$args[0]
$w = New-Object E2EWindow+RECT
$c = New-Object E2EWindow+RECT
if (-not [E2EWindow]::GetWindowRect($h, [ref]$w)) { throw 'GetWindowRect に失敗しました' }
if (-not [E2EWindow]::GetClientRect($h, [ref]$c)) { throw 'GetClientRect に失敗しました' }
$style = [E2EWindow]::GetWindowLong($h, -16)
$exStyle = [E2EWindow]::GetWindowLong($h, -20)
[PSCustomObject]@{
    window = [PSCustomObject]@{ x = $w.Left; y = $w.Top; width = $w.Right - $w.Left; height = $w.Bottom - $w.Top }
    client = [PSCustomObject]@{ width = $c.Right - $c.Left; height = $c.Bottom - $c.Top }
    scale = [E2EWindow]::GetDpiForWindow($h) / 96.0
    minimizeBox = ($style -band 0x00020000) -ne 0
    maximizeBox = ($style -band 0x00010000) -ne 0
    topmost = ($exStyle -band 0x00000008) -ne 0
    toolWindow = ($exStyle -band 0x00000080) -ne 0
    appWindow = ($exStyle -band 0x00040000) -ne 0
    noActivate = ($exStyle -band 0x08000000) -ne 0
    owned = [E2EWindow]::Owner($h) -ne [IntPtr]::Zero
} | ConvertTo-Json -Compress
`,
		[String(BigInt(hwnd))]
	);
	return JSON.parse(stdout.trim());
}

/**
 * `readWindow` で読んだウィンドウが、Alt+Tab の一覧に出る形か。ツールウィンドウでも、前面にならないもの (WS_EX_NOACTIVATE)
 * でもなく、オーナーがないか WS_EX_APPWINDOW を持つもの (タスクバーのボタンを作る条件。Microsoft の文書「The Taskbar」の
 * 「Managing Taskbar Buttons」)。本物の Alt+Tab の一覧 (「タスクの切り替え」) は、UI Automation で項目を読めた回と
 * 読めない回があったので、スタイルで見る
 */
export function appearsInAltTab(window) {
	return !window.toolWindow && !window.noActivate && (!window.owned || window.appWindow);
}

/**
 * ウィンドウの枠の位置と大きさを変える (物理ピクセル)。ドラッグの代わり。前面にはせず、重なり順も変えない。
 * 最小の大きさより小さくすると、ウィンドウ側 (WM_GETMINMAXINFO) が最小に収める
 */
export async function moveWindow(hwnd, { x, y, width, height }) {
	await runPowerShell(
		`${WINDOW_TYPE}\n[E2EWindow]::Move([IntPtr][long]$args[0], [int]$args[1], [int]$args[2], [int]$args[3], [int]$args[4])`,
		[String(BigInt(hwnd)), Math.round(x), Math.round(y), Math.round(width), Math.round(height)]
	);
}

/** 前面にはせず、重なり順だけを通常のウィンドウの一番上に上げる (ほかのウィンドウに覆われていてクリックできないときに使う) */
export async function raiseWindow(hwnd) {
	await runPowerShell(`${WINDOW_TYPE}\n[E2EWindow]::Raise([IntPtr][long]$args[0])`, [
		String(BigInt(hwnd))
	]);
}

/** `upper` のウィンドウが `lower` より重なり順で上にあるか */
export async function isWindowAbove(upper, lower) {
	const stdout = await runPowerShell(
		`${WINDOW_TYPE}\n[E2EWindow]::IsAbove([IntPtr][long]$args[0], [IntPtr][long]$args[1])`,
		[String(BigInt(upper)), String(BigInt(lower))]
	);
	return stdout.trim() === 'True';
}

/**
 * ウィンドウの中に、名前が `name` の要素があるかを UI Automation で見る。WebView2 の画面の中も見える。
 * 描画プロセスが落ちた後の窓は WebDriver から読めなくなる ("tab crashed" のまま) ので、そのときの描き直しを見るのに使う
 */
export async function hasUiaElementNamed(hwnd, name) {
	const stdout = await runPowerShell(
		`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$args[0])
$named = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $args[1])
$null -ne $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $named)
`,
		[String(BigInt(hwnd)), name]
	);
	return stdout.trim() === 'True';
}

/**
 * タスクバー (Shell_TrayWnd) のボタンの名前と、画面での位置 (物理ピクセル) を UI Automation で読む。
 * 実行中のアプリのボタンは「アプリ名 - 1 個の実行中ウィンドウ」のような名前になる
 *
 * @returns {Promise<Array<{ name: string, rect: { x: number, y: number, width: number, height: number } }>>}
 */
export async function readTaskbarButtons() {
	const stdout = await runPowerShell(`${WINDOW_TYPE}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$isTaskbar = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
$taskbar = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $isTaskbar)
$isButton = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
ConvertTo-Json -Depth 3 -Compress -InputObject @($taskbar.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isButton) | ForEach-Object {
    $r = $_.Current.BoundingRectangle
    @{ name = $_.Current.Name; rect = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } }
})
`);
	return JSON.parse(stdout.trim() || '[]');
}

/** タスクバーのボタンの名前の一覧 */
export async function listTaskbarButtonNames() {
	return (await readTaskbarButtons()).map((button) => button.name);
}
