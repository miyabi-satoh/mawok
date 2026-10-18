import { describe, expect, it } from 'vitest';
import { completedWord, pathWordAt, quotePath, type PathWord } from './shell-completion';

/** カーソルを行末に置いて読む */
const wordAt = (line: string, platform: 'macos' | 'windows' = 'macos') =>
	pathWordAt(line, line.length, platform);

const word = (path: string, extra: Partial<PathWord> = {}): PathWord => ({
	start: 0,
	path,
	quote: null,
	tilde: false,
	...extra
});

describe('pathWordAt', () => {
	it('引数の位置の語を、引用符と \\ を外したパスにする', () => {
		expect(wordAt('@sh cat Doc')).toEqual({ start: 8, path: 'Doc', quote: null, tilde: false });
		expect(wordAt('@sh cat My\\ Fo')).toMatchObject({ start: 8, path: 'My Fo' });
		expect(wordAt('@sh cat "My Fo')).toMatchObject({ path: 'My Fo', quote: '"' });
		expect(wordAt("@sh cat 'it'\\'s")).toMatchObject({ path: "it's", quote: null });
		expect(wordAt('@sh cat ~/Wo')).toMatchObject({ path: '~/Wo', tilde: true });
		expect(wordAt('@sh cat ~/"My Fo')).toMatchObject({ path: '~/My Fo', quote: '"', tilde: true });
	});

	it('引数を打ち始める前なら、今のフォルダーの中を補う', () => {
		expect(wordAt('@sh cat ')).toEqual({ start: 8, path: '', quote: null, tilde: false });
	});

	it('カーソルの直前が逃がしの印だけなら補わない', () => {
		expect(wordAt('@sh cat My\\')).toBeNull();
		expect(wordAt('@sh cat "My\\')).toBeNull();
	});

	it('リダイレクトの後ろはファイルとして補う', () => {
		expect(wordAt('@sh sort >ou')).toMatchObject({ start: 10, path: 'ou' });
	});

	it('コマンドの名前の位置は、パスと分かる語だけを補う', () => {
		expect(wordAt('@sh gi')).toBeNull();
		expect(wordAt('@sh ls | gr')).toBeNull();
		expect(wordAt('@sh ./scr')).toMatchObject({ path: './scr' });
		expect(wordAt('@sh bin/ru')).toMatchObject({ path: 'bin/ru' });
		expect(wordAt('@sh ls | ~/bin/')).toMatchObject({ path: '~/bin/', tilde: true });
	});

	it('シェルが広げる語（変数・ワイルドカード）と、引用符の中の ~ は補わない', () => {
		expect(wordAt('@sh cat $HOME/')).toBeNull();
		expect(wordAt('@sh cat "$HOME/')).toBeNull();
		expect(wordAt('@sh cat "~/')).toBeNull();
		expect(wordAt('@sh rm ./a*')).toBeNull();
		expect(wordAt('@sh cat ~bo')).toMatchObject({ path: '~bo', tilde: false });
		expect(wordAt('@sh cat "a*')).toMatchObject({ path: 'a*' });
		expect(wordAt("@sh cat '$x")).toMatchObject({ path: '$x' });
	});

	it('@sh の行でなければ、宛先の上なら補わない', () => {
		expect(wordAt('cat Doc')).toBeNull();
		expect(wordAt('@ai Doc')).toBeNull();
		expect(wordAt('@shx Doc')).toBeNull();
		expect(pathWordAt('@sh cat Doc', 2, 'macos')).toBeNull();
		expect(wordAt('  @SH cat Doc')).toMatchObject({ start: 10, path: 'Doc' });
	});

	it('Windows は " だけを引用符にし、\\ を区切りに、^ を逃がしの印に読む', () => {
		expect(wordAt('@sh type "C:\\Program Fi', 'windows')).toMatchObject({
			start: 9,
			path: 'C:\\Program Fi',
			quote: '"'
		});
		expect(wordAt("@sh type it's", 'windows')).toMatchObject({ path: "it's" });
		expect(wordAt('@sh type a^&b', 'windows')).toMatchObject({ path: 'a&b' });
		expect(wordAt('@sh .\\scr', 'windows')).toMatchObject({ path: '.\\scr' });
		expect(wordAt('@sh type %USERPROFILE%\\', 'windows')).toBeNull();
		expect(wordAt('@sh type ^%TEMP^%\\', 'windows')).toBeNull();
		expect(wordAt('@sh type a;b\\', 'windows')).toMatchObject({ path: 'b\\' });
		// cmd の / で始まる語はスイッチ
		expect(wordAt('@sh dir /b', 'windows')).toBeNull();
		// cmd は ~ をホームに広げない
		expect(wordAt('@sh type ~\\', 'windows')).toBeNull();
	});
});

describe('quotePath', () => {
	it('macOS は、引用符の外なら \\ を付ける', () => {
		expect(quotePath('My Folder/', word('My'), 'macos', false)).toBe('My\\ Folder/');
		expect(quotePath("it's (1).txt", word('it'), 'macos', true)).toBe("it\\'s\\ \\(1\\).txt");
	});

	it('macOS は、開いた引用符の中ならその書き方にし、ファイルなら閉じる', () => {
		expect(quotePath('My Folder/', word('My', { quote: '"' }), 'macos', false)).toBe('"My Folder/');
		expect(quotePath('a"$.txt', word('a', { quote: '"' }), 'macos', true)).toBe('"a\\"\\$.txt"');
		expect(quotePath("it's", word('it', { quote: "'" }), 'macos', true)).toBe("'it'\\''s'");
	});

	it('macOS は、語の頭の ~ と = も逃がす', () => {
		expect(quotePath('~backup', word(''), 'macos', true)).toBe('\\~backup');
		expect(quotePath('=foo', word(''), 'macos', true)).toBe('\\=foo');
		expect(quotePath('a~=b', word('a'), 'macos', true)).toBe('a~=b');
	});

	it('macOS は、ホームの ~ を引用符の外に置く', () => {
		expect(quotePath('~/My Folder/', word('~/My', { tilde: true }), 'macos', false)).toBe(
			'~/My\\ Folder/'
		);
		expect(
			quotePath('~/My Folder/', word('~/My', { tilde: true, quote: '"' }), 'macos', false)
		).toBe('~/"My Folder/');
	});

	it('Windows は、cmd が囲む文字を含むか、引用符を開いていれば " で囲む', () => {
		expect(quotePath('C:\\Users\\', word('C:\\U'), 'windows', false)).toBe('C:\\Users\\');
		expect(quotePath('C:\\Program Files\\', word('C:\\Pro'), 'windows', false)).toBe(
			'"C:\\Program Files\\'
		);
		expect(quotePath('a&b.txt', word('a'), 'windows', true)).toBe('"a&b.txt"');
		expect(quotePath('notes.txt', word('no', { quote: '"' }), 'windows', true)).toBe('"notes.txt"');
	});
});

describe('completedWord', () => {
	it('ファイルなら引用符を閉じて空白を足し、フォルダーなら区切りで止める', () => {
		expect(completedWord('My notes.txt', word('My', { quote: '"' }), 'macos')).toBe(
			'"My notes.txt" '
		);
		expect(completedWord('My Folder/', word('My', { quote: '"' }), 'macos')).toBe('"My Folder/');
		expect(completedWord('Program Files\\', word('Pro'), 'windows')).toBe('"Program Files\\');
		// 後ろがもう空白なら空白を重ねず、名前の末尾の逃がした空白は残す
		expect(completedWord('notes.txt', word('no'), 'macos', true)).toBe('notes.txt');
		expect(completedWord('foo ', word('fo'), 'macos', true)).toBe('foo\\ ');
	});
});
