import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// アプリ側が決めている値 (識別子・ウィンドウの大きさ)。tauri.conf.json にあるものはそこから読み、
// Rust の定数にしかないものは写しを置く

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tauriConf = JSON.parse(
	fs.readFileSync(path.join(__dirname, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const draftWindow = tauriConf.app.windows.find((w) => w.label === 'main');

/** 設定や履歴のフォルダー名になる、アプリの識別子 */
export const APP_IDENTIFIER = tauriConf.identifier;
/** アプリの版番号 */
export const APP_VERSION = tauriConf.version;

/** 下書きウィンドウのタイトル */
export const DRAFT_TITLE = draftWindow.title;
/** 下書きウィンドウの既定の大きさと最小の大きさ (中身の大きさ、論理ピクセル) */
export const DRAFT_DEFAULT_SIZE = { width: draftWindow.width, height: draftWindow.height };
export const DRAFT_MIN_SIZE = { width: draftWindow.minWidth, height: draftWindow.minHeight };

// src-tauri/src/lib.rs の SETTINGS_MIN_SIZE・LICENSES_MIN_SIZE の写し (中身の大きさ、論理ピクセル)
export const SETTINGS_MIN_SIZE = { width: 560, height: 400 };
export const LICENSES_MIN_SIZE = { width: 480, height: 320 };

// src-tauri/src/i18n.rs の settings_title の写し。表示言語で変わるので、日本語で起動して使う
export const SETTINGS_TITLE = '設定';
// 表示言語を決めずに起動したときに、どちらの言語でも見分けるための一覧
export const SETTINGS_TITLES = [SETTINGS_TITLE, 'Settings'];

// src-tauri/src/i18n.rs の licenses_title の写し。設定ウィンドウのタイトルと同じく表示言語で変わる
export const LICENSES_TITLE = '第三者のソフトウェア';
// src-tauri/src/i18n.rs の manual の写し。メニューの項目と同じ文言
export const MANUAL_TITLE = '使い方';

// src-tauri/src/i18n.rs の、トレイ (メニューバー) のメニューの項目の写し (日本語)
export const TRAY_MENU_JA = {
	toggleDraft: 'テキストウィンドウを表示／隠す',
	settings: '設定…',
	manual: MANUAL_TITLE,
	quit: '終了'
};
