import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { actionErrorMessage } from './action-errors';

describe('actionErrorMessage', () => {
	it('アクションの失敗の符号を、何をすればよいかの案内にする', () => {
		expect(actionErrorMessage('action.invalid_key')).toBe(m.action_error_invalid_key());
		expect(actionErrorMessage('action.cancelled')).toBe(m.action_error_cancelled());
	});

	it('符号でなければ null を返す', () => {
		expect(actionErrorMessage('the key is empty')).toBeNull();
		expect(actionErrorMessage('toString')).toBeNull();
	});

	it('{ code, detail } の形（Rust 側の ActionFailure）でも、符号から案内を引ける', () => {
		expect(actionErrorMessage({ code: 'action.invalid_key', detail: null })).toBe(
			m.action_error_invalid_key()
		);
	});

	it('detail があれば、案内の末尾に添える', () => {
		expect(actionErrorMessage({ code: 'action.rejected', detail: 'API key not valid.' })).toBe(
			m.action_error_rejected() + m.action_error_detail({ detail: 'API key not valid.' })
		);
	});

	it('detail が無ければ、案内だけを返す（末尾に何も添えない）', () => {
		expect(actionErrorMessage({ code: 'action.rejected', detail: null })).toBe(
			m.action_error_rejected()
		);
	});

	it('コマンドの失敗は、終了コードを添え、標準エラーを次の行から出す', () => {
		expect(
			actionErrorMessage({ code: 'action.command_failed', detail: 'oops\nbad', exitCode: 2 })
		).toBe(`${m.action_error_command_failed({ code: 2 })}\noops\nbad`);
		expect(
			actionErrorMessage({ code: 'action.command_failed', detail: null, exitCode: null })
		).toBe(m.action_error_command_killed());
		expect(
			actionErrorMessage({ code: 'action.command_not_found', detail: 'not found', exitCode: 127 })
		).toBe(`${m.action_error_command_not_found()}\nnot found`);
		expect(actionErrorMessage('action.empty_output')).toBe(m.action_error_empty_output());
	});
});
