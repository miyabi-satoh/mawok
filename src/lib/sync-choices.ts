import { ENCODINGS, OUTPUTS } from '$lib/action-options';
import { aiServiceInfo } from '$lib/ai-services';
import type { SyncConflict } from '$lib/bindings/SyncConflict';
import type { SyncBackupDifference } from '$lib/bindings/SyncBackupDifference';
import type { SyncValue } from '$lib/bindings/SyncValue';
import { CONSTANTS } from '$lib/bindings/constants';
import { DEFAULT_TEXT_COLORS } from '$lib/color';
import { DRAFT_ACTIONS_IN_SETTINGS, draftActionLabel, formatKeys, type Platform } from '$lib/keys';
import { m } from '$lib/paraglide/messages';
import type { Locale } from '$lib/paraglide/runtime';
import {
	CHAR_WIDTH_KINDS,
	LANGUAGES,
	optionName,
	PUNCTUATION_STYLES,
	THEMES,
	WIDTH_STYLES
} from '$lib/setting-options';
import { snippetLabel } from '$lib/snippets';

/** 別々に変えた1項目を、どちらを使うか選ぶ画面に出す文言。値は、複数行なら改行でつなぐ */
export type ChoiceText = { label: string; thisDevice: string; otherDevice: string };

type ValueOf<T extends SyncValue['type']> = Extract<SyncValue, { type: T }>;
type Row = ValueOf<'replacement' | 'snippet'>;

const onOff = (on: boolean) => (on ? m.sync_choice_on() : m.sync_choice_off());
const pair = (label: string, value: string) => m.sync_choice_pair({ label, value });
const orDefault = (text: string) => (text === '' ? m.sync_choice_default() : text);
const orEmpty = (text: string) => (text === '' ? m.settings_row_empty() : text);
const keysText = (key: string, platform: Platform) =>
	key === '' ? m.settings_key_none() : formatKeys(key, platform);

/** 2つの値で違う項目だけを残す。値の一部だけが違う設定で、同じ所まで並べると、どこが違うのかを探すことになる */
function differing<K>(keys: readonly K[], same: (key: K) => boolean): readonly K[] {
	const changed = keys.filter((key) => !same(key));
	return changed.length > 0 ? changed : keys;
}

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
			return m.sync_choice_label_sub({
				group: m.settings_char_width(),
				item: m.settings_char_width_punctuation()
			});
		case 'char_widths':
			return m.settings_char_width();
		case 'exclude_from_clipboard_history':
			return m.settings_exclude_history();
		case 'text_font_size':
			return m.settings_draft_font_size();
		case 'text_color_light':
			return m.sync_choice_label_sub({
				group: m.settings_draft_text_color(),
				item: m.settings_draft_text_color_light()
			});
		case 'text_color_dark':
			return m.sync_choice_label_sub({
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
			return m.sync_choice_row_replacement({ name: rowName(value) });
		case 'snippet':
			return m.sync_choice_row_snippet({ name: rowName(value) });
		case 'order':
			return m.sync_choice_order({
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

/** 同期前の控えへ戻すと、変わる・消える・戻る項目。 */
export function restoreChangeText(changes: SyncBackupDifference[], locale: Locale) {
	const summarize = (
		items: SyncBackupDifference[],
		value: (change: SyncBackupDifference) => SyncValue,
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
			shown.push(m.sync_restore_more({ count: names.length - shown.length }));
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
	const impliedOrder = ({ restored }: SyncBackupDifference) =>
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
			m.sync_restore_changes
		),
		removes: summarize(
			changes.filter(
				({ current, restored }) => current.type !== 'deleted' && restored.type === 'deleted'
			),
			({ current }) => current,
			m.sync_restore_removes
		),
		bringsBack: summarize(
			changes.filter(
				({ current, restored }) => current.type === 'deleted' && restored.type !== 'deleted'
			),
			({ restored }) => restored,
			m.sync_restore_brings_back
		)
	};
}

/** `other` と同じ種類の値なら、その値。行は、片方が「削除」のことがある */
function sameType<T extends SyncValue>(value: T, other: SyncValue): T | null {
	return other.type === value.type ? (other as T) : null;
}

/** 値。設定の画面で見えるのと同じ言い方にする。`other` は、違う所だけを出すために見る、もう片方の値 */
function valueText(value: SyncValue, other: SyncValue, platform: Platform): string {
	switch (value.type) {
		case 'deleted':
			return m.sync_choice_deleted();
		case 'language':
			return optionName(LANGUAGES, value.value);
		case 'theme':
			return optionName(THEMES, value.value);
		case 'text_window_always_on_top':
		case 'hide_text_window_on_blur':
		case 'show_text_window_buttons':
		case 'trim_trailing_whitespace':
		case 'exclude_from_clipboard_history':
			return onOff(value.value);
		case 'text_history_size':
		case 'text_font_size':
			return String(value.value);
		case 'punctuation_style':
			return optionName(PUNCTUATION_STYLES, value.value);
		case 'char_widths': {
			const theirs = sameType(value, other)?.value;
			return differing(CHAR_WIDTH_KINDS, ({ kind }) => theirs?.[kind] === value.value[kind])
				.map(({ kind, label }) => pair(label(), optionName(WIDTH_STYLES, value.value[kind])))
				.join('\n');
		}
		case 'text_color_light':
			return value.value || DEFAULT_TEXT_COLORS.light;
		case 'text_color_dark':
			return value.value || DEFAULT_TEXT_COLORS.dark;
		case 'input_guidance':
			if (value.value === null) return m.sync_choice_default();
			return value.value === '' ? m.sync_choice_empty() : value.value;
		case 'ai_service':
			return aiServiceInfo(value.value).name();
		case 'ai_models': {
			const theirs = sameType(value, other)?.value ?? {};
			const services = CONSTANTS.AI_SERVICES.filter(
				(service) => service in value.value || service in theirs
			);
			return differing(services, (service) => theirs[service] === value.value[service])
				.map((service) =>
					pair(aiServiceInfo(service).name(), orDefault(value.value[service] ?? ''))
				)
				.join('\n');
		}
		case 'hotkey':
			return keysText(value.value, platform);
		case 'text_window_keys': {
			const theirs = sameType(value, other)?.value;
			return differing(
				DRAFT_ACTIONS_IN_SETTINGS,
				(action) => theirs?.[action] === value.value[action]
			)
				.map((action) => pair(draftActionLabel(action), keysText(value.value[action], platform)))
				.join('\n');
		}
		case 'text_font_family':
			return orDefault(value.value);
		case 'order':
			return '';
		case 'replacement': {
			const row = value.value;
			const theirs = sameType(value, other)?.value;
			const lines = [`${row.from} → ${row.to}`];
			if (theirs && theirs.enabled !== row.enabled) {
				lines.push(pair(m.settings_replacements_enabled(), onOff(row.enabled)));
			}
			return lines.join('\n');
		}
		case 'snippet': {
			const row = value.value;
			const theirs = sameType(value, other)?.value;
			const lines = [row.name, row.body].filter((line) => line !== '');
			if (theirs && theirs.output !== row.output) {
				const output = OUTPUTS.find((option) => option.value === row.output);
				lines.push(pair(m.settings_snippets_output(), output?.name() ?? row.output));
			}
			if (theirs && theirs.encoding !== row.encoding) {
				const encoding = ENCODINGS.find((option) => option.value === row.encoding);
				lines.push(pair(m.settings_snippets_encoding(), encoding?.name ?? row.encoding));
			}
			if (theirs && theirs.enabled !== row.enabled) {
				lines.push(pair(m.settings_snippets_enabled_unnamed(), onOff(row.enabled)));
			}
			return lines.join('\n');
		}
	}
}

/** 前の行を略したことを示す印 */
const OMITTED = '…';

/**
 * 複数行の2つの値を、違いが始まる行の1行前から出す。略したら、先頭の行に印を置く。
 * 先頭から出すと、後ろだけが違う長い本文は、見える範囲では両方が同じに見える
 */
export function fromDifference(mine: string, theirs: string): [string, string] {
	const [a, b] = [mine.split('\n'), theirs.split('\n')];
	const shorter = Math.min(a.length, b.length);
	let first = 0;
	while (first < shorter && a[first] === b[first]) first++;
	const start = first - 1;
	// 略して減るのが1行だけなら、印に替わるだけで短くならず、1行が見えなくなる
	if (start <= 1 || mine === theirs) return [mine, theirs];
	const cut = (lines: string[]) => [OMITTED, ...lines.slice(start)].join('\n');
	return [cut(a), cut(b)];
}

/** 1項目の名前と、このデバイスの値・ほかのデバイスの値。名前は、消していない方の値から付ける */
export function choiceText(conflict: SyncConflict, platform: Platform): ChoiceText {
	const { thisDevice, otherDevice } = conflict;
	const named = thisDevice.type !== 'deleted' ? thisDevice : otherDevice;
	const texts: [string, string] = [
		valueText(thisDevice, otherDevice, platform),
		valueText(otherDevice, thisDevice, platform)
	];
	// 片方で消した行は、比べる相手が無いので、残っている方を先頭から出す
	const oneSided = thisDevice.type === 'deleted' || otherDevice.type === 'deleted';
	const [mine, theirs] = oneSided ? texts : fromDifference(...texts);
	return {
		label: named.type === 'deleted' ? '' : (label(named) ?? ''),
		thisDevice: mine,
		otherDevice: theirs
	};
}

/** 項目ごとの選択肢。`later` は、この項目を今は選ばない */
export type ChoiceSide = 'this_device' | 'other_device' | 'later';

export const CHOICE_SIDES: { side: ChoiceSide; name: () => string }[] = [
	{ side: 'this_device', name: m.sync_choice_this_device },
	{ side: 'other_device', name: m.sync_choice_other_device },
	{ side: 'later', name: m.sync_choice_later }
];

/** 読み上げで、どの項目のどの選択肢かを見分ける名前 */
export function sideName(itemLabel: string, side: ChoiceSide): string {
	const name = CHOICE_SIDES.find((choice) => choice.side === side)?.name() ?? '';
	return m.sync_choice_side_of({ name: itemLabel, side: name });
}
