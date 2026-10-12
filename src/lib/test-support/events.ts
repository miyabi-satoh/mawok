import type { listen } from '@tauri-apps/api/event';
import type { MockInstance } from 'vitest';

/**
 * Rust 側からのイベントが届いたことにする。モックした listen に、画面が最後に渡した name の受け口を呼ぶ
 * （前に描いた画面の受け口が残っていても、今の画面の分だけを呼ぶ）
 */
export function emit(listened: MockInstance<typeof listen>, name: string, payload?: unknown) {
	const handler = listened.mock.calls.findLast(([event]) => event === name)?.[1];
	if (!handler) throw new Error(`not listening to ${name}`);
	handler({ event: name, id: 0, payload });
}
