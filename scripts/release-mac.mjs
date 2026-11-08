// Mac 版の配る版を作る (`just release-mac` から呼ぶ。→ docs/platform.md「Mac 版の配る版」)。
// ユニバーサル版を Developer ID で署名・公証し、DMG を src-tauri/target/release-mac/<版>/ に置く。

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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

// キーチェーンにある Developer ID Application の証明書の名前
function signingIdentity() {
	const identities = read('security', ['find-identity', '-v', '-p', 'codesigning']);
	const match = /"(Developer ID Application: [^"]+)"/.exec(identities);
	if (!match) {
		fail(
			'キーチェーンに Developer ID Application の証明書がありません。要るものと作り方は docs/platform.md「Mac 版の配る版」にあります'
		);
	}
	return match[1];
}

async function build() {
	const version = appVersion();
	const identity = signingIdentity();
	const appleId = process.env.APPLE_ID;
	if (!appleId) {
		fail('APPLE_ID に、公証に使う Apple Account のメールアドレスを入れてください');
	}

	const installed = read('rustup', ['target', 'list', '--installed']).split('\n');
	const missing = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].filter(
		(target) => !installed.includes(target)
	);
	if (missing.length > 0) {
		run('rustup', ['target', 'add', ...missing]);
	}

	const env = {
		...process.env,
		// DMG のアイコンの並びを整える Finder の操作を飛ばす (just bundle と同じ)
		CI: 'true',
		APPLE_SIGNING_IDENTITY: identity,
		APPLE_ID: appleId,
		APPLE_TEAM_ID: TEAM_ID,
		APPLE_PASSWORD: await askSecret('公証のアプリ用パスワード')
	};

	console.log(`Mawok ${version} を ${identity} で作ります`);
	run('pnpm', ['tauri', 'build', '--target', TARGET], { env });

	const app = join(BUNDLE_DIR, 'macos', 'Mawok.app');
	const archs = read('lipo', ['-archs', join(app, 'Contents/MacOS/mawok')]).split(' ');
	if (!archs.includes('x86_64') || !archs.includes('arm64')) {
		fail(`ユニバーサル版になっていません (${archs.join(' ')})`);
	}
	// 公証の結果が .app に綴じてあり、Gatekeeper が通すことを確かめる。Tauri は APPLE_* が欠けると公証を飛ばすだけで止まらない
	run('xcrun', ['stapler', 'validate', app]);
	run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);

	const outDir = join(OUT_ROOT, version);
	const dmg = `Mawok_${version}_universal.dmg`;
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	copyFileSync(join(BUNDLE_DIR, 'dmg', dmg), join(outDir, dmg));
	console.log(`\n${join(outDir, dmg)} に置きました。`);
}

await build();
