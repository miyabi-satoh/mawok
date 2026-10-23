// Tauri の側と型をやり取りするため、同じ版に揃えている依存が、揃っているかを見る (`just ci` から呼ぶ)。
// 版がずれても cfg(windows)・cfg(target_os = "linux") のコードはほかの OS でコンパイルされないので、1つの OS の検査だけでは気づけない。
// 揃え方は src-tauri/Cargo.toml のコメント、Dependabot が個別に上げないことは .github/dependabot.yml。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 手元が直接使う crate と、同じ版を使っているはずの相手。
const PINNED = [
	{ name: 'webview2-com', partner: 'wry' },
	{ name: 'windows-core', partner: 'wry' },
	{ name: 'tauri-winrt-notification', partner: 'notify-rust' },
	{ name: 'webkit2gtk', partner: 'wry' },
	{ name: 'gtk', partner: 'tao' },
	{ name: 'zbus', partner: 'tauri-plugin-single-instance' },
	{ name: 'block2', partner: 'objc2-foundation' },
	{ name: 'objc2', partner: 'tray-icon' },
	{ name: 'objc2-foundation', partner: 'tray-icon' },
	{ name: 'objc2-app-kit', partner: 'tray-icon' }
];

// Dependabot が相手より先に上げると、ここで落ちる PR が毎月来る。PINNED に足した crate を ignore に足し忘れないよう見る。
// 見るのは cargo の欄だけ (次の `- package-ecosystem:` まで)。npm の欄に同じ名前があっても数えない。
const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
const cargoSection =
	dependabot.split(/^\s*- package-ecosystem:/m).find((section) => /^\s*'cargo'/.test(section)) ??
	'';
const ignored = new Set(
	[...cargoSection.matchAll(/dependency-name:\s*'([^']+)'/g)].map((match) => match[1])
);
const notIgnored = PINNED.map(({ name }) => name).filter((name) => !ignored.has(name));

if (notIgnored.length > 0) {
	console.error(
		`.github/dependabot.yml の cargo の ignore に、揃えている依存が無い: ${notIgnored.join(', ')}`
	);
}

const metadata = JSON.parse(
	execFileSync(
		'cargo',
		['metadata', '--format-version', '1', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	)
);
const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const rootId = metadata.resolve.root;

/** `from` の名前の crate が依存する `name` の版 (ほかの OS 向けの依存も含む)。 */
function versionsUsedBy(from, name) {
	const versions = new Set();
	for (const node of nodes.values()) {
		if (packages.get(node.id).name !== from) continue;
		for (const dep of node.deps) {
			const pkg = packages.get(dep.pkg);
			if (pkg.name === name) versions.add(pkg.version);
		}
	}
	return [...versions];
}

const rootName = packages.get(rootId).name;
const errors = [];
for (const { name, partner } of PINNED) {
	const ours = versionsUsedBy(rootName, name);
	const theirs = versionsUsedBy(partner, name);
	if (ours.length !== 1 || theirs.length !== 1 || ours[0] !== theirs[0]) {
		errors.push(
			`${name}: 手元は ${ours.join(', ') || '無し'}、${partner} は ${theirs.join(', ') || '無し'}`
		);
	}
}

if (errors.length > 0) {
	console.error(
		'Tauri の側と揃えている依存の版がずれている (src-tauri/Cargo.toml の版を相手に合わせる):'
	);
	for (const error of errors) console.error(`  ${error}`);
}
if (errors.length > 0 || notIgnored.length > 0) process.exit(1);
