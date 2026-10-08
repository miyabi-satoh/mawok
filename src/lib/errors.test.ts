import { describe, expect, it } from 'vitest';
import { describeError, errorCode } from './errors';

function errorWithStack(message: string, stack: string | undefined) {
	const error = new TypeError(message);
	error.stack = stack;
	return error;
}

describe('describeError', () => {
	it('先頭にメッセージを含むスタック（V8）はそのまま使う', () => {
		const stack = 'TypeError: boom\n    at f (app.js:1:1)';
		expect(describeError(errorWithStack('boom', stack))).toBe(stack);
	});

	it('メッセージを含まないスタック（WebKit）には、エラー名とメッセージを前に付ける', () => {
		expect(describeError(errorWithStack('boom', 'f@app.js:1:1'))).toBe(
			'TypeError: boom\nf@app.js:1:1'
		);
	});

	it('スタックがなければ、エラー名とメッセージだけにする', () => {
		expect(describeError(errorWithStack('boom', undefined))).toBe('TypeError: boom');
	});

	it('Error 以外の値は文字列にする', () => {
		expect(describeError('main window not found')).toBe('main window not found');
		expect(describeError(undefined)).toBe('undefined');
	});
});

describe('errorCode', () => {
	it('符号だけの文字列はそのまま返す', () => {
		expect(errorCode('lan.unreachable')).toBe('lan.unreachable');
	});

	it('{ code } の形から符号を取り出す', () => {
		expect(errorCode({ code: 'action.cancelled', detail: null })).toBe('action.cancelled');
		expect(errorCode({ code: 'lan.partial', devices: ['ab'] })).toBe('lan.partial');
	});

	it('符号を持たなければ、文字列にしたものを返す', () => {
		expect(errorCode(new Error('boom'))).toBe('Error: boom');
		expect(errorCode({ code: 1 })).toBe('[object Object]');
		expect(errorCode(null)).toBe('null');
	});
});
