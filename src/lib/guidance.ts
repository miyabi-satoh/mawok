import { formatKeys, type DraftKeys, type Platform } from '$lib/keys';
import { m } from '$lib/paraglide/messages';
import type { SettingsView } from '$lib/settings.svelte';

/**
 * 下書きの入力欄に出す案内の文。設定が null なら既定の案内を、今の表示言語とキーで作る。
 * コピー・設定のキーやホットキーを外していたら、そのキーを書かない文にする。
 * ホットキーを登録できていなければ、呼び出せると書かずに、登録できないことを書く。ほかに気づく手がかりがトレイの ⚠ だけで、
 * Windows 11 ではトレイのアイコンが既定で隠れているため。
 * 自分で書いた文（空文字を含む）は、キーを差し込まずにそのまま返す。空文字は案内を出さないという意味
 */
export function draftGuidance(
	setting: string | null,
	hotkey: string,
	keys: DraftKeys,
	platform: Platform,
	hotkeyUnavailable = false
): string {
	if (setting !== null) return setting;
	const write = keys.copy
		? m.draft_guidance_write({ copy: formatKeys(keys.copy, platform) })
		: m.draft_guidance_write_no_copy();
	const summon = !hotkey
		? ''
		: hotkeyUnavailable
			? m.draft_guidance_hotkey_unavailable({ hotkey: formatKeys(hotkey, platform) })
			: m.draft_guidance_summon({ hotkey: formatKeys(hotkey, platform) });
	const change = keys.settings
		? m.draft_guidance_change({ settings: formatKeys(keys.settings, platform) })
		: m.draft_guidance_change_no_settings();
	// 1文ずつ行を分ける。どの文も既定の窓の幅で1行に収まり、文の切れ目と行の切れ目が揃う
	return [write, summon, change].filter(Boolean).join('\n');
}

/**
 * 案内に書くホットキー。デスクトップで割り当てるときは、portal で付いて読めたキーだけを書く。
 * キー設定から呼ぶ形では、どのキーかを Mawok は知らない
 */
export function guidanceHotkey(
	view: Pick<SettingsView, 'hotkey' | 'hotkeyByDesktop' | 'desktopHotkeyKeys'>
): string {
	return view.hotkeyByDesktop ? (view.desktopHotkeyKeys ?? '') : view.hotkey;
}
