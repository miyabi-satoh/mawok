import { runPowerShell } from './os.mjs';

// SendInput でマウスとキーを本物の入力として送る。WebDriver の操作は DOM に届くだけで、OS から見た
// フォーカスやクリックは起きないため、ほかのアプリをクリックする・貼り付け先に Ctrl+V を送る、には使えない。
//
// キーは wVk だけでなく wScan (MapVirtualKey で得たスキャンコード) も入れる。0 のままだと、
// 受け取る側 (WebView2 など) の KeyboardEvent.code が空になる。
// 座標は物理ピクセルで扱う (Per-Monitor V2。しないと GetWindowRect が拡大率で割り引いた値を返し、
// 拡大率の違うモニターが混ざるとクリックがずれる)
const INPUT_TYPE = `
Add-Type @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class E2EInput {
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint cInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    static void Send(INPUT[] inputs) {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent == inputs.Length) return;
        int error = Marshal.GetLastWin32Error();
        // 途中までしか送れなかったとき、押したままのキーやボタンを残すと、この後の入力 (ユーザーの操作も) が
        // Ctrl 付きなどに化けるので、送れた分のうち離していないものを離してから失敗させる
        System.Collections.Generic.List<INPUT> releases = new System.Collections.Generic.List<INPUT>();
        bool leftDown = false;
        System.Collections.Generic.List<ushort> keysDown = new System.Collections.Generic.List<ushort>();
        for (int i = 0; i < sent; i++) {
            if (inputs[i].type == INPUT_KEYBOARD) {
                ushort vk = inputs[i].u.ki.wVk;
                if ((inputs[i].u.ki.dwFlags & KEYEVENTF_KEYUP) == 0) { if (!keysDown.Contains(vk)) keysDown.Add(vk); }
                else keysDown.Remove(vk);
            } else if ((inputs[i].u.mi.dwFlags & MOUSEEVENTF_LEFTDOWN) != 0) {
                leftDown = true;
            } else if ((inputs[i].u.mi.dwFlags & MOUSEEVENTF_LEFTUP) != 0) {
                leftDown = false;
            }
        }
        for (int i = keysDown.Count - 1; i >= 0; i--) releases.Add(Key(keysDown[i], true));
        if (leftDown) releases.Add(Mouse(MOUSEEVENTF_LEFTUP));
        if (releases.Count > 0) SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        throw new Win32Exception(error);
    }

    static INPUT Mouse(uint flags) {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flags;
        return input;
    }

    static INPUT Key(ushort vk, bool up) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        input.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        // 矢印・PageUp/PageDown・Home/End・Insert/Delete は拡張キー。付けないと、同じスキャンコードの
        // テンキー (↑ なら Numpad8) として届く
        if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E) input.u.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
        return input;
    }

    // Per-Monitor V2。PowerShell の側ですでに決まっていて変えられなければ、システムの拡大率に合わせる
    static void BeDpiAware() {
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    }

    // 画面の点 (物理ピクセル) を左クリックする。ウィンドウに属さないもの (メニューの項目) を押すときに使う
    public static void ClickScreenPoint(int x, int y) {
        BeDpiAware();
        Click(x, y);
    }

    // クライアント領域の点 (物理ピクセル) を左クリックする
    public static void ClickClientPoint(IntPtr hWnd, int x, int y) {
        BeDpiAware();
        POINT point = new POINT();
        point.X = x;
        point.Y = y;
        if (!ClientToScreen(hWnd, ref point)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Click(point.X, point.Y);
    }

    // タイトルバー (ウィンドウの上端からクライアント領域の上端まで) の真ん中を左クリックする
    public static void ClickTitleBar(IntPtr hWnd) {
        BeDpiAware();
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
        POINT client = new POINT();
        if (!ClientToScreen(hWnd, ref client)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (client.Y - rect.Top < 8) throw new InvalidOperationException("タイトルバーがありません");
        Click((rect.Left + rect.Right) / 2, (rect.Top + client.Y) / 2);
    }

    // タイトルバーの閉じるボタンを左クリックする。ボタンの位置は、タイトルバーの高さで右端から左へ
    // WM_NCHITTEST を送り、HTCLOSE が返る点で見つける (Tauri のウィンドウは閉じるボタンを UI Automation に出さない)
    public static void ClickCloseButton(IntPtr hWnd) {
        BeDpiAware();
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
        POINT client = new POINT();
        if (!ClientToScreen(hWnd, ref client)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int y = (rect.Top + client.Y) / 2;
        const uint WM_NCHITTEST = 0x0084;
        const long HTCLOSE = 20;
        for (int x = rect.Right - 1; x > rect.Left; x -= 2) {
            // lParam はスクリーン座標の x と y を下位と上位の 16 ビットに詰めたもの
            long lParam = ((long)(short)y << 16) | ((long)(short)x & 0xFFFF);
            if (SendMessage(hWnd, WM_NCHITTEST, IntPtr.Zero, new IntPtr(lParam)).ToInt64() == HTCLOSE) {
                // ボタンの端ではなく、少し内側を押す
                Click(x - 6, y);
                return;
            }
        }
        throw new InvalidOperationException("タイトルバーに閉じるボタンが見つかりません");
    }

    // ウィンドウの右下の角を、本物のマウス入力でドラッグして (dx, dy) だけ動かす (物理ピクセル)。
    // 角の位置は、右下から内側へ WM_NCHITTEST が HTBOTTOMRIGHT を返す点を探して見つける。
    // SetWindowPos は最小の大きさ (WM_GETMINMAXINFO) を通り抜けるので、大きさの下限を見るときはこちら
    public static void DragBottomRightCorner(IntPtr hWnd, int dx, int dy) {
        BeDpiAware();
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
        const uint WM_NCHITTEST = 0x0084;
        const long HTBOTTOMRIGHT = 17;
        for (int inset = 0; inset < 20; inset++) {
            int x = rect.Right - 1 - inset;
            int y = rect.Bottom - 1 - inset;
            long lParam = ((long)(short)y << 16) | ((long)(short)x & 0xFFFF);
            if (SendMessage(hWnd, WM_NCHITTEST, IntPtr.Zero, new IntPtr(lParam)).ToInt64() != HTBOTTOMRIGHT) continue;
            MoveTo(x, y);
            Send(new INPUT[] { Mouse(MOUSEEVENTF_LEFTDOWN) });
            // ドラッグの始まりを受け取らせてから、少しずつ動かす
            System.Threading.Thread.Sleep(100);
            const int steps = 10;
            for (int i = 1; i <= steps; i++) {
                MoveTo(x + dx * i / steps, y + dy * i / steps);
                System.Threading.Thread.Sleep(30);
            }
            Send(new INPUT[] { Mouse(MOUSEEVENTF_LEFTUP) });
            return;
        }
        throw new InvalidOperationException("ウィンドウの右下の角が見つかりません");
    }

    static void MoveTo(int x, int y) {
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        INPUT move = Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
        move.u.mi.dx = (int)(((long)(x - left) * 65535) / (width - 1));
        move.u.mi.dy = (int)(((long)(y - top) * 65535) / (height - 1));
        Send(new INPUT[] { move });
    }

    // "17+86,65" のように、続けて送る組み合わせを , で、同時に押すキーを + で区切って送る。
    // IME が1つずつ処理できるよう、組み合わせの間を少し空ける
    public static void KeySequence(string spec) {
        foreach (string combo in spec.Split(',')) {
            string[] parts = combo.Split('+');
            ushort[] vks = new ushort[parts.Length];
            for (int i = 0; i < parts.Length; i++) vks[i] = ushort.Parse(parts[i]);
            KeyCombo(vks);
            System.Threading.Thread.Sleep(30);
        }
    }

    const uint GA_ROOT = 2;

    // ウィンドウの、ほかのウィンドウに覆われていない点を左クリックする。真ん中から試す
    public static void ClickWindow(IntPtr hWnd) {
        BeDpiAware();
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int[] percents = { 50, 25, 75, 10, 90 };
        foreach (int py in percents) {
            foreach (int px in percents) {
                POINT point = new POINT();
                point.X = rect.Left + (rect.Right - rect.Left) * px / 100;
                point.Y = rect.Top + (rect.Bottom - rect.Top) * py / 100;
                if (GetAncestor(WindowFromPoint(point), GA_ROOT) == hWnd) {
                    Click(point.X, point.Y);
                    return;
                }
            }
        }
        throw new InvalidOperationException("ウィンドウがほかのウィンドウに覆われていて、クリックできる点がありません");
    }

    static void Click(int x, int y) {
        // 絶対座標は、仮想デスクトップ全体を 0〜65535 に割り当てた値で渡す
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        INPUT move = Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
        move.u.mi.dx = (int)(((long)(x - left) * 65535) / (width - 1));
        move.u.mi.dy = (int)(((long)(y - top) * 65535) / (height - 1));
        Send(new INPUT[] { move, Mouse(MOUSEEVENTF_LEFTDOWN), Mouse(MOUSEEVENTF_LEFTUP) });
    }

    // 並べたキーを順に押し、逆の順に離す (Ctrl+V なら Ctrl↓ V↓ V↑ Ctrl↑)
    public static void KeyCombo(ushort[] vks) {
        INPUT[] inputs = new INPUT[vks.Length * 2];
        for (int i = 0; i < vks.Length; i++) {
            inputs[i] = Key(vks[i], false);
            inputs[inputs.Length - 1 - i] = Key(vks[i], true);
        }
        Send(inputs);
    }
}
"@
`;

/** 仮想キーコード。英字と数字は 'A'.charCodeAt(0)・'0'.charCodeAt(0) と同じ値 */
export const VK = Object.freeze({
	TAB: 0x09,
	ENTER: 0x0d,
	SHIFT: 0x10,
	CONTROL: 0x11,
	ALT: 0x12,
	IME_ON: 0x16,
	IME_OFF: 0x1a,
	ESCAPE: 0x1b,
	SPACE: 0x20,
	A: 0x41,
	UP: 0x26,
	DOWN: 0x28,
	J: 0x4a,
	K: 0x4b,
	L: 0x4c,
	M: 0x4d,
	R: 0x52,
	V: 0x56,
	W: 0x57,
	X: 0x58,
	Z: 0x5a,
	F5: 0x74,
	COMMA: 0xbc
});

/**
 * キーの組み合わせを、前面のウィンドウへ本物のキー入力として順に送る
 * (例: `sendKeySequence([[VK.CONTROL, VK.K], [VK.ESCAPE]])`)
 *
 * @param {number[][]} combos
 */
export async function sendKeySequence(combos) {
	const spec = combos.map((combo) => combo.join('+')).join(',');
	await runPowerShell(`${INPUT_TYPE}\n[E2EInput]::KeySequence([string]$args[0])`, [spec]);
}

// ハンドル (10 進の文字列) は、PowerShell の側で [IntPtr][long]$args[0] として受け取る
const handleArg = (hwnd) => String(BigInt(hwnd));

/**
 * 画面の点 (物理ピクセル) を、本物のマウス入力で左クリックする。
 * トレイのメニューの項目のように、ウィンドウのクライアント領域で位置を出せないものを押すときに使う
 */
export async function clickScreenPoint(x, y) {
	await runPowerShell(
		`${INPUT_TYPE}
[E2EInput]::ClickScreenPoint([int]$args[0], [int]$args[1])`,
		[Math.round(x), Math.round(y)]
	);
}

/** ウィンドウのクライアント領域の点 (物理ピクセル) を、本物のマウス入力で左クリックする */
export async function clickClientPoint(hwnd, x, y) {
	await runPowerShell(
		`${INPUT_TYPE}\n[E2EInput]::ClickClientPoint([IntPtr][long]$args[0], [int]$args[1], [int]$args[2])`,
		[handleArg(hwnd), Math.round(x), Math.round(y)]
	);
}

/**
 * ウィンドウの右下の角を、本物のマウス入力でドラッグして (dx, dy) 物理ピクセルだけ動かす。
 * 端のドラッグで大きさを変えたときだけ効く最小の大きさを見るときに使う
 */
export async function dragBottomRightCorner(hwnd, dx, dy) {
	await runPowerShell(
		`${INPUT_TYPE}\n[E2EInput]::DragBottomRightCorner([IntPtr][long]$args[0], [int]$args[1], [int]$args[2])`,
		[handleArg(hwnd), Math.round(dx), Math.round(dy)]
	);
}

/** ウィンドウのタイトルバーの閉じるボタンを、本物のマウス入力で左クリックする */
export async function clickCloseButton(hwnd) {
	await runPowerShell(`${INPUT_TYPE}\n[E2EInput]::ClickCloseButton([IntPtr][long]$args[0])`, [
		handleArg(hwnd)
	]);
}

/** ウィンドウのタイトルバーの真ん中を、本物のマウス入力で左クリックする */
export async function clickTitleBar(hwnd) {
	await runPowerShell(`${INPUT_TYPE}\n[E2EInput]::ClickTitleBar([IntPtr][long]$args[0])`, [
		handleArg(hwnd)
	]);
}

/**
 * ウィンドウ (ハンドルは 10 進の文字列) を、本物のマウス入力で左クリックする。真ん中から試し、
 * ほかのウィンドウに覆われていない点を選ぶ (下書きの位置はユーザーの使い方で変わり、重なることがあるため)
 */
export async function clickWindow(hwnd) {
	await runPowerShell(`${INPUT_TYPE}\n[E2EInput]::ClickWindow([IntPtr][long]$args[0])`, [
		handleArg(hwnd)
	]);
}

/** キーの組み合わせを、前面のウィンドウへ本物のキー入力として送る (例: `sendKeyCombo(VK.CONTROL, VK.V)`) */
export async function sendKeyCombo(...vks) {
	await sendKeySequence([vks]);
}
