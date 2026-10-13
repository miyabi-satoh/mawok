import { describe, expect, it } from 'vitest';
import {
	addressCandidates,
	aiInstruction,
	completedAddress,
	isRunnable,
	matchingAddresses,
	resolveAddressee,
	rowAddressee,
	shCommand,
	splitFirstLine,
	typedAddress
} from './addressee';

const device = (name: string, publicKey: string) => ({
	name,
	publicKey,
	address: '',
	sendTo: true
});
const devices = [device('MacBook Air', 'ab12cd'), device('AERO-13BE', 'ef34gh')];

describe('aiInstruction・shCommand', () => {
	it('行頭の宛先の後ろを、指示文・コマンドにする', () => {
		expect(aiInstruction('@ai 丁寧に: {{t}}')).toBe('丁寧に: {{t}}');
		expect(aiInstruction('  @ai\t訳して | sort ')).toBe('訳して | sort');
		expect(aiInstruction('@ai')).toBe('');
		expect(shCommand('@sh sort | uniq')).toBe('sort | uniq');
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
		expect(splitFirstLine('@all\r\n本文')).toEqual({ line: '@all', rest: '本文' });
	});
});

describe('resolveAddressee', () => {
	it('@ai と @sh は、実行する行にする', () => {
		expect(resolveAddressee('@ai 訳して', devices)).toEqual({
			kind: 'run',
			ai: true,
			line: '@ai 訳して'
		});
		expect(resolveAddressee('@sh ls', devices)).toEqual({ kind: 'run', ai: false, line: '@sh ls' });
	});

	it('@all は、つないだデバイスの全部にする', () => {
		expect(resolveAddressee('@all', devices)).toEqual({
			kind: 'devices',
			publicKeys: ['ab12cd', 'ef34gh']
		});
		expect(resolveAddressee('@all', [])).toEqual({ kind: 'devices', publicKeys: [] });
	});

	it('デバイスの名前は、空白を含んでいても、大文字と小文字を区別せずにそのまま合うものだけを受ける', () => {
		expect(resolveAddressee('@macbook air', devices)).toEqual({
			kind: 'devices',
			publicKeys: ['ab12cd']
		});
		expect(resolveAddressee('@AERO-13BE ', devices)).toEqual({
			kind: 'devices',
			publicKeys: ['ef34gh']
		});
	});

	it('途中までの名前、知らない名前、宛先の後ろに文が続く行は、宛先ではない', () => {
		expect(resolveAddressee('@aero', devices)).toBeNull();
		expect(resolveAddressee('@tanaka ありがとう', devices)).toBeNull();
		expect(resolveAddressee('@AERO-13BE これを見て', devices)).toBeNull();
		expect(resolveAddressee('ふつうの文', devices)).toBeNull();
	});

	it('同じ名前のデバイスと、宛先の語と同じ名前のデバイスは、公開鍵の先頭を添えた名前で受ける', () => {
		const same = [device('Mac', 'ab12cd'), device('Mac', 'ef34gh'), device('all', '1234ab')];

		expect(resolveAddressee('@Mac', same)).toBeNull();
		expect(resolveAddressee('@Mac (ef34)', same)).toEqual({
			kind: 'devices',
			publicKeys: ['ef34gh']
		});
		expect(resolveAddressee('@all (1234)', same)).toEqual({
			kind: 'devices',
			publicKeys: ['1234ab']
		});
		expect(resolveAddressee('@all', same)).toEqual({
			kind: 'devices',
			publicKeys: ['ab12cd', 'ef34gh', '1234ab']
		});
	});
});

describe('rowAddressee', () => {
	it('1行だけで宛先から始まる定型文は、選ぶと出す', () => {
		expect(rowAddressee('@ai 訳して\n', devices)?.kind).toBe('run');
		expect(rowAddressee('@sh sort', devices)?.kind).toBe('run');
		expect(rowAddressee('@AERO-13BE', devices)?.kind).toBe('devices');
	});

	it('2行目から下に中身のある文、宛先の無い文、実行するものの無い行は、挿入する', () => {
		expect(rowAddressee('@sh sort\nb\na', devices)).toBeNull();
		expect(rowAddressee('お疲れさまです。', devices)).toBeNull();
		expect(rowAddressee('@ai', devices)).toBeNull();
	});
});

describe('宛先の候補', () => {
	const candidates = addressCandidates(devices);

	it('@ai・@sh・@all と、つないだデバイスを出す。デバイスが無ければ @all は出さない', () => {
		expect(candidates.map((candidate) => candidate.address)).toEqual([
			'@ai',
			'@sh',
			'@all',
			'@MacBook Air',
			'@AERO-13BE'
		]);
		expect(addressCandidates([]).map((candidate) => candidate.address)).toEqual(['@ai', '@sh']);
	});

	it('テキストの先頭が @ で、カーソルが1行目の行末にあるときだけ、打った文字を返す', () => {
		expect(typedAddress('@a', 2)).toBe('@a');
		expect(typedAddress('@a\n本文', 2)).toBe('@a');
		expect(typedAddress('@a\n本文', 1)).toBeNull();
		expect(typedAddress('@a\n本文', 5)).toBeNull();
		expect(typedAddress('本文 @a', 5)).toBeNull();
	});

	it('打った文字から始まる候補に絞り、大文字と小文字は区別しない', () => {
		expect(matchingAddresses(candidates, '@a').map((candidate) => candidate.address)).toEqual([
			'@ai',
			'@all',
			'@AERO-13BE'
		]);
		expect(matchingAddresses(candidates, '@mac').map((candidate) => candidate.address)).toEqual([
			'@MacBook Air'
		]);
	});

	it('打った文字が候補そのものになったら、候補を出さない。指示を打ち始めた後も出さない', () => {
		expect(matchingAddresses(candidates, '@sh')).toEqual([]);
		expect(matchingAddresses(candidates, '@ai 訳して')).toEqual([]);
		expect(matchingAddresses(candidates, '@tanaka')).toEqual([]);
	});

	it('@ai と @sh は、続けて打てるよう空白を添えて入れる', () => {
		expect(completedAddress({ address: '@ai', kind: 'ai' })).toBe('@ai ');
		expect(completedAddress({ address: '@AERO-13BE', kind: 'device' })).toBe('@AERO-13BE');
	});
});
