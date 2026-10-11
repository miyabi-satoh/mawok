/**
 * 下書きの履歴。コピーして隠した下書きを覚え、履歴の本文は Rust 側でディスクにも保存する。
 * 他のデバイスから届いた下書きはここへ record しない。
 */

import { hasNoModifiers, isImeKey } from '$lib/keys';
import { CONSTANTS } from '$lib/bindings/constants';

/** 件数の既定値と上限。決めるのも収めるのも Rust 側（config.rs）で、ここは入力欄の max と設定が届く前に使う */
export const DEFAULT_DRAFT_HISTORY_SIZE: number = CONSTANTS.DEFAULT_DRAFT_HISTORY_SIZE;
export const MAX_DRAFT_HISTORY_SIZE: number = CONSTANTS.MAX_DRAFT_HISTORY_SIZE;

export class DraftHistory {
	// 下書きの前・次のボタンの出し方と押せるかを追えるよう、件数と位置は $state で持つ
	/** 古いものから順に並べる */
	#entries = $state<string[]>([]);
	/** たどっている位置。たどっていなければ null */
	#index = $state<number | null>(null);
	/** 履歴を出す前に打っていた内容。下キーで最後まで戻ったときに入力欄へ戻す */
	#draft = '';
	#size: number;
	/** 読み直している間に覚えた履歴。読み直していなければ null */
	#recordedWhileReloading: string[] | null = null;
	/** たどり終えたら入れ替える、読み直した履歴。無ければ null */
	#reloaded: string[] | null = null;

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
			this.#entries.splice(0, this.#entries.length - size);
			this.stopBrowsing();
		}
		return changed;
	}

	/** コピーした下書きを覚える。直前に覚えたものと同じなら足さない */
	record(text: string): boolean {
		this.stopBrowsing();
		if (this.#size === 0 || this.#entries.at(-1) === text) return false;
		this.#entries.push(text);
		if (this.#entries.length > this.#size) this.#entries.shift();
		this.#recordedWhileReloading?.push(text);
		return true;
	}

	/** 同期で替わった履歴を読み直している途中か。途中の一覧は古いので、保存しない */
	get isReloading(): boolean {
		return this.#recordedWhileReloading !== null;
	}

	/** 同期で替わった履歴の読み直しを始める */
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
		this.#reloaded = [...entries, ...recorded];
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
	 * たどっている間の一覧は読み直す前のもので、保存すると、同期で届いた履歴を古い一覧で上書きする
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
