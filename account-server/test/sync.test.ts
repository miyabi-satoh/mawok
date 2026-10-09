import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	SYNC_ITEM_BYTES,
	SYNC_TOTAL_BYTES,
	getSync,
	putSync,
	purgeSync,
	shouldReset
} from '../src/sync';
import { newAccount } from './helpers';

const KEY = 'a'.repeat(16);

describe('sync', () => {
	it('makes a reset necessary when the saved position was purged', () => {
		expect(shouldReset(0, 3)).toBe(false);
		expect(shouldReset(2, 3)).toBe(true);
		expect(shouldReset(3, 3)).toBe(false);
		expect(shouldReset(4, 3)).toBe(false);
	});

	it('checks an item and the total before writing anything', async () => {
		const account = await newAccount();
		const item = {
			collection: 'settings' as const,
			id: 'one',
			base_seq: null,
			deleted: false,
			data: btoa('x'.repeat(SYNC_ITEM_BYTES + 1))
		};
		expect(await putSync(env, account, { key_id: KEY, items: [item] })).toMatchObject({
			error: 'too_large',
			limit: 'item'
		});
		expect((await getSync(env, account, { since: 0, limit: 10 })).seq).toBe(0);

		await env.DB.prepare(
			'INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes) VALUES (?, ?, 0, 0, ?)'
		)
			.bind(account, KEY, SYNC_TOTAL_BYTES)
			.run();
		expect(
			await putSync(env, account, {
				key_id: KEY,
				items: [{ ...item, data: btoa('x') }]
			})
		).toMatchObject({ error: 'too_large', limit: 'total' });
	});

	it('purges old tombstones and only expires copies whose Pro ended long ago', async () => {
		const t = 4_102_444_800;
		const [active, ended, noSubscription] = [
			await newAccount(),
			await newAccount(),
			await newAccount()
		];
		for (const account of [active, ended, noSubscription]) {
			await env.DB.prepare(
				'INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes) VALUES (?, ?, 4, 0, 0)'
			)
				.bind(account, KEY)
				.run();
		}
		await env.DB.prepare(
			`INSERT INTO sync_items (account_id, collection, id, seq, deleted, data, updated_at)
			 VALUES (?, 'settings', 'gone', 3, 1, NULL, ?)`
		)
			.bind(active, t - 90 * 24 * 60 * 60)
			.run();
		await env.DB.prepare(
			`INSERT INTO subscriptions (id, account_id, plan, paid_through, status, created_at)
			 VALUES ('sync_active', ?, 'monthly', ?, 'active', 0),
			        ('sync_ended', ?, 'monthly', ?, 'canceled', 0)`
		)
			.bind(active, t + 1, ended, t - 90 * 24 * 60 * 60)
			.run();

		await purgeSync(env, t);
		const { results } = await env.DB.prepare(
			'SELECT account_id, purged_seq FROM sync_accounts WHERE account_id IN (?, ?, ?) ORDER BY account_id'
		)
			.bind(active, ended, noSubscription)
			.all<{ account_id: string; purged_seq: number }>();
		expect(results).toEqual([{ account_id: active, purged_seq: 3 }]);
	});
});
