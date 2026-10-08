import { marked, Renderer, type Tokens } from 'marked';
import type { Platform } from '$lib/keys';

/** 目次に載せる節 (見出し2)。 */
interface ManualSection {
	id: string;
	title: string;
}

export interface Manual {
	/** 見出し1。目次より上に出すので、本文の HTML には含めない */
	title: string;
	html: string;
	sections: ManualSection[];
}

/**
 * 見出し2に、目次から移るための id を振る。id は並びの番号にする。日本語の見出しから作ると、
 * 英語と日本語で id が揃わず、記号の扱いも決めることになるため。
 * 表は、横に送れる領域で包む。表そのものを `overflow` にすると、表の中に押せる要素が無いので
 * キーボードでは見切れた列に届かない。
 */
class ManualRenderer extends Renderer {
	title = '';
	readonly sections: ManualSection[] = [];
	readonly tableLabel: string;

	constructor(tableLabel: string) {
		super();
		this.tableLabel = tableLabel;
	}

	override heading(token: Tokens.Heading): string {
		if (token.depth === 1) {
			this.title = token.text;
			return '';
		}
		if (token.depth !== 2) return super.heading(token);
		const id = `section-${this.sections.length + 1}`;
		this.sections.push({ id, title: token.text });
		// 目次から移ったときにフォーカスを置けるよう、tabindex を付ける
		return `<h2 id="${id}" tabindex="-1">${this.parser.parseInline(token.tokens)}</h2>\n`;
	}

	override table(token: Tokens.Table): string {
		const label = escapeAttribute(this.tableLabel);
		return `<div class="table-scroll" tabindex="0" role="region" aria-label="${label}">${super.table(token)}</div>`;
	}
}

function escapeAttribute(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

const CJK = '[　-ヿ一-鿿＀-￯]';
/** 直後に空白を置かない約物。これで終わる行は、次に何が来ても詰めてよい。 */
const TERMINATOR = '[。、！？」』）]';
const CLOSING_TAGS = '(?:</[a-zA-Z][^>]*>)*';
const OPENING_TAGS = '(?:<[a-zA-Z][^>]*>)*';
// 次の文字は先読みで見る。消費すると `あ\nい\nう` の2つ目の改行を取りこぼすため
const AFTER_TERMINATOR = new RegExp(`(${TERMINATOR}${CLOSING_TAGS})\\n`, 'g');
const BETWEEN_CJK = new RegExp(`(${CJK}${CLOSING_TAGS})\\n(?=${OPENING_TAGS}${CJK})`, 'g');

/**
 * 日本語の行送りが空白になって出るのを防ぐ。Markdown は段落の中の改行を空白でつなぐが、
 * 日本語は語の間に空白を置かないので、文の区切りに隙間が開いて見える。
 * 詰めるのは、約物の直後の改行と、両側が日本語の文字の改行。日本語と欧文の境目の空白は残す。
 * `<pre>` の中は行が意味を持つので触らない
 */
export function collapseCjkLineBreaks(html: string): string {
	return html
		.split(/(<pre[\s\S]*?<\/pre>)/)
		.map((part, index) =>
			index % 2 === 1 ? part : part.replace(AFTER_TERMINATOR, '$1').replace(BETWEEN_CJK, '$1')
		)
		.join('');
}

const PLATFORMS: readonly Platform[] = ['macos', 'windows'];
// 文の中で OS ごとに違う所。中身は Markdown のままで、波かっこは含められない。区切りに縦棒を使わないのは、
// 表の中に置いても、GitHub などで原典を読んだときに表の列の区切りにならないようにするため
const INLINE = /\{macos:([^{}]*)\}\{windows:([^{}]*)\}/g;
const BLOCK_START = /^::: (macos|windows)$/;
const BLOCK_END = ':::';
// 印のつもりで書いたのに印にならない行 (字下げした、OS の名前を違えた)。そのまま本文に出てしまうので、描かずに知らせる
const MARKER_LIKE = /^\s*:::/;

/**
 * 原典の OS ごとの書き分けから、`platform` の分だけを残す。アプリの中では開いた OS が分かるので、
 * 両方を併記せずにその OS の書き方だけを出す (AGENTS.md「マニュアル」)。
 * - 文の中: `{macos:…}{windows:…}`
 * - 段落や項目ごと: `::: macos` か `::: windows` の行から `:::` の行まで。印の行は残さないので、
 *   箇条書きの途中に置いても、前後の項目は1つの箇条書きのままになる
 */
export function selectPlatform(markdown: string, platform: Platform): string {
	const kept: string[] = [];
	let block: { platform: Platform; line: number } | null = null;
	for (const [index, line] of markdown.split('\n').entries()) {
		const start = BLOCK_START.exec(line);
		if (start) {
			if (block !== null) {
				throw new Error(
					`${index + 1} 行目: ${block.line} 行目の OS の書き分けが閉じる前に、次の書き分けが始まっています`
				);
			}
			block = { platform: start[1] as Platform, line: index + 1 };
			continue;
		}
		if (line === BLOCK_END) {
			if (block === null)
				throw new Error(`${index + 1} 行目: 始まっていない OS の書き分けを閉じています`);
			block = null;
			continue;
		}
		if (MARKER_LIKE.test(line)) {
			throw new Error(
				`${index + 1} 行目: OS の書き分けの印は、字下げせずに \`::: macos\`・\`::: windows\`・\`:::\` と書きます`
			);
		}
		if (block === null || block.platform === platform) kept.push(line);
	}
	if (block !== null) throw new Error(`${block.line} 行目で始まった OS の書き分けが閉じていません`);
	const index = PLATFORMS.indexOf(platform);
	return kept.join('\n').replace(INLINE, (_, ...texts: string[]) => texts[index]);
}

/**
 * 使い方の Markdown を HTML と目次にする。ソースは同梱の `docs/manual/*.md` だけで、
 * 外から入る文字を含まないので、サニタイズは挟まない。
 *
 * @param tableLabel 表を包む領域の名前。画面の表示言語で渡す
 * @param platform 開いた OS。原典の OS ごとの書き分けから、この OS の分だけを出す
 */
export function renderManual(markdown: string, tableLabel: string, platform: Platform): Manual {
	const renderer = new ManualRenderer(tableLabel);
	const html = marked.parse(selectPlatform(markdown, platform), { async: false, renderer });
	return { title: renderer.title, html: collapseCjkLineBreaks(html), sections: renderer.sections };
}
