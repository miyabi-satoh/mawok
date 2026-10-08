import { untrack } from 'svelte';
import { reorder } from '$lib/reorder';
import { coalescedSaver } from '$lib/saver';

/** 一覧の1行。id は each の key に使うだけで、Rust 側へは渡さない */
export type Row<T> = T & { id: string };

function withId<T extends object>(item: T): Row<T> {
	return { ...item, id: crypto.randomUUID() };
}

/**
 * 設定画面で編集する一覧（置き換え辞書・定型文・アクション）。
 * 打っている途中に Rust 側からの反映で打ち消されないよう、最初の1回だけ写して以降は画面側が持ち主になる。
 * 変えるたびに save で行を丸ごと保存する。
 * 欄がすべて空の行（isBlank）は、足した直後の書きかけとして保存はするが、溜めない。
 * 「追加」は空の行が残っていればそれを使い、写すときと dropBlanks で捨てる
 */
export class RowList<T extends object> {
	rows = $state<Row<T>[]>([]);
	/** 行を変えたら呼ぶ。保存が重なっても古い内容で上書きしない（coalescedSaver） */
	readonly save: () => Promise<void>;
	readonly #isBlank: (item: T) => boolean;
	/** 写してから画面で変えたか。変えていなければ、写し直しても打った内容を消さない */
	#edited = false;

	constructor(
		items: T[],
		save: (rows: Row<T>[]) => Promise<unknown>,
		isBlank: (item: T) => boolean
	) {
		this.#isBlank = isBlank;
		// 前に開いたときに足したまま閉じた空の行は、写さない。次に保存したときに設定からも消える
		this.rows = items.filter((item) => !isBlank(item)).map(withId);
		const saver = coalescedSaver(() => save(this.rows));
		this.save = () => {
			this.#edited = true;
			return saver();
		};
	}

	/**
	 * まだ画面で変えていなければ、Rust 側の今の中身を写し直す。保存はしない。
	 * 同じ位置の行は id を引き継ぐ。開いている行は id で覚えているので、作り直すと閉じてしまう
	 */
	recopy(items: T[]) {
		if (this.#edited) return;
		// 呼び出し元の effect が、行の並びの変化で走り直さないよう、今の行は追わずに読む
		const ids = untrack(() => this.rows.map((row) => row.id));
		this.rows = items
			.filter((item) => !this.#isBlank(item))
			.map((item, i) => {
				const id = ids[i];
				return id ? { ...item, id } : withId(item);
			});
	}

	/** 行を末尾に足し、足した行を返す */
	add(...items: T[]): Row<T>[] {
		const rows = items.map(withId);
		this.rows.push(...rows);
		this.save();
		return this.rows.slice(-rows.length);
	}

	/** 書くための空の行を返す。空の行が残っていればそれを、無ければ末尾に足した行を返す */
	addBlank(blank: T): Row<T> {
		const existing = this.rows.find((row) => this.#isBlank(row));
		if (existing) return existing;
		const [row] = this.add(blank);
		return row;
	}

	/** 欄がすべて空の行を捨てる。書きかけでない行は残す */
	dropBlanks() {
		if (!this.rows.some((row) => this.#isBlank(row))) return;
		this.rows = this.rows.filter((row) => !this.#isBlank(row));
		this.save();
	}

	remove(index: number) {
		this.rows.splice(index, 1);
		this.save();
	}

	/** 行を from から to へ動かす（「…」メニューの移動用）。端を越える指定は何もしない */
	move(from: number, to: number) {
		const next = reorder(this.rows, from, to);
		if (next === this.rows) return;
		this.rows = next;
		this.save();
	}

	/** ドラッグ中の並び（svelte-dnd-action の consider）。確定まで保存はしない */
	consider(rows: Row<T>[]) {
		this.rows = rows;
	}

	/** ドラッグの確定（svelte-dnd-action の finalize）。並びを確定して保存する */
	finalize(rows: Row<T>[]) {
		this.rows = rows;
		this.save();
	}
}
