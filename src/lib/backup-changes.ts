import type { BackupDifference } from '$lib/bindings/BackupDifference';
import type { SyncValue } from '$lib/bindings/SyncValue';
import { m } from '$lib/paraglide/messages';
import type { Locale } from '$lib/paraglide/runtime';
import { CHAR_WIDTH_KINDS } from '$lib/setting-options';
import { snippetLabel } from '$lib/snippets';

type Row = Extract<SyncValue, { type: 'replacement' | 'snippet' }>;

const orEmpty = (text: string) => (text === '' ? m.settings_row_empty() : text);

function rowName(row: Row): string {
	switch (row.type) {
		case 'replacement':
			return orEmpty(row.value.from);
		case 'snippet':
			return orEmpty(snippetLabel(row.value));
	}
}

/** 項目の名前。設定の画面でのその項目のラベルと同じ言い方にし、行は種類と行の名前にする */
function label(value: Exclude<SyncValue, { type: 'deleted' }>): string | undefined {
	switch (value.type) {
		case 'language':
			return m.settings_language();
		case 'theme':
			return m.settings_theme();
		case 'text_window_always_on_top':
			return m.settings_draft_always_on_top();
		case 'hide_text_window_on_blur':
			return m.settings_hide_draft_on_blur();
		case 'show_text_window_buttons':
			return m.settings_draft_buttons();
		case 'text_history_size':
			return m.settings_draft_history_size();
		case 'trim_trailing_whitespace':
			return m.settings_trim_trailing();
		case 'punctuation_style':
			return m.backup_label_sub({
				group: m.settings_char_width(),
				item: m.settings_char_width_punctuation()
			});
		case 'alphabet_width':
		case 'digit_width':
		case 'space_width':
		case 'symbol_width':
		case 'katakana_width':
			return m.backup_label_sub({
				group: m.settings_char_width(),
				item: CHAR_WIDTH_KINDS.find(({ kind }) => `${kind}_width` === value.type)?.label() ?? ''
			});
		case 'exclude_from_clipboard_history':
			return m.settings_exclude_history();
		case 'text_font_size':
			return m.settings_draft_font_size();
		case 'text_color_light':
			return m.backup_label_sub({
				group: m.settings_draft_text_color(),
				item: m.settings_draft_text_color_light()
			});
		case 'text_color_dark':
			return m.backup_label_sub({
				group: m.settings_draft_text_color(),
				item: m.settings_draft_text_color_dark()
			});
		case 'input_guidance':
			return m.settings_draft_guidance();
		case 'ai_service':
			return m.settings_ai_service();
		case 'ai_models':
			return m.settings_ai_model();
		case 'hotkey':
			return m.settings_hotkey();
		case 'text_window_keys':
			return m.settings_category_keys();
		case 'text_font_family':
			return m.settings_draft_font();
		case 'replacement':
			return m.backup_row_replacement({ name: rowName(value) });
		case 'snippet':
			return m.backup_row_snippet({ name: rowName(value) });
		case 'order':
			return m.backup_order({
				name:
					{
						replacements: m.settings_replacements(),
						snippets: m.settings_category_snippets()
					}[value.value] ?? value.value
			});
		default:
			return undefined;
	}
}

/** バックアップへ戻すと、変わる・消える・戻る項目。 */
export function restoreChangeText(changes: BackupDifference[], locale: Locale) {
	const summarize = (
		items: BackupDifference[],
		value: (change: BackupDifference) => SyncValue,
		message: (args: { names: string }) => string
	) => {
		const names = items
			.map((change) => {
				const named = value(change);
				return named.type === 'deleted' ? undefined : label(named);
			})
			.filter((name): name is string => Boolean(name));
		if (names.length === 0) return undefined;
		const shown = names.slice(0, 3);
		if (names.length > shown.length)
			shown.push(m.backup_restore_more({ count: names.length - shown.length }));
		return message({ names: shown.join(locale === 'ja' ? '、' : ', ') });
	};
	// 行が消える・戻るなら並びも必ず変わる。その一覧の並びまで挙げると、同じことを2回言うことになる
	const ROW_OF_ORDER: Record<string, SyncValue['type']> = {
		replacements: 'replacement',
		snippets: 'snippet'
	};
	const rowsMoved = new Set(
		changes
			.filter(({ current, restored }) => current.type === 'deleted' || restored.type === 'deleted')
			.map(({ current, restored }) => (current.type === 'deleted' ? restored.type : current.type))
	);
	const impliedOrder = ({ restored }: BackupDifference) =>
		restored.type === 'order' && rowsMoved.has(ROW_OF_ORDER[restored.value]);
	return {
		changes: summarize(
			changes.filter(
				(change) =>
					change.current.type !== 'deleted' &&
					change.restored.type !== 'deleted' &&
					!impliedOrder(change)
			),
			({ restored }) => restored,
			m.backup_restore_changes
		),
		removes: summarize(
			changes.filter(
				({ current, restored }) => current.type !== 'deleted' && restored.type === 'deleted'
			),
			({ current }) => current,
			m.backup_restore_removes
		),
		bringsBack: summarize(
			changes.filter(
				({ current, restored }) => current.type === 'deleted' && restored.type !== 'deleted'
			),
			({ restored }) => restored,
			m.backup_restore_brings_back
		)
	};
}
