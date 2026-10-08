import { formatKeys, type DraftKeys, type Platform } from '$lib/keys';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';

/**
 * 下書きの入力欄に出す案内の文。設定が null なら既定の案内を、今の表示言語とキーで作る。
 * コピー・設定のキーやホットキーを外していたら、そのキーを書かない文にする。
 * 自分で書いた文（空文字を含む）は、キーを差し込まずにそのまま返す。空文字は案内を出さないという意味
 */
export function draftGuidance(
	setting: string | null,
	hotkey: string,
	keys: DraftKeys,
	platform: Platform
): string {
	if (setting !== null) return setting;
	const write = keys.copy
		? m.draft_guidance_write({ copy: formatKeys(keys.copy, platform) })
		: m.draft_guidance_write_no_copy();
	const summon = hotkey ? m.draft_guidance_summon({ hotkey: formatKeys(hotkey, platform) }) : '';
	const change = keys.settings
		? m.draft_guidance_change({ settings: formatKeys(keys.settings, platform) })
		: m.draft_guidance_change_no_settings();
	// 日本語は文の間を空けず、英語は空白で区切る
	const gap = getLocale() === 'ja' ? '' : ' ';
	return `${[write, summon].filter(Boolean).join(gap)}\n${change}`;
}
