// `just linux-check-vm <VM> [テスト...]` の入口。Linux の確認 (linux-run.mjs) を VM の中で回す (e2e/vm/vm.sh)。
//
// 手元の画面・キーボード・フォーカスを使わず、Hyprland (arch-hyprland) と GNOME (ubuntu-2404・ubuntu-2604) を回せる。
// 回す前に、今のビルド (src-tauri/target/release/mawok) を VM の /usr/bin/mawok に写す。ビルドが無いか、ビルドの後に
// アプリのソースが変わっていれば (checkout や pull で入ったものも含む)、古い版で通らないよう、VM を起動せずに止める。
// VM が止まっていれば画面なしで起動し、回し終えたら止める (`--keep` で動かしたまま)。落ちた時点の記録は
// screenshots/linux-vm-failures/<VM>/ に持ち帰る
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs, waitForChildOnInterrupt } from './lib/runner.mjs';

const execFileAsync = promisify(execFile);
const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, '..');
const VM_SH = path.join(e2eDir, 'vm', 'vm.sh');
const BUILT = path.join(repoRoot, 'src-tauri', 'target', 'release', 'mawok');
const VMS = ['arch-hyprland', 'ubuntu-2404', 'ubuntu-2604'];

let options;
try {
	options = parseArgs(process.argv.slice(2), ['--keep']);
} catch (error) {
	console.error(`[linux-check-vm] ${error.message}`);
	process.exit(2);
}
const [vm, ...tests] = options.tests;
if (!VMS.includes(vm)) {
	console.error(`[linux-check-vm] VM を選んでください: ${VMS.join('・')}`);
	process.exit(2);
}

/** 標準入出力をそのまま流して動かし、終了コードを返す。`input` は標準入力に流すストリーム */
function run(command, args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit']
		});
		child.once('error', reject);
		child.once('exit', (code) => resolve(code ?? 1));
		if (input) input.pipe(child.stdin);
	});
}

const vmSh = (...args) => run(VM_SH, [vm, ...args]);
const ssh = (command, input) => run(VM_SH, [vm, 'ssh', command], input);

/** tar の出力を VM の中で展開する */
function tar(args, cwd) {
	const child = spawn('tar', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
	return child.stdout;
}

/**
 * ビルドに入らないファイル。変えても作り直さずに回せる。Markdown のうち docs/manual だけは、使い方の窓に入る
 */
function notBuilt(file) {
	if (/^(e2e|\.github|\.claude)\//.test(file)) return true;
	if (file === 'justfile' || file === 'lefthook.yml' || file.endsWith('.test.ts')) return true;
	return file.endsWith('.md') && !file.startsWith('docs/manual/');
}

/**
 * ビルドの後に変わった、ビルドに入るファイルのうち最も新しいものを返す (無ければ null)。コミットの時刻でなく
 * ファイルの更新時刻で見るのは、checkout や pull で入った変更は、コミットの時刻がビルドより前でも、ファイルの更新時刻が
 * 入れた時になるため
 */
async function changedSinceBuild(builtAt) {
	const { stdout } = await execFileAsync(
		'git',
		['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
		{ cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }
	);
	let newest = null;
	for (const file of stdout.split('\0')) {
		if (!file || notBuilt(file)) continue;
		const stat = await fs.stat(path.join(repoRoot, file)).catch(() => null);
		if (stat && stat.mtimeMs > builtAt && (!newest || stat.mtimeMs > newest.mtimeMs)) {
			newest = { file, mtimeMs: stat.mtimeMs };
		}
	}
	return newest;
}

const built = await fs.stat(BUILT).catch(() => null);
if (!built) {
	console.error(
		`[linux-check-vm] ${BUILT} がありません。pnpm tauri build --no-bundle でビルドしてから回してください`
	);
	process.exit(1);
}
const changed = await changedSinceBuild(built.mtimeMs);
if (changed) {
	console.error(
		`[linux-check-vm] ビルド (${built.mtime.toLocaleString()}) の後に ${changed.file} (${new Date(changed.mtimeMs).toLocaleString()}) が変わっています。` +
			'古い版で回さないよう止めます。pnpm tauri build --no-bundle でビルドし直してから回してください'
	);
	process.exit(1);
}

const wasRunning = await execFileAsync(VM_SH, [vm, 'ssh', 'true']).then(
	() => true,
	() => false
);
// Ctrl+C は子 (vm.sh・ssh) にも届いて終わらせるので、こちらは終わらずに後始末 (記録の持ち帰りと VM の停止) まで進む
waitForChildOnInterrupt();
// 起動に失敗しても (中断も含む) qemu は裏で動き出していることがあるので止める
if (!wasRunning && (await vmSh('start', '--headless')) !== 0) {
	await vmSh('stop');
	process.exit(1);
}

let code = 1;
try {
	console.log(`[linux-check-vm] 今のビルドを写します: ${BUILT} (${built.mtime.toLocaleString()})`);
	if (
		(await ssh(
			'cat > /tmp/mawok && sudo install -m755 /tmp/mawok /usr/bin/mawok',
			createReadStream(BUILT)
		)) !== 0
	) {
		throw new Error('ビルドを VM に写せませんでした');
	}
	// 確かめの仕組み (依存も含めて) と、app-conf.mjs が読む tauri.conf.json を写す
	const files = tar(
		[
			'-c',
			'--exclude=e2e/screenshots',
			'--exclude=e2e/.*backup*',
			'e2e',
			'src-tauri/tauri.conf.json'
		],
		repoRoot
	);
	if ((await ssh('rm -rf ~/mawok && mkdir -p ~/mawok && tar -x -C ~/mawok', files)) !== 0) {
		throw new Error('確かめの仕組みを VM に写せませんでした');
	}
	code = await ssh(`cd ~/mawok/e2e && node linux-run.mjs ${tests.join(' ')}`);
	// 落ちた時点の記録を持ち帰る
	const local = path.join(e2eDir, 'screenshots', 'linux-vm-failures', vm);
	await fs.rm(local, { recursive: true, force: true });
	await fs.mkdir(local, { recursive: true });
	const back = spawn(
		VM_SH,
		[
			vm,
			'ssh',
			'cd ~/mawok/e2e/screenshots/linux-failures 2>/dev/null && tar -c . || tar -c -T /dev/null'
		],
		{
			stdio: ['ignore', 'pipe', 'inherit']
		}
	);
	await run('tar', ['-x', '-C', local], back.stdout);
	const saved = await fs.readdir(local);
	if (saved.length > 0) console.log(`[linux-check-vm] 落ちた時点の記録: ${local}`);
} catch (error) {
	console.error(`[linux-check-vm] ${error.message}`);
} finally {
	if (!wasRunning && !options.flags.has('--keep')) await vmSh('stop');
}
process.exitCode = code;
