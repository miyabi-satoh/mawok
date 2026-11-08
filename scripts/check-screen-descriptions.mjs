// 画面の説明文を、置いてよい4つの場合 (→ AGENTS.md「文言」) の一覧にあるものだけにする。説明文は、正しくても
// 足しやすく、増えると肝心の注意が読まれなくなる。新しく置くときは、どの場合に当たるかを下の一覧に書く。

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');

// ui-preferences の4つ。取り返しの付かない操作の確認・入力の条件・結果が見えにくい設定・外へ送るものの告知
const allowed = {
	settings_folder_has_settings_description: '取り返しの付かない操作の確認',
	backup_restore_description: '取り返しの付かない操作の確認',
	settings_hotkey_recording_description: '入力の条件',
	settings_keys_recording_description: '入力の条件',
	settings_hotkey_change_in_desktop: '入力の条件',
	settings_hotkey_by_desktop: '入力の条件',
	settings_draft_font_description: '入力の条件',
	settings_exclude_history_description: '結果が見えにくい設定'
};

// 説明文として出る所: 部品の Description の中、description に渡す値、設定の行の部品 (switchRow) の6つ目の引数、
// `_description` で終わる名前の文言
const block = /<(\w+\.)?Description\b[^>]*>([\s\S]*?)<\/(\w+\.)?Description>/g;
const prop = /description[=:]\s*\{?\s*m\.(\w+)\(/g;
const switchRow = /switchRow\((?:[^,()]|\([^()]*\))*(?:,(?:[^,()]|\([^()]*\))*){4},\s*m\.(\w+)\(/g;
const named = /m\.(\w+_description)\(/g;
const call = /m\.(\w+)\(/g;

const files = readdirSync(path.join(root, 'src'), { recursive: true })
	.map((entry) => `src/${entry.split(path.sep).join('/')}`)
	.filter((file) => file.endsWith('.svelte') && !file.startsWith('src/lib/components/ui/'));

const violations = [];
for (const file of files) {
	const text = readFileSync(path.join(root, file), 'utf8');
	const keys = new Set();
	for (const [, , inner] of text.matchAll(block)) {
		for (const [, key] of inner.matchAll(call)) keys.add(key);
	}
	for (const pattern of [prop, switchRow, named]) {
		for (const [, key] of text.matchAll(pattern)) keys.add(key);
	}
	for (const key of keys) {
		if (!(key in allowed)) violations.push(`${file}: ${key}`);
	}
}

if (violations.length > 0) {
	console.error(
		'画面の説明文は、取り返しの付かない操作の確認・入力の条件・結果が見えにくい設定・外へ送るものの告知だけに置きます (→ AGENTS.md「文言」)。当たるなら scripts/check-screen-descriptions.mjs の一覧に足し、当たらないなら外してください:'
	);
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
