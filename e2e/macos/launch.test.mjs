import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ACTIVATION_POLICY,
	KEY,
	activationPolicy,
	draftWindowLayer,
	holdUserState,
	keyCode,
	mawokPids,
	openAgain,
	hideDraft,
	relaunchWithTestConfig,
	restoreUserState,
	showDraft,
	waitDraftFocused,
	watchLog,
	isDraftVisible,
	waitSettingsWindow
} from '../lib/macos.mjs';
import { expectStays, waitFor } from '../lib/wait.mjs';

// 多重起動と、Dock・Cmd+Tab・最前面の出方を macOS で見る。macOS は多重起動の防ぎ方 (`RunEvent::Reopen` とロックのファイル) と、
// Dock に出すかの作り (activation policy) が Windows と別

test.describe('macOS: 多重起動と OS ごとの見え方', () => {
	test.before(async () => {
		await holdUserState();
		await relaunchWithTestConfig();
	});

	test.after(async () => {
		await restoreUserState();
	});

	test('9.: 動いている Mawok を open で開き直すと、プロセスは増えず、下書きウィンドウが出る', async () => {
		const before = await mawokPids();
		assert.equal(before.length, 1);
		assert.equal(await isDraftVisible(), false, '開き直す前は、下書きウィンドウが隠れている');
		await openAgain();
		await waitDraftFocused('開き直して、下書きウィンドウが出て入力欄にフォーカスが入る');
		assert.deepEqual(await mawokPids(), before, 'プロセスは同じ1つのまま');
		assert.equal(
			await activationPolicy(),
			ACTIVATION_POLICY.accessory,
			'開き直しても、Dock と Cmd+Tab には出ない'
		);
		await hideDraft();
	});

	test('9.: open -n で2つ目を立てると、2つ目はすぐ終わり、下書きウィンドウは出ない', async () => {
		const before = await mawokPids();
		const log = watchLog();
		await openAgain({ newInstance: true });
		// 2つ目が立って、ほかの Mawok がいると分かって終わったことを、2つ目が書くログで見る
		await waitFor(log, (text) => text.includes('another instance is running; exiting'), {
			timeout: 10_000,
			label: '2つ目が、ほかの Mawok がいると分かって終わる'
		});
		await waitFor(mawokPids, (pids) => pids.length === 1, {
			timeout: 10_000,
			label: '2つ目のプロセスが終わる'
		});
		assert.deepEqual(await mawokPids(), before, '残ったのは前からのプロセス');
		await expectStays(isDraftVisible, false, { label: '2つ目を立てた後', duration: 2000 });
	});

	test('11.: Dock と Cmd+Tab には、設定ウィンドウを開いている間だけ出る', async () => {
		assert.equal(await activationPolicy(), ACTIVATION_POLICY.accessory, '常駐中は出ない');
		await showDraft();
		assert.equal(
			await activationPolicy(),
			ACTIVATION_POLICY.accessory,
			'下書きウィンドウを出しても出ない'
		);
		await keyCode(KEY.comma, ['command down']);
		await waitSettingsWindow(true);
		await waitFor(activationPolicy, (policy) => policy === ACTIVATION_POLICY.regular, {
			label: '設定ウィンドウを開いている間は出る'
		});
		await keyCode(KEY.w, ['command down']);
		await waitSettingsWindow(false);
		await waitFor(activationPolicy, (policy) => policy === ACTIVATION_POLICY.accessory, {
			label: '設定ウィンドウを閉じると出なくなる'
		});
		// 設定ウィンドウを閉じると、開く前に出ていた下書きウィンドウが戻る
		await waitDraftFocused();
		await hideDraft();
	});

	test('11.: 下書きウィンドウは常に最前面で、設定でオフにすると外れる', async () => {
		await showDraft();
		assert.ok((await draftWindowLayer()) > 0, '既定では、ふつうのウィンドウより上の層にある');
		await hideDraft();

		await relaunchWithTestConfig('text_window_always_on_top = false\n');
		await showDraft();
		assert.equal(await draftWindowLayer(), 0, 'オフなら、ふつうのウィンドウと同じ層にある');
		await hideDraft();
	});
});
