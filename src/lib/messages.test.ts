import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

/** 単位として数の後に来る語。プレースホルダーは名前で数かどうかを決めず、後ろの語で見る */
const UNIT = '(?:秒|分|時間|日|週|か月|年|件|回|文字|行|個|つ|[KMGT]B)';
/** 数字の後に日本語か単位、またはプレースホルダーの後に単位が、ふつうの空白を挟んで続く所 */
const BREAKABLE_NUMBER_UNIT = new RegExp(
	`\\d (?=[一-龠々ぁ-んァ-ヶ]|${UNIT})|\\{\\w+\\} (?=${UNIT})`
);

describe('日本語の文言', () => {
	// 数字と単位の間は、そこで折り返さないようノーブレークスペースにする
	it('数字と単位の間に、ふつうの空白を置かない', () => {
		const breakable = Object.entries(ja)
			.filter(([key, value]) => key !== '$schema' && BREAKABLE_NUMBER_UNIT.test(String(value)))
			.map(([key]) => key);
		expect(breakable).toEqual([]);
	});

	it('マニュアルでも、数字と単位の間に、ふつうの空白を置かない', () => {
		const manual = readFileSync(new URL('../../docs/manual/ja.md', import.meta.url), 'utf8');
		const breakable = manual.split('\n').filter((line) => BREAKABLE_NUMBER_UNIT.test(line));
		expect(breakable).toEqual([]);
	});
});

describe('文言の書き方', () => {
	// 文言を読む inlang の message-format の部品は、\ をエスケープの文字として扱い、\\ を1つの \ にする。
	// 書いた \ が画面で減るので、要る所は引数で渡す（$lib/folder-errors）
	it('文言に \\ を書かない', () => {
		const withBackslash = [...Object.entries(ja), ...Object.entries(en)]
			.filter(([key, value]) => key !== '$schema' && String(value).includes('\\'))
			.map(([key]) => key);
		expect(withBackslash).toEqual([]);
	});
});
