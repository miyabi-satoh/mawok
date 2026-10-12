import { untrack } from 'svelte';

/**
 * 開くたびに読み直すダイアログの、読み込みの段取り。開いたら load を呼び、
 * 閉じた後や読み直した後に届いた前の答えを、通し番号で見分けて捨てさせる。
 * 中で $effect を使うので、部品を作るときに作る
 */
export class OpenLoader {
	#loads = 0;

	constructor(isOpen: () => boolean, load: () => unknown) {
		// 開くのは呼んだ側なので、開いたことはここで見て読みに行く
		$effect(() => {
			if (isOpen()) untrack(() => void load());
			else this.#loads++;
		});
	}

	/** 読み込みを始める。返した関数は、その読み込みの答えをまだ使ってよいか（その後に読み直しておらず、閉じてもいないか）を返す */
	begin(): () => boolean {
		const load = ++this.#loads;
		return () => load === this.#loads;
	}
}
