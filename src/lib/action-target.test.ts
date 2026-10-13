import { describe, expect, it } from 'vitest';
import { splitActionTarget } from './action-target';

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
