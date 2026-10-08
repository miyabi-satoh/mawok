import type { UpdateStatus } from '$lib/bindings/UpdateStatus';
import { m } from '$lib/paraglide/messages';

/** 設定の「このアプリについて」の、更新の行に出す様子。まだ確かめていなければ出さない（ボタンだけを出す） */
export function updateStatusText(status: UpdateStatus): string {
	switch (status.state) {
		case 'unchecked':
			return '';
		case 'checking':
			return m.settings_update_checking();
		case 'upToDate':
			return m.settings_update_up_to_date();
		case 'available':
			return m.settings_update_available({ version: status.version });
		case 'installing':
			return m.settings_update_installing({ version: status.version });
		case 'checkFailed':
			return m.settings_update_check_failed();
		case 'installFailed':
			return m.settings_update_install_failed({ version: status.version });
	}
}

/**
 * 更新の行のボタン。check は「今すぐ確かめる」、install は「更新して再起動」、installing は押せない「更新して再起動」。
 * 確かめている間は出さない
 */
export type UpdateButton = 'check' | 'install' | 'installing' | null;

export function updateButton(status: UpdateStatus): UpdateButton {
	switch (status.state) {
		case 'checking':
			return null;
		case 'available':
		case 'installFailed':
			return 'install';
		case 'installing':
			return 'installing';
		case 'unchecked':
		case 'upToDate':
		case 'checkFailed':
			return 'check';
	}
}
