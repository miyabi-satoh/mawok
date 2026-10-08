// Windows 版の MSIX を作る (`just msix` から呼ぶ。→ docs/platform.md「Windows の MSIX 版」)。
// `pnpm tauri build --no-bundle` で作った mawok.exe とロゴを並べ、Windows SDK の makepri で resources.pri を作り、makeappx で固めて、
// 試しに入れるための自己署名の証明書で署名する。中身と宣言は src-tauri/msix/AppxManifest.xml に書いてある。

import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';

// Store での識別子。Partner Center の製品の「Product identity」に出る値。
// 試しに入れるための自己署名の証明書 (src-tauri/msix/new-test-cert.ps1 が作る) も、Subject を Publisher と揃えてある
const IDENTITY = {
	name: 'amiiby.Mawok',
	publisher: 'CN=BA27F417-AAC4-43D9-9E55-3320F7F52C6F',
	publisherDisplayName: 'amiiby'
};
const MANIFEST = 'src-tauri/msix/AppxManifest.xml';
const EXE = 'src-tauri/target/release/mawok.exe';
// マニフェストが指すロゴ。`just icons` (tauri icon) が作るものをそのまま使う
const LOGOS = ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png'];
const ICON_DIR = 'src-tauri/icons';
// タスクバーに下地なしで出すアイコン。`just icons` が大きさごとに <n>x<n>.png で作る (大きさの一覧は justfile にだけ書く)。
// 3つの作り (既定・暗いテーマ・明るいテーマ) がそろっていないと、Windows は下地に載せて出す
const TARGET_ICON_DIR = join(ICON_DIR, 'msix');
const TARGET_SUFFIXES = ['', '_altform-unplated', '_altform-lightunplated'];
// makeappx に渡すフォルダ。毎回作り直す
const LAYOUT_DIR = 'src-tauri/target/msix';
// makepri の設定。パッケージに入れないよう、LAYOUT_DIR の外に置く
const PRI_CONFIG = 'src-tauri/target/msix-priconfig.xml';
const OUTPUT_DIR = 'src-tauri/target/release/bundle/msix';
const SDK_BIN = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';

// MSIX のバージョンは4つ組で、Store は最後を 0 に限る
function msixVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		throw new Error(`MSIX にできないバージョンです (${version})。x.y.z の形にしてください`);
	}
	return `${match[1]}.${match[2]}.${match[3]}.0`;
}

// Windows SDK の中で、いちばん新しい版の x64 のツールを探す。別の場所なら環境変数 (MAKEAPPX・MAKEPRI・SIGNTOOL) で指定する
function findSdkTool(name, envName) {
	const fromEnv = process.env[envName];
	if (fromEnv) {
		return fromEnv;
	}
	const versions = existsSync(SDK_BIN)
		? readdirSync(SDK_BIN)
				.filter((dir) => /^10\.[\d.]+$/.test(dir))
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
				.reverse()
		: [];
	for (const version of versions) {
		const path = join(SDK_BIN, version, 'x64', name);
		if (existsSync(path)) {
			return path;
		}
	}
	throw new Error(
		`${name} が見つかりません。Windows SDK を入れるか、環境変数 ${envName} にパスを指定してください`
	);
}

function layout(version) {
	rmSync(LAYOUT_DIR, { recursive: true, force: true });
	mkdirSync(join(LAYOUT_DIR, 'Assets'), { recursive: true });
	copyFileSync(EXE, join(LAYOUT_DIR, 'mawok.exe'));
	for (const logo of LOGOS) {
		copyFileSync(join(ICON_DIR, logo), join(LAYOUT_DIR, 'Assets', logo));
	}
	const sizes = readdirSync(TARGET_ICON_DIR)
		.map((file) => /^(\d+)x\1\.png$/.exec(file)?.[1])
		.filter(Boolean);
	for (const size of sizes) {
		for (const suffix of TARGET_SUFFIXES) {
			copyFileSync(
				join(TARGET_ICON_DIR, `${size}x${size}.png`),
				join(LAYOUT_DIR, 'Assets', `Square44x44Logo.targetsize-${size}${suffix}.png`)
			);
		}
	}
	const manifest = readFileSync(MANIFEST, 'utf8')
		.replaceAll('{{NAME}}', IDENTITY.name)
		.replaceAll('{{PUBLISHER}}', IDENTITY.publisher)
		.replaceAll('{{PUBLISHER_DISPLAY_NAME}}', IDENTITY.publisherDisplayName)
		.replaceAll('{{VERSION}}', msixVersion(version));
	writeFileSync(join(LAYOUT_DIR, 'AppxManifest.xml'), manifest);
}

function main() {
	const { version } = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
	const makeappx = findSdkTool('makeappx.exe', 'MAKEAPPX');
	const unsigned = process.argv.includes('--unsigned');
	const output = join(OUTPUT_DIR, `Mawok_${version}_x64.msix`);

	layout(version);
	// targetsize などの付いた画像は、resources.pri に載っていないと Windows に使われない
	const makepri = findSdkTool('makepri.exe', 'MAKEPRI');
	execFileSync(
		makepri,
		['createconfig', '/cf', PRI_CONFIG, '/dq', 'en-US', '/pv', '10.0.0', '/o'],
		{
			stdio: 'inherit'
		}
	);
	execFileSync(
		makepri,
		[
			'new',
			'/pr',
			LAYOUT_DIR,
			'/cf',
			PRI_CONFIG,
			'/mn',
			join(LAYOUT_DIR, 'AppxManifest.xml'),
			'/of',
			join(LAYOUT_DIR, 'resources.pri'),
			'/o'
		],
		{ stdio: 'inherit' }
	);
	mkdirSync(OUTPUT_DIR, { recursive: true });
	execFileSync(makeappx, ['pack', '/o', '/h', 'SHA256', '/d', LAYOUT_DIR, '/p', output], {
		stdio: 'inherit'
	});
	// Store に上げる版は Store が署名するので、自分では署名しない (Store の Publisher の証明書は手元に無い)
	if (unsigned) {
		console.log(`wrote ${output} (unsigned)`);
		return;
	}
	// 証明書は、今の人の証明書ストア (CurrentUser\My) から Subject で選ぶ
	const subject = IDENTITY.publisher.replace(/^CN=/, '');
	const signtool = findSdkTool('signtool.exe', 'SIGNTOOL');
	execFileSync(signtool, ['sign', '/fd', 'SHA256', '/s', 'My', '/n', subject, output], {
		stdio: 'inherit'
	});
	console.log(`wrote ${output}`);
}

main();
