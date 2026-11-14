// Mac 版の配る版を作る (→ docs/platform.md「Mac 版の配る版」)。
// `just release-mac`: ユニバーサル版を Developer ID で署名・公証し、DMG を src-tauri/target/release-mac/<版>/ に置く。
// `just release-mas`: ユニバーサル版を Mac App Store 向けに署名して pkg にし、App Store Connect に上げる。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// 証明書とプロファイルの Team ID (developer.apple.com/account の Membership details)
const TEAM_ID = 'V6W6CVP93A';
const TARGET = 'universal-apple-darwin';
const BUNDLE_DIR = `src-tauri/target/${TARGET}/release/bundle`;
// Store の外の版と Store の版を、同じ版でも互いに消さないよう分けて置く
const OUT_ROOT = 'src-tauri/target/release-mac';
const APP_STORE_OUT_ROOT = 'src-tauri/target/release-mas';

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

function tauriConfig() {
	return JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
}

function appVersion() {
	return tauriConfig().version;
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
		const match = new RegExp(`"(${prefix}: [^"]+\\(${TEAM_ID}\\))"`).exec(identities);
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

function freshOutDir(root, version) {
	const outDir = join(root, version);
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

	const outDir = freshOutDir(OUT_ROOT, version);
	const dmg = `Mawok_${version}_universal.dmg`;
	copyFileSync(join(BUNDLE_DIR, 'dmg', dmg), join(outDir, dmg));
	console.log(`\n${join(outDir, dmg)} に置きました。`);
}

// 別の App ID やチームのプロファイルだと、上げた後に断られて版番号を1つ無駄にするので、ビルドの前に確かめる
function checkProfile(profile, bundleId) {
	const plist = execFileSync('security', ['cms', '-D', '-i', profile]);
	const appId = execFileSync(
		'/usr/libexec/PlistBuddy',
		['-c', 'Print :Entitlements:com.apple.application-identifier', '/dev/stdin'],
		{ input: plist, encoding: 'utf8' }
	).trim();
	if (appId !== `${TEAM_ID}.${bundleId}`) {
		fail(
			`プロビジョニングプロファイルの App ID が ${appId} です (${TEAM_ID}.${bundleId} のものが要ります)`
		);
	}
}

// upload: false は上げずに pkg までを作る (同じ版は2度上げられないので、作り方を変えたときに上げ直さずに試す)
async function buildAppStore({ upload }) {
	const version = appVersion();
	const bundleId = tauriConfig().identifier;
	const signing = identity(['Apple Distribution'], 'codesigning');
	// Mac Installer Distribution は、キーチェーンでは古い名前で出ることがある
	const installer = identity(['Mac Installer Distribution', '3rd Party Mac Developer Installer']);
	const profile = process.env.APPLE_PROVISIONING_PROFILE;
	if (!profile || !existsSync(profile)) {
		fail(
			'APPLE_PROVISIONING_PROFILE に、Mac App Store Connect のプロビジョニングプロファイルのパスを入れてください'
		);
	}
	// ビルドの後でなく前に聞く。端末が無いと分かるのが、数分のビルドの後にならないため
	checkProfile(profile, bundleId);
	const appleId = upload ? requireAppleId('アップロード') : '';
	const password = upload ? await askSecret('アップロードのアプリ用パスワード') : '';
	addRustTargets();
	const outDir = freshOutDir(APP_STORE_OUT_ROOT, version);

	// プロファイルと結ぶ権限は、プロファイルを埋め込まない版 (just bundle・Developer ID) に付けると起動できないので、
	// Store の版のときだけ、ほかの版と同じ権限に足して使う
	const entitlements = resolve(outDir, 'Entitlements.plist');
	copyFileSync('src-tauri/Entitlements.plist', entitlements);
	// plutil は鍵の名前の「.」を階層の区切りと読むので、「:」で区切る PlistBuddy で足す
	run('/usr/libexec/PlistBuddy', [
		'-c',
		`Add :com.apple.application-identifier string ${TEAM_ID}.${bundleId}`,
		'-c',
		`Add :com.apple.developer.team-identifier string ${TEAM_ID}`,
		entitlements
	]);

	// Store の版だけの設定。分類は Store が求める Info.plist の項目になる (ほかの版では Linux のメニューの分類なども変わる)。
	// プロファイルは公開しないリポジトリの外に置くので、パスはここで埋める
	const config = join(outDir, 'tauri.appstore.conf.json');
	writeFileSync(
		config,
		JSON.stringify({
			bundle: {
				category: 'Productivity',
				macOS: {
					signingIdentity: signing,
					entitlements,
					files: { 'embedded.provisionprofile': resolve(profile) }
				}
			}
		})
	);

	// APPLE_ID・APPLE_API_KEY などで Tauri が公証を始め、APPLE_CERTIFICATE などで別の証明書を使うので、APPLE_* はビルドに渡さない
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('APPLE_'))
	);
	console.log(`Mawok ${version} を ${signing} で作ります`);
	run('pnpm', ['tauri', 'build', '--target', TARGET, '--bundles', 'app', '--config', config], {
		env
	});

	const app = join(BUNDLE_DIR, 'macos', 'Mawok.app');
	checkUniversal(app);
	const signed = read('codesign', ['-d', '--entitlements', '-', '--xml', app]);
	if (
		!signed.includes('com.apple.application-identifier') ||
		!signed.includes('com.apple.developer.team-identifier')
	) {
		fail('App Store 向けの権限で署名されていません');
	}
	if (!existsSync(join(app, 'Contents/embedded.provisionprofile'))) {
		fail('プロビジョニングプロファイルが埋め込まれていません');
	}
	run('codesign', ['--verify', '--strict', '--deep', app]);

	const pkg = join(outDir, `Mawok_${version}_universal.pkg`);
	run('xcrun', ['productbuild', '--sign', installer, '--component', app, '/Applications', pkg]);
	run('pkgutil', ['--check-signature', pkg]);
	if (!upload) {
		console.log(`\n${pkg} に置きました (上げていません)。`);
		return;
	}

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

// 打ち間違えた引数を黙って捨てると、試すつもりで上げてしまうので止める
const { values: options } = parseArgs({
	options: { 'app-store': { type: 'boolean' }, 'no-upload': { type: 'boolean' } },
	strict: true
});
if (options['no-upload'] && !options['app-store']) {
	fail('--no-upload は --app-store と一緒に使います');
}
if (options['app-store']) {
	await buildAppStore({ upload: !options['no-upload'] });
} else {
	await buildDeveloperId();
}
