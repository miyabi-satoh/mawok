import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { purgeSync, SYNC_ITEM_BYTES } from '../../src/sync';
import { accountId, addSubscription, app, linkApp } from '../helpers';

const KEY = 'a'.repeat(16);

async function makePro(email: string) {
	const account = await accountId(email);
	await addSubscription(account, { id: `sync_${email}` });
	return account;
}

function put(token: string, body: unknown) {
	return app('/v1/sync', token, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('sync HTTP', () => {
	it('writes encrypted bytes and reads them in sequence order', async () => {
		const email = 'sync-read@example.com';
		const { token } = await linkApp(email);
		await makePro(email);
		expect(
			await (
				await put(token, {
					key_id: KEY,
					items: [
						{ collection: 'history', id: 'newest', base_seq: null, deleted: false, data: 'AgM=' },
						{ collection: 'settings', id: 'first', base_seq: null, deleted: false, data: 'AQ==' }
					]
				})
			).json()
		).toEqual({
			seq: 2,
			items: [
				{ collection: 'history', id: 'newest', seq: 1 },
				{ collection: 'settings', id: 'first', seq: 2 }
			]
		});
		expect(await (await app('/v1/sync?since=0&limit=1', token)).json()).toEqual({
			key_id: KEY,
			seq: 2,
			reset: false,
			items: [{ collection: 'history', id: 'newest', seq: 1, deleted: false, data: 'AgM=' }],
			more: true,
			next: 1
		});
		expect(await (await app('/v1/sync?since=1&limit=1&rebuild=1', token)).json()).toMatchObject({
			items: [{ collection: 'settings', id: 'first', seq: 2 }],
			more: false,
			next: 2
		});
	});

	// 競合と上限の場合ごとの中身は test/sync.test.ts が見る。ここは、状態コードと本文が届くことだけを見る。
	it('answers 409 with the current encrypted item for an old base, and for a different key', async () => {
		const email = 'sync-conflict@example.com';
		const { token } = await linkApp(email);
		await makePro(email);
		await put(token, {
			key_id: KEY,
			items: [{ collection: 'settings', id: 'one', base_seq: null, deleted: false, data: 'AQ==' }]
		});
		await put(token, {
			key_id: KEY,
			items: [{ collection: 'settings', id: 'one', base_seq: 1, deleted: false, data: 'Ag==' }]
		});
		const response = await put(token, {
			key_id: KEY,
			items: [{ collection: 'settings', id: 'one', base_seq: 1, deleted: false, data: 'Aw==' }]
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'conflict',
			conflicts: [{ collection: 'settings', id: 'one', seq: 2, deleted: false, data: 'Ag==' }]
		});
		// 違う鍵も 409 だが、アプリは error で競合と見分ける。
		const mismatch = await put(token, {
			key_id: 'b'.repeat(16),
			items: [{ collection: 'settings', id: 'two', base_seq: null, deleted: false, data: 'AQ==' }]
		});
		expect(mismatch.status).toBe(409);
		expect(await mismatch.json()).toEqual({ error: 'key_mismatch' });
	});

	it('writes all 100 items without exceeding D1 bindings', async () => {
		const email = 'sync-hundred@example.com';
		const { token } = await linkApp(email);
		await makePro(email);
		const items = Array.from({ length: 100 }, (_, n) => ({
			collection: 'settings' as const,
			id: `item-${n}`,
			base_seq: null,
			deleted: false,
			data: 'AQ=='
		}));
		const response = await put(token, { key_id: KEY, items });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			seq: 100,
			items: expect.arrayContaining([{ collection: 'settings', id: 'item-99', seq: 100 }])
		});
	});

	it('retries once when a different item is written at the same time', async () => {
		const email = 'sync-concurrent@example.com';
		const { token } = await linkApp(email);
		await makePro(email);
		const responses = await Promise.all(
			['left', 'right'].map((id) =>
				put(token, {
					key_id: KEY,
					items: [{ collection: 'settings', id, base_seq: null, deleted: false, data: 'AQ==' }]
				})
			)
		);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
		const synced = await (await app('/v1/sync?since=0', token)).json<{ items: unknown[] }>();
		expect(synced.items).toHaveLength(2);
	});

	it('answers 413 for an item over the limit', async () => {
		const email = 'sync-limits@example.com';
		const { token } = await linkApp(email);
		await makePro(email);
		const response = await put(token, {
			key_id: KEY,
			items: [
				{
					collection: 'settings',
					id: 'item',
					base_seq: null,
					deleted: false,
					data: btoa('x'.repeat(SYNC_ITEM_BYTES + 1))
				}
			]
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: 'too_large', limit: 'item' });
	});

	it('resets an old key and requires peers to rebuild from the server copy', async () => {
		const email = 'sync-reset@example.com';
		const { token } = await linkApp(email);
		await makePro(email);
		await put(token, {
			key_id: KEY,
			items: [{ collection: 'settings', id: 'one', base_seq: null, deleted: false, data: 'AQ==' }]
		});
		expect(
			await (
				await app('/v1/sync/reset', token, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ key_id: 'b'.repeat(16) })
				})
			).json()
		).toEqual({ seq: 2 });
		expect(await (await app('/v1/sync?since=1', token)).json()).toMatchObject({
			key_id: 'b'.repeat(16),
			seq: 2,
			reset: true,
			items: []
		});
	});

	it('ends a rebuild at the account seq so a purged tombstone does not reset it again', async () => {
		const email = 'sync-next@example.com';
		const { token } = await linkApp(email);
		const account = await makePro(email);
		await put(token, {
			key_id: KEY,
			items: [
				{ collection: 'settings', id: 'kept', base_seq: null, deleted: false, data: 'AQ==' },
				{ collection: 'settings', id: 'gone', base_seq: null, deleted: true }
			]
		});
		await env.DB.prepare(
			`UPDATE sync_items SET updated_at = 0 WHERE account_id = ? AND id = 'gone'`
		)
			.bind(account)
			.run();
		await purgeSync(env);
		const rebuilt = await (await app('/v1/sync?since=1', token)).json<{ next: number }>();
		expect(rebuilt).toMatchObject({ reset: true, more: false, next: 2 });
		expect(await (await app(`/v1/sync?since=${rebuilt.next}`, token)).json()).toMatchObject({
			reset: false,
			items: []
		});
	});

	it('requires Pro before reading or writing', async () => {
		const { token } = await linkApp('sync-no-pro@example.com');
		expect((await app('/v1/sync', token)).status).toBe(403);
		expect(
			(
				await put(token, {
					key_id: KEY,
					items: [
						{ collection: 'settings', id: 'one', base_seq: null, deleted: false, data: 'AQ==' }
					]
				})
			).status
		).toBe(403);
	});
});
