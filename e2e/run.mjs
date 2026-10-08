// `just e2e` の入口。画面がロック・スタンバイ中でないことを確かめ、終わるまで画面を点けたまま、
// リリース版をビルドし直してからテストを回す。
//
// 引数でテストファイルを選べる。`draft-clipboard` のように名前だけなら `tests/<名前>.test.mjs`、
// パスやグロブならそのまま使う。省略すると全部回す。ファイルは1つずつ `node` で直接回す (runner.mjs の runTests)。
//
// `--no-build` を付けるとビルドだけを飛ばす (画面とスタンバイの面倒は、これまでどおり見る)。
// コードを変えずに続けて回すときのためのもので、成果物の新しさで自動では判断しない。
// 自動にすると、古いビルドで回していることに気づかないまま通ってしまう。
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureSessionReady, keepDisplayOn } from './lib/power.mjs';
import {
	AUTOSTART_HELD_ENV,
	clearAutostartEntry,
	recoverStaleAutostartBackupIfAny,
	snapshotAutostartEntry,
	stopPowerShell
} from './lib/os.mjs';
import { APP_PATH } from './lib/paths.mjs';
import { parseArgs, run, runTests, testFiles, waitForChildOnInterrupt } from './lib/runner.mjs';

const execFileAsync = promisify(execFile);
const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, '..');

/** `git` を回して結果を1つの文字列で返す。回せなければ `null` */
async function git(args) {
	try {
		return (await execFileAsync('git', args, { cwd: repoRoot })).stdout.trim();
	} catch {
		return null;
	}
}

/** ローカル時刻の `YYYY-MM-DD HH:mm:ss` */
function formatTime(date) {
	const pad = (value) => String(value).padStart(2, '0');
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

/**
 * ビルドを飛ばすとき、どのビルドで回すのかを先に出す。回せるなら `true`。
 *
 * 実行ファイルが無ければ、黙ってビルドし直さずに、何をすればよいかを書いて `false` を返す。
 * コミットや作業ツリーとの新旧は、実行ファイルの更新時刻との比べで見ているだけなので、
 * 目安であって保証ではない (古いコミットに戻した後などは、新しくなくても中身は合っていない)
 */
async function reportBuild() {
	let builtAt;
	try {
		builtAt = (await stat(APP_PATH)).mtime;
	} catch {
		console.error(`[e2e] --no-build を付けましたが、実行ファイルがありません: ${APP_PATH}`);
		console.error('[e2e] 先に --no-build なしで1度回すか、just bundle でビルドしてください');
		return false;
	}
	console.log('[e2e] ビルドを飛ばします (--no-build)');
	console.log(`[e2e]   実行ファイル: ${APP_PATH}`);
	console.log(`[e2e]   ビルドした時刻: ${formatTime(builtAt)}`);

	const head = await git(['rev-parse', '--short', 'HEAD']);
	const committedAt = await git(['log', '-1', '--format=%cI']);
	console.log(
		`[e2e]   今の HEAD: ${head ?? '読めませんでした'}` +
			(committedAt
				? ` (${formatTime(new Date(committedAt))} のコミット)`
				: ' (コミット時刻は読めませんでした)')
	);
	if (committedAt && new Date(committedAt) > builtAt) {
		console.log('[e2e]   ※ HEAD のコミットは、この実行ファイルより後です。古いビルドで回します');
	}

	const dirty = await git(['status', '--porcelain']);
	if (dirty === null) console.log('[e2e]   作業ツリー: 読めませんでした');
	else if (dirty === '') console.log('[e2e]   作業ツリー: 変更なし');
	else {
		const count = dirty.split('\n').length;
		console.log(`[e2e]   ※ 作業ツリーに ${count} 件の変更があります。ビルドに入っていません`);
	}
	return true;
}

let options;
try {
	options = parseArgs(process.argv.slice(2), ['--no-build']);
} catch (error) {
	console.error(`[e2e] ${error.message}`);
	process.exit(2);
}

// 中断されたら、テスト側が config.toml を書き戻して終わるのを待ってから、画面を点けておく要求を取り消す
// (2回目の Ctrl+C で待たずに終わったときは、パイプが閉じれば取り消される)
waitForChildOnInterrupt();

await ensureSessionReady();
// テストは別のプロセスで回るので、ここで立ち上げた PowerShell はビルドとテストのあいだ使わない
await stopPowerShell();
const display = await keepDisplayOn();
try {
	let code = 0;
	if (options.flags.has('--no-build')) {
		if (!(await reportBuild())) code = 2;
	} else {
		code = await run('just', ['bundle'], repoRoot);
	}
	if (code === 0) {
		// ログイン時の起動の登録は、全体の前後で1度だけ控えて戻し、回している間は外しておく。
		// 外しておけば、autostart をオフにしたテストの設定 (config.mjs の beginTestConfig) で起動したアプリは登録に触れない。
		// テストのプロセスには AUTOSTART_HELD_ENV で伝え、テストファイルごとの控えと書き戻しをさせない
		await recoverStaleAutostartBackupIfAny();
		const autostart = await snapshotAutostartEntry();
		try {
			await clearAutostartEntry();
			await stopPowerShell();
			process.env[AUTOSTART_HELD_ENV] = '1';
			code = await runTests(testFiles('tests', options.tests, e2eDir), e2eDir);
		} finally {
			await autostart.restore();
			await stopPowerShell();
		}
	}
	process.exitCode = code;
} finally {
	await display.release();
}
