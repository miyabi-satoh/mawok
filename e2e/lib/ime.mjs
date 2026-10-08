import { sendKeySequence, VK } from './input.mjs';
import { clickElement, readDraft, showDraftAndWaitVisible } from './app.mjs';
import { getDraftWindowHandle, getForegroundWindowHandle, runPowerShell } from './os.mjs';
import { waitFor } from './wait.mjs';

// 本物の日本語 IME (Microsoft IME) を動かす。WebDriver から送る文字は IME を通らないので、変換中の
// キーの扱いは SendInput で IME をオンにしてローマ字を打って確かめる。前面のウィンドウの入力欄に
// フォーカスがある状態で呼ぶこと。Microsoft IME が入っている環境が前提

// IME がオンかどうかを読む。既定の IME ウィンドウ (ImmGetDefaultIMEWnd) に
// WM_IME_CONTROL の IMC_GETOPENSTATUS を送る。ほかのプロセスのウィンドウでも読める。
//
// 読む相手は、最前面のウィンドウではなく「キーボードのフォーカスがあるウィンドウ」
// (GetGUIThreadInfo の hwndFocus)。下書きも設定も中身は WebView2 で、入力欄のフォーカスは
// 別プロセス (msedgewebview2.exe) の Chrome_WidgetWin_1 にある。IME の開閉はそちらが持っていて、
// 最前面の Tauri Window から読むと、オンにしても 0 のままになる
const IME_STATUS_TYPE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class E2EIme {
    [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
        public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus;
        public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
        public int left; public int top; public int right; public int bottom;
    }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("imm32.dll")] static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr answer);

    // 戻り値は、オンなら 1、オフなら 0、読めなければ -1
    // (WM_IME_CONTROL = 0x0283、IMC_GETOPENSTATUS = 0x0005、SMTO_ABORTIFHUNG = 0x0002)
    public static int OpenStatus() {
        var info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        // スレッド ID に 0 を渡すと、最前面のスレッドの情報が返る
        if (!GetGUIThreadInfo(0, ref info)) return -1;
        // フォーカスがまだ来ていないなら、読めなかったものとして返す。ここで最前面のウィンドウに
        // 落とすと、最前面は必ず 0 を返すので (実測は e2e/README.md)、「読めなかった」が「オフ」に化ける。
        // しかもそれが起きるのは、フォーカスがまだ来ていない = IME がオンにならない、まさにその場面
        if (info.hwndFocus == IntPtr.Zero) return -1;
        IntPtr ime = ImmGetDefaultIMEWnd(info.hwndFocus);
        if (ime == IntPtr.Zero) return -1;
        // SendMessage は応答しないウィンドウ相手に無期限に止まる。止まると runPowerShell は
        // 1本のキューなので以降のテストごと詰まり、JS 側の待ちでは抜けられない。
        // 待ち時間を切れば、返らなかったことを -1 (読めなかった) として分けられる
        UIntPtr answer;
        if (SendMessageTimeoutW(ime, 0x0283, new IntPtr(0x0005), IntPtr.Zero, 0x0002, 500, out answer) == IntPtr.Zero) return -1;
        return answer == UIntPtr.Zero ? 0 : 1;
    }
}
"@
[E2EIme]::OpenStatus()
`;

/**
 * 今フォーカスのある入力欄の IME がオンか。読めなければ (フォーカスがない、IME が付いていない) `null`
 *
 * @returns {Promise<boolean | null>}
 */
async function readImeOpenStatus() {
	const value = (await runPowerShell(IME_STATUS_TYPE)).trim();
	// 読めなかったことを表すのは -1 だけ。空文字や思わぬ文字を Number() に通すと 0 や NaN になり、
	// どちらも「オフ」として扱われて、読めていないのに IME のせいにしてしまう
	if (value !== '-1' && value !== '0' && value !== '1') {
		throw new Error(`IME がオンかを読めませんでした (返ってきた値: ${value})`);
	}
	return value === '-1' ? null : value === '1';
}

/**
 * フォーカスのある入力欄の IME をオンにする (VK_IME_ON)。
 *
 * ウィンドウが IME を受け取れる状態になる前に送ると、キーが落ちて IME がオンにならない。
 * そのまま打つとローマ字が生のまま入り、3手あとで値が合わないという形でしか気づけないので、
 * 本当にオンになったかを読み、なるまで送り直す。文字を打ち直すのではなく、前提が整うのを待つ形にして、
 * IME そのものが壊れているときは隠さずに落とす
 */
export async function turnImeOn() {
	const openOrSendAgain = async () => {
		const status = await readImeOpenStatus();
		if (status === true) return true;
		await sendKeySequence([[VK.IME_ON]]);
		return readImeOpenStatus();
	};
	try {
		await waitFor(openOrSendAgain, (status) => status === true, {
			label: 'IME がオンになる',
			timeout: 3000
		});
	} catch (error) {
		throw new Error(
			'IME をオンにできませんでした (入力欄にフォーカスがあって IME を受け取れる状態か、' +
				'Microsoft IME が既定かを確かめてください。読む相手は最前面のウィンドウではなく、' +
				'フォーカスのあるウィンドウです)',
			{ cause: error }
		);
	}
}

/** フォーカスのある入力欄の IME をオフにする (VK_IME_OFF) */
export async function turnImeOff() {
	await sendKeySequence([[VK.IME_OFF]]);
}

/** ローマ字 (a〜z) を1文字ずつ打つ。IME がオンなら変換中になる */
export async function typeRomaji(romaji) {
	if (!/^[a-z]+$/.test(romaji)) throw new Error(`ローマ字は a〜z だけで渡してください: ${romaji}`);
	await sendKeySequence([...romaji].map((letter) => [letter.toUpperCase().charCodeAt(0)]));
}

/** `typeRomaji('nihon')` で入る、変換する前の読み */
export const NIHON_READING = 'にほ';

/**
 * 入力欄を本物のクリックでフォーカスし、IME をオンにして「にほｎ」と打って変換中にする。
 *
 * `hwnd` はその入力欄があるネイティブウィンドウ、`element` はクリックする入力欄の WebDriver の要素、
 * `readValue` は入力欄の今の中身を読む関数。
 * ウィンドウが前面になる前に `VK_IME_ON` を送ると届かないので、前面になるのを待ってからオンにする
 * (ただしクリックは本物のマウス入力なので、たいてい1回目の読みで前面になっていて、待ちにはなっていない)
 */
export async function startComposingNihon(client, hwnd, element, readValue) {
	await clickElement(client, hwnd, element);
	await waitFor(getForegroundWindowHandle, (handle) => handle === hwnd, {
		label: '入力欄のあるウィンドウが前面になる'
	});
	await turnImeOn();
	await typeRomaji('nihon');
	await waitFor(readValue, (value) => value.startsWith(NIHON_READING), {
		label: '変換中の文字が入力欄に出る'
	});
}

/** 下書きを出し、本物のクリックで入力欄にフォーカスを入れ、「にほｎ」と打って変換中にする */
export async function startComposingInDraft(client) {
	await showDraftAndWaitVisible();
	await startComposingNihon(
		client,
		await getDraftWindowHandle(),
		await client.$('textarea'),
		async () => (await readDraft(client)).value
	);
}

/** Space で変換し、読みから変わるまで待つ。変換した後の入力欄の中身を返す */
export async function convertComposition(readValue) {
	await sendKeySequence([[VK.SPACE]]);
	return waitFor(readValue, (value) => value !== '' && !value.startsWith(NIHON_READING), {
		label: '変換した文字'
	});
}
