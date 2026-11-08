import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '$lib/bindings/constants';
import { m } from '$lib/paraglide/messages';
import {
	describeError,
	errorCode,
	settingsFolderProblem,
	settingsProblemNotice,
	settingsSaveProblem
} from './errors';

function errorWithStack(message: string, stack: string | undefined) {
	const error = new TypeError(message);
	error.stack = stack;
	return error;
}

describe('describeError', () => {
	it('先頭にメッセージを含むスタック（V8）はそのまま使う', () => {
		const stack = 'TypeError: boom\n    at f (app.js:1:1)';
		expect(describeError(errorWithStack('boom', stack))).toBe(stack);
	});

	it('メッセージを含まないスタック（WebKit）には、エラー名とメッセージを前に付ける', () => {
		expect(describeError(errorWithStack('boom', 'f@app.js:1:1'))).toBe(
			'TypeError: boom\nf@app.js:1:1'
		);
	});

	it('スタックがなければ、エラー名とメッセージだけにする', () => {
		expect(describeError(errorWithStack('boom', undefined))).toBe('TypeError: boom');
	});

	it('Error 以外の値は文字列にする', () => {
		expect(describeError('main window not found')).toBe('main window not found');
		expect(describeError(undefined)).toBe('undefined');
	});
});

describe('errorCode', () => {
	it('符号だけの文字列はそのまま返す', () => {
		expect(errorCode('keys.invalid')).toBe('keys.invalid');
	});

	it('文字列でなければ、文字列にしたものを返す', () => {
		expect(errorCode(new Error('boom'))).toBe('Error: boom');
		expect(errorCode(null)).toBe('null');
	});
});

describe('settingsSaveProblem', () => {
	it('設定のファイルを読めなかった符号だけを、その旨の文にする', () => {
		expect(settingsSaveProblem(ERROR_CODES.SETTINGS_FILE_UNREADABLE)).toBe(
			m.settings_file_unreadable()
		);
		expect(settingsSaveProblem(ERROR_CODES.KEYS_INVALID)).toBeUndefined();
	});
});

describe('settingsFolderProblem', () => {
	it('置き場の都合で替えなかった符号を、それぞれの理由の文にする', () => {
		expect(settingsFolderProblem(ERROR_CODES.SETTINGS_FILE_UNREADABLE)).toBe(
			m.settings_folder_unreadable()
		);
		expect(settingsFolderProblem(ERROR_CODES.SETTINGS_FOLDER_UNAVAILABLE)).toBe(
			m.settings_folder_link_missing()
		);
		expect(settingsFolderProblem(ERROR_CODES.SETTINGS_ACCESS_DENIED)).toBe(
			m.settings_folder_access_denied()
		);
	});

	it('ほかの失敗は、受け取った文を添えて出す', () => {
		expect(settingsFolderProblem('disk full')).toBe(m.settings_failed({ error: 'disk full' }));
	});
});

describe('settingsProblemNotice', () => {
	it('読めないファイルは、名前を並べて出す', () => {
		expect(
			settingsProblemNotice({ kind: 'unreadable', files: ['settings.toml', 'snippets.toml'] })
		).toBe(m.settings_file_unreadable_notice({ files: 'settings.toml, snippets.toml' }));
	});

	it('保存先が無いときと、読む許可が無いときは、それぞれの知らせにする', () => {
		expect(settingsProblemNotice({ kind: 'folderMissing', path: '/a/Mawok' })).toBe(
			m.settings_folder_missing({ path: '/a/Mawok' })
		);
		expect(settingsProblemNotice({ kind: 'accessNeeded', path: '/a/settings.toml' })).toBe(
			m.settings_folder_access_needed({ path: '/a/settings.toml' })
		);
	});
});
