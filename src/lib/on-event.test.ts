import { listen } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';
import { onEvent } from './on-event';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('onEvent', () => {
	it('イベントの中身だけを渡し、返した関数で待ち受けをやめる', async () => {
		const unlisten = vi.fn();
		vi.mocked(listen).mockResolvedValue(unlisten);
		const handler = vi.fn();

		const stop = onEvent<string>('snippet-added', handler);
		const [name, listener] = vi.mocked(listen).mock.calls[0];
		expect(name).toBe('snippet-added');
		listener({ event: 'snippet-added', id: 0, payload: '中身' });
		expect(handler).toHaveBeenCalledWith('中身');

		stop();
		await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
	});
});
