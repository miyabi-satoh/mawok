import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	SYNC_ITEM_BYTES,
	SYNC_TOMBSTONE_RETENTION,
	SYNC_ACCOUNT_UPDATE_SQL,
	SYNC_TOTAL_BYTES,
	getSync,
	putSync,
	putSyncKey,
	purgeSync,
	startSyncKey,
	deleteSync,
	getSyncKey,
	shouldReset
} from '../src/sync';
import { newAccount } from './helpers';

const KEY = 'a'.repeat(16);

/** 書けるのは同期を始めた (包んだ鍵を置いた) 写しだけ。 */
async function startedAccount() {
	const account = await newAccount();
	await startSyncKey(env, account, { key_id: KEY, wrapped_key: 'wrapped' });
	return account;
}

describe('sync', () => {
	it('resets only outside a rebuild when the saved position was purged or is newer than the server', () => {
		expect(shouldReset(0, 3, 5, false)).toBe(false);
		expect(shouldReset(2, 3, 5, false)).toBe(true);
		expect(shouldReset(3, 3, 5, false)).toBe(false);
		expect(shouldReset(6, 3, 5, false)).toBe(true);
		expect(shouldReset(2, 3, 5, true)).toBe(false);
		expect(shouldReset(6, 3, 5, true)).toBe(false);
	});

	it('keeps every D1 statement below the 100 binding limit at 100 items', () => {
		expect(SYNC_ACCOUNT_UPDATE_SQL.match(/\?/g) ?? []).toHaveLength(9);
	});

	it('checks an item and the total before writing anything', async () => {
		const account = await startedAccount();
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
		expect((await getSync(env, account, { since: 0, limit: 10, rebuild: false })).seq).toBe(0);

		await env.DB.prepare('UPDATE sync_accounts SET bytes = ? WHERE account_id = ?')
			.bind(SYNC_TOTAL_BYTES, account)
			.run();
		expect(
			await putSync(env, account, {
				key_id: KEY,
				items: [{ ...item, data: btoa('x') }]
			})
		).toMatchObject({ error: 'too_large', limit: 'total' });
	});

	it('answers an old base with the current item, a missing one as deleted, and rejects a different key', async () => {
		const account = await startedAccount();
		const item = (id: string, base_seq: number | null, data: string) => ({
			collection: 'settings' as const,
			id,
			base_seq,
			deleted: false,
			data
		});
		await putSync(env, account, { key_id: KEY, items: [item('one', null, 'AQ==')] });
		await putSync(env, account, { key_id: KEY, items: [item('one', 1, 'Ag==')] });
		expect(await putSync(env, account, { key_id: KEY, items: [item('one', 1, 'Aw==')] })).toEqual({
			ok: false,
			error: 'conflict',
			conflicts: [{ collection: 'settings', id: 'one', seq: 2, deleted: false, data: 'Ag==' }]
		});
		expect(
			await putSync(env, account, { key_id: KEY, items: [item('missing', 99, 'AQ==')] })
		).toEqual({
			ok: false,
			error: 'conflict',
			conflicts: [{ collection: 'settings', id: 'missing', seq: null, deleted: true, data: null }]
		});
		expect(
			await putSync(env, account, { key_id: 'b'.repeat(16), items: [item('two', null, 'AQ==')] })
		).toEqual({ ok: false, error: 'key_mismatch' });
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
			.bind(active, t - SYNC_TOMBSTONE_RETENTION)
			.run();
		await env.DB.prepare(
			`INSERT INTO subscriptions (id, account_id, plan, paid_through, status, created_at)
			 VALUES ('sync_active', ?, 'monthly', ?, 'active', 0),
			        ('sync_ended', ?, 'monthly', ?, 'canceled', 0)`
		)
			.bind(active, t + 1, ended, t - SYNC_TOMBSTONE_RETENTION)
			.run();

		await purgeSync(env, t);
		const { results } = await env.DB.prepare(
			'SELECT account_id, purged_seq FROM sync_accounts WHERE account_id IN (?, ?, ?) ORDER BY account_id'
		)
			.bind(active, ended, noSubscription)
			.all<{ account_id: string; purged_seq: number }>();
		expect(results).toEqual([{ account_id: active, purged_seq: 3 }]);
	});

	it('refuses writes to a copy that has not started, so a key is never set without its wrapped key', async () => {
		const account = await newAccount();
		const item = {
			collection: 'settings' as const,
			id: 'one',
			base_seq: null,
			deleted: false,
			data: 'AQ=='
		};
		expect(await putSync(env, account, { key_id: KEY, items: [item] })).toEqual({
			ok: false,
			error: 'key_mismatch'
		});
		// 前の版が置いた、包んだ鍵の無い key_id も同じ。
		await env.DB.prepare(
			'INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes) VALUES (?, ?, 0, 0, 0)'
		)
			.bind(account, KEY)
			.run();
		expect(await putSync(env, account, { key_id: KEY, items: [item] })).toEqual({
			ok: false,
			error: 'key_mismatch'
		});
		// パスワードの変更 (包み直し) でも、包んだ鍵を付けて始めさせない。
		expect(await putSyncKey(env, account, { key_id: KEY, wrapped_key: 'wrapped' })).toBe(
			'key_mismatch'
		);
	});

	it('starts only once, deletes the copy and key, then starts again', async () => {
		const account = await newAccount();
		const key = (id: string, wrapped_key: string) => ({ key_id: id, wrapped_key });
		expect(await startSyncKey(env, account, key(KEY, 'one'))).toEqual({ seq: 0 });
		await putSync(env, account, {
			key_id: KEY,
			items: [{ collection: 'settings', id: 'kept', base_seq: null, deleted: false, data: 'AQ==' }]
		});
		expect(await startSyncKey(env, account, key('b'.repeat(16), 'two'))).toBe('already_started');
		expect(
			(await getSync(env, account, { since: 0, limit: 10, rebuild: false })).items
		).toHaveLength(1);
		await deleteSync(env, account);
		expect(await getSyncKey(env, account)).toEqual({ key_id: null, wrapped_key: null });
		expect(
			await env.DB.prepare('SELECT seq, purged_seq, bytes FROM sync_accounts WHERE account_id = ?')
				.bind(account)
				.first()
		).toEqual({ seq: 2, purged_seq: 2, bytes: 0 });
		expect(await getSync(env, account, { since: 1, limit: 10, rebuild: false })).toMatchObject({
			reset: true,
			items: []
		});
		expect(
			(await getSync(env, account, { since: 0, limit: 10, rebuild: false })).key_id
		).toBeNull();
		// 削除を知らないデバイスの書き込みとパスワードの変更は、鍵の食い違いとして断る
		expect(
			await putSync(env, account, {
				key_id: KEY,
				items: [{ collection: 'settings', id: 'late', base_seq: null, deleted: false, data: 'AQ==' }]
			})
		).toMatchObject({ ok: false, error: 'key_mismatch' });
		expect(await putSyncKey(env, account, key(KEY, 'rewrapped'))).toBe('key_mismatch');
		expect(await startSyncKey(env, account, key('b'.repeat(16), 'two'))).toEqual({ seq: 3 });
		expect(await startSyncKey(env, account, { key_id: KEY })).toBe('invalid_request');
	});
});
