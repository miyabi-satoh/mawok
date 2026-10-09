import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SYNC_TOTAL_BYTES } from '../../src/sync';
import { accountId, app, linkApp } from '../helpers';

const KEY = 'a'.repeat(16);

async function makePro(email: string) {
	const account = await accountId(email);
	await env.DB.prepare(
		`INSERT INTO subscriptions (id, account_id, plan, paid_through, status, created_at)
		 VALUES (?, ?, 'monthly', 4102444800, 'trialing', 0)`
	)
		.bind(`sync_${email}`, account)
		.run();
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
			more: true
		});
	});

	it('returns the current encrypted item for an old base and rejects a different key', async () => {
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
		expect(
			await (
				await put(token, {
					key_id: KEY,
					items: [{ collection: 'settings', id: 'one', base_seq: 1, deleted: false, data: 'Aw==' }]
				})
			).json()
		).toEqual({
			error: 'conflict',
			conflicts: [{ collection: 'settings', id: 'one', seq: 2, deleted: false, data: 'Ag==' }]
		});
		expect(
			await (
				await put(token, {
					key_id: 'b'.repeat(16),
					items: [
						{ collection: 'settings', id: 'two', base_seq: null, deleted: false, data: 'AQ==' }
					]
				})
			).json()
		).toEqual({ error: 'key_mismatch' });
	});

	it('enforces the item and total limits', async () => {
		const email = 'sync-limits@example.com';
		const { token } = await linkApp(email);
		const account = await makePro(email);
		const oversized = btoa('x'.repeat(256 * 1024 + 1));
		expect(
			await (
				await put(token, {
					key_id: KEY,
					items: [
						{ collection: 'settings', id: 'item', base_seq: null, deleted: false, data: oversized }
					]
				})
			).json()
		).toEqual({ error: 'too_large', limit: 'item' });
		await env.DB.prepare(
			'INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes) VALUES (?, ?, 0, 0, ?)'
		)
			.bind(account, KEY, SYNC_TOTAL_BYTES)
			.run();
		expect(
			await (
				await put(token, {
					key_id: KEY,
					items: [
						{ collection: 'settings', id: 'total', base_seq: null, deleted: false, data: 'AQ==' }
					]
				})
			).json()
		).toEqual({ error: 'too_large', limit: 'total' });
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
