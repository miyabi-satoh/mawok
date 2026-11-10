/**
 * 呼ぶたびにすぐ走らせ、重ならないようにする役を作る。設定の保存のように、変更のたびにすぐ保存したいものに使う
 * （待ってからまとめると、待っている間にウィンドウを閉じたときに落ちるため）。
 * 重ねて走らせると古い内容で上書きしたり結果の順が崩れたりするので、走っている間に呼ばれたら、終わってからもう一度だけ走らせる。
 * 返す Promise は、走っている分ともう一度の分まで終わると解ける。窓を閉じる前に、保存し終えるのを待てるようにするため
 */
export function coalesced(run: () => Promise<unknown>) {
	let running: Promise<void> | null = null;
	let calledWhileRunning = false;
	return (): Promise<void> => {
		if (running) {
			calledWhileRunning = true;
			return running;
		}
		running = (async () => {
			try {
				do {
					calledWhileRunning = false;
					await run();
				} while (calledWhileRunning);
			} finally {
				running = null;
			}
		})();
		return running;
	};
}
