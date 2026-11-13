import { relative } from 'node:path';
import process from 'node:process';
import type { Reporter, TestModule } from 'vitest/node';

/**
 * 流し直して通ったテストを、最後に警告として出す。テストは通るので、出さないと時々落ちるテストが埋もれる。
 * GitHub Actions では警告の注記にする。vitest の github-actions の reporter は実行の概要にしか書かず、
 * 概要は実行のページを開かないと見えないが、注記は PR のチェックと `gh run view` に出る
 */
export function flakyAnnotations(): Reporter {
	return {
		onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
			const onGitHubActions = process.env.GITHUB_ACTIONS === 'true';
			for (const module of testModules) {
				for (const test of module.children.allTests()) {
					const diagnostic = test.diagnostic();
					if (!diagnostic?.flaky) continue;
					const file = relative(process.cwd(), module.moduleId);
					const line = test.location?.line;
					const message = `Passed on retry ${diagnostic.retryCount}: ${test.fullName}`;
					process.stdout.write(
						onGitHubActions
							? `::warning file=${escapeProperty(file)}${line ? `,line=${line}` : ''},title=Flaky test::${escapeData(message)}\n`
							: `⚠ Flaky test (${file}${line ? `:${line}` : ''}) ${message}\n`
					);
				}
			}
		}
	};
}

// GitHub Actions のワークフローコマンドの書き方 (vitest の github-actions の reporter と同じ逃がし方)
function escapeData(s: string) {
	return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s: string) {
	return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
