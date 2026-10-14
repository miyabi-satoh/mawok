// Rust の依存のライセンス表示が最新か確認する (`just licenses-check`。`just ci` から呼ぶ)。
// 入力と結果が、前に作ったときの印のままなら、作り直さずに通す (scripts/rust-licenses-stamp.mjs)。
// 変わっていれば作り直し、結果か印に差分があれば、コミットし忘れとして落とす。

import { execFileSync } from 'node:child_process';
import { computeStamp, OUTPUT, readStamp, STAMP } from './rust-licenses-stamp.mjs';

const stamp = computeStamp();
if (stamp !== null && stamp === readStamp()) {
	console.log('Rust の依存のライセンス表示は、入力が変わっていないので作り直しません');
	process.exit(0);
}

const node = (args) => execFileSync(process.execPath, args, { stdio: 'inherit' });
try {
	node(['scripts/generate-rust-licenses.mjs']);
	node(['scripts/check-generated.mjs', 'licenses', OUTPUT, STAMP]);
} catch (err) {
	// 子プロセスが理由を出しているので、ここでは終了コードだけを伝える
	process.exit(err.status ?? 1);
}
