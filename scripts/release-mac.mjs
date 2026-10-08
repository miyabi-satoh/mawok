// Mac 版の配る版を作って出す (`just release-mac` から呼ぶ。→ docs/platform.md「Mac 版の配る版」)。
//
//   build:   ユニバーサル版を Developer ID で署名・公証し、更新用のファイルに更新の鍵で署名して、
//            確認先の JSON と一緒に src-tauri/target/release-mac/<版>/ に並べる
//   publish: GitHub Releases に上げてから、JSON を site/public/updates/latest.json に置き、窓口ごと置き直す
//
// JSON を site/ に置くのは Releases に上げた後にする。先に main に入れると、その間に誰かが窓口を置き直したとき、
// まだ上がっていない版を Mac が見つけてダウンロードに失敗する。

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 配るファイルを置くリポジトリ。公開していないと、利用者がダウンロードできない
const REPO = 'miyabi-satoh/mawok';
// Developer ID の証明書の Team ID (developer.apple.com/account の Membership details)
const TEAM_ID = 'V6W6CVP93A';
const TARGET = 'universal-apple-darwin';
const BUNDLE_DIR = `src-tauri/target/${TARGET}/release/bundle`;
const OUT_ROOT = 'src-tauri/target/release-mac';
const SITE_LATEST_JSON = 'site/public/updates/latest.json';
// 確認先の JSON の platforms のキー。ユニバーサル版の同じファイルを両方に書く
const PLATFORMS = ['darwin-aarch64', 'darwin-x86_64'];

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

function artifacts(version) {
	const dir = join(OUT_ROOT, version);
	const base = `Mawok_${version}_universal`;
	return {
		dir,
		dmg: join(dir, `${base}.dmg`),
		tarball: join(dir, `${base}.app.tar.gz`),
		signature: join(dir, `${base}.app.tar.gz.sig`),
		latest: join(dir, 'latest.json')
	};
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
	const updaterKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
	if (!updaterKey) {
		fail('TAURI_SIGNING_PRIVATE_KEY に、更新の鍵のファイルの場所か中身を入れてください');
	}
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
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: await askSecret('更新の鍵のパスワード'),
		APPLE_PASSWORD: await askSecret('公証のアプリ用パスワード')
	};

	console.log(`Mawok ${version} を ${identity} で作ります`);
	run(
		'pnpm',
		[
			'tauri',
			'build',
			'--target',
			TARGET,
			'--config',
			JSON.stringify({ bundle: { createUpdaterArtifacts: true } })
		],
		{ env }
	);

	const app = join(BUNDLE_DIR, 'macos', 'Mawok.app');
	const archs = read('lipo', ['-archs', join(app, 'Contents/MacOS/mawok')]).split(' ');
	if (!archs.includes('x86_64') || !archs.includes('arm64')) {
		fail(`ユニバーサル版になっていません (${archs.join(' ')})`);
	}
	// 公証の結果が .app に綴じてあり、Gatekeeper が通すことを確かめる。Tauri は APPLE_* が欠けると公証を飛ばすだけで止まらない
	run('xcrun', ['stapler', 'validate', app]);
	run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);

	const out = artifacts(version);
	rmSync(out.dir, { recursive: true, force: true });
	mkdirSync(out.dir, { recursive: true });
	copyFileSync(join(BUNDLE_DIR, 'dmg', `Mawok_${version}_universal.dmg`), out.dmg);
	copyFileSync(join(BUNDLE_DIR, 'macos', 'Mawok.app.tar.gz'), out.tarball);
	copyFileSync(join(BUNDLE_DIR, 'macos', 'Mawok.app.tar.gz.sig'), out.signature);

	const url = `https://github.com/${REPO}/releases/download/v${version}/${out.tarball.split('/').pop()}`;
	const signature = readFileSync(out.signature, 'utf8').trim();
	const latest = {
		version,
		pub_date: new Date().toISOString(),
		platforms: Object.fromEntries(PLATFORMS.map((key) => [key, { url, signature }]))
	};
	writeFileSync(out.latest, `${JSON.stringify(latest, null, '\t')}\n`);

	console.log(
		`\n${out.dir} に並べました。版の番号の変更を main に入れてから、just release-mac publish を流してください。`
	);
}

function publish() {
	const version = appVersion();
	const out = artifacts(version);
	for (const file of [out.dmg, out.tarball, out.signature, out.latest]) {
		if (!existsSync(file)) {
			fail(`${file} がありません。先に just release-mac build を流してください`);
		}
	}
	const latest = JSON.parse(readFileSync(out.latest, 'utf8'));
	const signature = readFileSync(out.signature, 'utf8').trim();
	if (
		latest.version !== version ||
		PLATFORMS.some((key) => latest.platforms[key]?.signature !== signature)
	) {
		fail(
			`${out.latest} が、アプリの版 (${version}) か更新用のファイルの署名と合いません。build を流し直してください`
		);
	}
	if (
		read('gh', ['repo', 'view', REPO, '--json', 'visibility', '-q', '.visibility']) !== 'PUBLIC'
	) {
		fail(`${REPO} が公開されていないので、利用者が Releases からダウンロードできません`);
	}

	run('git', ['fetch', '--quiet', 'origin', 'main']);
	if (read('git', ['branch', '--show-current']) !== 'main') {
		fail('main で流してください');
	}
	if (read('git', ['status', '--porcelain', '--untracked-files=no']) !== '') {
		fail('作業ツリーに未コミットの変更があります');
	}
	const head = read('git', ['rev-parse', 'HEAD']);
	if (head !== read('git', ['rev-parse', 'origin/main'])) {
		fail('手元の main が origin/main と揃っていません');
	}

	// 先にファイルを上げ、確認先の JSON はその後に置く。逆だと、上がる前に見つけた Mac が落とせない
	run('gh', [
		'release',
		'create',
		`v${version}`,
		'--repo',
		REPO,
		'--target',
		head,
		'--title',
		`Mawok ${version}`,
		'--notes',
		'',
		out.dmg,
		out.tarball,
		out.signature
	]);
	mkdirSync('site/public/updates', { recursive: true });
	copyFileSync(out.latest, SITE_LATEST_JSON);
	const deployed = spawnSync('pnpm', ['run', 'deploy'], {
		cwd: 'account-server',
		stdio: 'inherit'
	});
	if (deployed.status !== 0) {
		fail(
			'窓口を置き直せませんでした。Releases には上がっているので、account-server で pnpm run deploy を流し直してください'
		);
	}
	console.log(
		`\nMawok ${version} を出しました。次に窓口を置き直したときに古い JSON に戻らないよう、${SITE_LATEST_JSON} を main に入れてください。`
	);
}

const command = process.argv[2];
if (command === 'build') {
	await build();
} else if (command === 'publish') {
	publish();
} else {
	fail('使い方: just release-mac build | publish');
}
