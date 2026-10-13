import { aiInstruction, shCommand } from '$lib/addressee';
import { CONSTANTS } from '$lib/bindings/constants';

/** コマンドの行で、下書きに置き換える印 */
export const TEXT_MARK = CONSTANTS.TEXT_MARK;

/**
 * Windows で、`!` と `^` が cmd の遅延展開で特別な意味を持つ行か。`{{t}}` のある `@sh` の行だけが遅延展開で動く（docs/actions.md「コマンド」）。
 * 変わった結果が終了コード 0 で返り、失敗の帯では気づけないので、設定の欄の下で知らせる
 */
export function hasDelayedExpansionChars(line: string): boolean {
	const command = aiInstruction(line) === null ? shCommand(line) : null;
	return command !== null && command.includes(TEXT_MARK) && /[!^]/.test(command);
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
