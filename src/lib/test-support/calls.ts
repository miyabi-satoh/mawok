/** モックした関数（invoke など）の呼び出しのうち、最初の引数が command のもの。呼ばれた順に並ぶ */
export function callsOf<A extends unknown[]>(fn: { mock: { calls: A[] } }, command: string): A[] {
	return fn.mock.calls.filter(([first]) => first === command);
}
