import { CONSTANTS } from '$lib/bindings/constants';
import { keyedDeviceName } from '$lib/devices';
import type { Device } from '$lib/settings.svelte';

/** 残りを指示文として AI サービスへ送る宛先 */
const AI = CONSTANTS.AI_PREFIX;
/** 残りをコマンドとして、その機のシェルで実行する宛先 */
const SH = CONSTANTS.SH_PREFIX;
/** つないだすべてのデバイスへ送る宛先 */
const ALL = CONSTANTS.ALL_DEVICES;

/**
 * 行頭が宛先 `prefix` なら、その後ろ（前後の空白を除く）を返す。宛先の直後は空白か行の終わりに限る。
 * 大文字と小文字は区別しない（src-tauri/src/actions.rs の addressed と揃える）
 */
function addressed(line: string, prefix: string): string | null {
	const head = line.trimStart();
	if (head.slice(0, prefix.length).toLowerCase() !== prefix) return null;
	const rest = head.slice(prefix.length);
	return rest === '' || /^\s/.test(rest) ? rest.trim() : null;
}

/** 行頭が `@ai` なら、その後ろの指示文。AI の行でなければ null */
export function aiInstruction(line: string): string | null {
	return addressed(line, AI);
}

/** 行頭が `@sh` なら、その後ろのコマンド。シェルの行でなければ null */
export function shCommand(line: string): string | null {
	return addressed(line, SH);
}

/** 1行目の宛先が指す先（docs/actions.md「宛先」） */
export type Addressee =
	/** AI かシェルで実行する。`line` は Rust 側へそのまま渡す1行目 */
	| { kind: 'run'; ai: boolean; line: string }
	/** デバイスへ送る。つないだデバイスが無い `@all` は空 */
	| { kind: 'devices'; publicKeys: string[] };

/** テキストを、1行目と、2行目から下に分ける。1行だけなら下は空 */
export function splitFirstLine(text: string): { line: string; rest: string } {
	const end = text.indexOf('\n');
	if (end < 0) return { line: text, rest: '' };
	return { line: text.slice(0, end).replace(/\r$/, ''), rest: text.slice(end + 1) };
}

/**
 * 宛先に書くデバイスの名前（公開鍵ごと）。`@ai`・`@sh`・`@all` として読まれてしまう名前と、
 * ほかのデバイスと重なる名前には、公開鍵の先頭を添える。
 * 宛先は大文字と小文字を区別せずに受けるので、どちらも小文字にして見る
 */
function deviceAddresses(devices: Device[]): Map<string, string> {
	const reserved = (name: string) => {
		const line = `@${name}`;
		return aiInstruction(line) !== null || shCommand(line) !== null || line === ALL;
	};
	const counts = new Map<string, number>();
	for (const device of devices) {
		const name = device.name.toLowerCase();
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return new Map(
		devices.map((device) => {
			const name = device.name.toLowerCase();
			const keyed = reserved(name) || (counts.get(name) ?? 0) > 1;
			return [device.publicKey, `@${keyed ? keyedDeviceName(device) : device.name}`];
		})
	);
}

/**
 * 1行目が宛先なら、その先を返す。宛先でなければ null（ふつうの文として扱う）。
 * デバイスの名前は、候補から入る名前そのままだけを受ける（大文字と小文字は区別しない）。途中までの名前では送らない
 */
export function resolveAddressee(line: string, devices: Device[]): Addressee | null {
	const name = line.trim().toLowerCase();
	// デバイスを先に見る。`Sh Phone (ab12)` のように、公開鍵の先頭を添えた名前が `@sh` の行としても読めるため
	const match = [...deviceAddresses(devices)].find(([, address]) => address.toLowerCase() === name);
	if (match) return { kind: 'devices', publicKeys: [match[0]] };
	if (aiInstruction(line) !== null) return { kind: 'run', ai: true, line };
	if (shCommand(line) !== null) return { kind: 'run', ai: false, line };
	return name === ALL ? { kind: 'devices', publicKeys: devices.map((d) => d.publicKey) } : null;
}

/** 実行するものがあるか。`@ai`・`@sh` だけで後ろが空の行は実行しない */
export function isRunnable(line: string): boolean {
	return (aiInstruction(line) ?? shCommand(line) ?? '') !== '';
}

/**
 * 登録した定型文が、選ぶと出すものか。本文が1行だけで宛先から始まるものは、今のテキストを中身にして出す。
 * 2行目から下に中身まで書いてある文は、そのまま出せる書きかけなので挿入する（docs/actions.md「定型文」）
 */
export function rowAddressee(body: string, devices: Device[]): Addressee | null {
	const line = body.trim();
	if (line.includes('\n')) return null;
	const addressee = resolveAddressee(line, devices);
	if (addressee?.kind === 'run' && !isRunnable(line)) return null;
	return addressee;
}

/** 宛先の候補の1件。`address` は1行目に入れる文字（`@ai` など） */
export type AddressCandidate = {
	address: string;
	kind: 'ai' | 'sh' | 'all' | 'device';
};

/** 宛先の候補。`@all` は、つないだデバイスがあるときだけ出す */
export function addressCandidates(devices: Device[]): AddressCandidate[] {
	return [
		{ address: AI, kind: 'ai' },
		{ address: SH, kind: 'sh' },
		...(devices.length > 0 ? [{ address: ALL, kind: 'all' } as const] : []),
		...[...deviceAddresses(devices).values()].map((address) => ({
			address,
			kind: 'device' as const
		}))
	];
}

/**
 * 宛先を打っている途中なら、行頭の `@` からカーソルまでの文字。打っていなければ null。
 * 候補を出すのは、テキストの先頭が `@` で、カーソルが1行目の行末にあるときだけ。
 * 本文の途中の `@`（メールアドレスや、チャット向けの宛名）では出さない
 */
export function typedAddress(text: string, caret: number): string | null {
	if (!text.startsWith('@')) return null;
	const { line } = splitFirstLine(text);
	return caret === line.length ? line : null;
}

/**
 * 打った文字から始まる候補。打った文字が候補そのものになったら、入れるものが無いので出さない
 */
export function matchingAddresses(
	candidates: AddressCandidate[],
	typed: string
): AddressCandidate[] {
	const head = typed.toLowerCase();
	const matches = candidates.filter((candidate) =>
		candidate.address.toLowerCase().startsWith(head)
	);
	return matches.length === 1 && matches[0].address.toLowerCase() === head ? [] : matches;
}

/** 候補を選んだ後の1行目。`@ai`・`@sh` は、続けて指示やコマンドを打てるよう空白を添える */
export function completedAddress(candidate: AddressCandidate): string {
	return candidate.kind === 'ai' || candidate.kind === 'sh'
		? `${candidate.address} `
		: candidate.address;
}
