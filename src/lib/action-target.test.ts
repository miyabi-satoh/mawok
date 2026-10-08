import { describe, expect, it } from 'vitest';
import {
	aiInstruction,
	hasDelayedExpansionChars,
	isRunnable,
	splitActionTarget
} from './action-target';

describe('splitActionTarget', () => {
	it('前の空行と、後ろの空白と改行を分ける', () => {
		expect(splitActionTarget('\n  \nあいう\nえお\n\n', false)).toEqual({
			leading: '\n  \n',
			body: 'あいう\nえお',
			trailing: '\n\n'
		});
	});

	it('コマンドは、1行目の字下げを中身に残す', () => {
		expect(splitActionTarget('    foo\n    bar\n', false)).toEqual({
			leading: '',
			body: '    foo\n    bar',
			trailing: '\n'
		});
	});

	it('Windows の改行の空行も前に分ける', () => {
		expect(splitActionTarget('\r\nabc', false)).toEqual({
			leading: '\r\n',
			body: 'abc',
			trailing: ''
		});
	});

	it('AI は、1行目の字下げや全角空白も前に分ける（結果の前後の空白は落ちて返るため）', () => {
		expect(splitActionTarget('\u3000\n    foo\n    bar', true)).toEqual({
			leading: '\u3000\n    ',
			body: 'foo\n    bar',
			trailing: ''
		});
	});
});

describe('aiInstruction', () => {
	it('行頭の @ai の後ろを指示文にする', () => {
		expect(aiInstruction('@ai 丁寧に: {{t}}')).toBe('丁寧に: {{t}}');
		expect(aiInstruction('  @ai\t訳して | sort ')).toBe('訳して | sort');
		expect(aiInstruction('@ai')).toBe('');
	});

	it('行頭でない @ai や、続きのある語は AI の行ではない', () => {
		expect(aiInstruction('@aix')).toBeNull();
		expect(aiInstruction('echo @ai')).toBeNull();
	});
});

describe('isRunnable', () => {
	it('空の行と、指示文が空の @ai の行は実行しない', () => {
		expect(isRunnable('  ')).toBe(false);
		expect(isRunnable('@ai  ')).toBe(false);
		expect(isRunnable('@ai 訳して')).toBe(true);
		expect(isRunnable('date')).toBe(true);
	});
});

describe('hasDelayedExpansionChars', () => {
	it('{{t}} のあるシェルの行に ! か ^ があれば知らせる', () => {
		expect(hasDelayedExpansionChars('echo {{t}}!')).toBe(true);
		expect(hasDelayedExpansionChars('echo {{t}} ^& more')).toBe(true);
	});

	it('{{t}} の無い行、! も ^ も無い行、@ai の行では知らせない', () => {
		expect(hasDelayedExpansionChars('echo a^b!')).toBe(false);
		expect(hasDelayedExpansionChars('echo {{t}}')).toBe(false);
		expect(hasDelayedExpansionChars('@ai 訳して! {{t}}')).toBe(false);
	});
});
