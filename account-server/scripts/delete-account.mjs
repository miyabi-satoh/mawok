// 窓口のアカウントを消す (→ src/account-deletion.ts)。削除の請求を問い合わせで受けたときに、運営者が流す。
// 購入の台帳は、結び付きだけを外して残る。
//
// 使い方: node scripts/delete-account.mjs <メールアドレス> [--env staging]
import { spawnSync } from 'node:child_process';
import { DELETE_ACCOUNT_STATEMENTS } from '../src/account-deletion.ts';

const [rawEmail, ...rest] = process.argv.slice(2);
const email = (rawEmail ?? '').trim().toLowerCase();
const env = rest[0] === '--env' && rest[1] ? ['--env', rest[1]] : [];
// SQL に書き込むので、アドレスの形でないものは通さない (引用符を含む値で文を壊さないように)。
if (!/^[^\s'"@;]+@[^\s'"@;]+$/.test(email) || (rest.length > 0 && env.length === 0)) {
	console.error('usage: node scripts/delete-account.mjs <email> [--env staging]');
	process.exit(1);
}

const sql = DELETE_ACCOUNT_STATEMENTS.map((s) => `${s.replaceAll('?1', `'${email}'`)};`).join('\n');
const result = spawnSync(
	'pnpm',
	['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', ...env, '--command', sql],
	{ stdio: 'inherit' }
);
process.exit(result.status ?? 1);
