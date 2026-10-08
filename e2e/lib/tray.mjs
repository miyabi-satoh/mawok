import { runPowerShell } from './os.mjs';
import { clickScreenPoint, sendKeySequence, VK } from './input.mjs';
import { expectStays, waitFor } from './wait.mjs';

// タスクトレイ (通知領域) のアイコンとメニューを操作する。
//
// アイコンは UI Automation で押す (`Invoke`)。Tauri は show_menu_on_left_click(true) なので、
// 左クリックでメニューが出る。アイコンをタスクバーに常設で出すかどうかは実行ファイルごとの設定なので、
// 常設で出ていることも、「非表示のアイコン」の中に入っていることもある。後者は、
// 「非表示のアイコンを表示する」を押してフライアウトを開くまで UI Automation の木にも出てこないので、
// まずタスクバーを見て、いなければ開いてから探す。どちらを通ったかは `openTrayMenu` が `where` で返す。
//
// 出るメニューは Win32 のポップアップメニュー (クラス `#32768`) で、UI Automation には項目が出ない。
// メニューのウィンドウに `MN_GETHMENU` を送って `HMENU` を取り、項目の文字列と状態、
// 画面での位置 (`GetMenuItemRect`) を読む。項目を押すのは、その位置を本物のマウスでクリックする。
// キーボード (↓・Enter) でも選べるが、使えなくなっている項目 (問題の知らせ) は矢印で飛ばされないため、
// 数え方が項目の並びに左右される。位置を読んで押す方が、並びが変わっても効く。
//
// ここのスクリプトは、立ち上げたままの PowerShell (`os.mjs` の runPowerShell) の中で
// スクリプトブロックとして動く。`exit` を書くとホストごと終わってしまうので、`return` で返すこと

/** トレイのアイコンの名前 (ツールチップ)。届いた下書きがあると後ろに文が付く (`lib.rs` の tray_tooltip) */
const ICON_NAME = 'Mawok';

const UIA_PRELUDE = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$ErrorActionPreference = 'Stop'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = [System.Windows.Automation.TreeScope]::Children
$descendants = [System.Windows.Automation.TreeScope]::Descendants

function Find-Window([string]$className) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $className)
    $root.FindFirst($children, $cond)
}

# 通知領域のアイコンは AutomationId が NotifyItemIcon。名前はツールチップなので、
# 届いた下書きがあるときは「Mawok — 届いたテキストがあります」になる
function Find-Icon($window, [string]$name) {
    if ($null -eq $window) { return $null }
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'NotifyItemIcon')
    @($window.FindAll($descendants, $cond)) |
        Where-Object { $_.Current.Name -eq $name -or $_.Current.Name.StartsWith($name + ' ') } |
        Select-Object -First 1
}

# 「非表示のアイコンを表示する」(英語版は Show Hidden Icons) のボタン。
# 通知領域のアイコンと同じ SystemTray.NormalButton で、AutomationId も時計や音量と同じ SystemTrayIcon なので、
# 名前で見分けるしかない
function Find-Chevron($window) {
    if ($null -eq $window) { return $null }
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'SystemTrayIcon')
    @($window.FindAll($descendants, $cond)) |
        Where-Object { $_.Current.Name -like '*非表示のアイコン*' -or $_.Current.Name -like '*Hidden icons*' -or $_.Current.Name -like '*hidden icons*' } |
        Select-Object -First 1
}

function Invoke-Element($element) {
    $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
`;

// 「非表示のアイコン」の入れ物。Windows 11 は XAML の島、Windows 10 は NotifyIconOverflowWindow
const OVERFLOW_CLASSES = ['TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow'];

// フライアウトが開いているかを読む。閉じてもウィンドウ自体は残る (実測で、開いているときは
// visible=True、閉じると visible=False になり、ウィンドウは消えない) ので、見えているかどうかで見る。
//
// 2つのクラスをまとめて見ているのは、実測で並存しなかったため (Windows 11 build 26200 では
// NotifyIconOverflowWindow のウィンドウは1つも無く、XAML の島だけがある)。
//
// 閉じられなかったときのために、そのときの状態を採れるようにしてある (`Describe`)。
// 見えているかだけでは説明の付かない落ち方をしたときに、推測ではなく実測から始められるようにする
const OVERFLOW_TYPE = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class E2ETrayOverflow {
    delegate bool EnumProc(IntPtr hWnd, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder buffer, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    // DWMWA_CLOAKED = 14。XAML の島は、隠れていても IsWindowVisible が真のまま
    // DWM で隠されていることがあるので、説明が付かないときのために一緒に採る
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);

    static string ClassOf(IntPtr hWnd) {
        var name = new StringBuilder(64);
        GetClassNameW(hWnd, name, 64);
        return name.ToString();
    }

    static List<IntPtr> OverflowWindows() {
        var found = new List<IntPtr>();
        EnumWindows((hWnd, param) => {
            var cls = ClassOf(hWnd);
            if (${OVERFLOW_CLASSES.map((c) => `cls == "${c}"`).join(' || ')}) found.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool IsOpen() {
        foreach (IntPtr hWnd in OverflowWindows()) { if (IsWindowVisible(hWnd)) return true; }
        return false;
    }

    public static string Describe() {
        var lines = new List<string>();
        foreach (IntPtr hWnd in OverflowWindows()) {
            // 読めなかった値を 0 のまま出すと、本物の 0 と見分けが付かない。
            // ここは推測ではなく実測から始めるために置いたものなので、読めなかったことも残す
            int cloaked;
            int hr = DwmGetWindowAttribute(hWnd, 14, out cloaked, 4);
            string cloakedText = hr == 0 ? cloaked.ToString() : String.Format("読めず(hr=0x{0:X8})", hr);
            RECT r;
            string rectText = GetWindowRect(hWnd, out r)
                ? String.Format("{0},{1},{2},{3}", r.Left, r.Top, r.Right, r.Bottom)
                : "読めず";
            lines.Add(String.Format("{0} hwnd={1} visible={2} cloaked={3} rect={4}",
                ClassOf(hWnd), hWnd.ToInt64(), IsWindowVisible(hWnd), cloakedText, rectText));
        }
        if (lines.Count == 0) lines.Add("フライアウトのウィンドウは1つも無い");
        IntPtr fg = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(fg, out pid);
        lines.Add(String.Format("前面のウィンドウ: hwnd={0} class={1} pid={2}", fg.ToInt64(), ClassOf(fg), pid));
        return String.Join(" / ", lines.ToArray());
    }
}
"@
`;

const MENU_TYPE = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class E2ETray {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    delegate bool EnumProc(IntPtr hWnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder buffer, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuStringW(IntPtr menu, uint item, StringBuilder buffer, int max, uint flags);
    [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMenuItemRect(IntPtr hWnd, IntPtr menu, uint item, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    public static void BeDpiAware() {
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
    }

    // FindWindow ではメニューのウィンドウを拾えないことがあるので、全部数えて持ち主のプロセスで絞る。
    // ほかのアプリが同時にメニューを出していても取り違えない。
    // 「どのプロセスでも可」は用意しない (絞り込みが黙って外れると、取り違えに気づけなくなる)
    public static List<string> MenuWindows(uint wantedPid) {
        var found = new List<string>();
        EnumWindows((hWnd, param) => {
            var name = new StringBuilder(64);
            GetClassNameW(hWnd, name, 64);
            if (name.ToString() == "#32768" && IsWindowVisible(hWnd)) {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == wantedPid) found.Add(hWnd.ToInt64().ToString());
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
[E2ETray]::BeDpiAware()
`;

/** `MN_GETHMENU`。メニューのウィンドウから `HMENU` を取る */
const MN_GETHMENU = '0x01E1';
/** `GetMenuString` などに渡す `MF_BYPOSITION` */
const MF_BYPOSITION = '0x0400';

/**
 * タスクバーと「非表示のアイコン」の中を見て、アイコンがあれば押す。
 * 押した場所 (`taskbar` か `overflow`) を返す。どちらにも無ければ `null`
 */
async function invokeTrayIcon(name) {
	const stdout = await runPowerShell(
		`${UIA_PRELUDE}
$name = $args[0]
$icon = Find-Icon (Find-Window 'Shell_TrayWnd') $name
if ($null -ne $icon) { Invoke-Element $icon; return 'taskbar' }
foreach ($class in @(${OVERFLOW_CLASSES.map((c) => `'${c}'`).join(', ')})) {
    $icon = Find-Icon (Find-Window $class) $name
    if ($null -ne $icon) { Invoke-Element $icon; return 'overflow' }
}
return ''
`,
		[name]
	);
	return stdout.trim() || null;
}

/** タスクバーと、開いている「非表示のアイコン」の中にある、名前が `name` のアイコンの数 */
async function countVisibleTrayIcons(name) {
	const stdout = await runPowerShell(
		`${UIA_PRELUDE}
$name = $args[0]
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'NotifyItemIcon')
$count = 0
foreach ($class in @('Shell_TrayWnd', ${OVERFLOW_CLASSES.map((c) => `'${c}'`).join(', ')})) {
    $window = Find-Window $class
    if ($null -eq $window) { continue }
    $count += @($window.FindAll($descendants, $cond) | Where-Object { $_.Current.Name -eq $name -or $_.Current.Name.StartsWith($name + ' ') }).Count
}
[string]$count
`,
		[name]
	);
	return Number(stdout.trim());
}

/**
 * トレイに出ている、名前が `name` のアイコンの数。タスクバーに常設のものと「非表示のアイコン」の中のものを合わせて数える。
 * 「非表示のアイコン」は、開くまで UI Automation の木に中身が出ないので、開いて数えてから閉じる
 * (はじめから開いていても閉じて終える)。アイコンを押さないので、メニューは出ない
 */
export async function countTrayIcons(name = ICON_NAME) {
	if (!(await hasTrayOverflowChevron())) return countVisibleTrayIcons(name);
	await setTrayOverflowOpen(true);
	try {
		return await countVisibleTrayIcons(name);
	} finally {
		await closeTrayOverflow();
	}
}

/**
 * 「非表示のアイコンを表示する」がタスクバーにあるか。
 * 隠れているアイコンが1つもない機には無い (Windows 10 の「常にすべてのアイコンを表示する」、
 * Windows 11 で隠れているアイコンが1つもないとき)
 */
async function hasTrayOverflowChevron() {
	const value = (
		await runPowerShell(`${UIA_PRELUDE}
if ($null -eq (Find-Chevron (Find-Window 'Shell_TrayWnd'))) { return 'no' }
return 'yes'`)
	).trim();
	if (value !== 'yes' && value !== 'no') {
		throw new Error(`「非表示のアイコンを表示する」があるかを読めませんでした: ${value}`);
	}
	return value === 'yes';
}

/**
 * トレイのアイコンを押してメニューを出し、出たメニューのウィンドウのハンドル (10 進の文字列) を返す。
 * アイコンが「非表示のアイコン」の中にあるときは、先にフライアウトを開いてから探す。
 *
 * `pid` は、メニューを出すアプリのプロセス ID。ほかのアプリのメニューを取り違えないために渡す
 */
export async function openTrayMenu(pid, name = ICON_NAME) {
	const before = await listTrayMenuWindows(pid);
	if (before.length > 0) {
		throw new Error(`トレイのメニューを出す前に、すでにメニューが出ています: ${before.join(', ')}`);
	}
	// 起動の直後はまだ登録されていないことがあるので、出てくるまで待つ。
	// タスクバーに出るか「非表示のアイコン」の中に出るかは機ごとに違ううえ、登録が遅れて
	// タスクバーの側に出ることもあるので、毎周どちらも見る
	let where;
	/** 最後の周に見た「非表示のアイコンを表示する」の有無 (見つからなかったときの文言に使う) */
	let chevron;
	/** 読む側で落ちたときの誤り。タイムアウトと区別して、包まずにそのまま投げるために持つ */
	let failedWhileReading;
	try {
		where = await waitFor(
			async () => {
				try {
					const found = await invokeTrayIcon(name);
					if (found !== null) return found;
					// フライアウトはフォーカスを失うと自分で閉じるので、閉じていれば開け直す。
					// シェブロンを押すのは setTrayOverflowOpen だけで、開く側と閉じる側で作法が分かれない
					chevron = await hasTrayOverflowChevron();
					if (!chevron) return null;
					await setTrayOverflowOpen(true);
					// 開け直しに押し直しが要ると数秒かかる。次の周に回すと、その間に下の期限が
					// 切れて、中を一度も見ないまま落ちるので、開けた同じ周で探す
					return await invokeTrayIcon(name);
				} catch (error) {
					// 読む側の失敗 (開けられない、状態を読めない、シェブロンが消えた) は、
					// 下で「見つかりません」に包み替えない。包むと、本当の原因が cause にしか残らない
					failedWhileReading = error;
					throw error;
				}
			},
			(found) => found !== null,
			{ label: `トレイのアイコン「${name}」を押す` }
		);
	} catch (error) {
		if (error === failedWhileReading) throw error;
		const overflow = await isTrayOverflowOpen().then(
			(open) => (open ? '開いていた' : '閉じていた'),
			() => '読めなかった'
		);
		throw new Error(
			`トレイのアイコン「${name}」が見つかりません (最後に見たとき、` +
				`「非表示のアイコンを表示する」は${chevron === undefined ? '見ていない' : chevron ? 'あった' : 'なかった'}、` +
				`「非表示のアイコン」は${overflow}。例えば、まだ登録されていない、Shell_TrayWnd を` +
				'読めていない、シェブロンの名前が日本語でも英語でもない、など)',
			{ cause: error }
		);
	}
	const handles = await waitFor(
		() => listTrayMenuWindows(pid),
		(found) => found.length > 0,
		{
			label: 'トレイのメニューの表示'
		}
	);
	return { hwnd: handles[0], where };
}

/** 今出ている、`pid` のプロセスのメニューのウィンドウのハンドルの一覧 */
async function listTrayMenuWindows(pid) {
	// pid がないまま呼ぶと、どのプロセスのメニューでも拾ってしまう。
	// アプリが動いていなければ getMawokProcessId() は null を返すので、そのまま渡させない
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
		throw new Error(`トレイのメニューを探すプロセス ID が要ります (受け取った値: ${pid})`);
	}
	const stdout = await runPowerShell(
		`${MENU_TYPE}\nConvertTo-Json -InputObject @([E2ETray]::MenuWindows([uint32]$args[0])) -Compress`,
		[String(pid)]
	);
	return JSON.parse(stdout.trim() || '[]');
}

/**
 * 出ているメニューの項目を読む。`text` は項目名、`accelerator` は右端に添えたキー (なければ空)、
 * `separator` は区切り線、`enabled` は選べるか。`rect` は画面での位置 (物理ピクセル)
 *
 * @returns {Promise<Array<{ text: string, accelerator: string, separator: boolean, enabled: boolean, rect: { left: number, top: number, right: number, bottom: number } }>>}
 */
export async function readTrayMenu(menuHwnd) {
	const stdout = await runPowerShell(
		`${MENU_TYPE}
$menu = [IntPtr][long]$args[0]
$handle = [E2ETray]::SendMessageW($menu, ${MN_GETHMENU}, [IntPtr]::Zero, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero) { throw 'MN_GETHMENU でメニューを取れませんでした' }
# GetMenuItemCount は失敗すると -1 を返す。-1 でも 0 でもループが回らず $items が $null になり、
# 受け取る側で「メニューのハンドルを取れていない」ことを指さない落ち方になる
$count = [E2ETray]::GetMenuItemCount($handle)
if ($count -le 0) { throw "メニューの項目の数を読めませんでした (count=$count)" }
$items = for ($i = 0; $i -lt $count; $i++) {
    $buffer = New-Object System.Text.StringBuilder 512
    $length = [E2ETray]::GetMenuStringW($handle, [uint32]$i, $buffer, 512, ${MF_BYPOSITION})
    # GetMenuState は失敗すると (UINT)-1 を返す。そのままだと区切り線かつ選べない項目に見え、
    # 警告の項目を数えるところに幻の項目として現れる
    $state = [E2ETray]::GetMenuState($handle, [uint32]$i, ${MF_BYPOSITION})
    # Windows PowerShell 5.1 は 16 進のリテラルを桁数で決まる符号付きの型として読むので、
    # 0xFFFFFFFF と書くと Int32 の -1 になり、uint の $state とは決して一致しない
    if ($state -eq [uint32]::MaxValue) { throw "メニューの $i 番目の状態を読めませんでした" }
    $rect = New-Object E2ETray+RECT
    if (-not [E2ETray]::GetMenuItemRect($menu, $handle, [uint32]$i, [ref]$rect)) {
        throw "メニューの $i 番目の位置を読めませんでした"
    }
    # MF_SEPARATOR = 0x0800、MF_GRAYED = 0x0001、MF_DISABLED = 0x0002
    $separator = ($state -band 0x0800) -ne 0
    # 区切り線は文字を持たないので 0 でよい。そうでないのに 0 なら読めていない
    # (空文字のまま返すと、区切り線と見分けが付かないまま警告の本文として扱われる)
    if (-not $separator -and $length -eq 0) { throw "メニューの $i 番目の文字列を読めませんでした" }
    [PSCustomObject]@{
        text = $buffer.ToString()
        separator = $separator
        enabled = ($state -band 0x0003) -eq 0
        rect = [PSCustomObject]@{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom }
    }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 4
`,
		[String(BigInt(menuHwnd))]
	);
	// 添えたキー (アクセラレーター) は、muda が項目の文字列の \t の後ろに付ける。項目名と分けて返す
	return JSON.parse(stdout.trim() || '[]').map((item) => {
		const [text, accelerator = ''] = item.text.split('\t');
		return { ...item, text, accelerator };
	});
}

/** 出ているメニューの、項目名 (添えたキーを除く) が `text` の項目を本物のマウスでクリックする */
export async function clickTrayMenuItem(menuHwnd, text) {
	const items = await readTrayMenu(menuHwnd);
	const item = items.find((candidate) => candidate.text === text);
	if (!item) {
		const names = items.map((candidate) => (candidate.separator ? '(区切り)' : candidate.text));
		throw new Error(`トレイのメニューに「${text}」がありません (今ある項目: ${names.join(', ')})`);
	}
	if (!item.enabled) throw new Error(`トレイのメニューの「${text}」は選べません`);
	// 大きさのない矩形は、位置を読めていないということ。そのまま押すと画面の左上を本物のマウスで押してしまう
	if (item.rect.right <= item.rect.left || item.rect.bottom <= item.rect.top) {
		throw new Error(
			`トレイのメニューの「${text}」の位置を読めていません: ${JSON.stringify(item.rect)}`
		);
	}
	await clickScreenPoint(
		(item.rect.left + item.rect.right) / 2,
		(item.rect.top + item.rect.bottom) / 2
	);
}

/** 「非表示のアイコン」のフライアウトが開いているか */
async function isTrayOverflowOpen() {
	const value = (
		await runPowerShell(`${OVERFLOW_TYPE}
[E2ETrayOverflow]::IsOpen()`)
	).trim();
	// True でも False でもないなら読めていない。そのまま false と見なすと、開いたままなのを
	// 「閉じている」と取り違えて、後始末をしないまま終わってしまう
	if (value !== 'True' && value !== 'False') {
		throw new Error(`「非表示のアイコン」が開いているかを読めませんでした: ${value}`);
	}
	return value === 'True';
}

/** 閉じられなかったときに、そのときの状態を文字列で採る。採れなければその旨を返す */
async function describeTrayOverflow() {
	try {
		return (
			await runPowerShell(`${OVERFLOW_TYPE}
[E2ETrayOverflow]::Describe()`)
		).trim();
	} catch (error) {
		return `状態を採れませんでした: ${error.message}`;
	}
}

/** 「非表示のアイコンを表示する」を押す。押すたびに開閉が入れ替わる */
async function pressTrayOverflowChevron() {
	await runPowerShell(`${UIA_PRELUDE}
$chevron = Find-Chevron (Find-Window 'Shell_TrayWnd')
if ($null -eq $chevron) { throw "「非表示のアイコンを表示する」が見つかりません" }
Invoke-Element $chevron
`);
}

/**
 * 「非表示のアイコン」のフライアウトを、開いた状態か閉じた状態にする。すでにそうなら何もしない。
 *
 * **シェブロンを押すのはここだけ**。押すたびに開閉が入れ替わるので、押す・読む・待つの作法が
 * 開く側と閉じる側で分かれていると、片方を直したときにもう片方へ穴が開く。
 *
 * 押した直後はまだ押す前の状態が読めるので、400ms 置いてから読む。ここを詰めると、開きかけを
 * 「まだ閉じている」と読んでもう一度押し、閉じてしまう。
 *
 * **1回押しただけでは変わらないことがある** (主に閉じる側)。
 * 何がそうさせるのかは掴めていないので、そうなるまで押し直す
 */
async function setTrayOverflowOpen(wanted) {
	let presses = 0;
	const pressThenRead = async () => {
		if ((await isTrayOverflowOpen()) === wanted) return wanted;
		presses += 1;
		// 2回目以降に入ったことは、掴めていない振る舞いの手掛かりになるので必ず残す。
		// 一度も出ないなら、押し直しは効いていない (直ったのは別の理由) ということ
		if (presses > 1) {
			console.warn(
				`[e2e] 「非表示のアイコン」が${wanted ? '開かない' : '閉じない'}ので、${presses} 回目を押します`
			);
		}
		await pressTrayOverflowChevron();
		await new Promise((resolve) => setTimeout(resolve, 400));
		return isTrayOverflowOpen();
	};
	try {
		await waitFor(pressThenRead, (open) => open === wanted, {
			label: `「非表示のアイコン」が${wanted ? '開く' : '閉じる'}`,
			interval: 300
		});
	} catch (error) {
		throw new Error(
			`「非表示のアイコン」を${wanted ? '開け' : '閉じられ'}ませんでした。` +
				`そのときの状態: ${await describeTrayOverflow()}`,
			{ cause: error }
		);
	}
}

/**
 * 「非表示のアイコン」のフライアウトが開いていれば閉じる。開いていなければ何もしない。
 *
 * アイコンが「非表示のアイコン」の中にあると `openTrayMenu` がフライアウトを開くが、これは Explorer 側の
 * ものなので、メニューを閉じても開いたまま残る。テストは通るが、機械の状態が元に戻らない。
 * Esc を無条件に送ると、下書きが出ているときにそれを隠してしまうので、「非表示のアイコンを表示する」を
 * 押して閉じる。キーではなく UI Automation で押すので、どこにフォーカスがあっても効く。
 *
 * **読むのと押すのは同期していない**。読んでから押すまでに PowerShell の往復1回ぶんの隙があり、
 * その間にフライアウトが自分で閉じると、押した結果また開く。抜けた後に、閉じたままであることを
 * 確かめて塞ぐ (ここを見ないと、落ちたうえにフライアウトを開いたまま残すことになる)
 */
export async function closeTrayOverflow() {
	await setTrayOverflowOpen(false);
	try {
		await expectStays(isTrayOverflowOpen, false, {
			label: '「非表示のアイコン」が閉じたまま',
			duration: 600
		});
	} catch (error) {
		throw new Error(
			`「非表示のアイコン」が閉じた後にまた開きました。そのときの状態: ${await describeTrayOverflow()}`,
			{ cause: error }
		);
	}
}

/**
 * 出したままのメニューが残っていれば閉じる。残っていなければ何もしない。
 *
 * テストの後始末のための best-effort なので、閉じられなくても投げない。投げると、
 * 呼ぶ側の本当の失敗を上書きするうえ、続くフライアウトの後始末に進めず、開いたまま
 * 次のファイルへ持ち越す。`pid` が `null` (アプリが動いていない) のときも何もしない
 */
export async function closeLeftoverTrayMenu(pid) {
	try {
		if (pid == null) return;
		if ((await listTrayMenuWindows(pid)).length === 0) return;
		await closeTrayMenu(pid);
	} catch (error) {
		// 後始末なので次へ進むが、跡は残す。メニューが残ると、次のテストの openTrayMenu が
		// 「すでにメニューが出ています」で、原因から離れた場所で落ちるため
		console.warn(
			`[e2e] 残っていたトレイのメニューを閉じられませんでした: ${error instanceof Error ? error.message : error}`
		);
	}
}

/** 出ているメニューを Esc で閉じ、閉じるまで待つ */
export async function closeTrayMenu(pid) {
	await sendKeySequence([[VK.ESCAPE]]);
	await waitFor(
		() => listTrayMenuWindows(pid),
		(found) => found.length === 0,
		{
			label: 'トレイのメニューが閉じる'
		}
	);
}
