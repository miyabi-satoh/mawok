import type { Context } from 'hono';
import { deleteHostCookie, getHostCookie, setHostCookie } from './cookie';
import { now, randomHex, sha256Hex } from './util';

/** セッションの期限。Mawok を結ぶたびにメールでサインインし直させないように。 */
const SESSION_TTL = 30 * 24 * 60 * 60;

const COOKIE = 'session';

export type Account = { id: string; email: string };

export async function currentAccount(c: Context<{ Bindings: Env }>): Promise<Account | null> {
	const id = getHostCookie(c, COOKIE);
	if (!id) return null;
	return c.env.DB.prepare(
		`SELECT accounts.id, accounts.email FROM sessions
		 JOIN accounts ON accounts.id = sessions.account_id
		 WHERE sessions.id_hash = ? AND sessions.expires_at > ?`
	)
		.bind(await sha256Hex(id), now())
		.first<Account>();
}

export async function startSession(c: Context<{ Bindings: Env }>, accountId: string) {
	const id = randomHex(32);
	const t = now();
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(t),
		c.env.DB.prepare(
			'INSERT INTO sessions (id_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
		).bind(await sha256Hex(id), accountId, t + SESSION_TTL, t)
	]);
	setHostCookie(c, COOKIE, id, SESSION_TTL);
}

export async function endSession(c: Context<{ Bindings: Env }>) {
	const id = getHostCookie(c, COOKIE);
	if (id) {
		await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?')
			.bind(await sha256Hex(id))
			.run();
	}
	deleteHostCookie(c, COOKIE);
}
