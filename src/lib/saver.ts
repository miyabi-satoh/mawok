/**
 * 変更のたびにすぐ保存する役を作る。待ってからまとめて保存すると、待っている間にウィンドウを閉じたときに落ちるため。
 * 保存が重なると古い内容で上書きしかねないので、走っている間に変わったら、終わってからもう一度保存する。
 * 保存に限らず、重ねて走らせると結果の順が崩れる処理（届いた下書きの受け取りなど）にも使う
 */
export function coalescedSaver(save: () => Promise<unknown>) {
	let saving = false;
	let changedWhileSaving = false;
	return async () => {
		if (saving) {
			changedWhileSaving = true;
			return;
		}
		saving = true;
		try {
			do {
				changedWhileSaving = false;
				await save();
			} while (changedWhileSaving);
		} finally {
			saving = false;
		}
	};
}
