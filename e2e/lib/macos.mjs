// macOS の自動の確認 (`just macos-check`) の土台。macOS の WKWebView には WebDriver がないので、
// `osascript` の JXA で動かして読む。キーとウィンドウは System Events、画面の中の要素はアクセシビリティの API
// (AXUIElement)、マウスは CGEvent、ウィンドウの重なりはウィンドウサーバーの一覧 (CGWindowList) を使う。
// 動かす端末に、アクセシビリティの許可が要る (→ e2e/README.md「macOS の確認」)。
//
// 常用の Mawok (/Applications/Mawok.app) で動かす。設定・履歴・位置の記録・クリップボードを控えて、
// 終わったら戻す (`holdUserState`・`restoreUserState`)
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
	APP_IDENTIFIER,
	DRAFT_TITLE,
	SETTINGS_TITLE,
	SETTINGS_TITLES,
	TRAY_MENU_JA
} from './app-conf.mjs';
import {
	fileExists,
	markLog,
	readLogSince,
	readTextIfExists,
	recordPath,
	writeJsonAtomic
} from './files.mjs';
import { expectStays, waitFor } from './wait.mjs';

const execFileAsync = promisify(execFile);

const APP_BUNDLE = process.env.MAWOK_APP ?? '/Applications/Mawok.app';
const PROCESS_NAME = 'mawok';

const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', APP_IDENTIFIER);
const CONFIG_PATH = path.join(DATA_DIR, 'config.toml');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', APP_IDENTIFIER, 'Mawok.log');
// 設定・履歴・位置の記録。テストが書き換えるので、まとめて控えて戻す
const HELD_FILES = ['config.toml', 'history.json', '.window-state.json'];

// 控えのフォルダー。次に回したときに残っていれば、先に戻す
const BACKUP_DIR = recordPath('.macos-backup');

// key code (Carbon の kVK_*)
export const KEY = {
	return: 36,
	escape: 53,
	space: 49,
	delete: 51,
	comma: 43,
	d: 2,
	j: 38,
	k: 40,
	w: 13,
	left: 123,
	right: 124,
	down: 125,
	up: 126,
	eisu: 102,
	kana: 104
};

/**
 * JXA を動かし、戻り値を JSON で受け取る。`body` は関数の本体で、`args` を読める。
 * System Events (`se`)・Mawok のプロセス (`mawok()`)・前面のアプリのプロセス名 (`front()`)・名前でウィンドウを探す
 * `findWindow(プロセス, 名前)` と `win(名前)` (Mawok のもの)・閉じるボタンを押す `pressClose(ウィンドウ)` を前置きで用意する
 */
async function jxa(body, args = {}) {
	const script = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
	const args = JSON.parse(argv[0]);
	const se = Application('System Events');
	const mawok = () => se.processes.byName(${JSON.stringify(PROCESS_NAME)});
	// 前面のアプリのプロセス名。キー入力が Mawok に入るなら Mawok とする。
	// 下書きはアプリを前面にしないパネルで出すので、NSWorkspace でも System Events の frontmost でも前のアプリのままになる。
	// そのときもアクセシビリティの AXFrontmost は true になる。設定を開いたときなど、アプリごと前面になったときは NSWorkspace で読む。
	// NSWorkspace のほうは、アプリを終了した後などに古い値 (loginwindow) を返し続けることがあるので、ほかのアプリは System Events で読む
	const front = () => {
		try {
			if (mawok().exists() && mawok().attributes.byName('AXFrontmost').value()) return ${JSON.stringify(PROCESS_NAME)};
		} catch (e) {}
		const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
		if (app.executableURL.lastPathComponent.js === ${JSON.stringify(PROCESS_NAME)}) return ${JSON.stringify(PROCESS_NAME)};
		// アプリを終了・起動した直後は、前面のプロセスが一瞬無いことがある
		const procs = se.processes.whose({ frontmost: true });
		return procs.length > 0 ? procs[0].name() : null;
	};
	// 名前は1回の問い合わせでまとめて読む。窓ごとに読むと、読んでいる間に閉じた窓で投げる (-1728・-1719)
	const findWindow = (p, title) => (p.windows.name().includes(title) ? p.windows.byName(title) : undefined);
	const win = (title) => findWindow(mawok(), title);
	const pressClose = (w) => w.buttons().find((b) => b.subrole() === 'AXCloseButton').actions.byName('AXPress').perform();
	const result = (() => { ${body} })();
	return JSON.stringify(result === undefined ? null : result);
}`;
	const { stdout } = await execFileAsync(
		'osascript',
		['-l', 'JavaScript', '-e', script, JSON.stringify(args)],
		// ライセンスの一覧の条文のように、読んだ中身が大きくなることがある
		{ timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }
	);
	return JSON.parse(stdout.trim() || 'null');
}

/** 前面のアプリのプロセス名 */
export function frontmostApp() {
	return jxa('return front();');
}

/** 文字を打つ。`modifiers` は `['command down', 'shift down']` の形 */
export function keystroke(text, modifiers = []) {
	return jxa('se.keystroke(args.text, { using: args.modifiers });', { text, modifiers });
}

export function keyCode(code, modifiers = []) {
	return jxa('se.keyCode(args.code, { using: args.modifiers });', { code, modifiers });
}

/** 既定のホットキー (Cmd+Shift+Space) を送る */
export function pressHotkey() {
	return keystroke(' ', ['command down', 'shift down']);
}

/**
 * 下書きウィンドウの様子。出ているか、前面か、フォーカスのある要素の役割と値と、選んだ範囲 (`caret`)。
 * 隠れた (orderOut した) ウィンドウは、アクセシビリティのウィンドウの一覧に出ない
 */
export function draftState() {
	return jxa(
		`
	const p = mawok();
	if (!p.exists()) return { running: false, visible: false, frontmost: false };
	const visible = win(args.title) !== undefined;
	let focusedRole = null, value = null, placeholder = null, caret = null;
	try {
		const f = p.attributes.byName('AXFocusedUIElement').value();
		focusedRole = f.role();
		value = String(f.value());
		try { placeholder = String(f.attributes.byName('AXPlaceholderValue').value()); } catch (e) {}
		// System Events は選んだ範囲を 1 始まりの [最初の文字, 最後の文字] で返す (カーソルだけなら [位置 + 1, 位置])。
		// 0 始まりの [始まり, 終わり] に直す
		try { const [first, last] = f.attributes.byName('AXSelectedTextRange').value(); caret = [first - 1, last]; } catch (e) {}
	} catch (e) {}
	const frontName = front();
	return { running: true, visible, frontmost: frontName === args.process, front: frontName, focusedRole, value, placeholder, caret };
`,
		{ title: DRAFT_TITLE, process: PROCESS_NAME }
	);
}

/** Mawok の出ているウィンドウの名前 (隠れたウィンドウはアクセシビリティの一覧に出ない) */
export function windowNames() {
	return jxa('const p = mawok(); return p.exists() ? p.windows.name() : [];');
}

/**
 * 画面に出ている Mawok の窓を、ウィンドウサーバーの一覧 (CGWindowList) から読む (`screenWindows`) JXA の前置き。
 * 窓ごとに kCGWindowName・kCGWindowLayer などを持つ。アクセシビリティでは読めない重なりの層を見るのに使う
 */
const SCREEN_WINDOWS_PRELUDE = `
	ObjC.bindFunction('CFBridgingRelease', ['id', ['void *']]);
	const screenWindows = () => {
		const pid = mawok().unixId();
		const list = ObjC.deepUnwrap($.CFBridgingRelease($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
		return list.filter((w) => w.kCGWindowOwnerPID === pid);
	};
`;

/**
 * メニューバーのアイコンのメニューを開く (`openMenu`) と、開いているかを読む (`menuOpen`) JXA の前置き。
 * メニューの要素はアクセシビリティでは閉じていても読め、押すこともできるので、開いているかは、
 * 画面に出ている Mawok のポップアップメニューの層 (kCGPopUpMenuWindowLevel) の窓で見る
 */
const TRAY_MENU_PRELUDE = `${SCREEN_WINDOWS_PRELUDE}
	const menuOpen = () => screenWindows().some((w) => w.kCGWindowLayer === 101);
	const openMenu = () => {
		const icon = mawok().menuBars()[1].menuBarItems()[0];
		icon.actions.byName('AXPress').perform();
		for (let i = 0; i < 50 && !menuOpen(); i++) delay(0.1);
		if (!menuOpen()) throw new Error('メニューバーのアイコンのメニューが開きません');
		return icon;
	};
`;

/** メニューバーのアイコンのメニューを開いて項目の名前 (区切りは null) を読み、Esc で閉じる */
export function readTrayMenu() {
	return jxa(`${TRAY_MENU_PRELUDE}
	const icon = openMenu();
	const names = icon.menus()[0].menuItems().map((m) => m.name());
	se.keyCode(${KEY.escape});
	return names;
`);
}

/**
 * メニューバーのアイコンのメニューの、項目の名前と添えたキー。アクセシビリティでは、閉じていても読める。
 * `key` はキーの文字 (無ければ null)、`modifiers` は AXMenuItemCmdModifiers の値
 * (Command を前提に、1 が Shift・2 が Option・4 が Control、8 は Command なし)
 */
export function trayMenuKeys() {
	return jxa(`
	const read = (item, name) => item.attributes.byName(name).value();
	return mawok().menuBars()[1].menuBarItems()[0].menus()[0].menuItems().map((m) => ({
		name: m.name(),
		key: read(m, 'AXMenuItemCmdChar'),
		modifiers: read(m, 'AXMenuItemCmdModifiers')
	}));
`);
}

/** メニューバーのアイコンのメニューを開いたままにする */
export function openTrayMenu() {
	return jxa(`${TRAY_MENU_PRELUDE} openMenu();`);
}

/** メニューバーのアイコンのメニューが開いているか */
export function isTrayMenuOpen() {
	return jxa(`${TRAY_MENU_PRELUDE} return menuOpen();`);
}

/** メニューバーのアイコンのメニューを開き、名前の項目を押す */
export function pressTrayMenuItem(name) {
	return jxa(
		`
	${TRAY_MENU_PRELUDE}
	const item = openMenu().menus()[0].menuItems().find((m) => m.name() === args.name);
	if (!item) throw new Error('メニューに項目がありません: ' + args.name);
	item.actions.byName('AXPress').perform();
`,
		{ name }
	);
}

// 画面の中の要素は、アクセシビリティの API を直接呼んで読む。System Events は要素ごとに問い合わせるので、
// 数千の要素があるウィンドウ (ライセンスの一覧) を読むと数分かかる
const AX_PRELUDE = `
	ObjC.import('ApplicationServices');
	const axGet = (el, name) => {
		const ref = Ref();
		return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ObjC.castRefToObject(ref[0]) : null;
	};
	const axPlain = (el, name) => {
		const v = axGet(el, name);
		return v !== null && (v.isKindOfClass($.NSString) || v.isKindOfClass($.NSNumber)) ? v.js : null;
	};
	// 要素の名前。タイトルが無ければ説明を使う。aria-label はタイトルでなく説明に出るので、
	// アイコンだけのボタンや入力欄の名前は説明から読む
	const axName = (el) => axPlain(el, 'AXTitle') || axPlain(el, 'AXDescription') || '';
	const axWindow = (title) => {
		const windows = axGet($.AXUIElementCreateApplication(mawok().unixId()), 'AXWindows');
		for (let i = 0; windows !== null && i < windows.count; i++) {
			if (axPlain(windows.objectAtIndex(i), 'AXTitle') === title) return windows.objectAtIndex(i);
		}
		return null;
	};
	// 木の順にたどり、visit が true を返したらそこで止める
	const axWalk = (el, visit) => {
		if (visit(el)) return true;
		const children = axGet(el, 'AXChildren');
		for (let i = 0; children !== null && i < children.count; i++) {
			if (axWalk(children.objectAtIndex(i), visit)) return true;
		}
		return false;
	};
`;

/**
 * 名前のウィンドウの中の要素を、木の順に平らに並べる ({ role, name, value })。出ていなければ null。
 * 画面の中のタブは AXRadioButton、ボタンは AXButton で、名前は `aria-label` か見える文字になる
 */
export function windowElements(title) {
	return jxa(
		`${AX_PRELUDE}
	const w = axWindow(args.title);
	if (w === null) return null;
	const out = [];
	axWalk(w, (el) => {
		out.push({ role: axPlain(el, 'AXRole'), name: axName(el), value: axPlain(el, 'AXValue') });
	});
	return out;
`,
		{ title }
	);
}

/**
 * `windowElements` と同じ読み方で、名前のウィンドウの中の、役割が `role` で名前が `prefix` で始まる最初の要素に
 * `act` をして true を返す。見つからなければ投げる。`act` は JXA の式で、見つけた要素を `el` で読める
 */
function actOnWindowElement(title, role, prefix, act) {
	return jxa(
		`${AX_PRELUDE}
	const w = axWindow(args.title);
	const found = w !== null && axWalk(w, (el) => {
		if (axPlain(el, 'AXRole') !== args.role || !axName(el).startsWith(args.prefix)) return false;
		${act};
		return true;
	});
	if (!found) throw new Error('要素がありません: ' + args.role + ' ' + args.prefix);
	return true;
`,
		{ title, role, prefix }
	);
}

/** 名前のウィンドウの中の、役割が `role` で名前が `prefix` で始まる要素を押す */
export function pressWindowElement(title, role, prefix) {
	return actOnWindowElement(title, role, prefix, "$.AXUIElementPerformAction(el, $('AXPress'))");
}

/** 名前のウィンドウの中の、役割が `role` で名前が `prefix` で始まる要素にフォーカスを入れる */
export function focusWindowElement(title, role, prefix) {
	return actOnWindowElement(
		title,
		role,
		prefix,
		"$.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true))"
	);
}

/** 名前のウィンドウの中で、役割が `role` で名前が `prefix` で始まる最初の要素の名前 (無ければ null) */
export async function elementName(title, role, prefix) {
	const found = ((await windowElements(title)) ?? []).find(
		(e) => e.role === role && e.name.startsWith(prefix)
	);
	return found?.name ?? null;
}

/** 下書きウィンドウに出ている文 (入力欄の下の知らせ・失敗の帯・一覧の行など)。出ていなければ空 */
export async function draftTexts() {
	return ((await windowElements(DRAFT_TITLE)) ?? [])
		.filter(({ role, value }) => role === 'AXStaticText' && value)
		.map(({ value }) => value);
}

// ── 日本語入力 ──

// 打つ読み。`nihongo` は最後まで仮名になる (`nihon` だと末尾の n が未確定のまま残る)
const ROMAJI = 'nihongo';

/**
 * 日本語入力に切り替えて読みを打ち、`before` の後ろに未確定の文が出るまで待って、入力欄の値を返す。
 * ライブ変換がオンだと読みでなく漢字で出るので、ローマ字が残っていないことだけを見る
 */
export async function typeReading(before = '') {
	await keyCode(KEY.kana);
	await keystroke(ROMAJI);
	const { value } = await waitFor(
		draftState,
		(s) =>
			typeof s.value === 'string' &&
			s.value.startsWith(before) &&
			s.value.length > before.length &&
			!/[a-z]/.test(s.value.slice(before.length)),
		{ label: `${JSON.stringify(before)} の後ろに未確定の文が出る` }
	);
	return value;
}

/**
 * 変換中の文を Esc で取り消して英数に戻す。変換した後とライブ変換の文は、1回目の Esc で読みに戻るだけのことがあるので、
 * 入力欄が `before` に戻るまで送る。そのあいだ、窓 (`isOpen`) は閉じないこと
 */
export async function escapeComposition(before, isOpen) {
	for (let i = 1; i <= 3; i++) {
		await keyCode(KEY.escape);
		await expectStays(isOpen, true, { label: `変換中の Esc (${i} 回目) の後、窓が出ているか` });
		if ((await draftState()).value === before) {
			await keyCode(KEY.eisu);
			return;
		}
	}
	throw new Error(`Esc を3回送っても、入力欄が ${JSON.stringify(before)} に戻らない`);
}

/** 開いている一覧 (アクション・定型文) の行 (「名前 本文の頭」の文)。一覧が開いていなければ null */
export async function paletteOptions() {
	const elements = (await windowElements(DRAFT_TITLE)) ?? [];
	const list = elements.findIndex(({ role }) => role === 'AXList');
	if (list < 0) return null;
	// 行の文は、一覧の後ろに続く名前つきの文。一覧の外の文 (入力欄の写しなど) は名前が空
	return elements
		.slice(list + 1)
		.filter(({ role, name }) => role === 'AXStaticText' && name)
		.map(({ name }) => name);
}

/**
 * 下書きで Cmd+K でアクションの一覧を開き、絞り込みに `filter` を打って、`option` で始まる行を選ぶ。
 * 一覧の先頭は、絞り込みに書いたものをそのまま実行する「この内容で実行」なので、Enter の前に ↓ で行まで移る。
 * 絞り込みは英数で打つ (日本語入力のままだと変換される)
 */
export async function runAction(filter, option = `${filter} `) {
	await keyCode(KEY.k, ['command down']);
	await waitFor(paletteOptions, (options) => options !== null, { label: 'アクションの一覧' });
	await keystroke(filter);
	// 先頭の「この内容で実行」が打った文字を写していれば、絞り込み終えている。終える前の一覧で数えると、行の位置がずれる
	const options = await waitFor(
		paletteOptions,
		(current) =>
			current?.[0] === `この内容で実行 ${filter}` &&
			current.some((name) => name.startsWith(option)),
		{ label: `一覧の「${option.trim()}」の行` }
	);
	const index = options.findIndex((name) => name.startsWith(option));
	for (let i = 0; i < index; i++) await keyCode(KEY.down);
	await keyCode(KEY.return);
}

/** Mawok の中で前面にあるウィンドウの名前 (無ければ null) */
export function focusedWindowName() {
	return jxa(`
	try { return mawok().attributes.byName('AXFocusedWindow').value().name(); } catch (e) { return null; }
`);
}

/** 名前のウィンドウを、Mawok の中で前面に出す */
export function raiseWindow(title) {
	return jxa("win(args.title).actions.byName('AXRaise').perform();", { title });
}

/** 名前のウィンドウの位置と大きさ (タイトルバーを含む、画面の座標)。出ていなければ null */
export function windowFrame(title) {
	return jxa(
		`
	const w = win(args.title);
	if (!w) return null;
	const [x, y] = w.position();
	const [width, height] = w.size();
	return { x, y, width, height };
`,
		{ title }
	);
}

/** 名前のウィンドウの位置と大きさを、アクセシビリティで変える (端をドラッグするのと同じく、最小の大きさで止まる) */
export function setWindowFrame(title, { x, y, width, height }) {
	return jxa(
		`
	const w = win(args.title);
	w.position = [args.x, args.y];
	w.size = [args.width, args.height];
`,
		{ title, x, y, width, height }
	);
}

/** 名前のウィンドウのタイトルバーの、最小化と拡大のボタンが押せるか */
export function windowButtonsEnabled(title) {
	return jxa(
		`
	const w = win(args.title);
	const enabled = (name) => w.attributes.byName(name).value().enabled();
	return { minimize: enabled('AXMinimizeButton'), zoom: enabled('AXZoomButton') };
`,
		{ title }
	);
}

/**
 * 名前のウィンドウの中の、役割が `role` で名前が `prefix` で始まる要素の位置と大きさ (画面の座標) を、木の順に並べる。
 * System Events の position() は、画面の中の要素では、同じ形の要素がみな同じ位置を返すことがある (実機で読んだ) ので、
 * アクセシビリティの API で直に読む。値は AXValue で、JXA からは中身を取り出せないので、説明の文字列から読む
 */
export function elementFrames(title, role, prefix) {
	return jxa(
		`${AX_PRELUDE}
	const w = axWindow(args.title);
	const out = [];
	if (w === null) return out;
	const pair = (el, name, a, b) => {
		const v = axGet(el, name);
		const m = v === null ? null : v.description.js.match(new RegExp(a + ':([-0-9.]+) ' + b + ':([-0-9.]+)'));
		if (m === null) throw new Error('位置か大きさが読めません: ' + name + ' ' + axName(el) + ' ' + (v && v.description.js));
		return [Number(m[1]), Number(m[2])];
	};
	axWalk(w, (el) => {
		if (axPlain(el, 'AXRole') !== args.role || !axName(el).startsWith(args.prefix)) return false;
		const [x, y] = pair(el, 'AXPosition', 'x', 'y');
		const [width, height] = pair(el, 'AXSize', 'w', 'h');
		out.push({ x, y, width, height });
		return false;
	});
	return out;
`,
		{ title, role, prefix }
	);
}

/** 位置と大きさ (`elementFrames` の1つ) の真ん中 */
export function frameCenter({ x, y, width, height }) {
	return { x: x + width / 2, y: y + height / 2 };
}

/** 名前のウィンドウの中で、役割が `role` で名前が `prefix` で始まる最初の要素の真ん中 (画面の座標。無ければ null) */
export async function elementCenter(title, role, prefix) {
	const [frame] = await elementFrames(title, role, prefix);
	return frame ? frameCenter(frame) : null;
}

/**
 * 設定ウィンドウの要素を押す。開いた直後や描き直しの途中は、要素がまだアクセシビリティに出ていないことがあるので、
 * 押せるまでやり直す
 */
export function pressInSettings(role, prefix) {
	return waitFor(
		() => pressWindowElement(SETTINGS_TITLE, role, prefix).catch(() => null),
		Boolean,
		{
			timeout: 10_000,
			interval: 300,
			label: `「${prefix}」を押す`
		}
	);
}

/**
 * 開いている設定ウィンドウで、分類 `category` を出す。画面を読み込み終える前に押すと、押せても分類が切り替わらないので、
 * その分類にだけあるボタン `ready` が出るまで押し直す
 */
function openSettingsCategory(category, ready) {
	return waitFor(
		async () => {
			await pressWindowElement(SETTINGS_TITLE, 'AXRadioButton', category).catch(() => null);
			return elementName(SETTINGS_TITLE, 'AXButton', ready);
		},
		Boolean,
		{ timeout: 15_000, interval: 500, label: `「${category}」の分類が出る` }
	);
}

/** 下書きウィンドウが出ているか */
export async function isDraftVisible() {
	return (await draftState()).visible;
}

/** 設定ウィンドウが出ているか (日本語・英語のどちらのタイトルでも) */
export async function isSettingsVisible() {
	return (await windowNames()).some((name) => SETTINGS_TITLES.includes(name));
}

/** 設定ウィンドウが出る (`visible` が false なら閉じる) まで待つ */
export function waitSettingsWindow(
	visible,
	label = visible ? '設定ウィンドウが出る' : '設定ウィンドウが閉じる'
) {
	return waitFor(isSettingsVisible, (v) => v === visible, { timeout: 10_000, label });
}

/** メニューから設定を開き、`category` を渡せばその分類を出す (`ready` は `openSettingsCategory` と同じ) */
export async function openSettings(category, ready) {
	await pressTrayMenuItem(TRAY_MENU_JA.settings);
	await waitSettingsWindow(true);
	if (category !== undefined) await openSettingsCategory(category, ready);
}

/** 設定ウィンドウを閉じるボタンで閉じる */
export async function closeSettings() {
	await pressCloseButton(SETTINGS_TITLE);
	await waitSettingsWindow(false);
}

/** 下書きウィンドウが前面に出て、入力欄にフォーカスが入るまで待つ */
export function waitDraftFocused(label = '下書きウィンドウが出て、入力欄にフォーカスが入る') {
	return waitFor(draftState, (s) => s.visible && s.frontmost && s.focusedRole === 'AXTextArea', {
		timeout: 10_000,
		label
	});
}

/** ホットキーで出し、入力欄にフォーカスが入るまで待つ */
export async function showDraft() {
	await pressHotkey();
	return waitDraftFocused();
}

export function waitDraftHidden(label = '下書きウィンドウが隠れる') {
	return waitFor(draftState, (s) => !s.visible, { timeout: 10_000, label });
}

/** 下書きを Esc で隠す */
export async function hideDraft(label) {
	await keyCode(KEY.escape);
	await waitDraftHidden(label);
}

/** 下書きを Cmd+Enter でコピーして隠し、クリップボードが `expected` になるまで待つ */
export async function copyAndHide(expected) {
	await keyCode(KEY.return, ['command down']);
	await waitDraftHidden();
	await waitFor(getClipboard, (text) => text === expected, { label: 'クリップボード' });
}

/** 入力欄の値が `expected` になるまで待つ (打った文字は少し遅れて値に出る) */
export function waitDraftValue(expected) {
	return waitFor(draftState, (s) => s.value === expected, {
		label: `入力欄の値が ${JSON.stringify(expected)} になるの`
	});
}

/**
 * 下書きを出して (出ていればそのまま) 英数の入力にし、中身を `text` に書き直す。Esc で隠しても書きかけが残るので、
 * 前の確認の文を消してから書く。`paste` なら打たずに貼り付ける (日本語や改行は打てない。クリップボードは書き換わる)
 */
export async function showDraftWith(text, { paste = false } = {}) {
	// 出ているときにホットキーを送ると隠れる
	if (!(await isDraftVisible())) await showDraft();
	await keyCode(KEY.eisu);
	await keystroke('a', ['command down']);
	await keyCode(KEY.delete);
	await waitDraftValue('');
	if (!text) return;
	if (paste) {
		await setClipboard(text);
		await keystroke('v', ['command down']);
	} else {
		await keystroke(text);
	}
	await waitDraftValue(text);
}

/** 名前のウィンドウの閉じるボタンを押す */
export function pressCloseButton(title) {
	return jxa('pressClose(win(args.title));', { title });
}

/** ほかのアプリ (Finder など) を前面にする */
async function activateApp(name) {
	await jxa('se.processes.byName(args.name).frontmost = true;', { name });
	await waitFor(frontmostApp, (front) => front === name, { label: `${name} の前面` });
}

/** 下書きウィンドウの、入力欄の真ん中とタイトルバーの位置 (画面の座標) */
export function draftPoints() {
	return jxa(
		`
	const w = win(args.title);
	const [x, y] = w.position();
	const [width] = w.size();
	const f = mawok().attributes.byName('AXFocusedUIElement').value();
	const [fx, fy] = f.position();
	const [fw, fh] = f.size();
	return { title: { x: x + width / 2, y: y + 12 }, input: { x: fx + fw / 2, y: fy + fh / 2 } };
`,
		{ title: DRAFT_TITLE }
	);
}

/**
 * Finder の、名前のウィンドウで選ばれている項目の名前 (ウィンドウが無ければ null)。Finder を AppleScript で操る
 * 許可は使わず、アクセシビリティで読む (選ばれた行の、名前の欄の値)
 */
export function finderSelection(name) {
	return jxa(
		`
	const w = findWindow(se.processes.byName('Finder'), args.name);
	if (!w) return null;
	const selected = [];
	for (const e of w.entireContents()) {
		try {
			if (e.role() === 'AXTextField' && e.selected()) selected.push(String(e.value()));
		} catch (error) {}
	}
	return selected;
`,
		{ name }
	);
}

/** Finder の、名前のウィンドウを閉じる */
export function closeFinderWindow(name) {
	return jxa(
		`
	const w = findWindow(se.processes.byName('Finder'), args.name);
	if (w) pressClose(w);
`,
		{ name }
	);
}

/** Finder の出ているウィンドウの名前 */
export function finderWindowNames() {
	return jxa("return se.processes.byName('Finder').windows.name();");
}

/** 画面の座標を、本物のマウスで1回クリックする (CGEvent) */
export function click({ x, y }) {
	return jxa(
		`
	const point = $.CGPointMake(args.x, args.y);
	for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
		const event = $.CGEventCreateMouseEvent($(), type, point, $.kCGMouseButtonLeft);
		$.CGEventPost($.kCGHIDEventTap, event);
		delay(0.05);
	}
`,
		{ x, y }
	);
}

/**
 * 画面の座標 `from` から `to` へ、本物のマウスでドラッグする (CGEvent)。押したまま少しずつ動かす。
 * 一気に動かすと、ドラッグの部品 (svelte-dnd-action) が動きを拾う前に離したことになる
 */
export function drag(from, to, steps = 12) {
	return jxa(
		`
	const post = (type, x, y) => {
		const event = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), $.kCGMouseButtonLeft);
		$.CGEventPost($.kCGHIDEventTap, event);
	};
	post($.kCGEventMouseMoved, args.from.x, args.from.y);
	delay(0.1);
	post($.kCGEventLeftMouseDown, args.from.x, args.from.y);
	delay(0.15);
	for (let i = 1; i <= args.steps; i++) {
		const t = i / args.steps;
		post($.kCGEventLeftMouseDragged, args.from.x + (args.to.x - args.from.x) * t, args.from.y + (args.to.y - args.from.y) * t);
		delay(0.05);
	}
	delay(0.3);
	post($.kCGEventLeftMouseUp, args.to.x, args.to.y);
`,
		{ from, to, steps }
	);
}

// ── ログイン項目 ──

const SYSTEM_SETTINGS = 'System Settings';

/**
 * システム設定の「ログイン項目と機能拡張」の「ログイン時に開く」の節に出ている文 (`Mawok.app` などの名前と、その種類)。
 * 登録の一覧はほかのアプリからは読めず、`sfltool dumpbtm` は管理者のパスワードを求めるので、システム設定の画面を読む。
 * 開いていたシステム設定では読み込み直されるか分からないので、開いていれば始めずに落とし、開いたものは読んだら終了する
 */
export async function loginItemsAtLogin() {
	if ((await processPids(SYSTEM_SETTINGS)).length > 0) {
		throw new Error(
			'システム設定が開いています。ログイン項目を読み直すのに使うので、終了してから回してください'
		);
	}
	await execFileAsync('open', [
		'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
	]);
	try {
		return await waitFor(
			() =>
				jxa(
					`
	const p = se.processes.byName(args.app);
	if (!p.exists() || p.windows().length === 0) return null;
	const texts = [];
	for (const e of p.windows()[0].entireContents()) {
		try { if (e.role() === 'AXStaticText') texts.push(String(e.value())); } catch (error) {}
	}
	// 節の説明の文と、次の節 (バックグラウンドでの実行) の説明の文のあいだが、ログイン時に開く項目。
	// 次の節まで出ていなければ、まだ並べ終えていない
	const start = texts.findIndex((t) => t.startsWith('以下の項目がログイン時に自動的に開きます'));
	const end = texts.findIndex((t) => t.startsWith('アプリは閉じたあともバックグラウンドで動作し'));
	return start < 0 || end < start ? null : texts.slice(start + 1, end);
`,
					{ app: SYSTEM_SETTINGS }
				),
			(texts) => texts !== null,
			{ timeout: 15_000, interval: 500, label: 'システム設定のログイン項目' }
		);
	} finally {
		await execFileAsync('osascript', ['-e', `tell application "${SYSTEM_SETTINGS}" to quit`]);
		await waitFor(
			() => processPids(SYSTEM_SETTINGS),
			(pids) => pids.length === 0,
			{
				label: 'システム設定が終了する'
			}
		);
	}
}

// ── クリップボード ──

/** クリップボードの文字列 (無ければ null) */
export function getClipboard() {
	return jxa(`
	const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
	return s.isNil() ? null : s.js;
`);
}

export function setClipboard(text) {
	return jxa(
		`
	const pb = $.NSPasteboard.generalPasteboard;
	pb.clearContents;
	pb.setStringForType($(args.text), $.NSPasteboardTypeString);
`,
		{ text }
	);
}

/** クリップボードに載っている形式の一覧 */
export function pasteboardTypes() {
	return jxa(`
	const types = $.NSPasteboard.generalPasteboard.types;
	const out = [];
	for (let i = 0; i < types.count; i++) out.push(types.objectAtIndex(i).js);
	return out;
`);
}

/**
 * クリップボードの項目を、形式ごとの中身まで `dir` の下のファイルに控え、形式とファイル名の一覧を返す。
 * 画像などは大きいので、中身は標準出力や引数ではなくファイルで受け渡す
 */
function readPasteboard(dir) {
	return jxa(
		`
	const items = $.NSPasteboard.generalPasteboard.pasteboardItems;
	const out = [];
	for (let i = 0; i < items.count; i++) {
		const item = items.objectAtIndex(i);
		const types = item.types;
		const entry = [];
		for (let j = 0; j < types.count; j++) {
			const type = types.objectAtIndex(j);
			const data = item.dataForType(type);
			if (data.isNil()) continue;
			const file = args.dir + '/' + i + '-' + j + '.bin';
			if (!data.writeToFileAtomically($(file), true)) throw new Error('クリップボードを控えられませんでした: ' + file);
			entry.push({ type: type.js, file });
		}
		out.push(entry);
	}
	return out;
`,
		{ dir }
	);
}

/** `readPasteboard` で控えた項目を、クリップボードに書き戻す */
function writePasteboard(items) {
	return jxa(
		`
	const pb = $.NSPasteboard.generalPasteboard;
	pb.clearContents;
	const objects = $.NSMutableArray.array;
	for (const entry of args.items) {
		const item = $.NSPasteboardItem.alloc.init;
		for (const { type, file } of entry) {
			item.setDataForType($.NSData.dataWithContentsOfFile($(file)), $(type));
		}
		objects.addObject(item);
	}
	if (objects.count > 0) pb.writeObjects(objects);
`,
		{ items }
	);
}

// ── Mawok の起動と終了 ──

async function isMawokRunning() {
	return (await mawokPids()).length > 0;
}

async function quitMawok() {
	if (!(await isMawokRunning())) return;
	await execFileAsync('pkill', ['-x', PROCESS_NAME]).catch(() => {});
	await waitFor(isMawokRunning, (running) => !running, {
		timeout: 10_000,
		label: 'Mawok の終了'
	});
}

/** Finder から開くのと同じく LaunchServices で起動し、メニューバーのアイコンが出るまで待つ */
async function launchMawok() {
	// 終了した直後は、LaunchServices がまだ前のプロセスを抱えていて -609 で失敗することがあるので、少し置いてやり直す
	await waitFor(
		() =>
			execFileAsync('open', [APP_BUNDLE]).then(
				() => true,
				() => false
			),
		Boolean,
		{ timeout: 10_000, interval: 500, label: 'open での起動' }
	);
	await waitFor(
		() =>
			jxa('const p = mawok(); return p.exists() && p.menuBars().length > 1;').catch(() => false),
		Boolean,
		{ timeout: 20_000, interval: 300, label: 'Mawok の起動 (メニューバーのアイコン)' }
	);
}

/**
 * 設定ファイルを書き換えて起動し直す。`text` が null なら設定ファイルを消して起動する。
 * 省くと、設定ファイルはそのままで起動し直す。`clearHistory` なら、下書きの履歴を消して起動する
 */
export async function relaunchWithConfig(text, { clearHistory = false } = {}) {
	await quitMawok();
	if (text === null) await fs.rm(CONFIG_PATH, { force: true });
	else if (text !== undefined) await fs.writeFile(CONFIG_PATH, text);
	if (clearHistory) await fs.rm(HISTORY_PATH, { force: true });
	await launchMawok();
}

/** 今の設定ファイルの中身 (無ければ null) */
export function configText() {
	return readTextIfExists(CONFIG_PATH);
}

/** 設定フォルダーにある `config.broken-….toml` (読めない設定を直す前に写したもの) の名前の一覧 */
export async function brokenConfigCopies() {
	const names = await fs.readdir(DATA_DIR);
	return names.filter((name) => name.startsWith('config.broken-')).sort();
}

/** 設定フォルダーの `config.broken-….toml` を消す (テストが作らせたものの後始末) */
async function removeBrokenConfigCopy(name) {
	if (!name.startsWith('config.broken-'))
		throw new Error(`消せるのは config.broken-….toml だけです: ${name}`);
	await fs.rm(path.join(DATA_DIR, name), { force: true });
}

/** 動いている Mawok のプロセス ID */
export function mawokPids() {
	return processPids(PROCESS_NAME);
}

/** 名前のプロセスの ID */
function processPids(name) {
	return pgrep(['-x', name]);
}

/** コマンドの行に `pattern` を含むプロセスの ID */
export function processesMatching(pattern) {
	return pgrep(['-f', pattern]);
}

/** pgrep で見つかったプロセスの ID。pgrep は、見つからないと終了コード 1 で終わる */
async function pgrep(args) {
	try {
		const { stdout } = await execFileAsync('pgrep', args);
		return stdout.trim().split('\n').map(Number);
	} catch (error) {
		if (error.code === 1) return [];
		throw error;
	}
}

/** 名前のアプリのウィンドウが出るまで待つ */
function waitAppWindow(name) {
	return waitFor(
		() =>
			jxa(
				'const p = se.processes.byName(args.name); return p.exists() && p.windows().length > 0;',
				{ name }
			).catch(() => false),
		Boolean,
		{ timeout: 15_000, interval: 300, label: `${name} のウィンドウ` }
	);
}

/** 動いている Mawok を、Finder から開くのと同じく `open` で開き直す。`newInstance` なら `open -n` で2つ目を立てる */
export function openAgain({ newInstance = false } = {}) {
	return execFileAsync('open', newInstance ? ['-n', APP_BUNDLE] : [APP_BUNDLE]);
}

/** 今からの Mawok のログを読む関数を返す (呼んだ時点より後に書かれた分) */
export function watchLog() {
	const mark = markLog(LOG_PATH);
	return () => readLogSince(LOG_PATH, mark);
}

// NSApplicationActivationPolicy の値
export const ACTIVATION_POLICY = { regular: 0, accessory: 1 };

/** Mawok の activation policy。Regular なら Dock と Cmd+Tab に出て、Accessory なら出ない */
export function activationPolicy() {
	return jxa(
		`
	const app = $.NSWorkspace.sharedWorkspace.runningApplications.js.find(
		(a) => a.bundleIdentifier.js === args.identifier
	);
	return app ? Number(app.activationPolicy) : null;
`,
		{ identifier: APP_IDENTIFIER }
	);
}

/**
 * 下書きウィンドウの重なりの層 (`kCGWindowLayer`)。ふつうのウィンドウは 0 で、常に最前面にすると 0 より上になる。
 * アクセシビリティでは層を読めないので、ウィンドウサーバーの一覧から読む。ほかのアプリのウィンドウの名前は、
 * 画面収録の許可が無いと一覧に出ない (見つからず null になる)。名前を使わずに探すと、0 より上の層にあるメニューバーのアイコンを拾ってしまう
 */
export function draftWindowLayer() {
	return jxa(
		`${SCREEN_WINDOWS_PRELUDE}
	const w = screenWindows().find((w) => w.kCGWindowName === args.title);
	return w ? w.kCGWindowLayer : null;
`,
		{ title: DRAFT_TITLE }
	);
}

// ── 常用の状態の控え ──

/**
 * 利用者の設定のまま一度起動し、ログイン時の起動が効いているかを読む。
 * 設定がオンでも、ログイン項目が有効でない (システム設定で切った、登録が無い) と、起動したときに Mawok が設定をオフにそろえ、
 * そのことをログに書く (src-tauri/src/lib.rs の settle_autostart)。ログイン項目の登録の状態は、
 * ほかのアプリからは読めない (SMAppService の mainAppService は、呼んだアプリ自身のもの) ので、これで見分ける
 */
async function readAutostartOn() {
	const config = await readTextIfExists(CONFIG_PATH);
	// 設定ファイルが無いと初めての起動になり、起動すると登録してしまうので、起動せずに効いていないとみなす
	// (戻すときに登録を外す。利用者が次に起動したときは初めての起動になり、そこで登録される)
	if (config === null) return false;
	if (/^autostart\s*=\s*false\s*$/m.test(config)) return false;
	const log = watchLog();
	await launchMawok();
	await quitMawok();
	return !log().includes('launch at login was turned off outside Mawok');
}

/**
 * 回す端末に、アクセシビリティと画面収録 (`screenCapture` が false なら見ない) の許可があるかを確かめ、
 * 無ければ始める前に落とす。許可が無いと、要素やウィンドウの名前の読み取りが黙って失敗し、時間切れや食い違いで
 * 落ちるので、原因が分からない。許可は、
 * osascript を起動した大元のアプリ (Claude Code なら版の番号の名前の実行ファイル) に付くので、その版が上がるたびに外れる
 */
export async function assertPermissions({ screenCapture: needScreenCapture = true } = {}) {
	const { accessibility, screenCapture } = await jxa(`
	ObjC.import('ApplicationServices');
	// JXA の CoreGraphics の読み込みには入っていないので、自分で結ぶ
	ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
	return { accessibility: $.AXIsProcessTrusted(), screenCapture: $.CGPreflightScreenCaptureAccess() };
`);
	const missing = [
		...(accessibility ? [] : ['「アクセシビリティ」']),
		...(screenCapture || !needScreenCapture ? [] : ['「画面収録とシステムオーディオ録音」'])
	];
	if (missing.length > 0) {
		throw new Error(
			`許可がありません。システム設定の「プライバシーとセキュリティ」の${missing.join('と')}で、` +
				'この確認を流しているアプリ (端末。Claude Code から流すときは、版の番号の名前の項目) をオンにしてください'
		);
	}
}

/**
 * 常用の Mawok を終了し、設定・履歴・位置の記録・クリップボード・設定の写しの一覧と、ログイン時の起動が効いているかを控える。
 * 前に中断されて控えが残っていれば、先にそれを戻す
 */
export async function holdUserState() {
	const recoveredRunning = (await fileExists(BACKUP_DIR))
		? (console.warn('前に中断された控えが残っていたので、先に戻します'),
			(await restoreUserState({ relaunch: false })) === true)
		: false;
	const wasRunning = recoveredRunning || (await isMawokRunning());
	await fs.mkdir(path.join(BACKUP_DIR, 'files'), { recursive: true });
	await fs.mkdir(path.join(BACKUP_DIR, 'clipboard'), { recursive: true });
	// 控えを取り終える前に止まっても、動いていた Mawok を起動し直せるよう、先に書いておく
	await writeJsonAtomic(path.join(BACKUP_DIR, 'running.json'), { wasRunning });
	await quitMawok();
	const present = [];
	for (const name of HELD_FILES) {
		const source = path.join(DATA_DIR, name);
		if (await fileExists(source)) {
			await fs.copyFile(source, path.join(BACKUP_DIR, 'files', name));
			present.push(name);
		}
	}
	const clipboard = await readPasteboard(path.join(BACKUP_DIR, 'clipboard'));
	// 戻すときに、テストが作らせた写し (設定を直す前の config.broken-….toml) だけを消せるよう、前からある分を控える
	const brokenCopies = await brokenConfigCopies();
	const autostartOn = await readAutostartOn();
	// 記録は最後に書く。これがあることを、控えが揃った印にする
	await writeJsonAtomic(path.join(BACKUP_DIR, 'state.json'), {
		wasRunning,
		present,
		clipboard,
		brokenCopies,
		autostartOn
	});
}

/**
 * 控えた状態に戻す。Mawok を終了してからファイルを戻し、動いていたなら起動し直す。
 * 控えたときに Mawok が動いていたかを返す (控えが無ければ null)
 */
export async function restoreUserState({ relaunch = true } = {}) {
	if (!(await fileExists(BACKUP_DIR))) return null;
	const stateFile = path.join(BACKUP_DIR, 'state.json');
	if (!(await fileExists(stateFile))) {
		// 控えを取り終える前に止まった。ファイルはまだ書き換えていない
		const running = await fs
			.readFile(path.join(BACKUP_DIR, 'running.json'), 'utf8')
			.then(JSON.parse, () => ({ wasRunning: false }));
		if (relaunch && running.wasRunning && !(await isMawokRunning())) await launchMawok();
		await fs.rm(BACKUP_DIR, { recursive: true, force: true });
		return running.wasRunning;
	}
	const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
	await quitMawok();
	// ログイン項目の登録を、利用者の状態に戻す。初めての起動を試すと登録され、ログイン時の起動の確認は登録を外すので、
	// オフならオフの設定で一度起動して外し、オンなら設定ファイルの無い初めての起動で登録する
	// (設定がオンで登録が無いと、起動しても登録せず、設定をオフにそろえるため。src-tauri/src/lib.rs の autostart_at_launch)
	if (state.autostartOn) await fs.rm(CONFIG_PATH, { force: true });
	else await fs.writeFile(CONFIG_PATH, 'autostart = false\n');
	await launchMawok();
	await quitMawok();
	for (const name of HELD_FILES) {
		const target = path.join(DATA_DIR, name);
		if (state.present.includes(name)) {
			await fs.copyFile(path.join(BACKUP_DIR, 'files', name), target);
		} else {
			await fs.rm(target, { force: true });
		}
	}
	// 前の版の控えには写しの一覧が無い。どれがテストのものか分からないので、そのときは消さない
	for (const name of state.brokenCopies ? await brokenConfigCopies() : []) {
		if (!state.brokenCopies.includes(name)) await removeBrokenConfigCopy(name);
	}
	await writePasteboard(state.clipboard);
	// 戻し終えたら、控えを「起動し直すだけ」に縮めてから起動する。起動の途中で止まっても、次の回は起動し直すだけで、
	// その間に利用者が変えた設定や履歴を古い控えで上書きしないように
	await writeJsonAtomic(path.join(BACKUP_DIR, 'running.json'), { wasRunning: state.wasRunning });
	await fs.rm(stateFile, { force: true });
	await fs.rm(path.join(BACKUP_DIR, 'files'), { recursive: true, force: true });
	await fs.rm(path.join(BACKUP_DIR, 'clipboard'), { recursive: true, force: true });
	if (relaunch && state.wasRunning) await launchMawok();
	await fs.rm(BACKUP_DIR, { recursive: true, force: true });
	return state.wasRunning;
}

/** 控えた設定から、テストで使う設定ファイルを作る。ログイン時の起動だけは、利用者の値を引き継ぐ */
async function testConfigText(extra = '') {
	const held = path.join(BACKUP_DIR, 'files', 'config.toml');
	const text = (await readTextIfExists(held)) ?? '';
	// ログイン項目の登録を書き換えないよう、利用者の値のまま起動する (既定はオン)
	const autostart = /^autostart\s*=\s*false\s*$/m.test(text) ? 'autostart = false\n' : '';
	return autostart + extra;
}

/** `testConfigText(extra)` の設定で起動し直す。`opts` は `relaunchWithConfig` と同じ */
export async function relaunchWithTestConfig(extra = '', opts) {
	await relaunchWithConfig(await testConfigText(extra), opts);
}

// ── 前のアプリ ──

const OTHER_APP = 'Calculator';

/**
 * 下書きや設定を閉じた後に戻る先として、計算機を開いて前面にする。Finder は、アプリが非アクティブになったときに
 * macOS が前面を渡す先にもなるので、戻し先として見分けられない。動いていなければ開き、片付けで終了する
 */
export async function launchOtherApp() {
	const wasRunning = (await processPids(OTHER_APP)).length > 0;
	const close = async () => {
		if (!wasRunning) await execFileAsync('pkill', ['-x', OTHER_APP]).catch(() => {});
	};
	try {
		await execFileAsync('open', ['-a', OTHER_APP]);
		await waitAppWindow(OTHER_APP);
		await activateApp(OTHER_APP);
	} catch (error) {
		// 返す前に落ちると、呼んだ側は片付けられないので、ここで閉じる
		await close();
		throw error;
	}
	// 下書きはアプリを前面にしないパネルで出すので、出す前から前面にいた計算機は前面のままになる。
	// そこで activate しても何も変わらず、キー入力は下書きに残る。利用者と同じく、窓をクリックして移る
	const clickWindow = async () => {
		const point = await jxa(
			`
	const w = se.processes.byName(args.name).windows[0];
	const [x, y] = w.position();
	const [width] = w.size();
	return { x: x + width / 2, y: y + 12 };
`,
			{ name: OTHER_APP }
		);
		await click(point);
		await waitFor(frontmostApp, (front) => front === OTHER_APP, { label: `${OTHER_APP} の前面` });
	};
	return { name: OTHER_APP, activate: () => activateApp(OTHER_APP), clickWindow, close };
}

// ── 貼り付け先 (TextEdit) ──

const PASTE_TARGET = 'TextEdit';

/**
 * 空のテキストファイルを TextEdit で開いて前面にする。利用者が使っている TextEdit を
 * 巻き込まないよう、動いていれば始めずに落ちる
 */
export async function launchPasteTarget() {
	if ((await processPids(PASTE_TARGET)).length > 0) {
		throw new Error('TextEdit が動いています。貼り付け先に使うので、終了してから回してください');
	}
	const file = path.join(os.tmpdir(), `mawok-macos-check-${process.pid}.txt`);
	const close = async () => {
		await execFileAsync('pkill', ['-x', PASTE_TARGET]).catch(() => {});
		await fs.rm(file, { force: true });
	};
	try {
		await fs.writeFile(file, '');
		// -F: 前に開いていたウィンドウを復元しない
		await execFileAsync('open', ['-F', '-a', PASTE_TARGET, file]);
		await waitAppWindow(PASTE_TARGET);
		await activateApp(PASTE_TARGET);
	} catch (error) {
		// 返す前に落ちると、呼んだ側は片付けられないので、ここで閉じる
		await close();
		throw error;
	}
	return { name: PASTE_TARGET, activate: () => activateApp(PASTE_TARGET), close };
}

/** 貼り付け先の本文 */
export function pasteTargetText() {
	return jxa(
		'return String(se.processes.byName(args.name).windows[0].scrollAreas[0].textAreas[0].value());',
		{ name: PASTE_TARGET }
	);
}

/** 貼り付け先の本文の真ん中 (画面の座標) */
export function pasteTargetPoint() {
	return jxa(
		`
	const area = se.processes.byName(args.name).windows[0].scrollAreas[0];
	const [x, y] = area.position();
	const [w, h] = area.size();
	return { x: x + w / 2, y: y + h / 2 };
`,
		{ name: PASTE_TARGET }
	);
}

/** 貼り付け先の本文を全部選んでから貼り付ける (本文がクリップボードの中身に置き換わる) */
export async function pasteIntoTarget() {
	await keystroke('a', ['command down']);
	await keystroke('v', ['command down']);
}
