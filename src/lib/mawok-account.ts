import type { AccountStatus } from '$lib/bindings/AccountStatus';
import { m } from '$lib/paraglide/messages';

/**
 * Mawok のクレジットの残りの文。null（確かめられなかった）ならその旨を、
 * undefined（答えを待っている）なら何も出さない
 */
export function mawokRemainingText(status: AccountStatus | null | undefined): string {
	if (status) return m.settings_mawok_remaining({ percent: status.remainingPercent });
	return status === null ? m.settings_mawok_status_unknown() : '';
}
