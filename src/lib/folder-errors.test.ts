import { describe, expect, it } from 'vitest';
import { folderErrorMessage } from './folder-errors';
import { m } from '$lib/paraglide/messages';

describe('folderErrorMessage', () => {
	it('Rust 側の符号を、何をすればよいかの案内にする', () => {
		expect(folderErrorMessage('folder.not_found')).toBe(m.folder_error_not_found());
		expect(folderErrorMessage('folder.not_a_folder')).toBe(m.folder_error_not_a_folder());
		expect(folderErrorMessage('folder.network')).toBe(m.folder_error_network({ prefix: '\\\\' }));
	});

	it('ネットワークのパスの印は、どの表示言語でも \\ の2文字のまま出す', () => {
		for (const locale of ['ja', 'en'] as const) {
			expect(m.folder_error_network({ prefix: '\\\\' }, { locale })).toContain('\\\\');
		}
	});

	it('符号でなければ、受け取った文字列をそのまま出す', () => {
		expect(folderErrorMessage('main window not found')).toBe('main window not found');
		expect(folderErrorMessage('toString')).toBe('toString');
	});
});
