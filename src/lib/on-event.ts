import { listen } from '@tauri-apps/api/event';

/**
 * Rust 側からのイベントを待ち受け、やめる関数を返す。`$effect(() => onEvent(…))` と書けば、effect の片付けでやめる。
 * listen がやめる関数を返すのは待ち受けを始めた後なので、それを待ってからやめる
 */
export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
	const unlisten = listen<T>(name, (event) => handler(event.payload));
	return () => {
		unlisten.then((fn) => fn());
	};
}
