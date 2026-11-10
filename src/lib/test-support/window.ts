/**
 * @tauri-apps/api/window のモック。テストの中では Tauri の窓が無いので、閉じる前の受け口を覚えておき、
 * closeRequested で閉じるボタンが押されたことにする
 */
type CloseHandler = () => Promise<void> | void;

let closeHandler: CloseHandler | null = null;

export const windowModule = {
	getCurrentWindow: () => ({
		onCloseRequested: (handler: CloseHandler) => {
			closeHandler = handler;
			return Promise.resolve(() => {
				if (closeHandler === handler) closeHandler = null;
			});
		}
	})
};

/** 窓を閉じようとしたことにして、画面の受け口が終わるのを待つ */
export async function closeRequested() {
	if (!closeHandler) throw new Error('not listening to close requested');
	await closeHandler();
}
