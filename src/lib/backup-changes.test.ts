import { describe, expect, it } from 'vitest';
import type { BackupDifference } from '$lib/bindings/BackupDifference';
import { m } from '$lib/paraglide/messages';
import type { Replacement, Snippet } from '$lib/settings.svelte';
import { newSnippet } from '$lib/snippets';
import { restoreChangeText } from './backup-changes';

const replacement: Replacement = { from: '濃度', to: 'Node.js', enabled: true };
const snippet: Snippet = newSnippet('挨拶', 'お世話になっております。\n佐藤です。');

describe('restoreChangeText', () => {
	it('変わるものは先頭3件と残りを日本語の区切りで出す', () => {
		const changes: BackupDifference[] = [
			{
				id: 'theme',
				current: { type: 'theme', value: 'dark' },
				restored: { type: 'theme', value: 'light' }
			},
			{
				id: 'replacements:濃度',
				current: { type: 'replacement', value: replacement },
				restored: { type: 'replacement', value: { ...replacement, to: '戻した値' } }
			},
			{
				id: 'replacements#order',
				current: { type: 'order', value: 'replacements' },
				restored: { type: 'order', value: 'replacements' }
			},
			{
				id: 'snippets:挨拶\nお世話になっております。\n佐藤です。',
				current: { type: 'snippet', value: snippet },
				restored: { type: 'snippet', value: { ...snippet, body: '戻した本文' } }
			}
		];
		expect(restoreChangeText(changes, 'ja')).toEqual({
			changes: m.backup_restore_changes({
				names: [
					m.settings_theme(),
					m.backup_row_replacement({ name: '濃度' }),
					m.backup_order({ name: m.settings_replacements() }),
					m.backup_restore_more({ count: 1 })
				].join('、')
			}),
			removes: undefined,
			bringsBack: undefined
		});
	});

	it('行が消える・戻る一覧の並びは、変わるものに挙げない', () => {
		const changes: BackupDifference[] = [
			{
				id: 'snippets:挨拶\nお世話になっております。\n佐藤です。',
				current: { type: 'snippet', value: snippet },
				restored: { type: 'deleted' }
			},
			{
				id: 'snippets#order',
				current: { type: 'order', value: 'snippets' },
				restored: { type: 'order', value: 'snippets' }
			},
			{
				id: 'replacements#order',
				current: { type: 'order', value: 'replacements' },
				restored: { type: 'order', value: 'replacements' }
			}
		];
		expect(restoreChangeText(changes, 'ja').changes).toBe(
			m.backup_restore_changes({ names: m.backup_order({ name: m.settings_replacements() }) })
		);
	});

	it('消えるものは今の行の名前で示す', () => {
		const changes: BackupDifference[] = [
			{
				id: 'replacements:濃度',
				current: { type: 'replacement', value: replacement },
				restored: { type: 'deleted' }
			},
			{
				id: 'snippets:挨拶\nお世話になっております。\n佐藤です。',
				current: { type: 'snippet', value: snippet },
				restored: { type: 'deleted' }
			}
		];
		expect(restoreChangeText(changes, 'en')).toEqual({
			changes: undefined,
			removes: m.backup_restore_removes({
				names: [
					m.backup_row_replacement({ name: '濃度' }),
					m.backup_row_snippet({ name: '挨拶' })
				].join(', ')
			}),
			bringsBack: undefined
		});
	});

	it('戻るものは戻した行の名前で示す', () => {
		const changes: BackupDifference[] = [
			{
				id: 'replacements:濃度',
				current: { type: 'deleted' },
				restored: { type: 'replacement', value: replacement }
			},
			{
				id: 'snippets:挨拶\nお世話になっております。\n佐藤です。',
				current: { type: 'deleted' },
				restored: { type: 'snippet', value: snippet }
			}
		];
		expect(restoreChangeText(changes, 'en')).toEqual({
			changes: undefined,
			removes: undefined,
			bringsBack: m.backup_restore_brings_back({
				names: [
					m.backup_row_replacement({ name: '濃度' }),
					m.backup_row_snippet({ name: '挨拶' })
				].join(', ')
			})
		});
	});

	it.each([
		['text_window_always_on_top', m.settings_draft_always_on_top],
		['hide_text_window_on_blur', m.settings_hide_draft_on_blur],
		['show_text_window_buttons', m.settings_draft_buttons]
	] as const)('テキストウィンドウの見出しの下の項目 %s は、見出しを付けて示す', (type, item) => {
		const changes: BackupDifference[] = [
			{
				id: `s_${type}`,
				current: { type, value: true },
				restored: { type, value: false }
			}
		];
		expect(restoreChangeText(changes, 'ja').changes).toBe(
			m.backup_restore_changes({
				names: m.backup_label_sub({ group: m.settings_section_draft_window(), item: item() })
			})
		);
	});
});
