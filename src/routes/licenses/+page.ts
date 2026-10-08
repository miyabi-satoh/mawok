import { asset } from '$app/paths';
import { platformFromUrl } from '$lib/keys';
import type { PageLoad } from './$types';

/** 条文。同じ条文は一覧の中で1つにまとめてあり、パッケージからは添え字で指す。 */
export interface LicenseText {
	/** SPDX の識別子や式 (例: `MIT`)。 */
	id: string;
	/** 見出しに出す名前。 */
	name: string;
	/** 著作権表示を含む本文。 */
	text: string;
}

/** 配布物に入っているパッケージ。同じ名前の違う版は1つにまとめてある。 */
export interface LicensePackage {
	name: string;
	versions: string[];
	/** 宣言しているライセンスの式 (例: `MIT OR Apache-2.0`)。 */
	license: string;
	/** ソースの置き場所。持たないパッケージもある。 */
	repository: string | null;
	/** `LicenseList.texts` の添え字。 */
	texts: number[];
}

/** 画面が読む一覧 (scripts/license-display.mjs が作る)。 */
export interface LicenseList {
	texts: LicenseText[];
	/** 名前の順。 */
	packages: LicensePackage[];
}

// Rust の分はリポジトリに入れてあり（`just licenses`）、画面の分はビルドのたびに作る
// （scripts/third-party-licenses.ts）。どちらも配布物に入る静的なファイルなので、そのまま取る。
const FILES = {
	rust: asset('/third-party-licenses/rust.json'),
	npm: asset('/third-party-licenses/npm.json')
} as const;

export const load: PageLoad = async ({ fetch, url }) => {
	const [rust, npm] = await Promise.all([
		fetchLicenses(fetch, FILES.rust),
		fetchLicenses(fetch, FILES.npm)
	]);
	// 閉じるキーを OS で分ける
	return { rust, npm, platform: platformFromUrl(url) };
};

/**
 * 一覧を取る。取れなければ `null`。
 *
 * 開発サーバーにはビルドで作る分（npm）が無いので、片方が欠けてもページは出す。
 */
async function fetchLicenses(
	fetch: typeof globalThis.fetch,
	path: string
): Promise<LicenseList | null> {
	try {
		const response = await fetch(path);
		if (!response.ok) return null;
		return (await response.json()) as LicenseList;
	} catch {
		return null;
	}
}
