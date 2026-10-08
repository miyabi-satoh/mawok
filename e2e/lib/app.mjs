import { remote } from 'webdriverio';
import { SETTINGS_TITLE } from './app-conf.mjs';
import {
	findVisibleMawokWindow,
	getForegroundWindowHandle,
	isDraftWindowVisible,
	sendGlobalHotkey
} from './os.mjs';
import { clickClientPoint, sendKeySequence, VK } from './input.mjs';
import { expectStays, waitFor } from './wait.mjs';
import { DEFAULT_HOTKEY } from './config.mjs';
import { APP_PATH } from './paths.mjs';

export { APP_PATH, DEFAULT_HOTKEY };

// ホットキーを変えるテストで使う、既定でない組み合わせ (本物のキー入力では Ctrl+Shift+J)。
// 下書きウィンドウの操作の既定のキー (draft_keys.rs) とも重ならない
export const OTHER_HOTKEY = 'CommandOrControl+Shift+KeyJ';

/**
 * Mawok を起動して WebDriver セッションに繋ぐ。
 *
 * `wdio:enforceWebDriverClassic: true` が必須: WebdriverIO 9 は既定で BiDi セッションを張るが、
 * このアプリでは BiDi 経由だと about:blank のまま何もしていない別 webview に繋がってしまい、
 * 実際の下書きウィンドウ (http://tauri.localhost/) の内容にも `invoke` にも到達できない
 * (`Origin header is not a valid URL` で拒否される)。classic WebDriver に強制すると解消する。
 *
 * @param {{ port: number }} options
 */
export async function launchApp({ port }) {
	return remote({
		hostname: '127.0.0.1',
		port,
		capabilities: {
			browserName: 'wry',
			'wdio:enforceWebDriverClassic': true,
			'tauri:options': { application: APP_PATH }
		}
	});
}

/** 下書きウィンドウを表示する (OS のグローバルホットキー経由。トグルなので、隠れている前提で呼ぶこと) */
export async function showDraft() {
	await sendGlobalHotkey();
}

/**
 * 画面の中で色の指定 (`#abc` や `var(--foreground)`) を解決した後の値にする。
 * getComputedStyle が返す色は oklch のまま返ることがあり、テスト側の #rrggbb と直に比べられないので、
 * 同じ画面に作った要素にその色を当てて、解決した後の値どうしで比べるために使う
 */
export function resolveColor(client, value) {
	return client.execute(resolveColorInPage, value);
}

/** resolveColor の、画面の中で動く部分 */
function resolveColorInPage(value) {
	const probe = document.createElement('span');
	probe.style.color = value;
	document.body.appendChild(probe);
	const resolved = getComputedStyle(probe).color;
	probe.remove();
	return resolved;
}

/**
 * 下書きの入力欄の、文字の色と案内 (placeholder) の色・字体を読む。
 * 比べる相手として、案内の色の変数 (`--draft-guidance`) と標準の文字色 (`--foreground`) を
 * 解決した後の値も一緒に返す
 */
export function readDraftColors(client) {
	// execute は関数を文字列にして画面へ送るので、外の関数は画面の中から呼べない。
	// resolveColorInPage の中身も埋め込んで送り、比べる相手の色まで1回で読む
	return client.execute(`return (${readDraftColorsInPage})(${resolveColorInPage});`);
}

/** readDraftColors の、画面の中で動く部分 */
function readDraftColorsInPage(resolve) {
	// 設定ウィンドウにも textarea (#draft-guidance) があるので、ウィンドウを取り違えたまま
	// 嘘の色を返さないよう、設定側の欄を名指しで弾く
	const textarea = document.querySelector('textarea');
	if (!textarea) throw new Error('入力欄が見つかりません');
	if (textarea.id === 'draft-guidance') {
		throw new Error(
			'設定ウィンドウの「入力欄の案内」を読もうとしています (下書きのウィンドウに切り替えてから呼んでください)'
		);
	}
	const placeholder = getComputedStyle(textarea, '::placeholder');
	return {
		text: getComputedStyle(textarea).color,
		guidance: placeholder.color,
		guidanceFontStyle: placeholder.fontStyle,
		guidanceVariable: resolve('var(--draft-guidance)'),
		foreground: resolve('var(--foreground)')
	};
}

/** 下書きの入力欄にフォーカスして文字を打つ */
export async function typeIntoDraft(client, text) {
	const textarea = await client.$('textarea');
	await textarea.click();
	await textarea.setValue(text);
}

/** 下書きをコピーして隠す (Ctrl+Enter。macOS は Cmd+Enter だが、E2E は Windows でしか回さない) */
export async function hideDraft(client) {
	await client.keys(['Control', 'Enter']);
}

/** 下書きをコピーせずに隠す (Esc)。クリップボードは変わらず、書きかけは入力欄に残る */
export async function hideDraftWithoutCopy(client) {
	await client.keys(['Escape']);
}

/** アプリのコマンドを、設定画面などと同じ入口 (invoke) で呼ぶ */
export async function invokeApp(client, command, args = {}) {
	return client.execute((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), command, args);
}

/** 表示文言をテストから決め打ちできるよう、日本語表示にする */
export async function setJapanese(client) {
	await invokeApp(client, 'set_language', { language: 'ja' });
}

/** ホットキーで下書きを出し、ネイティブウィンドウとして表示されるまで待つ (隠れている前提で呼ぶ) */
export async function showDraftAndWaitVisible(label = '下書きウィンドウの表示') {
	await showDraft();
	await waitDraftVisible(label);
}

/** 下書きがネイティブウィンドウとして表示されるまで待つ。`options` は waitFor に渡す (timeout など) */
export async function waitDraftVisible(label, options = {}) {
	await waitFor(isDraftWindowVisible, (visible) => visible === true, { ...options, label });
}

/** 下書きがネイティブウィンドウとして隠れるまで待つ */
export async function waitDraftHidden(label) {
	await waitFor(isDraftWindowVisible, (visible) => visible === false, { label });
}

/**
 * 下書きが出たままであることを、しばらく見続ける。ほかのアプリに移ったと見なして隠すのは、
 * フォーカスが外れてから 150ms 待ってからなので (lib.rs の HIDE_ON_BLUR_DELAY)、それより十分長く見る
 */
export async function expectDraftStaysVisible(label, duration = 1000) {
	await expectDraftVisibility(true, label, duration);
}

/** 下書きが隠れたままであることを、しばらく見続ける */
export async function expectDraftStaysHidden(label, duration = 2000) {
	await expectDraftVisibility(false, label, duration);
}

async function expectDraftVisibility(expected, label, duration) {
	await expectStays(isDraftWindowVisible, expected, {
		label: `${label}: 下書きの表示`,
		duration
	});
}

/** ホットキーで出し、書いて Ctrl+Enter でコピーし、隠れるまで待つ */
export async function copyDraft(client, text) {
	await showDraftAndWaitVisible();
	await typeIntoDraft(client, text);
	await hideDraft(client);
	await waitDraftHidden(`「${text}」をコピーした後の非表示`);
}

/**
 * 下書きに見えているボタンの一覧。`position` は入力欄に対して上 ('above') か下 ('below') か。
 * 定型文の一覧を出しているときも、下書きのボタンだけを返す
 */
export async function listDraftButtons(client) {
	return client.execute(() => {
		const textarea = document.querySelector('textarea').getBoundingClientRect();
		return [...document.querySelectorAll('main > div button, main > button')]
			.filter((button) => !button.closest('[role="dialog"]') && button.offsetParent !== null)
			.map((button) => {
				const rect = button.getBoundingClientRect();
				return {
					text: button.textContent.trim(),
					label: button.getAttribute('aria-label'),
					position: rect.bottom <= textarea.top ? 'above' : 'below',
					disabled: button.disabled
				};
			});
	});
}

/** 定型文の一覧の状態 (出ていなければ `open: false`) */
export async function readSnippetPalette(client) {
	return client.execute(() => {
		const dialog = document.querySelector('[role="dialog"]');
		const input = dialog?.querySelector('input[role="combobox"]');
		return {
			open: dialog !== null,
			query: input?.value ?? null,
			inputFocused: input !== null && input !== undefined && document.activeElement === input,
			options: [...(dialog?.querySelectorAll('[role="option"]') ?? [])].map((option) =>
				option.textContent.trim()
			),
			status: dialog?.querySelector('[role="status"]')?.textContent.trim() ?? null
		};
	});
}

/** アクションの一覧を開き (本物の Ctrl+K)、開いた一覧を返す。一覧を開いたときの選択が、実行する範囲になる */
export async function openActions(client) {
	await sendKeySequence([[VK.CONTROL, VK.K]]);
	return waitFor(
		() => readSnippetPalette(client),
		(palette) => palette.open,
		{ label: 'アクションの一覧' }
	);
}

/** アクションの一覧の行 (見出しと、その下に添えたコマンドの行) */
export async function readActionOptions(client) {
	return client.execute(() =>
		[...document.querySelectorAll('[role="dialog"] [role="option"]')].map((option) => {
			const [label, preview] = option.querySelectorAll('span.flex > span');
			return { label: label?.textContent.trim(), preview: preview?.textContent.trim() ?? null };
		})
	);
}

/** 開いているアクションの一覧で、見出しが `label` の行を押す */
export async function clickActionOption(client, label) {
	const options = await readActionOptions(client);
	const index = options.findIndex((option) => option.label === label);
	if (index === -1) throw new Error(`一覧に「${label}」があるはず: ${JSON.stringify(options)}`);
	const elements = await client.$$('[role="dialog"] [role="option"]');
	await elements[index].click();
}

/** アクションの一覧を開いて、見出しが `name` の行を押す */
export async function runAction(client, name) {
	await openActions(client);
	await clickActionOption(client, name);
}

/** 失敗の帯の中身。出ていなければ null */
export async function readAlert(client) {
	return client.execute(() => document.querySelector('[role="alert"]')?.textContent.trim() ?? null);
}

/** 失敗の帯が出るのを待ち、その中身を返す */
export function waitAlert(client, label) {
	return waitFor(
		() => readAlert(client),
		(alert) => alert !== null,
		{ label, timeout: 10000 }
	);
}

/** 設定の一覧の行を開閉するボタン。「…」のメニューのボタンも aria-expanded を持つので、行の id を指す aria-controls で絞る */
export const ROW_TOGGLE = 'button[aria-expanded][aria-controls^="row-"]';

/** `panel` の中の閉じている行を、すべて開く */
export async function expandAllRows(client, panel) {
	for (const toggle of await panel.$$(`${ROW_TOGGLE}[aria-expanded="false"]`)) await toggle.click();
	await client.pause(300);
}

/** 下書きの中身を画面の中で入れ、入ったのを待つ (改行を打つと Enter のキーになるため) */
export async function setDraftValue(client, value) {
	await client.execute((text) => {
		const textarea = document.querySelector('textarea');
		textarea.value = text;
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
	}, value);
	await waitFor(
		async () => (await readDraft(client)).value,
		(current) => current === value,
		{ label: '入れた下書き' }
	);
}

/**
 * ホットキーを SendInput の本物のキー入力として送る。IME の変換中に送るときに使う
 * (SendKeys は IME を通り抜ける送り方をしないことがあるため、変換中の振る舞いを見るときはこちら)
 */
export async function sendHotkeyAsKeyInput() {
	await sendKeySequence([[VK.CONTROL, VK.SHIFT, VK.SPACE]]);
}

/**
 * 下書きの入力欄の状態を読む。`focused` は WebView の中で入力欄にフォーカスがあるか
 * (ウィンドウが前面かは `getForegroundWindowHandle` で別に見る)
 */
export async function readDraft(client) {
	return client.execute(() => {
		const textarea = document.querySelector('textarea');
		return {
			value: textarea.value,
			selectionStart: textarea.selectionStart,
			selectionEnd: textarea.selectionEnd,
			focused: document.activeElement === textarea
		};
	});
}

/** 下書きの入力欄のカーソルを置く (WebDriver からは直接置けないので、画面の中で setSelectionRange する) */
export async function setDraftCaret(client, start, end = start) {
	await client.execute(
		(s, e) => {
			const textarea = document.querySelector('textarea');
			textarea.focus();
			textarea.setSelectionRange(s, e);
		},
		start,
		end
	);
}

/**
 * 画面の要素の真ん中を、本物のマウス入力で左クリックする。WebDriver の click は OS から見たクリックを
 * 起こさないので、フォーカスの移り方 (IME の確定、ほかのアプリに移ったと見なすか) を見るときはこちら。
 * `hwnd` は要素がある WebView のウィンドウ
 */
export async function clickElement(client, hwnd, element) {
	// WebView はクライアント領域いっぱいに広がっているので、CSS ピクセルに拡大率を掛ければクライアント座標になる
	const { x, y, ratio } = await client.execute((target) => {
		const rect = target.getBoundingClientRect();
		return {
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
			ratio: window.devicePixelRatio
		};
	}, element);
	await clickClientPoint(hwnd, x * ratio, y * ratio);
}

/** 指定件数になるまで window handle を待つ (下書き↔設定の行き来など、非同期でウィンドウが増減するのを待つ) */
export async function waitForWindowCount(client, count, options = {}) {
	return waitFor(
		() => client.getWindowHandles(),
		(handles) => handles.length === count,
		{
			label: 'window handle',
			...options
		}
	);
}

/**
 * 設定ウィンドウが出て前面になるまで待ち、WebDriver の窓の切り替えに使うハンドル (`settingsHandle`) と
 * ネイティブのハンドル (`settingsHwnd`) を返す。WebDriver は切り替えない
 */
export async function waitSettingsWindow(client, draftHandle) {
	const handles = await waitForWindowCount(client, 2);
	const settingsHandle = handles.find((handle) => handle !== draftHandle);
	const settingsHwnd = await waitFor(
		() => findVisibleMawokWindow(SETTINGS_TITLE),
		(hwnd) => hwnd !== null,
		{ label: '設定ウィンドウの表示' }
	);
	await waitFor(getForegroundWindowHandle, (handle) => handle === settingsHwnd, {
		label: '設定ウィンドウが前面になる'
	});
	return { settingsHandle, settingsHwnd };
}

/**
 * 出ている下書きの入力欄を押して Ctrl+, で設定を開き、下書きが隠れるのを見届けて、WebDriver を設定ウィンドウに
 * 切り替える。戻り値は下書きのウィンドウ (WebDriver のハンドル)
 */
export async function openSettingsFromDraft(client) {
	const textarea = await client.$('textarea');
	await textarea.click();
	const [draftHandle] = await client.getWindowHandles();
	await client.keys(['Control', ',']);
	await waitDraftHidden('下書きウィンドウの非表示 (設定を開いた直後)');
	const handles = await waitForWindowCount(client, 2);
	await client.switchToWindow(handles.find((handle) => handle !== draftHandle));
	return draftHandle;
}

/**
 * 設定画面の「コピーの整え」の分類を選び、置き換え辞書の「追加」のボタンを返す。
 * 設定画面は開くたびに「一般」の分類から始まり、ほかの分類の項目は hidden で DOM に残るので、
 * 分類を選べたことを見届けてから返す
 */
export async function selectCopyCategory(client) {
	await client.$('button[role="tab"]*=コピーの整え').click();
	const addButton = await client.$('[role="tabpanel"]:not([hidden])').$('button*=追加');
	await addButton.waitForDisplayed({ timeout: 5000 });
	return addButton;
}

/**
 * 下書きを出して Ctrl+, で設定を開き、「テキストの見た目」の分類を選ぶ。戻り値は下書きのウィンドウ。
 * `readySelector` は、その分類が出そろったことを見届けるための、分類の中の要素
 */
export async function openDraftAppearanceSettings(client, readySelector) {
	// 設定を閉じると下書きは出し直されるので、2回目からは出ている。
	// 出ているときにホットキーを送ると、トグルなので隠れてしまう
	if (!(await isDraftWindowVisible())) await showDraftAndWaitVisible();
	const draftHandle = await openSettingsFromDraft(client);
	await client.$('button[role="tab"]*=テキストの見た目').click();
	await client.$(readySelector).waitForDisplayed({ timeout: 5000 });
	return draftHandle;
}

/** 設定を Esc で閉じ、出し直された下書きに戻る */
export async function closeDraftSettings(client, draftHandle) {
	await client.keys(['Escape']);
	await waitForWindowCount(client, 1);
	await waitDraftVisible('下書きウィンドウの表示 (設定を閉じた後の出し直し)');
	await client.switchToWindow(draftHandle);
}
