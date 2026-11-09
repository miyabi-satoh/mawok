/**
 * 変更のたびにすぐ保存する役を作る。待ってからまとめて保存すると、待っている間にウィンドウを閉じたときに落ちるため。
 * 保存が重なると古い内容で上書きしかねないので、走っている間に変わったら、終わってからもう一度保存する。
 * 保存に限らず、重ねて走らせると結果の順が崩れる処理（置き換えのハイライトの更新など）にも使う。
 * 返す Promise は、走っている保存し直しまで終わると解ける。窓を閉じる前に、保存し終えるのを待てるようにするため
 */
export function coalescedSaver(save: () => Promise<unknown>) {
	let running: Promise<void> | null = null;
	let changedWhileSaving = false;
	return (): Promise<void> => {
		if (running) {
			changedWhileSaving = true;
			return running;
		}
		running = (async () => {
			try {
				do {
					changedWhileSaving = false;
					await save();
				} while (changedWhileSaving);
			} finally {
				running = null;
			}
		})();
		return running;
	};
}
