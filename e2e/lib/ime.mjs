import { sendKeySequence, VK } from './input.mjs';
import { clickElement, readDraft, showDraftAndWaitVisible } from './app.mjs';
import { getDraftWindowHandle, getForegroundWindowHandle, runPowerShell } from './os.mjs';
import { waitFor } from './wait.mjs';

// 本物の日本語 IME (Microsoft IME・Google 日本語入力) を動かす。WebDriver から送る文字は IME を通らないので、変換中の
// キーの扱いは SendInput で IME をオンにしてローマ字を打って確かめる。前面のウィンドウの入力欄に
// フォーカスがある状態で呼ぶこと。入力言語が日本語で、日本語の IME が入っている環境が前提

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
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint threadId);

    // 戻り値は「開閉 入力言語」。開閉は、オンなら 1、オフなら 0、読めなければ -1。
    // 入力言語は、フォーカスのあるウィンドウのスレッドのキーボードレイアウトの下位の語 (日本語は 411)。読めなければ 0
    // (WM_IME_CONTROL = 0x0283、IMC_GETOPENSTATUS = 0x0005、SMTO_ABORTIFHUNG = 0x0002)
    public static string OpenStatus() {
        var info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        // スレッド ID に 0 を渡すと、最前面のスレッドの情報が返る
        if (!GetGUIThreadInfo(0, ref info)) return "-1 0";
        // フォーカスがまだ来ていないなら、読めなかったものとして返す。ここで最前面のウィンドウに
        // 落とすと、最前面は必ず 0 を返すので (実測は e2e/README.md)、「読めなかった」が「オフ」に化ける。
        // しかもそれが起きるのは、フォーカスがまだ来ていない = IME がオンにならない、まさにその場面
        if (info.hwndFocus == IntPtr.Zero) return "-1 0";
        long layout = GetKeyboardLayout(GetWindowThreadProcessId(info.hwndFocus, IntPtr.Zero)).ToInt64() & 0xFFFF;
        string language = " " + layout.ToString("x");
        IntPtr ime = ImmGetDefaultIMEWnd(info.hwndFocus);
        if (ime == IntPtr.Zero) return "-1" + language;
        // SendMessage は応答しないウィンドウ相手に無期限に止まる。止まると runPowerShell は
        // 1本のキューなので以降のテストごと詰まり、JS 側の待ちでは抜けられない。
        // 待ち時間を切れば、返らなかったことを -1 (読めなかった) として分けられる
        UIntPtr answer;
        if (SendMessageTimeoutW(ime, 0x0283, new IntPtr(0x0005), IntPtr.Zero, 0x0002, 500, out answer) == IntPtr.Zero) return "-1" + language;
        return (answer == UIntPtr.Zero ? "0" : "1") + language;
    }
}
"@
[E2EIme]::OpenStatus()
`;

/** キーボードレイアウトの下位の語のうち、日本語 (ja-JP) */
const JAPANESE_LANGUAGE = '411';

/**
 * 今フォーカスのある入力欄の IME がオンか (`open`。読めなければ (フォーカスがない、IME が付いていない) `null`) と、
 * その入力欄の入力言語 (`language`。キーボードレイアウトの下位の語の16進。読めなければ `null`)
 *
 * @returns {Promise<{ open: boolean | null, language: string | null }>}
 */
async function readImeStatus() {
	const value = (await runPowerShell(IME_STATUS_TYPE)).trim();
	const [open, language] = value.split(' ');
	// 読めなかったことを表すのは -1 だけ。空文字や思わぬ文字を Number() に通すと 0 や NaN になり、
	// どちらも「オフ」として扱われて、読めていないのに IME のせいにしてしまう
	if ((open !== '-1' && open !== '0' && open !== '1') || !/^[0-9a-f]+$/.test(language ?? '')) {
		throw new Error(`IME がオンかを読めませんでした (返ってきた値: ${value})`);
	}
	return {
		open: open === '-1' ? null : open === '1',
		language: language === '0' ? null : language
	};
}

/**
 * フォーカスのある入力欄の IME をオンにする (VK_IME_ON)。
 *
 * ウィンドウが IME を受け取れる状態になる前に送ると、キーが落ちて IME がオンにならない。
 * そのまま打つとローマ字が生のまま入り、3手あとで値が合わないという形でしか気づけないので、
 * 本当にオンになったかを読み、なるまで送り直す。文字を打ち直すのではなく、前提が整うのを待つ形にして、
 * IME そのものが壊れているときは隠さずに落とす。
 *
 * 入力言語が日本語でなければ (タスクバーの入力の表示が ENG など)、VK_IME_ON は何もしないので、待たずにその場で落とす
 * (ENG に切り替わる仕組みは e2e/README.md)
 */
export async function turnImeOn() {
	const openOrSendAgain = async () => {
		let status = await readImeStatus();
		if (
			status.open !== true &&
			(status.language === null || status.language === JAPANESE_LANGUAGE)
		) {
			await sendKeySequence([[VK.IME_ON]]);
			status = await readImeStatus();
		}
		if (status.language !== null && status.language !== JAPANESE_LANGUAGE) {
			throw new Error(
				`入力言語が日本語ではないので、IME をオンにできません (入力欄のキーボードレイアウト: ${status.language})。` +
					'タスクバーの入力の表示が ENG なら、Win+Space で日本語の IME に戻してから回し直してください'
			);
		}
		return status.open;
	};
	try {
		await waitFor(openOrSendAgain, (open) => open === true, {
			label: 'IME がオンになる',
			timeout: 3000
		});
	} catch (error) {
		if (error.message.startsWith('入力言語が日本語ではない')) throw error;
		throw new Error(
			'IME をオンにできませんでした (入力欄にフォーカスがあって IME を受け取れる状態か、' +
				'日本語の IME が入っているかを確かめてください。読む相手は最前面のウィンドウではなく、' +
				'フォーカスのあるウィンドウです)',
			{ cause: error }
		);
	}
}

/** フォーカスのある入力欄の IME をオフにする (VK_IME_OFF) */
export async function turnImeOff() {
	await sendKeySequence([[VK.IME_OFF]]);
}

/**
 * 変換を確定させずに取り消す。入力欄が空になるまで Esc を送る (候補の一覧から読みへ、読みから空へと1段ずつ戻る)。
 *
 * 2番目より後の候補を選んだままテストを終えると、後始末 (IME をオフにする・アプリを閉じる) でその候補が確定し、
 * IME が学習して、次の回から第一候補が入れ替わる。使う人の IME の辞書にも残るので、候補を選んだテストの終わりで呼ぶ。
 * 空になってから Esc を送ると下書きが隠れるので、送る前に毎回読み、送った後は戻るのを待ってから読む
 */
export async function cancelComposition(readValue) {
	const escapeOnce = async () => {
		const value = await readValue();
		if (value === '') return value;
		await sendKeySequence([[VK.ESCAPE]]);
		return waitFor(readValue, (next) => next !== value, {
			label: 'Esc で変換が1段戻る',
			timeout: 1000
		}).catch(() => readValue());
	};
	await waitFor(escapeOnce, (value) => value === '', { label: 'Esc で変換を取り消す' });
}

/** ローマ字 (a〜z) を1文字ずつ打つ。IME がオンなら変換中になる */
export async function typeRomaji(romaji) {
	if (!/^[a-z]+$/.test(romaji)) throw new Error(`ローマ字は a〜z だけで渡してください: ${romaji}`);
	await sendKeySequence([...romaji].map((letter) => [letter.toUpperCase().charCodeAt(0)]));
}

/**
 * `typeRomaji('nihon')` で入る、変換する前の読み。最後の n は「ん」に決まらず、全角の「ｎ」のまま残る。
 * 変換すると「ｎ」は必ず「ん」になるので、第一候補が IME の学習で「日本」でも「にほん」でも、変換したかを見分けられる
 */
export const NIHON_READING = 'にほｎ';

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
	// 「にほ」だけが出たところで返すと、続く「ｎ」が出たのを変換したと取り違える
	await waitFor(readValue, (value) => value === NIHON_READING, {
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

/**
 * Space で変換し、読みから変わるまで待つ。変換した後の入力欄の中身を返す。
 * 何に変わるか (「日本」か) は見ない。第一候補は IME の学習で入れ替わる
 */
export async function convertComposition(readValue) {
	await sendKeySequence([[VK.SPACE]]);
	return waitFor(readValue, (value) => value !== '' && value !== NIHON_READING, {
		label: '変換した文字'
	});
}
