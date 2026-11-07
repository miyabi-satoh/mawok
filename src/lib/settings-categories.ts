import FolderSyncIcon from '@lucide/svelte/icons/folder-sync';
import InfoIcon from '@lucide/svelte/icons/info';
import KeyboardIcon from '@lucide/svelte/icons/keyboard';
import SettingsIcon from '@lucide/svelte/icons/settings';
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
		{ value: 'sync', label: m.settings_category_sync, icon: FolderSyncIcon },
		{ value: 'about', label: m.settings_category_about, icon: InfoIcon }
	];
}
