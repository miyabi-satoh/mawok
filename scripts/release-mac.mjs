// Mac 版の配る版を作る (→ docs/platform.md「Mac 版の配る版」)。
// `just release-mac`: ユニバーサル版を Developer ID で署名・公証し、DMG を src-tauri/target/release-mac/<版>/ に置く。
// `just release-mas`: ユニバーサル版を Mac App Store 向けに署名して pkg にし、App Store Connect に上げる。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Developer ID の証明書の Team ID (developer.apple.com/account の Membership details)
const TEAM_ID = 'V6W6CVP93A';
const TARGET = 'universal-apple-darwin';
const BUNDLE_DIR = `src-tauri/target/${TARGET}/release/bundle`;
const OUT_ROOT = 'src-tauri/target/release-mac';

function run(command, args, options = {}) {
	execFileSync(command, args, { stdio: 'inherit', ...options });
}

function read(command, args) {
	return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function appVersion() {
	return JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
}

// 端末に出さずにパスワードを読む。貼り付けは1回の data でまとめて届く
function askSecret(label) {
	const { stdin, stdout } = process;
	if (!stdin.isTTY) {
		fail(`${label}を読めません。端末から実行してください`);
	}
	stdout.write(`${label}: `);
	stdin.setRawMode(true);
	stdin.setEncoding('utf8');
	stdin.resume();
	return new Promise((resolve) => {
		let value = '';
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					stdin.setRawMode(false);
					stdin.pause();
					stdin.off('data', onData);
					stdout.write('\n');
					resolve(value);
					return;
				}
				if (char === '\u0003') {
					stdout.write('\n');
					process.exit(130);
				}
				value = char === '\u007f' ? value.slice(0, -1) : value + char;
			}
		};
		stdin.on('data', onData);
	});
}

// キーチェーンにある証明書の名前。インストーラーの証明書はコード署名の用途に出ないので、policy で分ける
function identity(prefixes, policy) {
	const identities = read('security', ['find-identity', '-v', ...(policy ? ['-p', policy] : [])]);
	for (const prefix of prefixes) {
		const match = new RegExp(`"(${prefix}: [^"]+)"`).exec(identities);
		if (match) {
			return match[1];
		}
	}
	fail(
		`キーチェーンに ${prefixes[0]} の証明書がありません。要るものと作り方は docs/platform.md「Mac 版の配る版」にあります`
	);
}

function requireAppleId(purpose) {
	const appleId = process.env.APPLE_ID;
	if (!appleId) {
		fail(`APPLE_ID に、${purpose}に使う Apple Account のメールアドレスを入れてください`);
	}
	return appleId;
}

function addRustTargets() {
	const installed = read('rustup', ['target', 'list', '--installed']).split('\n');
	const missing = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].filter(
		(target) => !installed.includes(target)
	);
	if (missing.length > 0) {
		run('rustup', ['target', 'add', ...missing]);
	}
}

function checkUniversal(app) {
	const archs = read('lipo', ['-archs', join(app, 'Contents/MacOS/mawok')]).split(' ');
	if (!archs.includes('x86_64') || !archs.includes('arm64')) {
		fail(`ユニバーサル版になっていません (${archs.join(' ')})`);
	}
}

function freshOutDir(version) {
	const outDir = join(OUT_ROOT, version);
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	return outDir;
}

async function buildDeveloperId() {
	const version = appVersion();
	const signing = identity(['Developer ID Application'], 'codesigning');
	const appleId = requireAppleId('公証');
	addRustTargets();

	const env = {
		...process.env,
		// DMG のアイコンの並びを整える Finder の操作を飛ばす (just bundle と同じ)
		CI: 'true',
		APPLE_SIGNING_IDENTITY: signing,
		APPLE_ID: appleId,
		APPLE_TEAM_ID: TEAM_ID,
		APPLE_PASSWORD: await askSecret('公証のアプリ用パスワード')
	};

	console.log(`Mawok ${version} を ${signing} で作ります`);
	run('pnpm', ['tauri', 'build', '--target', TARGET], { env });

	const app = join(BUNDLE_DIR, 'macos', 'Mawok.app');
	checkUniversal(app);
	// 公証の結果が .app に綴じてあり、Gatekeeper が通すことを確かめる。Tauri は APPLE_* が欠けると公証を飛ばすだけで止まらない
	run('xcrun', ['stapler', 'validate', app]);
	run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);

	const outDir = freshOutDir(version);
	const dmg = `Mawok_${version}_universal.dmg`;
	copyFileSync(join(BUNDLE_DIR, 'dmg', dmg), join(outDir, dmg));
	console.log(`\n${join(outDir, dmg)} に置きました。`);
}

async function buildAppStore() {
	const version = appVersion();
	const signing = identity(['Apple Distribution'], 'codesigning');
	// Mac Installer Distribution は、キーチェーンでは古い名前で出ることがある
	const installer = identity(['Mac Installer Distribution', '3rd Party Mac Developer Installer']);
	const appleId = requireAppleId('アップロード');
	const profile = process.env.APPLE_PROVISIONING_PROFILE;
	if (!profile || !existsSync(profile)) {
		fail(
			'APPLE_PROVISIONING_PROFILE に、Mac App Store Connect のプロビジョニングプロファイルのパスを入れてください'
		);
	}
	addRustTargets();
	const outDir = freshOutDir(version);

	// App Store の版だけの設定。プロファイルは公開しないリポジトリの外に置くので、パスはここで埋める
	const config = join(outDir, 'tauri.appstore.conf.json');
	writeFileSync(
		config,
		JSON.stringify({
			bundle: {
				macOS: {
					signingIdentity: signing,
					entitlements: resolve('src-tauri/Entitlements.appstore.plist'),
					files: { 'embedded.provisionprofile': resolve(profile) }
				}
			}
		})
	);

	// APPLE_ID などを渡すと Tauri が公証を始めるので、ビルドには渡さない
	const env = { ...process.env, CI: 'true' };
	for (const key of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_SIGNING_IDENTITY']) {
		delete env[key];
	}
	console.log(`Mawok ${version} を ${signing} で作ります`);
	run('pnpm', ['tauri', 'build', '--target', TARGET, '--bundles', 'app', '--config', config], {
		env
	});

	const app = join(BUNDLE_DIR, 'macos', 'Mawok.app');
	checkUniversal(app);
	const entitlements = read('codesign', ['-d', '--entitlements', '-', '--xml', app]);
	if (!entitlements.includes('com.apple.application-identifier')) {
		fail('App Store 向けの権限で署名されていません');
	}

	const pkg = join(outDir, `Mawok_${version}_universal.pkg`);
	run('xcrun', ['productbuild', '--sign', installer, '--component', app, '/Applications', pkg]);
	run('pkgutil', ['--check-signature', pkg]);

	const password = await askSecret('アップロードのアプリ用パスワード');
	run(
		'xcrun',
		[
			'altool',
			'--upload-app',
			'-f',
			pkg,
			'-t',
			'macos',
			'-u',
			appleId,
			'-p',
			'@env:APPLE_PASSWORD'
		],
		{ env: { ...process.env, APPLE_PASSWORD: password } }
	);
	console.log(`\n${pkg} を App Store Connect に上げました。処理が済むと TestFlight に出ます。`);
}

if (process.argv.includes('--app-store')) {
	await buildAppStore();
} else {
	await buildDeveloperId();
}
