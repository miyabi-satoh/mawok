// 画面のビルドに同梱した npm のパッケージのライセンス表示を、ビルドの出力に書き出す Vite プラグイン
// (→ docs/third-party-licenses.md「第三者のソフトウェア」)。
// package.json の依存ではなく、実際に chunk に入ったモジュールから集める。lint やテストの道具を表示に混ぜないため。
// 画面に出す形に整えるところは Rust の分と共通 (scripts/license-display.mjs)。

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { buildLicenseDisplay, type ExtractedPackage } from './license-display.mjs';

const NPM_LICENSES_FILE = 'third-party-licenses/npm.json';

const NODE_MODULES = '/node_modules/';
// 二重ライセンスのパッケージは `LICENSE-MIT`・`LICENSE-APACHE` のように本文を分けて持つ。
// `@tauri-apps/api` は `LICENSE_MIT`・`LICENSE_APACHE-2.0` と下線で区切る。
const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i;
// `license.js` のような同じ名前のコードを本文と間違えないため。
// `LICENSE.spdx` は SPDX のメタデータで、条文ではない。
const NOT_LICENSE_TEXT = /\.(js|mjs|cjs|ts|tsx|json|map|ya?ml|spdx)$/i;

// npm の `repository` の省略形が指す先。bitbucket だけ `.com` ではない。
const SHORTHAND_HOSTS: Record<string, string> = {
	github: 'github.com',
	gitlab: 'gitlab.com',
	bitbucket: 'bitbucket.org'
};

// コードを同梱しているのに、chunk からは辿れないパッケージ。
// - Paraglide は `src/lib/paraglide` に出力するので、モジュールの ID が node_modules の外になる。
//   出力はコンパイラが書いたコードで、そのままバンドルに入る。
// - CSS の `@import` (`src/routes/layout.css`) は @tailwindcss/vite が展開してしまい、
//   Rollup のモジュールにもアセットにも出てこない。中身は配る CSS に入っている。
const EXTRA_PACKAGES = ['@inlang/paraglide-js', 'tailwindcss', 'tw-animate-css', 'shadcn-svelte'];

// ビルドの道具がバンドルに差し込む仮想モジュール (ID が `\0` で始まる) と、そのコードを持つパッケージ。
// node_modules の外の ID なので、ここで対応を付けないと数え漏れる。
// 知らない仮想モジュールがバンドルに入ったらビルドを止め、どのパッケージのコードかを確かめてから足す。
// - `\0vite/preload-helper.js`: 動的 import の先読みの手伝い。Vite 本体のコード。
// - `\0rolldown/runtime.js`: モジュールの読み込みの手伝い。Vite が使う Rolldown 本体のコード。
// ID は完全に一致したものだけを通す。前方一致にすると、同じ道具の知らないモジュールまで確かめずに通ってしまう。
const VIRTUAL_MODULES: Record<string, (root: string) => string> = {
	'\0vite/preload-helper.js': (root) => viteDir(root),
	// Vite が読み込む Rolldown を、Vite の場所から Node の解決で探す (pnpm でも、npm が入れ子に置いても見つかる)。
	'\0rolldown/runtime.js': (root) =>
		dirname(createRequire(join(viteDir(root), 'package.json')).resolve('rolldown/package.json'))
};

// 本文の中で、配る物に入らない部分が始まる印。そこから後ろは表示しない。
// - Vite の `LICENSE.md` は、Vite 本体の条文の後に、Vite 自身が同梱する依存の条文を2千行ほど続けている。
//   配る物に入るのは Vite 本体のコード (上の preload-helper) だけなので、本体の条文だけを出す。
const TEXT_END: Record<string, string> = {
	vite: '\n# Licenses of bundled dependencies'
};

// 名前が LICENSE で始まらないので拾えないが、本文として足すファイル。
// - Rolldown の `LICENSE` は、一部が外部のライブラリに由来し、その条文は THIRD-PARTY-LICENSE にあると書いている。
//   中身は Rollup と esbuild の MIT の条文と著作権表示。配る runtime にどちらかに由来するコードがありうるので、並べて出す。
const EXTRA_TEXT_FILES: Record<string, string[]> = {
	rolldown: ['THIRD-PARTY-LICENSE']
};

// package.json に置き場所を書いていないパッケージと、確かめた上流のリポジトリ。
// - svelte-toolbelt: package.json に repository も homepage も無い。bits-ui と同じ作者のリポジトリで、条文も同じ。
const REPOSITORIES: Record<string, string> = {
	'svelte-toolbelt': 'https://github.com/huntabyte/svelte-toolbelt'
};

// 本文を同梱していないパッケージと、同じ条文を持つ本文の借り先。
// 条文を配らずに名前だけ並べても、MIT の許諾表示を配ったことにならないため、借りて出す。
// - `@tauri-apps/plugin-log` は `LICENSE.spdx` しか持たない。同じ作者 (Tauri Apps Contributors) の
//   `@tauri-apps/api` と、同じプラグインの Rust のクレート (tauri-plugin-log) は同じ2つの条文を持つ。
const BORROWED_TEXTS: Record<string, string> = {
	'@tauri-apps/plugin-log': '@tauri-apps/api'
};

// 配ってよいライセンスの一覧。ここに無いものが入ったらビルドを止め、中身を確かめてから足す。
// Rust 側の `about.toml` の `accepted` と同じ役目 (→ docs/third-party-licenses.md「第三者のソフトウェア」)。
// npm の `license` は `(MIT OR Apache-2.0)` のような SPDX の式も取るので、`isAccepted` で分解して見る。
const ACCEPTED = [
	'0BSD',
	'Apache-2.0',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'BSL-1.0',
	'ISC',
	'MIT',
	'Unicode-3.0',
	'Unlicense',
	'Zlib'
];

export function thirdPartyLicenses(): Plugin {
	return {
		name: 'mawok:third-party-licenses',
		apply: 'build',
		// サーバー側のビルドは配らないので、ブラウザに届く分だけを数える。
		applyToEnvironment: (environment) => environment.name === 'client',
		generateBundle(_options, bundle) {
			const packageDirs = new Set<string>();
			for (const output of Object.values(bundle)) {
				// JS は chunk に入ったモジュール、フォントなどのファイルは元の場所から辿る。
				const sources =
					output.type === 'chunk'
						? output.moduleIds
						: output.originalFileNames.map((name) => resolve(this.environment.config.root, name));
				for (const source of sources) {
					if (source.startsWith('\0')) {
						const packageOf = VIRTUAL_MODULES[source];
						if (packageOf === undefined) {
							this.error(
								`仮想モジュール ${source.slice(1)} のパッケージが分からない (VIRTUAL_MODULES に足す)`
							);
						}
						const dir = packageOf(this.environment.config.root);
						if (!existsSync(join(dir, 'package.json'))) {
							this.error(`${source.slice(1)} のパッケージが見つからない (${dir})`);
						}
						packageDirs.add(dir);
						continue;
					}
					const dir = packageDir(source);
					if (dir) packageDirs.add(dir);
				}
			}
			for (const name of EXTRA_PACKAGES) {
				const dir = resolve(this.environment.config.root, 'node_modules', name);
				if (!existsSync(join(dir, 'package.json'))) {
					this.error(`${name} が見つからない (EXTRA_PACKAGES を見直す)`);
				}
				packageDirs.add(dir);
			}

			const extracted: ExtractedPackage[] = [];
			for (const dir of packageDirs) {
				const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
				const borrowed = BORROWED_TEXTS[manifest.name];
				const ownText = cutAtEnd(
					licenseText(
						borrowed ? resolve(this.environment.config.root, 'node_modules', borrowed) : dir
					),
					TEXT_END[manifest.name]
				);
				// 追加の本文 (EXTRA_TEXT_FILES) を足す前に見る。足した後だと、本来の条文が欠けても空にならず気づけない。
				if (ownText.trim() === '') {
					this.error(
						`${manifest.name} がライセンスの本文を同梱していない。同じ条文の借り先を BORROWED_TEXTS に足す (${dir})`
					);
				}
				const text = ownText + extraTexts(dir, EXTRA_TEXT_FILES[manifest.name] ?? []);
				// 欄を持たないパッケージ (runed など) は本文から見分ける。
				const id = licenseId(manifest) ?? (/^\s*MIT License/.test(text) ? 'MIT' : null);
				if (id === null) {
					this.error(`${manifest.name} のライセンスが分からない (${dir})`);
				}
				if (!isAccepted(id)) {
					this.error(`${manifest.name} のライセンス (${id}) を確かめて ACCEPTED に足す (${dir})`);
				}
				extracted.push({
					name: manifest.name,
					version: manifest.version,
					license: id,
					repository: REPOSITORIES[manifest.name] ?? repositoryUrl(manifest.repository),
					texts: [{ id, name: id, text }]
				});
			}

			// pnpm は同じ版を peer ごとに別の場所へ置くので、同じ `名前@版` は1つにする。
			const unique = new Map(extracted.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
			let display;
			try {
				display = buildLicenseDisplay([...unique.values()]);
			} catch (error) {
				this.error(error instanceof Error ? error.message : String(error));
			}
			this.emitFile({
				type: 'asset',
				fileName: NPM_LICENSES_FILE,
				source: JSON.stringify(display)
			});
		}
	};
}

/** モジュールの ID から、それを含むパッケージのディレクトリを返す。npm のパッケージでなければ `null`。 */
function packageDir(moduleId: string): string | null {
	const path = moduleId.replace(/[?#].*$/, '').replaceAll('\\', '/');
	if (path.startsWith('\0')) return null;
	const index = path.lastIndexOf(NODE_MODULES);
	if (index === -1) return null;
	const rest = path.slice(index + NODE_MODULES.length).split('/');
	const segments = rest[0].startsWith('@') ? 2 : 1;
	const dir = path.slice(0, index + NODE_MODULES.length) + rest.slice(0, segments).join('/');
	return existsSync(join(dir, 'package.json')) ? dir : null;
}

/** パッケージのライセンス本文。持っていなければ空文字。 */
function licenseText(dir: string): string {
	const files = readdirSync(dir, { withFileTypes: true })
		// LICENSE がシンボリックリンクのパッケージがあるので、`isFile()` だけで絞らない。
		.filter((entry) => !entry.isDirectory() && LICENSE_FILE.test(entry.name))
		.map((entry) => entry.name)
		.filter((name) => !NOT_LICENSE_TEXT.test(name))
		.sort();
	// 二重ライセンスのパッケージはどちらか一方を選ぶと嘘になるので、持っている本文を全部並べる。
	// 2つ以上あるときは、どの条文かが分かるようファイル名を挟む。
	return files
		.map((name) => {
			const text = readFileSync(join(dir, name), 'utf8');
			return files.length > 1 ? `${name}\n\n${text}` : text;
		})
		.join('\n\n');
}

/** EXTRA_TEXT_FILES のファイルを、どの条文かが分かるようファイル名を挟んで並べる。無ければビルドを止める。 */
function extraTexts(dir: string, names: string[]): string {
	return names
		.map((name) => {
			const path = join(dir, name);
			if (!existsSync(path)) throw new Error(`${path} が無い (EXTRA_TEXT_FILES を見直す)`);
			return `\n\n${name}\n\n${readFileSync(path, 'utf8')}`;
		})
		.join('');
}

/** `end` があれば、そこから後ろを落とす。印が見つからなければ、形が変わったのでビルドを止める。 */
function cutAtEnd(text: string, end: string | undefined): string {
	if (end === undefined) return text;
	const index = text.indexOf(end);
	if (index === -1) throw new Error(`本文に ${JSON.stringify(end)} が無い (TEXT_END を見直す)`);
	return text.slice(0, index).trimEnd() + '\n';
}

/** Vite のパッケージの実際の場所。pnpm ではシンボリックリンクの先が本物で、依存はその隣に並ぶ。 */
function viteDir(root: string): string {
	return realpathSync(resolve(root, 'node_modules', 'vite'));
}

/** `package.json` が書いているライセンス。旧い形式 (`{ type }`・`licenses`) も拾う。 */
function licenseId(manifest: Record<string, unknown>): string | null {
	const license = manifest.license ?? (manifest.licenses as unknown[] | undefined)?.[0];
	if (typeof license === 'string') return license;
	if (typeof license === 'object' && license !== null && 'type' in license) {
		const type = (license as { type: unknown }).type;
		if (typeof type === 'string') return type;
	}
	return null;
}

/**
 * 配ってよいライセンスか。
 *
 * SPDX の式 (`(MIT OR Apache-2.0)`・`Apache-2.0 AND MIT`) は項に分けて見る。
 * `OR` はどれか1つ、`AND` は全部が `ACCEPTED` に要る。`AND` が `OR` より強く結び付く。
 * 括弧の入れ子 (`(MIT OR Apache-2.0) AND GPL-3.0` など) や `WITH` の例外は読まないので、
 * そのときは通さずビルドを止めて人に確かめさせる。括弧を外して読むと、式の意味が変わるため。
 */
function isAccepted(expression: string): boolean {
	if (/\bWITH\b/i.test(expression)) return false;
	// 式の全体を囲む1組の括弧だけは外してよい。それ以外に括弧が残れば入れ子なので読まない。
	const terms = expression.trim().replace(/^\(([^()]*)\)$/, '$1');
	if (/[()]/.test(terms)) return false;
	return terms
		.split(/\bOR\b/i)
		.some((branch) =>
			branch.split(/\bAND\b/i).every((term) => ACCEPTED.includes(term.trim().replace(/\+$/, '')))
		);
}

/**
 * ソースの置き場所の URL。分からなければ `null`。
 *
 * npm の `repository` は `user/repo`・`github:user/repo`・`git@github.com:user/repo.git` のような
 * 書き方も許すので、そのままリンクにすると画面の中の相対パスとして解釈されてしまう。
 */
function repositoryUrl(repository: unknown): string | null {
	const raw =
		typeof repository === 'string'
			? repository
			: typeof repository === 'object' && repository !== null && 'url' in repository
				? String(repository.url)
				: null;
	if (raw === null) return null;
	const url = raw
		.replace(/^git\+/, '')
		.replace(/\.git$/, '')
		.replace(/^git@([^:]+):/, 'https://$1/')
		.replace(/^(git|ssh):\/\/(git@)?/, 'https://')
		.replace(
			/^(github|gitlab|bitbucket):/,
			(_, host: string) => `https://${SHORTHAND_HOSTS[host]}/`
		)
		// ホストを書かない書き方は GitHub を指す (npm の決まり)。
		.replace(/^(?![a-z]+:\/\/)([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1');
	// 画面は https だけを開く (lib.rs の `open_license_source`) ので、それ以外はリンクにしない。
	return /^https:\/\//.test(url) ? url : null;
}
