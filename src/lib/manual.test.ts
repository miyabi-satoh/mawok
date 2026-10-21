import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collapseCjkLineBreaks, githubSlug, renderManual, selectPlatform } from './manual';

const read = (locale: string) =>
	readFileSync(new URL(`../../docs/manual/${locale}.md`, import.meta.url), 'utf8');

describe('renderManual', () => {
	it('見出し1を題名として本文から外し、見出し2を目次に載せ、並びの番号の id と、フォーカスを置ける tabindex を振る', () => {
		const { title, html, sections } = renderManual(
			'# 題\n\n## 一つ目\n\n### 小見出し\n\n## `二つ目`\n',
			'表',
			'macos'
		);
		expect(title).toBe('題');
		expect(html).not.toContain('<h1');
		expect(sections).toEqual([
			{ id: 'section-1', title: '一つ目' },
			{ id: 'section-2', title: '`二つ目`' }
		]);
		expect(html).toContain('<h2 id="section-1" tabindex="-1">一つ目</h2>');
		expect(html).toContain('<h2 id="section-2" tabindex="-1"><code>二つ目</code></h2>');
		expect(html).toContain('<h3>小見出し</h3>');
	});

	it('キーだけを書いたコードをキーキャップにし、+ は読み上げにだけ残す。それ以外のコードはそのまま', () => {
		const { html } = renderManual(
			'`Cmd+,` と `Esc`、`Ctrl+Alt+↑ / Ctrl+Alt+↓`。`@ai` と `@sh sort`\n',
			'表',
			'windows'
		);
		const sep = '<span class="sr-only">+</span>';
		expect(html).toContain(`<kbd class="keys"><kbd>Cmd</kbd>${sep}<kbd>,</kbd></kbd>`);
		expect(html).toContain('<kbd class="keys"><kbd>Esc</kbd></kbd>');
		expect(html).toContain(
			`<kbd class="keys"><kbd>Ctrl</kbd>${sep}<kbd>Alt</kbd>${sep}<kbd>↑</kbd></kbd> / <kbd class="keys">`
		);
		expect(html).toContain('<code>@ai</code>');
		expect(html).toContain('<code>@sh sort</code>');
	});

	it('GitHub と同じ見出しの # で書いた節へのリンクを、後ろの節でもその節の id へ向け直す', () => {
		const { html } = renderManual(
			'# 題\n\n## 一つ目\n\n「[AI を使う](#ai-を使う)」を参照\n\n## AI を使う\n',
			'表',
			'macos'
		);
		expect(html).toContain('<a href="#section-2">AI を使う</a>');
	});

	it('節へのリンクの先の見出しが無ければ、描かずに知らせる', () => {
		expect(() => renderManual('## 一つ目\n\n[無い節](#無い節)\n', '表', 'macos')).toThrow(
			'#無い節'
		);
	});

	it.each([
		['AI を使う', 'ai-を使う'],
		['What is sent and privacy', 'what-is-sent-and-privacy'],
		['Write an addressee, and run', 'write-an-addressee-and-run']
	])('GitHub と同じ見出しの # にする: %s', (text, slug) => {
		expect(githubSlug(text)).toBe(slug);
	});

	it('番号付きの並びにだけ role="list" を付ける', () => {
		const { html } = renderManual('1. a\n2. b\n\n- c\n', '表', 'macos');
		expect(html).toContain('<ol role="list">');
		expect(html).toContain('<ul>');
	});

	it('表を、名前の付いた横に送れる領域で包む', () => {
		const { html } = renderManual('| a | b |\n| - | - |\n| 1 | 2 |\n', 'Table "x"', 'macos');
		expect(html).toMatch(
			/^<div class="table-scroll" tabindex="0" role="region" aria-label="Table &quot;x&quot;"><table>/
		);
	});

	it.each(['macos', 'windows', 'linux'] as const)(
		'日本語と英語のマニュアルは、%s で描いても節が同じ数だけ並ぶ',
		(platform) => {
			const ja = renderManual(read('ja'), '表', platform).sections;
			const en = renderManual(read('en'), 'Table', platform).sections;
			expect(ja.length).toBeGreaterThan(0);
			expect(en).toHaveLength(ja.length);
		}
	);
});

describe('selectPlatform', () => {
	const source = [
		'1. {macos:`Cmd+K`}{windows:`Ctrl+K`}{linux:`Ctrl+K`} を押す',
		'2. 選ぶ',
		'::: windows',
		'3. cmd で動く',
		':::',
		'::: macos',
		'3. シェルで動く',
		':::',
		'::: linux',
		'3. sh で動く',
		':::',
		'{macos:}{windows:Windows だけの文。}{linux:}'
	].join('\n');

	it('文の中と段落の書き分けから、開いた OS の分だけを残し、印の行は残さない', () => {
		expect(selectPlatform(source, 'macos')).toBe('1. `Cmd+K` を押す\n2. 選ぶ\n3. シェルで動く\n');
		expect(selectPlatform(source, 'windows')).toBe(
			'1. `Ctrl+K` を押す\n2. 選ぶ\n3. cmd で動く\nWindows だけの文。'
		);
		expect(selectPlatform(source, 'linux')).toBe('1. `Ctrl+K` を押す\n2. 選ぶ\n3. sh で動く\n');
	});

	it('書き分けの印が閉じていない・閉じすぎ・重なっているときは、描かずに知らせる', () => {
		expect(() => selectPlatform('A\n::: macos\nB', 'macos')).toThrow('2 行目で始まった');
		expect(() => selectPlatform('A\n:::', 'macos')).toThrow('2 行目');
		expect(() => selectPlatform('::: macos\n::: windows\n:::', 'macos')).toThrow('2 行目');
		expect(() => selectPlatform('1. A\n   ::: windows\n   B\n   :::', 'macos')).toThrow('2 行目');
		expect(() => selectPlatform('::: mac\nA\n:::', 'macos')).toThrow('1 行目');
	});

	// OS を書き足したときに、書き分けの漏れた所が、ある OS で黙って消えたり印のまま出たりしないようにする
	it.each([
		['OS が欠けている', 'A\n{macos:`Cmd+K`}{windows:`Ctrl+K`} を押す'],
		['順が違う', 'A\n{windows:`Ctrl+K`}{macos:`Cmd+K`}{linux:`Ctrl+K`}'],
		['ほかの OS の段落の中にある', '::: macos\n{macos:a}{windows:b}\n:::']
	])('文の中の書き分けが3つそろっていなければ、描かずに知らせる: %s', (_, markdown) => {
		expect(() => selectPlatform(markdown, 'linux')).toThrow('2 行目');
	});

	// 書き分け忘れを拾う。開いた OS と違う OS の言葉が残っていれば、併記のままの所がある
	const linuxWords =
		'Linux|GNOME|Hyprland|Wayland|X11|\\bapt\\b|AUR|(?<!タスク)トレイ|(?<!system )\\btray\\b';
	const other = {
		macos: new RegExp(
			`Ctrl\\+|Windows|タスクトレイ|エクスプローラー|system tray|File Explorer|${linuxWords}|^\\s*:::`,
			'm'
		),
		windows: new RegExp(
			`Cmd\\+|Option\\+|macOS|メニューバー|Finder|キーチェーン|menu bar|Keychain|${linuxWords}|^\\s*:::`,
			'm'
		),
		linux:
			/Cmd\+|Option\+|macOS|Windows|メニューバー|タスクトレイ|Finder|エクスプローラー|キーチェーン|menu bar|system tray|File Explorer|Keychain|^\s*:::/m
	};
	it.each([
		['ja', 'macos'],
		['ja', 'windows'],
		['ja', 'linux'],
		['en', 'macos'],
		['en', 'windows'],
		['en', 'linux']
	] as const)('%s の原典を %s で描くと、印も、ほかの OS の言葉も残らない', (locale, platform) => {
		const lines = selectPlatform(read(locale), platform)
			.split('\n')
			.filter((line) => other[platform].test(line));
		expect(lines).toEqual([]);
	});
});

describe('collapseCjkLineBreaks', () => {
	it('約物の直後と、日本語どうしの改行を詰め、日本語と欧文の境目と pre の中は残す', () => {
		expect(collapseCjkLineBreaks('<p>文。\nNext\nあ\nい\n欧文\nword</p>')).toBe(
			'<p>文。Next\nあい欧文\nword</p>'
		);
		expect(collapseCjkLineBreaks('<pre>あ\nい</pre>')).toBe('<pre>あ\nい</pre>');
	});
});
