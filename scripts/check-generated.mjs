// 生成物が最新か確認する (`just ci` から呼ぶ。CI が PR ごとに流す)。
// 生成し直した直後に呼び、対象に差分か未追跡のファイルがあれば、コミットし忘れとして落とす。
//
// Node で書いているのは、Windows でも実行できるようにするため (justfile の windows-shell は
// cmd.exe で、POSIX シェルの構文が使えない)。

import { execFileSync } from 'node:child_process';

const [recipe, ...targets] = process.argv.slice(2);
if (!recipe || targets.length === 0) {
	console.error('usage: node scripts/check-generated.mjs <recipe> <path>...');
	process.exit(2);
}

function hasUnstagedChanges() {
	try {
		execFileSync('git', ['diff', '--quiet', '--', ...targets], { stdio: 'ignore' });
		return false;
	} catch (err) {
		// 差分があるときの終了コードは1。それ以外は git 自体の失敗なので伝える。
		if (err.status === 1) return true;
		throw err;
	}
}

// 初めて生成したファイルは未追跡で diff に出ないので、差分とは別に見る。
function untrackedTargets() {
	const stdout = execFileSync(
		'git',
		['ls-files', '--others', '--exclude-standard', '--', ...targets],
		{
			encoding: 'utf8'
		}
	);
	return stdout.trim();
}

if (hasUnstagedChanges() || untrackedTargets()) {
	console.error(
		`${targets.join(' / ')} が古い状態です。'just ${recipe}' の結果をコミットに含めてください。`
	);
	process.exit(1);
}
