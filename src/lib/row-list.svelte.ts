import { untrack } from 'svelte';
import { reorder } from '$lib/reorder';
import { coalescedSaver } from '$lib/saver';

/** 一覧の1行。key は画面の要素を保つためだけに使い、設定の id は Rust 側へ渡す。 */
export type Row<T> = T & { key: string };

function withId<T extends object>(item: T): Row<T> {
	return { ...item, key: crypto.randomUUID() };
}

/**
 * 設定画面で編集する一覧（置き換え辞書・定型文・アクション）。
 * 打っている途中に Rust 側からの反映で打ち消されないよう、最初の1回だけ写して以降は画面側が持ち主になる。
 * 変えるたびに save で行を丸ごと保存する。
 * 欄がすべて空の行（isBlank）は、足した直後の書きかけとして保存はするが、溜めない。
 * 「追加」は空の行が残っていればそれを使い、写すときと dropBlanks で捨てる
 */
export class RowList<T extends { id: string }> {
	rows = $state<Row<T>[]>([]);
	/** 行を変えたら呼ぶ。保存が重なっても古い内容で上書きしない（coalescedSaver） */
	readonly save: () => Promise<void>;
	readonly #isBlank: (item: T) => boolean;
	/** 写してから画面で変えたか。変えていなければ、写し直しても打った内容を消さない */
	#edited = false;
	/** 保存を Rust 側へ送って、答えを待っているか */
	#saving = false;
	readonly #save: () => Promise<void>;

	constructor(
		items: T[],
		save: (rows: Row<T>[]) => Promise<T[] | undefined>,
		isBlank: (item: T) => boolean
	) {
		this.#isBlank = isBlank;
		// 前に開いたときに足したまま閉じた空の行は、写さない。次に保存したときに設定からも消える
		this.rows = items.filter((item) => !isBlank(item)).map(withId);
		const saver = coalescedSaver(async () => {
			const submitted = this.rows.map((row) => ({ ...row }));
			this.#saving = true;
			const saved = await save(submitted).finally(() => (this.#saving = false));
			if (!saved) return;
			for (const [index, item] of saved.entries()) {
				const row = this.rows.find((current) => current.key === submitted[index]?.key);
				if (row) row.id = item.id;
			}
		});
		this.#save = saver;
		this.save = () => {
			this.#edited = true;
			return saver();
		};
	}

	/**
	 * まだ画面で変えていなければ、Rust 側の今の中身を写し直す。保存はしない。
	 * 同じ設定 ID の行は key を引き継ぐ。開いている行は key で覚えているので、作り直すと閉じてしまう。
	 * force は、画面で変えていても写し直す（同期で届いた行を入れるとき。入れないと、次の保存が届いた行を画面の古い並びで消す）
	 */
	recopy(items: T[], force = false) {
		if (this.#edited && !force) return;
		// 呼び出し元の effect が、行の並びの変化で走り直さないよう、今の行は追わずに読む
		const previous = untrack(() => this.rows);
		const keyOf = (item: T) => previous.find((row) => row.id !== '' && row.id === item.id)?.key;
		// 設定 ID で引き継ぐ key を先に押さえる。途中に行が差し込まれると、位置で引き継ぐ行が同じ key を取ろうとする
		const used = items.map(keyOf).filter((key) => key !== undefined);
		this.rows = items
			// 画面に出ている書きかけの空の行は、足した直後に写し直しても残す
			.filter((item) => !this.#isBlank(item) || (force && keyOf(item) !== undefined))
			.map((item, index) => {
				// 届いた行を入れるときは、足した直後でまだ設定 ID の無い行の key を別の行に渡さない
				// （開いた状態やフォーカスが、届いた行へ移る）
				const byPosition = force && previous[index]?.id === '' ? undefined : previous[index]?.key;
				const key =
					keyOf(item) ?? (byPosition && !used.includes(byPosition) ? byPosition : undefined);
				if (!key) return withId(item);
				used.push(key);
				return { ...item, key };
			});
		// 答えを待っている保存は、写し直す前の並びを送っている。それが後から届いて届いた行を消さないよう、写した並びを保存し直す
		if (force && this.#saving) void this.#save();
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
