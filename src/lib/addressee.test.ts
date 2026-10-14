import { describe, expect, it } from 'vitest';
import {
	ADDRESS_CANDIDATES,
	aiInstruction,
	completedAddress,
	isRunnable,
	matchingAddresses,
	resolveAddressee,
	rowAddressee,
	shCommand,
	splitFirstLine,
	textAddressee,
	typedAddress
} from './addressee';

describe('aiInstruction・shCommand', () => {
	it('行頭の宛先の後ろを、指示文・コマンドにする', () => {
		expect(aiInstruction('@ai 丁寧に: 敬語で')).toBe('丁寧に: 敬語で');
		expect(aiInstruction('  @ai\t訳して | sort ')).toBe('訳して | sort');
		expect(aiInstruction('@ai')).toBe('');
		expect(shCommand('@sh sort | uniq')).toBe('sort | uniq');
	});

	it('宛先の大文字と小文字は区別しない', () => {
		expect(aiInstruction('@AI 訳して')).toBe('訳して');
		expect(shCommand('@Sh ls')).toBe('ls');
	});

	it('行頭でない宛先や、続きのある語は宛先ではない', () => {
		expect(aiInstruction('@aix')).toBeNull();
		expect(aiInstruction('echo @ai')).toBeNull();
		expect(shCommand('@shell ls')).toBeNull();
		expect(shCommand('sort')).toBeNull();
	});
});

describe('isRunnable', () => {
	it('宛先だけで後ろが空の行と、宛先の無い行は実行しない', () => {
		expect(isRunnable('@ai  ')).toBe(false);
		expect(isRunnable('@sh')).toBe(false);
		expect(isRunnable('date')).toBe(false);
		expect(isRunnable('@ai 訳して')).toBe(true);
		expect(isRunnable('@sh date')).toBe(true);
	});
});

describe('splitFirstLine', () => {
	it('1行目と、2行目から下に分ける', () => {
		expect(splitFirstLine('@sh sort\nb\na\n')).toEqual({ line: '@sh sort', rest: 'b\na\n' });
		expect(splitFirstLine('@sh ls')).toEqual({ line: '@sh ls', rest: '' });
		expect(splitFirstLine('@sh ls\r\n本文')).toEqual({ line: '@sh ls', rest: '本文' });
	});
});

describe('resolveAddressee', () => {
	it('@ai と @sh は、実行する行にする', () => {
		expect(resolveAddressee('@ai 訳して')).toEqual({ ai: true, line: '@ai 訳して' });
		expect(resolveAddressee('@sh ls')).toEqual({ ai: false, line: '@sh ls' });
	});

	it('@ で始まっていても、@ai・@sh でなければ宛先ではない', () => {
		expect(resolveAddressee('@all')).toBeNull();
		expect(resolveAddressee('@MacBook Air')).toBeNull();
		expect(resolveAddressee('@tanaka ありがとう')).toBeNull();
		expect(resolveAddressee('ふつうの文')).toBeNull();
	});
});

describe('textAddressee', () => {
	it('1行目が @ai・@sh のテキストは、その宛先を返す（コピーのキーで実行する）', () => {
		expect(textAddressee('@sh sort\nb\na')).toEqual({ ai: false, line: '@sh sort' });
		expect(textAddressee('@AI 訳して')).toEqual({ ai: true, line: '@AI 訳して' });
		// 後ろが空でも宛先。実行するものが無いことは、押したときに知らせる
		expect(textAddressee('@sh')).toEqual({ ai: false, line: '@sh' });
	});

	it('1行目が宛先でないテキストは null（コピーのキーでコピーする）', () => {
		expect(textAddressee('')).toBeNull();
		expect(textAddressee('ふつうの文')).toBeNull();
		expect(textAddressee('@tanaka ありがとう')).toBeNull();
		expect(textAddressee('@shell ls')).toBeNull();
		// 宛先を読むのは1行目だけ
		expect(textAddressee('メモ\n@sh sort')).toBeNull();
		expect(textAddressee('\n@ai 訳して')).toBeNull();
	});
});

describe('rowAddressee', () => {
	it('1行だけで宛先から始まる定型文は、選ぶと出す', () => {
		expect(rowAddressee('@ai 訳して\n')).toEqual({ ai: true, line: '@ai 訳して' });
		expect(rowAddressee('@sh sort')).toEqual({ ai: false, line: '@sh sort' });
	});

	it('2行目から下に中身のある文、宛先の無い文、実行するものの無い行は、挿入する', () => {
		expect(rowAddressee('@sh sort\nb\na')).toBeNull();
		expect(rowAddressee('お疲れさまです。')).toBeNull();
		expect(rowAddressee('@all')).toBeNull();
		expect(rowAddressee('@ai')).toBeNull();
	});
});

describe('宛先の候補', () => {
	it('@ai と @sh を出す', () => {
		expect(ADDRESS_CANDIDATES.map((candidate) => candidate.address)).toEqual(['@ai', '@sh']);
	});

	it('テキストの先頭が @ で、カーソルが1行目の行末にあるときだけ、打った文字を返す', () => {
		expect(typedAddress('@a', 2)).toBe('@a');
		expect(typedAddress('@a\n本文', 2)).toBe('@a');
		expect(typedAddress('@a\n本文', 1)).toBeNull();
		expect(typedAddress('@a\n本文', 5)).toBeNull();
		expect(typedAddress('本文 @a', 5)).toBeNull();
	});

	it('打った文字から始まる候補に絞り、大文字と小文字は区別しない', () => {
		const addresses = (typed: string) =>
			matchingAddresses(ADDRESS_CANDIDATES, typed).map((candidate) => candidate.address);
		expect(addresses('@')).toEqual(['@ai', '@sh']);
		expect(addresses('@A')).toEqual(['@ai']);
		expect(addresses('@s')).toEqual(['@sh']);
	});

	it('打った文字が候補そのものになったら、候補を出さない。指示を打ち始めた後も出さない', () => {
		expect(matchingAddresses(ADDRESS_CANDIDATES, '@sh')).toEqual([]);
		expect(matchingAddresses(ADDRESS_CANDIDATES, '@ai 訳して')).toEqual([]);
		expect(matchingAddresses(ADDRESS_CANDIDATES, '@tanaka')).toEqual([]);
	});

	it('続けて打てるよう空白を添えて入れる', () => {
		expect(completedAddress({ address: '@ai', kind: 'ai' })).toBe('@ai ');
	});
});
