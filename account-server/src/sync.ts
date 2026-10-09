/** Pro の設定と履歴の同期。窓口は暗号文をそのまま置き、解釈しない。 */
import { proOf, proUntilSql } from './credits';
import { now } from './util';

export const SYNC_ITEM_LIMIT = 100;
export const SYNC_ITEM_BYTES = 256 * 1024;
export const SYNC_TOTAL_BYTES = 16 * 1024 * 1024;
export const SYNC_TOMBSTONE_RETENTION = 90 * 24 * 60 * 60;

type Collection = 'settings' | 'history';
type SyncItem = {
	collection: Collection;
	id: string;
	base_seq: number | null;
	deleted: boolean;
	data?: string;
};
type StoredItem = {
	collection: Collection;
	id: string;
	seq: number;
	deleted: number;
	data: ArrayBuffer | null;
	size: number;
};
type SyncAccount = { key_id: string | null; seq: number; purged_seq: number; bytes: number };

type PutResult =
	| { ok: true; seq: number; items: Array<{ collection: Collection; id: string; seq: number }> }
	| { ok: false; error: 'invalid_request' | 'key_mismatch' }
	| { ok: false; error: 'too_large'; limit: 'item' | 'total' }
	| {
			ok: false;
			error: 'conflict';
			conflicts: Array<{
				collection: Collection;
				id: string;
				seq: number;
				deleted: boolean;
				data: string | null;
			}>;
	  };

const itemId = /^[A-Za-z0-9_-]{1,64}$/;
const keyId = /^[0-9a-f]{16,64}$/;

function integer(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeBase64(value: string): ArrayBuffer | undefined {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		return undefined;
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes.buffer;
	} catch {
		return undefined;
	}
}

function encodeBase64(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function validKeyId(value: unknown): value is string {
	return typeof value === 'string' && keyId.test(value);
}

function validItem(value: unknown): value is SyncItem {
	if (!value || typeof value !== 'object') return false;
	const item = value as Record<string, unknown>;
	return (
		(item.collection === 'settings' || item.collection === 'history') &&
		typeof item.id === 'string' &&
		itemId.test(item.id) &&
		(item.base_seq === null || (integer(item.base_seq) && item.base_seq > 0)) &&
		typeof item.deleted === 'boolean' &&
		(item.data === undefined || typeof item.data === 'string')
	);
}

/** 消した記録より古い位置から読む機器は、窓口の写しで組み直す。 */
export function shouldReset(since: number, purgedSeq: number): boolean {
	return since > 0 && since < purgedSeq;
}

export function syncQuery(query: {
	since?: string;
	limit?: string;
}): { since: number; limit: number } | undefined {
	const since = query.since === undefined ? 0 : Number(query.since);
	const limit = query.limit === undefined ? 200 : Number(query.limit);
	if (!integer(since) || !integer(limit) || limit < 1 || limit > 500) return undefined;
	return { since, limit };
}

/** 同期を読める Pro か。試用も `proOf` の active に含む。 */
export async function hasSyncPro(env: Env, accountId: string): Promise<boolean> {
	return (await proOf(env, accountId)).active;
}

export async function getSync(
	env: Env,
	accountId: string,
	query: { since: number; limit: number }
) {
	const account = await env.DB.prepare(
		'SELECT key_id, seq, purged_seq, bytes FROM sync_accounts WHERE account_id = ?'
	)
		.bind(accountId)
		.first<SyncAccount>();
	const reset = shouldReset(query.since, account?.purged_seq ?? 0);
	const since = reset ? 0 : query.since;
	const { results } = await env.DB.prepare(
		`SELECT collection, id, seq, deleted, data FROM sync_items
		 WHERE account_id = ? AND seq > ? AND (deleted = 0 OR ? > 0)
		 ORDER BY seq LIMIT ?`
	)
		.bind(accountId, since, since, query.limit + 1)
		.all<StoredItem>();
	const more = results.length > query.limit;
	const items = results.slice(0, query.limit).map((item) => ({
		collection: item.collection,
		id: item.id,
		seq: item.seq,
		deleted: item.deleted === 1,
		data: item.data === null ? null : encodeBase64(item.data)
	}));
	return { key_id: account?.key_id ?? null, seq: account?.seq ?? 0, reset, items, more };
}

function conflictFor(item: SyncItem, current: StoredItem | undefined) {
	return {
		collection: item.collection,
		id: item.id,
		// seq は1からなので 0 は「この項目はまだ無い」を表す。
		seq: current?.seq ?? 0,
		deleted: current?.deleted === 1 || current === undefined,
		data: current?.data === null || current === undefined ? null : encodeBase64(current.data)
	};
}

async function currentSync(env: Env, accountId: string, items: SyncItem[]) {
	const requested = JSON.stringify(items.map(({ collection, id }) => ({ collection, id })));
	const [account, rows] = await env.DB.batch<SyncAccount | StoredItem>([
		env.DB.prepare(
			'SELECT key_id, seq, purged_seq, bytes FROM sync_accounts WHERE account_id = ?'
		).bind(accountId),
		env.DB.prepare(
			`SELECT collection, id, seq, deleted, data, length(data) AS size FROM sync_items
				 WHERE account_id = ? AND EXISTS (
				   SELECT 1 FROM json_each(?) wanted
				   WHERE json_extract(wanted.value, '$.collection') = sync_items.collection
				     AND json_extract(wanted.value, '$.id') = sync_items.id
				 )`
		).bind(accountId, requested)
	]);
	return {
		account: (account.results[0] as SyncAccount | undefined) ?? {
			key_id: null,
			seq: 0,
			purged_seq: 0,
			bytes: 0
		},
		items: new Map(
			(rows.results as StoredItem[]).map((item) => [`${item.collection}\u0000${item.id}`, item])
		)
	};
}

/** 一まとまりの更新を全て書くか、競合として何も書かないかにする。 */
export async function putSync(env: Env, accountId: string, body: unknown): Promise<PutResult> {
	if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_request' };
	const request = body as { key_id?: unknown; items?: unknown };
	if (!validKeyId(request.key_id) || !Array.isArray(request.items))
		return { ok: false, error: 'invalid_request' };
	if (
		request.items.length < 1 ||
		request.items.length > SYNC_ITEM_LIMIT ||
		!request.items.every(validItem)
	)
		return { ok: false, error: 'invalid_request' };
	const items = request.items;
	const ids = new Set<string>();
	const data = new Map<string, ArrayBuffer | null>();
	for (const item of items) {
		const id = `${item.collection}\u0000${item.id}`;
		if (ids.has(id)) return { ok: false, error: 'invalid_request' };
		ids.add(id);
		if (item.deleted) {
			data.set(id, null);
			continue;
		}
		if (typeof item.data !== 'string') return { ok: false, error: 'invalid_request' };
		const decoded = decodeBase64(item.data);
		if (!decoded) return { ok: false, error: 'invalid_request' };
		if (decoded.byteLength > SYNC_ITEM_BYTES)
			return { ok: false, error: 'too_large', limit: 'item' };
		data.set(id, decoded);
	}
	const current = await currentSync(env, accountId, items);
	if (current.account.key_id !== null && current.account.key_id !== request.key_id)
		return { ok: false, error: 'key_mismatch' };
	const conflicts = items
		.filter((item) => {
			const found = current.items.get(`${item.collection}\u0000${item.id}`);
			return item.base_seq === null ? found !== undefined : found?.seq !== item.base_seq;
		})
		.map((item) => conflictFor(item, current.items.get(`${item.collection}\u0000${item.id}`)));
	if (conflicts.length > 0) return { ok: false, error: 'conflict', conflicts };

	let delta = 0;
	for (const item of items) {
		const id = `${item.collection}\u0000${item.id}`;
		delta += (data.get(id)?.byteLength ?? 0) - (current.items.get(id)?.size ?? 0);
	}
	if (current.account.bytes + delta > SYNC_TOTAL_BYTES)
		return { ok: false, error: 'too_large', limit: 'total' };
	const t = now();
	const { seq, bytes, purged_seq } = current.account;
	const accountMatches = `EXISTS (SELECT 1 FROM sync_accounts
		WHERE account_id = ? AND seq = ? AND bytes = ? AND purged_seq = ?
		  AND (key_id IS NULL OR key_id = ?))`;
	const accountBindings = [accountId, seq, bytes, purged_seq, request.key_id];
	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes)
			 VALUES (?, NULL, 0, 0, 0) ON CONFLICT (account_id) DO NOTHING`
		).bind(accountId)
	];
	for (const [index, item] of items.entries()) {
		const id = `${item.collection}\u0000${item.id}`;
		const itemSeq = seq + index + 1;
		const value = data.get(id)!;
		if (item.base_seq === null) {
			statements.push(
				env.DB.prepare(
					`INSERT INTO sync_items (account_id, collection, id, seq, deleted, data, updated_at)
						 SELECT ?, ?, ?, ?, ?, ?, ?
						 WHERE ${accountMatches}
						   AND NOT EXISTS (SELECT 1 FROM sync_items WHERE account_id = ? AND collection = ? AND id = ?)`
				).bind(
					accountId,
					item.collection,
					item.id,
					itemSeq,
					item.deleted ? 1 : 0,
					value,
					t,
					...accountBindings,
					accountId,
					item.collection,
					item.id
				)
			);
		} else {
			statements.push(
				env.DB.prepare(
					`UPDATE sync_items SET seq = ?, deleted = ?, data = ?, updated_at = ?
						 WHERE account_id = ? AND collection = ? AND id = ? AND seq = ? AND ${accountMatches}`
				).bind(
					itemSeq,
					item.deleted ? 1 : 0,
					value,
					t,
					accountId,
					item.collection,
					item.id,
					item.base_seq,
					...accountBindings
				)
			);
		}
	}
	const itemWritten = items
		.map(
			(item, index) =>
				`EXISTS (SELECT 1 FROM sync_items WHERE account_id = ? AND collection = ? AND id = ? AND seq = ?)`
		)
		.join(' AND ');
	const itemBindings = items.flatMap((item, index) => [
		accountId,
		item.collection,
		item.id,
		seq + index + 1
	]);
	statements.push(
		env.DB.prepare(
			`UPDATE sync_accounts SET key_id = coalesce(key_id, ?), seq = seq + ?, bytes = bytes + ?
				 WHERE account_id = ? AND seq = ? AND bytes = ? AND purged_seq = ?
				   AND (key_id IS NULL OR key_id = ?) AND ${itemWritten}`
		).bind(request.key_id, items.length, delta, ...accountBindings, ...itemBindings)
	);
	const results = await env.DB.batch(statements);
	if (results.at(-1)?.meta.changes === 1)
		return {
			ok: true,
			seq: seq + items.length,
			items: items.map((item, index) => ({
				collection: item.collection,
				id: item.id,
				seq: seq + index + 1
			}))
		};
	// 条件付き書き込みが外れた場合は、並行した更新を取り直して合わせてもらう。
	const latest = await currentSync(env, accountId, items);
	if (latest.account.key_id !== null && latest.account.key_id !== request.key_id)
		return { ok: false, error: 'key_mismatch' };
	return {
		ok: false,
		error: 'conflict',
		conflicts: items.map((item) =>
			conflictFor(item, latest.items.get(`${item.collection}\u0000${item.id}`))
		)
	};
}

/** 鍵を作り直した機器のため、前の暗号文と消した記録を一度に外す。 */
export async function resetSync(env: Env, accountId: string, body: unknown) {
	const key = body && typeof body === 'object' ? (body as { key_id?: unknown }).key_id : undefined;
	if (!validKeyId(key)) return undefined;
	const [, account] = await env.DB.batch([
		env.DB.prepare('DELETE FROM sync_items WHERE account_id = ?').bind(accountId),
		env.DB.prepare(
			`INSERT INTO sync_accounts (account_id, key_id, seq, purged_seq, bytes)
				 VALUES (?, ?, 0, 0, 0)
				 ON CONFLICT (account_id) DO UPDATE SET key_id = excluded.key_id, bytes = 0,
				 seq = sync_accounts.seq + 1, purged_seq = sync_accounts.seq + 1
				 RETURNING seq`
		).bind(accountId, key)
	]);
	return { seq: (account.results[0] as { seq: number } | undefined)?.seq ?? 0 };
}

/** Cron から呼ぶ、消した記録と期限が切れて90日たった Pro の写しの掃除。 */
export async function purgeSync(env: Env, t = now()) {
	const tombstoneBefore = t - SYNC_TOMBSTONE_RETENTION;
	const { results: tombstones } = await env.DB.prepare(
		`SELECT account_id, max(seq) AS seq FROM sync_items
		 WHERE deleted = 1 AND updated_at <= ? GROUP BY account_id`
	)
		.bind(tombstoneBefore)
		.all<{ account_id: string; seq: number }>();
	const statements: D1PreparedStatement[] = [
		env.DB.prepare('DELETE FROM sync_items WHERE deleted = 1 AND updated_at <= ?').bind(
			tombstoneBefore
		)
	];
	for (const tombstone of tombstones) {
		statements.push(
			env.DB.prepare(
				'UPDATE sync_accounts SET purged_seq = max(purged_seq, ?) WHERE account_id = ?'
			).bind(tombstone.seq, tombstone.account_id)
		);
	}
	const proBefore = t - SYNC_TOMBSTONE_RETENTION;
	statements.push(
		env.DB.prepare(
			`DELETE FROM sync_accounts
				 WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = sync_accounts.account_id)
				    OR coalesce((
				      SELECT max(CASE WHEN revoked_at IS NOT NULL THEN min(revoked_at, ${proUntilSql})
				                      ELSE ${proUntilSql} END)
				      FROM subscriptions WHERE account_id = sync_accounts.account_id
				    ), 0) <= ?`
		).bind(proBefore)
	);
	await env.DB.batch(statements);
}
