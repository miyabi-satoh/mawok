import type { Action } from '$lib/bindings/Action';

/** 行頭にあれば、残りを指示文として AI サービスへ送る印（src-tauri/src/actions.rs の AI_PREFIX と揃える） */
const AI_PREFIX = '@ai';
/** コマンドの行で、下書きに置き換える印（src-tauri/src/actions.rs の TEXT_MARK と揃える） */
export const TEXT_MARK = '{{t}}';

/** 新しく足すアクションの1件。結果は置き換え、文字コードは UTF-8、有効にしておく（src-tauri/src/config.rs の Default for Action と揃える） */
export function newAction(name: string, command: string): Action {
	return { name, command, output: 'replace', encoding: 'utf-8', enabled: true };
}

/**
 * 行頭が `@ai` なら、その後ろ（前後の空白を除く）の指示文を返す。AI の行でなければ null。
 * `@ai` の直後は空白か行の終わりに限る（src-tauri/src/actions.rs の ai_instruction と揃える）
 */
export function aiInstruction(command: string): string | null {
	const line = command.trimStart();
	if (!line.startsWith(AI_PREFIX)) return null;
	const rest = line.slice(AI_PREFIX.length);
	return rest === '' || /^\s/.test(rest) ? rest.trim() : null;
}

/**
 * Windows で、`!` と `^` が cmd の遅延展開で特別な意味を持つ行か。`{{t}}` のあるシェルの行だけが遅延展開で動く（docs/actions.md「コマンド」）。
 * 変わった結果が終了コード 0 で返り、失敗の帯では気づけないので、設定の欄の下で知らせる
 */
export function hasDelayedExpansionChars(command: string): boolean {
	return aiInstruction(command) === null && command.includes(TEXT_MARK) && /[!^]/.test(command);
}

/** 実行するものがあるか。空の行と、`@ai` だけで指示文が空の行は実行しない */
export function isRunnable(command: string): boolean {
	return command.trim() !== '' && aiInstruction(command) !== '';
}

/**
 * 実行する文を、前の空行・中身・後ろの空白と改行に分ける（docs/actions.md「コマンド」）。
 * 渡すのは中身だけで、分けた前後は置き換えるときに結果の前後へ戻す。戻さないと、段落を改行ごと選んで実行したときに次の段落とつながる。
 * コマンドは1行目の字下げを中身に残す。行ごとに加工するコマンドで、1行目だけ崩れないため。
 * AI は結果の前後の空白を落として返すので、前の空白は字下げも含めて分けておき、置き換えるときに戻す
 */
export function splitActionTarget(
	target: string,
	ai: boolean
): {
	leading: string;
	body: string;
	trailing: string;
} {
	const trailing = /\s*$/.exec(target)?.[0] ?? '';
	const rest = target.slice(0, target.length - trailing.length);
	const leading = (ai ? /^\s*/ : /^(?:[ \t]*\r?\n)*/).exec(rest)?.[0] ?? '';
	return { leading, body: rest.slice(leading.length), trailing };
}
