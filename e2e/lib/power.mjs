import { spawn } from 'node:child_process';
import { powerShellArgs, runPowerShell } from './os.mjs';

// 入力を受けているデスクトップの名前と、画面の状態 (GUID_CONSOLE_DISPLAY_STATE) を読む。
// ロック中は入力が Winlogon のセキュアデスクトップに移り、開けない (null) か "Default" 以外になる。
// 画面の状態は RegisterPowerSettingNotification で登録すると、今の値がすぐに一度届くので、
// 見えないウィンドウで受けて読む
const SESSION_STATE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public class E2ESessionState : NativeWindow {
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("user32.dll")] static extern IntPtr RegisterPowerSettingNotification(IntPtr hRecipient, ref Guid PowerSettingGuid, int Flags);
    [DllImport("user32.dll")] static extern bool UnregisterPowerSettingNotification(IntPtr Handle);

    const int WM_POWERBROADCAST = 0x0218;
    const int PBT_POWERSETTINGCHANGE = 0x8013;
    const int UOI_NAME = 2;
    const uint DESKTOP_READOBJECTS = 0x0001;

    // 0: 消えている、1: 点いている、2: 暗くなっている。-1 はまだ届いていない
    public int DisplayState = -1;
    IntPtr registration;

    public E2ESessionState() {
        CreateHandle(new CreateParams());
        Guid consoleDisplayState = new Guid("6FE69556-704A-47A0-8F24-C28D936FDA47");
        registration = RegisterPowerSettingNotification(Handle, ref consoleDisplayState, 0);
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_POWERBROADCAST && m.WParam.ToInt64() == PBT_POWERSETTINGCHANGE) {
            // POWERBROADCAST_SETTING: PowerSetting (GUID、16 バイト) + DataLength (4 バイト) + Data
            DisplayState = Marshal.ReadInt32(m.LParam, 20);
        }
        base.WndProc(ref m);
    }

    public void Close() {
        if (registration != IntPtr.Zero) UnregisterPowerSettingNotification(registration);
        DestroyHandle();
    }

    public static string InputDesktopName() {
        IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (desktop == IntPtr.Zero) return null;
        try {
            StringBuilder name = new StringBuilder(256);
            int needed;
            return GetUserObjectInformation(desktop, UOI_NAME, name, name.Capacity * 2, out needed) ? name.ToString() : null;
        } finally {
            CloseDesktop(desktop);
        }
    }
}
"@
$state = New-Object E2ESessionState
$deadline = [DateTime]::Now.AddSeconds(2)
while ($state.DisplayState -lt 0 -and [DateTime]::Now -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 20
}
$displayState = $state.DisplayState
$state.Close()
[PSCustomObject]@{ inputDesktop = [E2ESessionState]::InputDesktopName(); displayState = $displayState } | ConvertTo-Json -Compress
`;

/**
 * 画面がロックされていたり、消えていたり (Modern Standby の機ではスタンバイに入っている) したら、
 * テストを始める前にはっきり失敗させる。
 * ロック中はホットキーの送信 (SendKeys) が「Access is denied」で落ち、スタンバイ中は WebView2 が
 * ウィンドウを作れないなど、原因の分かりにくい落ち方になるため
 */
export async function ensureSessionReady() {
	const { inputDesktop, displayState } = JSON.parse(
		(await runPowerShell(SESSION_STATE_SCRIPT)).trim()
	);
	if (inputDesktop !== 'Default') {
		throw new Error(
			'画面がロックされているため E2E を始められません (入力を受けているデスクトップ: ' +
				`${inputDesktop ?? '開けない'})。ロックを解除してから回してください。`
		);
	}
	if (displayState === 0) {
		throw new Error(
			'画面が消えているため E2E を始められません (スタンバイに入っているかもしれません)。' +
				'画面を点けてから回してください。'
		);
	}
	if (displayState === -1) {
		console.warn(
			'[e2e] 画面が点いているかを確かめられませんでした。点いているものとして続けます。'
		);
	}
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
const EXECUTION_STATE_KEEP_DISPLAY_ON = 0x80000003;

/**
 * 実行中は画面を消さず、スリープにも入らないようにする。画面が消えないので、消えたときに掛かる
 * ロックも起きない。Modern Standby の機では、ES_SYSTEM_REQUIRED だけだと画面が消えた時点で
 * スタンバイに入ってしまうので、ES_DISPLAY_REQUIRED で画面ごと点けておく。
 *
 * SetThreadExecutionState はスレッドごとの要求で、そのスレッドが終わると取り消される。Node からは
 * 呼べないので、要求を出したまま標準入力が閉じるのを待つ PowerShell を子プロセスとして置く。
 * `release()` を呼べばもちろん、このプロセスが落ちたり強制終了されたりしても、パイプが閉じて
 * 子プロセスが終わるので、要求は必ず取り消される
 *
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
export async function keepDisplayOn() {
	const script = `
Add-Type -Name E2EPower -Namespace E2E -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
if ([E2E.E2EPower]::SetThreadExecutionState([uint32]${EXECUTION_STATE_KEEP_DISPLAY_ON}) -eq 0) {
    [Console]::Error.WriteLine('SetThreadExecutionState に失敗しました')
    exit 1
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
[void][Console]::In.ReadToEnd()
`;
	const child = spawn('powershell', powerShellArgs(script), { stdio: ['pipe', 'pipe', 'inherit'] });
	const exited = new Promise((resolve) => child.once('exit', resolve));

	await new Promise((resolve, reject) => {
		let buffered = '';
		const fail = (error) => {
			clearTimeout(timeout);
			child.kill();
			reject(error);
		};
		const timeout = setTimeout(
			() => fail(new Error('画面を点けておく要求がタイムアウト内に出せませんでした')),
			15_000
		);
		child.stdout.on('data', (chunk) => {
			buffered += chunk.toString();
			if (buffered.includes('ready')) {
				clearTimeout(timeout);
				resolve();
			}
		});
		child.once('error', fail);
		child.once('exit', (code) =>
			fail(new Error(`画面を点けておく要求を出す前にプロセスが終わりました (code=${code})`))
		);
	});

	// Ctrl+C は同じコンソールの子プロセスにも届くので、release() より先に終わっていることがある。
	// そのとき標準入力を閉じようとして落ちないようにする
	child.stdin.on('error', () => {});
	let releasing = false;
	child.once('exit', () => {
		if (!releasing) {
			console.warn(
				'[e2e] 画面を点けておくプロセスが途中で終わりました。この後は画面が消えることがあります。'
			);
		}
	});

	return {
		async release() {
			releasing = true;
			if (child.exitCode === null && child.signalCode === null) child.stdin.end();
			await exited;
		}
	};
}
