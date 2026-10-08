/**
 * 下書きの履歴。コピーして隠した下書きを覚え、履歴の本文は Rust 側でディスクにも保存する。
 * 他の機器から届いた下書きはここへ record しない。
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
		return true;
	}

	/** ディスクから読んだ履歴を入れる。読み込み前に record されたものは新しい方として後ろに残す */
	load(entries: string[]) {
		const current = this.#entries;
		this.#entries = [];
		for (const entry of [...entries, ...current]) {
			if (this.#entries.at(-1) !== entry) this.#entries.push(entry);
		}
		if (this.#entries.length > this.#size) {
			this.#entries.splice(0, this.#entries.length - this.#size);
		}
		this.stopBrowsing();
	}

	/** 履歴をすべて消す */
	clear() {
		this.#entries = [];
		this.stopBrowsing();
	}

	/** 保存する履歴。古いものから順に返す */
	get entries(): string[] {
		return [...this.#entries];
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
