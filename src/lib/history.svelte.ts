/**
 * 下書きの履歴。コピーして隠した下書きを覚え、履歴の本文は Rust 側でディスクにも保存する。
 */

import { hasNoModifiers, isImeKey } from '#lib/keys.ts';
import { CONSTANTS } from '#lib/bindings/constants.ts';
import { historyItems, type HistoryItem } from '#lib/history-search.ts';

/** 件数の既定値と上限。決めるのも収めるのも Rust 側（config.rs）で、ここは入力欄の max と設定が届く前に使う */
export const DEFAULT_DRAFT_HISTORY_SIZE: number = CONSTANTS.DEFAULT_DRAFT_HISTORY_SIZE;
export const MAX_DRAFT_HISTORY_SIZE: number = CONSTANTS.MAX_DRAFT_HISTORY_SIZE;

export class DraftHistory {
	// 下書きの前・次のボタンの出し方と押せるかを追えるよう、件数と位置は $state で持つ。
	// 一覧は何千件にもなるので、要素ごとに追う深い $state にせず、変えるたびに配列ごと入れ替える。
	// 深く追うと、上限で古いものを落とすたびに全要素の書き換えを知らせることになる
	/** 古いものから順に並べる */
	#entries = $state.raw<string[]>([]);
	/** たどっている位置。たどっていなければ null */
	#index = $state<number | null>(null);
	/** 履歴を出す前に打っていた内容。下キーで最後まで戻ったときに入力欄へ戻す */
	#draft = '';
	#size: number;
	/** 読み直している間に覚えた履歴。読み直していなければ null */
	#recordedWhileReloading: string[] | null = null;
	/** たどり終えたら入れ替える、読み直した履歴。無ければ null */
	#reloaded: string[] | null = null;
	/** 消して、まだ保存していない本文。保存するときに Rust 側へ渡し、ほかのデバイスの履歴からも戻らないようにする */
	#deleted: string[] = [];

	constructor(size = DEFAULT_DRAFT_HISTORY_SIZE) {
		this.#size = size;
	}

	/** 覚えている履歴があるか */
	get hasEntries(): boolean {
		return this.#entries.length > 0;
	}

	/** 履歴をたどっている途中か。入力欄には呼び出した履歴がそのまま出ている（書き換えるとたどるのをやめるため） */
	get isBrowsing(): boolean {
		return this.#index !== null;
	}

	/** 1つ古い履歴へ移れるか。たどっていなければ、覚えている履歴があれば移れる */
	get canGoOlder(): boolean {
		return this.#index === null ? this.#entries.length > 0 : this.#index > 0;
	}

	/** 1つ新しい方へ移れるか。たどっている途中なら、いちばん新しい履歴の先（打っていた内容）まで移れる */
	get canGoNewer(): boolean {
		return this.#index !== null;
	}

	/** 件数を変える。減らしたら、その場で古いものから忘れる */
	resize(size: number): boolean {
		const changed = this.#size !== size || this.#entries.length > size;
		this.#size = size;
		if (this.#entries.length > size) {
			// 位置がずれるので、たどっている途中ならやめる
			this.#entries = this.#entries.slice(this.#entries.length - size);
			this.stopBrowsing();
		}
		return changed;
	}

	/** コピーした下書きを覚える。直前に覚えたものと同じなら足さない */
	record(text: string): boolean {
		this.stopBrowsing();
		if (this.#size === 0 || this.#entries.at(-1) === text) return false;
		const entries = [...this.#entries, text];
		this.#entries = entries.length > this.#size ? entries.slice(1) : entries;
		this.#recordedWhileReloading?.push(text);
		return true;
	}

	/**
	 * 入力欄を空から始めるときに、書きかけを覚える。たどっている途中なら、入力欄に出ているのは覚えている履歴なので、
	 * たどり始める前に打っていた内容を覚える。空白だけのものは覚えない。覚えて保存が要るかを返す
	 */
	setAside(current: string): boolean {
		const draft = this.#index === null ? current : this.#draft;
		this.stopBrowsing();
		return draft.trim() !== '' && this.record(draft);
	}

	/**
	 * 出している履歴を消す。同じ本文はすべて消し、たどるのをやめる。たどり始める前に打っていた内容を返す
	 * （入力欄をそれに戻す）。たどっていなければ null
	 */
	delete(): string | null {
		if (this.#index === null) return null;
		const text = this.#entries[this.#index];
		const draft = this.#draft;
		const without = (entries: string[]) => entries.filter((entry) => entry !== text);
		this.#entries = without(this.#entries);
		if (this.#reloaded) this.#reloaded = without(this.#reloaded);
		if (this.#recordedWhileReloading)
			this.#recordedWhileReloading = without(this.#recordedWhileReloading);
		this.#deleted.push(text);
		this.stopBrowsing();
		return draft;
	}

	/** 消して、まだ保存していない本文を取り出す。保存に失敗したら restoreDeleted で戻す */
	takeDeleted(): string[] {
		const deleted = this.#deleted;
		this.#deleted = [];
		return deleted;
	}

	restoreDeleted(deleted: string[]) {
		this.#deleted = [...deleted, ...this.#deleted];
	}

	/** ほかのデバイスの履歴を混ぜて替わった履歴を読み直している途中か。途中の一覧は古いので、保存しない */
	get isReloading(): boolean {
		return this.#recordedWhileReloading !== null;
	}

	/** ほかのデバイスの履歴を混ぜて替わった履歴の読み直しを始める */
	beginReload() {
		this.#recordedWhileReloading ??= [];
	}

	/** 読み直せなかった。今の一覧のまま続ける */
	cancelReload() {
		this.#recordedWhileReloading = null;
	}

	/**
	 * 読み直した履歴に入れ替える。読み直している間に覚えたものは、新しい方として後ろに残す。
	 * たどっている途中なら、出している履歴の位置がずれないよう、たどり終えてから入れ替える。
	 * 読み直している間に覚えたものがあって、保存が要るかを返す
	 */
	finishReload(entries: string[]): boolean {
		const recorded = this.#recordedWhileReloading ?? [];
		this.#recordedWhileReloading = null;
		// 消してまだ保存していない本文は、読み直した履歴に残っているので除く。消した後に覚え直した分（recorded）は残す
		this.#reloaded = [...entries.filter((entry) => !this.#deleted.includes(entry)), ...recorded];
		if (this.#index === null) this.#applyReloaded();
		return recorded.length > 0;
	}

	#applyReloaded() {
		if (this.#reloaded === null) return;
		this.#entries = this.#fit(this.#reloaded);
		this.#reloaded = null;
	}

	/** 続けて同じ内容が並ばないようにし、件数を超えた分を古いものから除く */
	#fit(entries: string[]): string[] {
		const fitted: string[] = [];
		for (const entry of entries) {
			if (fitted.at(-1) !== entry) fitted.push(entry);
		}
		if (fitted.length > this.#size) fitted.splice(0, fitted.length - this.#size);
		return fitted;
	}

	/** ディスクから読んだ履歴を入れる。読み込み前に record されたものは新しい方として後ろに残す */
	load(entries: string[]) {
		this.#entries = this.#fit([...entries, ...this.#entries]);
		this.stopBrowsing();
	}

	/** 履歴をすべて消す */
	clear() {
		this.#entries = [];
		// 消す前に読み直した履歴と、消す前に覚えた履歴は、戻さない
		this.#reloaded = null;
		if (this.#recordedWhileReloading !== null) this.#recordedWhileReloading = [];
		this.stopBrowsing();
	}

	/**
	 * 保存する履歴。古いものから順に返す。たどり終えるのを待っている読み直した履歴があれば、そちらを返す。
	 * たどっている間の一覧は読み直す前のもので、保存すると、ほかのデバイスから届いた履歴を古い一覧で上書きする
	 */
	get entries(): string[] {
		return this.#fit(this.#reloaded ?? this.#entries);
	}

	/** 1つ古い履歴を返す。それより古いものがなければ null。たどり始めるときは、今の入力欄の中身を覚えておく */
	older(current: string): string | null {
		if (this.#index === null) {
			if (this.#entries.length === 0) return null;
			this.#draft = current;
			this.#index = this.#entries.length - 1;
		} else if (this.#index === 0) {
			return null;
		} else {
			this.#index--;
		}
		return this.#entries[this.#index];
	}

	/** 1つ新しい履歴を返す。いちばん新しいものの先では、たどり始める前の内容を返してたどるのをやめる。たどっていなければ null */
	newer(): string | null {
		if (this.#index === null) return null;
		if (this.#index === this.#entries.length - 1) {
			const draft = this.#draft;
			this.stopBrowsing();
			return draft;
		}
		this.#index++;
		return this.#entries[this.#index];
	}

	/** 検索の一覧に出す履歴（historyItems）。一覧で打つたびに作り直さないよう、履歴が変わったときだけ求める */
	readonly searchItems: HistoryItem[] = $derived(historyItems(this.#entries));

	/**
	 * 検索の一覧で選んだ履歴へ移る。上下キーで出したときと同じく、たどり始めるときは今の入力欄の中身を覚えておき、
	 * そこから上下キーで前後の履歴へ移れる。位置が一覧の外なら null
	 */
	jump(index: number, current: string): string | null {
		const entry = this.#entries[index];
		if (entry === undefined) return null;
		if (this.#index === null) this.#draft = current;
		this.#index = index;
		return entry;
	}

	/** たどるのをやめる。出した履歴を書き換えたときは、書き換えた内容を今の書きかけとして扱う */
	stopBrowsing() {
		this.#index = null;
		this.#draft = '';
		this.#applyReloaded();
	}
}

export type HistoryDirection = 'older' | 'newer';

/** 履歴を移るキーか。修飾キーを押しているときと、IME の変換中は対象外にする */
export function historyDirection(
	event: Pick<
		KeyboardEvent,
		'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'
	>
): HistoryDirection | null {
	if (isImeKey(event) || !hasNoModifiers(event)) return null;
	if (event.key === 'ArrowUp') return 'older';
	if (event.key === 'ArrowDown') return 'newer';
	return null;
}
