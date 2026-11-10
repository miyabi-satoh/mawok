import { untrack } from 'svelte';
import { reorder } from '$lib/reorder';
import { coalesced } from '$lib/coalesce';

/** 一覧の1行。key は画面の要素（開いた状態・フォーカス・ドラッグ）を保つためだけに使い、Rust 側へは渡さない。 */
export type Row<T> = T & { key: string };

function withKey<T extends object>(item: T): Row<T> {
	return { ...item, key: crypto.randomUUID() };
}

function withoutKey<T extends object>(row: Row<T>): T {
	const item: Partial<Row<T>> = { ...row };
	delete item.key;
	return item as T;
}

/** 行の欄がすべて同じか。欄はどれも文字列か真偽値なので、そのまま比べる */
function sameFields<T extends object>(row: Row<T>, item: T): boolean {
	return (Object.keys(item) as (keyof T)[]).every((field) => row[field] === item[field]);
}

/**
 * 設定画面で編集する一覧（置き換え辞書・定型文）。
 * 打っている途中に Rust 側からの反映で打ち消されないよう、最初の1回だけ写して以降は画面側が持ち主になる。
 * 変えるたびに save で行を丸ごと保存する。
 * 欄がすべて空の行（isBlank）は、足した直後の書きかけとして保存はするが、溜めない。
 * 「追加」は空の行が残っていればそれを使い、写すときと dropBlanks で捨てる。
 * 設定の行は識別子を持たないので、写し直すときは中身で前の行と結ぶ（recopy）
 */
export class RowList<T extends object> {
	rows = $state<Row<T>[]>([]);
	/** 行を変えたら呼ぶ。保存が重なっても古い内容で上書きしない（coalesced） */
	readonly save: () => Promise<void>;
	readonly #isBlank: (item: T) => boolean;
	readonly #name: (item: T) => string;
	/** 保存を Rust 側へ送って、答えを待っているか */
	#saving = false;

	/** name は行の名前（置き換える前の文字列・定型文の名前）。写し直すときに、中身の変わった行を前の行と結ぶのに使う */
	constructor(
		items: T[],
		save: (items: T[]) => Promise<unknown>,
		isBlank: (item: T) => boolean,
		name: (item: T) => string
	) {
		this.#isBlank = isBlank;
		this.#name = name;
		// 前に開いたときに足したまま閉じた空の行は、写さない。次に保存したときに設定からも消える
		this.rows = items.filter((item) => !isBlank(item)).map(withKey);
		this.save = coalesced(async () => {
			this.#saving = true;
			await save(this.rows.map(withoutKey)).finally(() => (this.#saving = false));
		});
	}

	/**
	 * Rust 側の今の中身を写し直す（ほかで設定のファイルが変わったときや、バックアップから戻したとき）。保存はしない。
	 * 画面で変えていても写す。写さないと、次の保存が届いた行を画面の古い並びで消す。
	 * 前と同じ行は key を引き継ぐ。開いている行は key で覚えているので、作り直すと閉じてしまう。
	 * 同じ行かは、まず欄がすべて同じ行、残りは名前が同じ行で見る（ほかで本文や有効かだけを変えた行も引き継ぐため）
	 */
	recopy(items: T[]) {
		// 呼び出し元の effect が、行の並びの変化で走り直さないよう、今の行は追わずに読む
		const unused = [...untrack(() => this.rows)];
		const take = (matches: (row: Row<T>) => boolean) => {
			const index = unused.findIndex(matches);
			return index === -1 ? undefined : unused.splice(index, 1)[0].key;
		};
		const keys = items.map((item) => take((row) => sameFields(row, item)));
		for (const [index, item] of items.entries()) {
			keys[index] ??= take((row) => this.#name(row) === this.#name(item));
		}
		this.rows = items
			.map((item, index) => ({ item, key: keys[index] }))
			// 画面に出ている書きかけの空の行は、足した直後に写し直しても残す
			.filter(({ item, key }) => !this.#isBlank(item) || key !== undefined)
			.map(({ item, key }) => (key ? { ...item, key } : withKey(item)));
		// 答えを待っている保存は、写し直す前の並びを送っている。それが後から届いて届いた行を消さないよう、写した並びを保存し直す
		if (this.#saving) void this.save();
	}

	/** 行を末尾に足し、足した行を返す */
	add(...items: T[]): Row<T>[] {
		const rows = items.map(withKey);
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
