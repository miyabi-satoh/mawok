import CircleUserRoundIcon from '@lucide/svelte/icons/circle-user-round';
import InfoIcon from '@lucide/svelte/icons/info';
import KeyboardIcon from '@lucide/svelte/icons/keyboard';
import LaptopIcon from '@lucide/svelte/icons/laptop';
import SettingsIcon from '@lucide/svelte/icons/settings';
import SparklesIcon from '@lucide/svelte/icons/sparkles';
import TextQuoteIcon from '@lucide/svelte/icons/text-quote';
import TypeIcon from '@lucide/svelte/icons/type';
import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
import { m } from '$lib/paraglide/messages';

/** 設定画面のサイドバーの分類 */
export function settingsCategories() {
	return [
		{ value: 'general', label: m.settings_category_general, icon: SettingsIcon },
		{ value: 'keys', label: m.settings_category_keys, icon: KeyboardIcon },
		{ value: 'draft', label: m.settings_category_draft, icon: TypeIcon },
		{ value: 'copy', label: m.settings_category_copy, icon: WandSparklesIcon },
		{ value: 'snippets', label: m.settings_category_snippets, icon: TextQuoteIcon },
		{ value: 'actions', label: m.settings_category_actions, icon: SparklesIcon },
		{ value: 'devices', label: m.settings_category_devices, icon: LaptopIcon },
		{ value: 'account', label: m.settings_category_account, icon: CircleUserRoundIcon },
		{ value: 'about', label: m.settings_category_about, icon: InfoIcon }
	];
}
