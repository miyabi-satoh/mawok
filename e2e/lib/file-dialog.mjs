import { runPowerShell } from './os.mjs';
import { readVisibleFrame, WINDOW_TYPE } from './window.mjs';
import { waitFor } from './wait.mjs';

// テキストウィンドウの「開く」「保存」が出す、OS のファイルの窓 (コモンダイアログ。クラスは #32770) を読む・操作する。
// 窓は WebView の外にあるので、Win32 と UI Automation で扱う
const FILE_DIALOG_TYPE = `
if (-not ([System.Management.Automation.PSTypeName]'E2EFileDialog').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class E2EFileDialog {
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
        public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret;
    }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    // 窓の中でフォーカスのある入力欄に text を入れる。窓は出たときに「ファイル名」の欄にフォーカスを置く。
    // 入力欄にフォーカスが無ければ (窓の中身がまだできていなければ) 空を返し、あればその欄のクラス名を返す
    public static string SetFocusedText(IntPtr dialog, string text) {
        uint pid;
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
        if (!GetGUIThreadInfo(GetWindowThreadProcessId(dialog, out pid), ref info) || info.hwndFocus == IntPtr.Zero) return "";
        var cls = new StringBuilder(32);
        GetClassName(info.hwndFocus, cls, 32);
        if (cls.ToString() != "Edit") return "";
        SendMessage(info.hwndFocus, 0x000C, IntPtr.Zero, text); // WM_SETTEXT
        return cls.ToString();
    }

    // processIds のプロセスが持つ、表示中のダイアログ (#32770) を「ハンドル,オーナーのハンドル」で返す。なければ空
    public static string Find(uint[] processIds) {
        string found = "";
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (Array.IndexOf(processIds, pid) < 0 || !IsWindowVisible(hWnd)) return true;
            var cls = new StringBuilder(64);
            GetClassName(hWnd, cls, 64);
            if (cls.ToString() != "#32770") return true;
            found = hWnd.ToInt64() + "," + GetWindow(hWnd, 4).ToInt64();
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
"@
}
$ids = [uint32[]]@(Get-Process -Name mawok -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
`;

/** Mawok が出している、表示中のファイルの窓。`{ hwnd, owner }` (10 進の文字列。オーナーがなければ '0')。なければ null */
export async function findFileDialog() {
	const stdout = (
		await runPowerShell(
			`${FILE_DIALOG_TYPE}\nif ($ids.Count -gt 0) { [E2EFileDialog]::Find($ids) }`
		)
	).trim();
	if (!stdout) return null;
	const [hwnd, owner] = stdout.split(',');
	return { hwnd, owner };
}

/** ファイルの窓が出るまで待つ */
export async function waitFileDialog(label) {
	return waitFor(findFileDialog, (dialog) => dialog !== null, { label, timeout: 10000 });
}

/** ファイルの窓が閉じるまで待つ */
export async function waitFileDialogClosed(label) {
	await waitFor(findFileDialog, (dialog) => dialog === null, { label });
}

/**
 * ファイルの窓の、フォーカスがある「ファイル名」の欄に `filePath` を入れる。押す「開く」「保存」は、呼んだ側が本物の Enter で押す。
 * 窓は出たときに「ファイル名」の欄にフォーカスを置く。置かれるまで待ってから入れる
 */
export async function enterFileName(hwnd, filePath) {
	// UI Automation からは「ファイル名」の欄が見えず (一覧の列の見出しと検索ボックスしか出ない)、子ウィンドウの ID も開くと保存の窓で
	// 並びが違ったので、窓のスレッドでフォーカスのある入力欄 (GetGUIThreadInfo) に入れる。窓が出た直後は中身がまだ無いことがあるので待つ
	await runPowerShell(
		`${FILE_DIALOG_TYPE}
for ($i = 0; $i -lt 50; $i++) {
    if ([E2EFileDialog]::SetFocusedText([IntPtr][long]$args[0], $args[1])) { return }
    Start-Sleep -Milliseconds 100
}
throw 'ファイルの窓で、フォーカスのある入力欄が見つかりません'
`,
		[String(BigInt(hwnd)), filePath]
	);
}

/**
 * `hwnds` の窓がすべて入る、画面の範囲 (影を除いた見えている枠の和) を撮って `file` (PNG) に書く。
 * 重なり順は画面に出ているまま写るので、ファイルの窓がテキストウィンドウより前に出ているかを人が目で見るのに使う
 */
export async function captureWindowsOnScreen(hwnds, file) {
	const frames = await Promise.all(hwnds.map((hwnd) => readVisibleFrame(hwnd)));
	// 窓の周りも少し写し、どれが手前かを縁で見分けられるようにする
	const margin = 24;
	const left = Math.min(...frames.map((f) => f.x)) - margin;
	const top = Math.min(...frames.map((f) => f.y)) - margin;
	const right = Math.max(...frames.map((f) => f.x + f.width)) + margin;
	const bottom = Math.max(...frames.map((f) => f.y + f.height)) + margin;
	await runPowerShell(
		`${WINDOW_TYPE}
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap ([int]$args[3]), ([int]$args[4])
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen([int]$args[1], [int]$args[2], 0, 0, $bitmap.Size)
$bitmap.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
`,
		[file, left, top, right - left, bottom - top]
	);
}

/** 落ちたテストが残したファイルの窓を閉じる (WM_CLOSE)。窓が残ると、テキストウィンドウが入力を受けないまま次のテストへ進むため */
export async function closeFileDialogIfAny() {
	const dialog = await findFileDialog();
	if (dialog === null) return;
	await runPowerShell(
		`${FILE_DIALOG_TYPE}\n[void][E2EFileDialog]::PostMessage([IntPtr][long]$args[0], 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`,
		[String(BigInt(dialog.hwnd))]
	);
	await waitFileDialogClosed('残ったファイルの窓を閉じる');
}
