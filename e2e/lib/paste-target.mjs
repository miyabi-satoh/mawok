import { spawn } from 'node:child_process';
import { getForegroundWindowHandle, powerShellArgs, runPowerShell } from './os.mjs';
import { clickWindow, sendKeyCombo, VK } from './input.mjs';
import { raiseWindow } from './window.mjs';
import { waitFor } from './wait.mjs';

// 貼り付け先のアプリ。複数行のテキストボックスを1つだけ持つウィンドウを、PowerShell (WPF) で
// 別のプロセスとして起動する。メモ帳を使わないのは、Windows 11 のメモ帳が閉じても書きかけのタブを
// 次の起動で戻し、1つのプロセスに複数のタブ (ウィンドウ) をまとめるため。テストごとにまっさらな
// 貼り付け先を用意し、確実に片付けるのが難しい。
// WinForms ではなく WPF にするのは、WinForms の複数行のテキストボックスが UI Automation の
// ValuePattern も TextPattern も持たず、中身を読めないため (WPF は UI Automation に自前で対応している)。
//
// このテストのプロセスが強制終了されても残らないよう、ウィンドウ側でも起動したプロセスが
// 終わったかを見て、終わっていたら自分で閉じる
const TEXT_BOX_AUTOMATION_ID = 'pasteTargetText';

function pasteTargetScript({ parentPid, title, left, top }) {
	return `
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$parent = [System.Diagnostics.Process]::GetProcessById(${parentPid})
# ハンドルを持っておく。持たないと HasExited が毎回 PID から開き直し、同じ PID が別のプロセスに
# 使い回されたときに、終わっていないと見誤る
$null = $parent.Handle
$window = New-Object System.Windows.Window
$window.Title = '${title}'
$window.WindowStartupLocation = 'Manual'
$window.Left = ${left}
$window.Top = ${top}
$window.Width = 480
$window.Height = 240
# クリックで前面にするときに、ほかのウィンドウに覆われていないよう、最初だけ最前面にする
$window.Topmost = $true
$window.Add_Activated({ $window.Topmost = $false })
$box = New-Object System.Windows.Controls.TextBox
$box.AcceptsReturn = $true
[System.Windows.Automation.AutomationProperties]::SetAutomationId($box, '${TEXT_BOX_AUTOMATION_ID}')
$window.Content = $box
$window.Add_ContentRendered({
    $box.Focus() | Out-Null
    [Console]::Out.WriteLine((New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle.ToInt64())
    [Console]::Out.Flush()
})
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({ if ($parent.HasExited) { $window.Close() } })
$timer.Start()
$app = New-Object System.Windows.Application
[void]$app.Run($window)
`;
}

/**
 * 貼り付け先のウィンドウを起動する。前面にはしないので、使う前に `activate()` を呼ぶ。
 * 後始末に `close()` を必ず呼ぶこと。
 * 同じテストで2つ以上起動するときは、クリックする位置が重ならないよう `left` と `top` をずらす
 *
 * @param {{ title?: string, left?: number, top?: number }} [options]
 */
export async function launchPasteTarget({
	title = 'Mawok E2E 貼り付け先',
	left = 40,
	top = 40
} = {}) {
	const script = pasteTargetScript({ parentPid: process.pid, title, left, top });
	const child = spawn('powershell', powerShellArgs(script), {
		stdio: ['ignore', 'pipe', 'inherit']
	});
	const exited = new Promise((resolve) => child.once('exit', resolve));

	const hwnd = await new Promise((resolve, reject) => {
		let buffered = '';
		const fail = (error) => {
			clearTimeout(timeout);
			child.kill();
			reject(error);
		};
		const timeout = setTimeout(
			() => fail(new Error('貼り付け先のウィンドウがタイムアウト内に出ませんでした')),
			15_000
		);
		child.stdout.on('data', (chunk) => {
			buffered += chunk.toString();
			const line = buffered.match(/^(\d+)\r?\n/);
			if (line) {
				clearTimeout(timeout);
				resolve(line[1]);
			}
		});
		child.once('error', fail);
		child.once('exit', (code) =>
			fail(new Error(`貼り付け先のウィンドウが出る前にプロセスが終わりました (code=${code})`))
		);
	});

	return {
		hwnd,

		/**
		 * クリックして前面にし、前面になるまで待つ。最前面にしてあるのは最初に前面になるまでなので、2回目からは
		 * ほかのウィンドウ (最大化したターミナルなど) に覆われていることがある。クリックの前に重なり順だけ上げる
		 */
		async activate() {
			await raiseWindow(hwnd);
			await clickWindow(hwnd);
			await waitFor(getForegroundWindowHandle, (handle) => handle === hwnd, {
				label: '貼り付け先を前面にする'
			});
		},

		/** 前面になるまで待つ (下書きを隠した後に、フォーカスが戻ってくるのを見る) */
		async waitForeground(label = '貼り付け先へのフォーカスの戻り') {
			await waitFor(getForegroundWindowHandle, (handle) => handle === hwnd, { label });
		},

		/** Ctrl+V を本物のキー入力として送る。前面になってから呼ぶこと */
		async paste() {
			await sendKeyCombo(VK.CONTROL, VK.V);
		},

		/** テキストボックスの中身を UI Automation で読む。まだ見つからなければ null (待つ側でもう一度読む) */
		async readText() {
			const stdout = await runPowerShell(
				`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$args[0])
$isTextBox = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${TEXT_BOX_AUTOMATION_ID}')
$box = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $isTextBox)
if ($null -eq $box) { 'null' } else {
    ConvertTo-Json -InputObject $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
}
`,
				[String(BigInt(hwnd))]
			);
			return JSON.parse(stdout);
		},

		/** 貼り付け先を閉じ、プロセスが終わるまで待つ */
		async close() {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await exited;
		}
	};
}

/**
 * 下書きを隠した後、フォーカスが貼り付け先に戻り、Ctrl+V で `expected` がそのまま貼り付けられることを見る
 *
 * @param {Awaited<ReturnType<typeof launchPasteTarget>>} pasteTarget
 * @param {string} expected
 */
export async function expectPasted(pasteTarget, expected) {
	await pasteTarget.waitForeground();
	await pasteTarget.paste();
	return waitFor(
		() => pasteTarget.readText(),
		(text) => text === expected,
		{
			label: '貼り付け先の中身'
		}
	);
}
