import type { ClientInit, HandleClientError } from '@sveltejs/kit';
import { error as logError } from '@tauri-apps/plugin-log';
import { describeError } from '$lib/errors';
import { initSettings } from '$lib/settings.svelte';

// 画面側で起きた想定外のエラーも、Rust 側と同じログファイルに残す
function report(context: string, error: unknown) {
	// ログの送信自体の失敗を unhandledrejection で拾うと、送信を繰り返してしまうので握りつぶす
	logError(`${context}: ${describeError(error)}`).catch(() => {});
}

export const init: ClientInit = async () => {
	window.addEventListener('error', (event) =>
		report('uncaught error', event.error ?? event.message)
	);
	window.addEventListener('unhandledrejection', (event) =>
		report('unhandled rejection', event.reason)
	);
	// CSP（tauri.conf.json）に止められた読み込みは画面が黙って崩れるだけなので、ログに残す。
	// 止められた中身の抜粋（sample）は下書きを含みうるので書かない
	document.addEventListener('securitypolicyviolation', (event) =>
		report('CSP violation', `${event.effectiveDirective} blocked ${event.blockedURI || 'inline'}`)
	);
	// 表示言語とテーマを決めてから画面を出す
	await initSettings();
};

export const handleError: HandleClientError = ({ error, message }) => {
	report('SvelteKit error', error);
	return { message };
};
