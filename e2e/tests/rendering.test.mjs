import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import {
	expandAllRows,
	hideDraft,
	invokeApp,
	setJapanese,
	showDraftAndWaitVisible,
	typeIntoDraft,
	waitDraftHidden,
	waitForWindowCount,
	waitSettingsWindow
} from '../lib/app.mjs';
import {
	describeForegroundWindow,
	findVisibleMawokWindow,
	getDraftWindowHandle
} from '../lib/os.mjs';
import {
	DRAFT_MIN_SIZE,
	LICENSES_MIN_SIZE,
	LICENSES_TITLE,
	SETTINGS_MIN_SIZE
} from '../lib/app-conf.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import { readWindow } from '../lib/window.mjs';
import { beginTestConfig } from '../lib/config.mjs';
import {
	applyLook,
	clearScreens,
	findHighlightProblems,
	findRenderingProblems,
	resizeClient,
	saveScreen
} from '../lib/rendering.mjs';
import { waitFor } from '../lib/wait.mjs';

// 描かれ方。画面の状態ごとに、テーマ (ライト・ダーク) × 言語 (日本語・英語) と、最小の大きさ × 言語で、
// 重なり・はみ出し・省略・潰れを lib/rendering.mjs で調べ、画面を e2e/screenshots/ に撮る。
// 撮った画面は人とエージェントが目で見る (バランスや余白の不揃いは機械では決めにくいため)。
// 状態を作るのに要る設定は config.toml で入れる。送信先のデバイスは架空のもの
// (Mawok のアカウントにサインインしていない機で流す前提。Pro でないので、送るとつなぐ前に断られる)。
// アクションは一覧を開いて撮るだけで、選ばない。この機の資格情報管理に本物のキーがあれば、選んだ時点で
// AI サービスへ送ってしまうため (画面の invoke は差し替えられず、送る手前で止める口もない)。
// 同じ理由で、アクションに失敗したときの知らせと、届いた下書きの知らせ (相手のデバイスが要る) は撮らない

const suite = createSuite();

const LOOKS = [
	{ theme: 'light', language: 'ja' },
	{ theme: 'dark', language: 'ja' },
	{ theme: 'light', language: 'en' },
	{ theme: 'dark', language: 'en' }
];
const MIN_LOOKS = [
	{ theme: 'light', language: 'ja' },
	{ theme: 'light', language: 'en' }
];

const TEST_CONFIG = {
	hideTextWindowOnBlur: false,
	textWindowAlwaysOnTop: true,
	showTextWindowButtons: true,
	replacements: [
		{ from: 'ください', to: '下さい' },
		{ from: 'e.g.', to: 'for example' }
	],
	snippets: [
		{ name: 'かくにん', body: '一つずつ質問してください。\n以上です。' },
		{ name: '', body: 'git status' },
		{
			name: 'とても長い名前の定型文で、一覧の幅に収まりきらないときの見え方を確かめるためのもの',
			body: '本文も長めにしておきます。'.repeat(8)
		}
	],
	devices: [
		{
			name: 'MacBook Air',
			publicKey: 'ab'.repeat(32),
			// 文書用のアドレス (TEST-NET-1) なので、どこにも繋がらない
			address: '192.0.2.1',
			sendTo: true
		}
	],
	// 開発機の利用者のアクションに左右されないよう、既定の2件 (@ai の行とコマンドの行) で撮る
	actions: null,
	aiService: 'gemini',
	aiConsent: 'gemini'
};

const DRAFT_TEXT = 'お手数ですが、確認してください。\ne.g. git status の結果も添えてください。';

/**
 * 今の画面を、見た目 (テーマ × 言語) と大きさを変えながら調べて撮る。見つけた崩れはまとめて1回で落とす。
 * `prepare` は見た目を変えるたびに呼ぶ (3 秒で消える知らせのように、撮るたびに作り直す状態のため)。
 * `check` は、その状態だけで見るものを足すときに渡す (見つけた崩れを文字列の配列で返す)
 */
async function inspect(
	client,
	name,
	{ hwnd, minSize, overlays = [], inViewport = [], prepare, check }
) {
	const found = [];
	const original = (await readWindow(hwnd)).client;
	const scale = (await readWindow(hwnd)).scale;
	const defaultSize = { width: original.width / scale, height: original.height / scale };
	const rounds = [
		...LOOKS.map((look) => ({ look, size: defaultSize, suffix: '' })),
		...MIN_LOOKS.map((look) => ({ look, size: minSize, suffix: '-min' }))
	];
	try {
		for (const { look, size, suffix } of rounds) {
			await resizeClient(hwnd, size);
			await applyLook(client, look);
			await prepare?.();
			const label = `${name}-${look.language}-${look.theme}${suffix}`;
			const problems = [
				...(await findRenderingProblems(client, { overlays, inViewport })),
				...((await check?.()) ?? [])
			];
			for (const problem of problems) found.push(`${label}: ${problem}`);
			await saveScreen(client, label);
		}
	} finally {
		await resizeClient(hwnd, defaultSize);
		await applyLook(client, LOOKS[0]);
	}
	assert.deepEqual(found, [], `描かれ方の崩れ:\n${found.join('\n')}`);
}

/** 下書きの画面のまま、状態を作って調べる */
async function inspectDraft(client, name, options = {}) {
	await inspect(client, `draft-${name}`, {
		hwnd: await getDraftWindowHandle(),
		minSize: DRAFT_MIN_SIZE,
		...options
	});
}

async function readPaletteOpen(client) {
	return client.execute(() => document.querySelector('[role="dialog"]') !== null);
}

async function openPaletteWith(client, key) {
	await sendKeySequence([[VK.CONTROL, key]]);
	await waitFor(
		() => readPaletteOpen(client),
		(open) => open,
		{ label: '一覧が出る' }
	);
}

async function closePalette(client) {
	await sendKeySequence([[VK.ESCAPE]]);
	await waitFor(
		() => readPaletteOpen(client),
		(open) => !open,
		{ label: '一覧が閉じる' }
	);
}

async function focusDraft(client) {
	await client.$('textarea').click();
}

/**
 * 置き換えのハイライトの1つにマウスを重ね、ツールチップが出るまで待つ。
 * `pick` は `'first'` (先頭の行の左端) か `'right'` (右端に一番近いもの)
 */
async function hoverHighlight(client, pick) {
	const { x, y } = await client.execute((which) => {
		const rects = [...document.querySelectorAll('main mark')].map(
			(mark) => mark.getClientRects()[0]
		);
		const rect =
			which === 'first'
				? rects[0]
				: rects.reduce((best, current) => (current.right > best.right ? current : best));
		return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
	}, pick);
	// マウスが同じ位置のままだと mousemove が起きないので、いったん外してから重ねる
	await client
		.action('pointer', { parameters: { pointerType: 'mouse' } })
		.move({ x: 1, y: 1 })
		.move({ x, y })
		.perform();
	await waitFor(
		() => client.execute(() => document.querySelector('main .pointer-events-none.fixed') !== null),
		(shown) => shown,
		{ label: 'ツールチップが出る' }
	);
}

const TOOLTIP = 'main .pointer-events-none.fixed';

test.describe('描かれ方', () => {
	let testConfig;
	let client;

	test.before(async () => {
		await suite.before();
		await clearScreens();
		testConfig = await beginTestConfig(TEST_CONFIG);
		client = await suite.newClient();
		await setJapanese(client);
	});
	test.after(async () => {
		try {
			if (client) await suite.closeClient(client);
			await testConfig?.restore();
		} finally {
			await suite.after();
		}
	});

	// 前のテストが落ちて一覧が出たままでも、次のテストの操作が一覧に遮られないよう閉じておく
	test.beforeEach(async () => {
		if (await readPaletteOpen(client).catch(() => false)) await closePalette(client);
	});

	test('下書き: 空 (履歴なし・案内が見える)', async () => {
		await showDraftAndWaitVisible();
		await inspectDraft(client, 'empty');
	});

	test('下書き: 置き換えのツールチップ (履歴の列がないときの先頭の行・右端)', async () => {
		// 置き換える語だけを続けて、どの行の左端から右端までハイライトが並ぶようにする
		await typeIntoDraft(client, 'ください'.repeat(24));
		// 左端で落ちても右端を見るよう、まとめてから落とす
		const found = [];
		for (const pick of ['first', 'right']) {
			try {
				await inspectDraft(client, `tooltip-${pick}`, {
					inViewport: [TOOLTIP],
					prepare: () => hoverHighlight(client, pick)
				});
			} catch (error) {
				found.push(error.message);
			}
		}
		assert.deepEqual(found, [], found.join('\n\n'));
	});

	test('下書き: 縦にスクロールするほど長いときのハイライト', async () => {
		// 折り返す長い行にして、折り返しの位置のずれが撮った画面でも見えるようにする
		const line =
			'お手数ですが、次の手順で確認してください。e.g. の後に git status の結果を添えてください。';
		await typeIntoDraft(client, `${`${line.repeat(3)}\n`.repeat(8)}最後の行`);
		await inspectDraft(client, 'scrolling', { check: () => findHighlightProblems(client) });
	});

	test('下書き: 書いた後 (置き換えのハイライト・履歴のボタン)', async () => {
		// 履歴のボタンは、覚えている履歴があるときだけ出る
		await typeIntoDraft(client, '履歴に残す下書き');
		await hideDraft(client);
		await waitDraftHidden('コピーして閉じる');
		await showDraftAndWaitVisible();
		await typeIntoDraft(client, DRAFT_TEXT);
		await inspectDraft(client, 'text', { check: () => findHighlightProblems(client) });
	});

	test('下書き: コピーのキーが3つの組み合わせ', async () => {
		await invokeApp(client, 'set_draft_key', {
			action: 'copy',
			key: 'CommandOrControl+Alt+Shift+Enter'
		});
		try {
			await inspectDraft(client, 'copy-3keys');
		} finally {
			await invokeApp(client, 'reset_draft_key', { action: 'copy' });
		}
	});

	test('下書き: 定型文の一覧', async () => {
		await focusDraft(client);
		await openPaletteWith(client, VK.J);
		await inspectDraft(client, 'snippets', { overlays: ['[role="dialog"]'] });
	});

	test('下書き: 定型文に登録した知らせ', async () => {
		// 知らせは 3 秒で消えるので、撮るたびに一覧から登録し直す
		await inspectDraft(client, 'notice', {
			prepare: async () => {
				if (!(await readPaletteOpen(client))) {
					await focusDraft(client);
					await openPaletteWith(client, VK.J);
				}
				const options = await client.$$('[role="dialog"] [role="option"]');
				await options[options.length - 1].click();
				await waitFor(
					() =>
						client.execute(
							() => document.querySelector('p[role="status"]')?.textContent.trim() ?? ''
						),
					(text) => text !== '',
					{ label: '登録の知らせが出る' }
				);
			}
		});
	});

	test('下書き: アクション一覧', async () => {
		await focusDraft(client);
		await openPaletteWith(client, VK.K);
		await inspectDraft(client, 'actions', { overlays: ['[role="dialog"]'] });
	});

	test('下書き: 送信先の一覧', async () => {
		await focusDraft(client);
		await openPaletteWith(client, VK.L);
		await inspectDraft(client, 'send-targets', { overlays: ['[role="dialog"]'] });
	});

	// 送っている最中の画面は撮らない。サインインしていない機では Pro でなく、送信はつなぐ前に断られるため。
	// 「送信中…」の文言と、その間のボタンが押せない見た目は、手での確認で見る

	test('下書き: 送れなかったときのエラー', async () => {
		// Pro でないので、送るとすぐエラーが出る。エラーは表示言語を替えると消えるので、
		// 撮るたびに、出ていなければ送り直す。Pro のアカウントにサインインした機では、つなぐのを 3 秒待ってから
		// つながらないエラーが出るので、その分も待つ
		// 隠れている帯や消えかけの古い帯に当たらないよう、出ている帯があるかで見る
		const readAlertShown = () =>
			client.execute(() =>
				[...document.querySelectorAll('[role="alert"]')].some(
					(alert) => alert.checkVisibility() && alert.getBoundingClientRect().height > 0
				)
			);
		await inspectDraft(client, 'send-error', {
			overlays: ['[role="alert"]'],
			prepare: async () => {
				if (await readAlertShown()) return;
				// 「送信」ボタン (送信先の▼とつながった左側)。キーは前面のウィンドウに届かないことがあるので押す
				await client.$('main button.rounded-r-none').click();
				await waitFor(readAlertShown, (shown) => shown, {
					label: '送れなかったエラーが出る',
					timeout: 10000
				});
			}
		});
	});

	test('設定: 分類ごと', async () => {
		const [draftHandle] = await client.getWindowHandles();
		await invokeApp(client, 'open_settings_window');
		const { settingsHandle, settingsHwnd } = await waitSettingsWindow(client, draftHandle);
		await client.switchToWindow(settingsHandle);
		await client.$('[role="tab"][aria-selected="true"]').waitForDisplayed({ timeout: 5000 });
		const values = await client.execute(() =>
			[...document.querySelectorAll('[role="tab"]')].map((tab) => tab.dataset.value)
		);
		const found = [];
		for (const value of values) {
			await client.$(`[role="tab"][data-value="${value}"]`).click();
			await client.pause(300);
			try {
				await inspect(client, `settings-${value}`, {
					hwnd: settingsHwnd,
					minSize: SETTINGS_MIN_SIZE
				});
			} catch (error) {
				found.push(error.message);
			}
		}

		// アクションの行を開いた状態。コマンドの行には文字コードの選択が出る
		await client.$('[role="tab"][data-value="actions"]').click();
		const actionsPanel = await client.$('[role="tabpanel"]:not([hidden])');
		await expandAllRows(client, actionsPanel);
		try {
			await inspect(client, 'settings-actions-open', {
				hwnd: settingsHwnd,
				minSize: SETTINGS_MIN_SIZE,
				// 狭い幅では文字コードの選択が下に隠れるので、そこまで送ってから撮る
				prepare: () =>
					client.execute(() =>
						document
							.querySelector('[role="tabpanel"]:not([hidden]) select')
							?.scrollIntoView({ block: 'center' })
					)
			});
		} catch (error) {
			found.push(error.message);
		}

		// ホットキーの記録中。記録の表示と「キャンセル」が、題名の横の狭い所に入る。
		// 記録は設定ウィンドウからフォーカスが外れると止まる作り (settings/+page.svelte の onblur) なので、
		// 撮るたびに記録の表示が残っているかを見て、消えていればそのときの前面のウィンドウを添えて落とす
		const recordingStatus = () => client.$('[role="tabpanel"]:not([hidden]) [role="status"]');
		const expectRecording = async (when) => {
			if (await recordingStatus().isExisting()) return;
			// 前面のウィンドウは手がかりでしかないので、取れなくても記録が止まっていたことのほうを落とす
			const foreground = await describeForegroundWindow().catch(
				(error) => `取れなかった (${error.message})`
			);
			throw new Error(
				`ホットキーの記録が止まっていた (${when})。設定ウィンドウからフォーカスが外れると止まる。前面のウィンドウ: ${foreground}`
			);
		};
		await client.$('[role="tab"][data-value="keys"]').click();
		await client.$('button[aria-label^="ホットキーを変更"]').click();
		await recordingStatus().waitForDisplayed({ timeout: 5000 });
		try {
			await inspect(client, 'settings-keys-recording', {
				hwnd: settingsHwnd,
				minSize: SETTINGS_MIN_SIZE,
				prepare: () => expectRecording('撮る前')
			});
			await expectRecording('撮り終えた後');
		} catch (error) {
			found.push(error.message);
		} finally {
			// 止まっていれば押すものがない。止まったことは上で落としている
			const cancel = client.$('[role="tabpanel"]:not([hidden]) [role="status"] + button');
			if (await cancel.isExisting()) await cancel.click();
		}

		// 第三者のソフトウェアは、分類「このアプリについて」から開く別のウィンドウ
		await invokeApp(client, 'open_licenses_window');
		const handles = await waitForWindowCount(client, 3);
		const licensesHandle = handles.find((h) => h !== draftHandle && h !== settingsHandle);
		const licensesHwnd = await waitFor(
			() => findVisibleMawokWindow(LICENSES_TITLE),
			(hwnd) => hwnd !== null,
			{ label: '第三者のソフトウェアのウィンドウ' }
		);
		await client.switchToWindow(licensesHandle);
		// パッケージごとに details が並ぶ。1件目を開いて、本文の見え方も撮る
		await client.$('details', { strict: false }).waitForDisplayed({ timeout: 5000 });
		await client.$('details summary', { strict: false }).click();
		try {
			await inspect(client, 'licenses', { hwnd: licensesHwnd, minSize: LICENSES_MIN_SIZE });
		} catch (error) {
			found.push(error.message);
		}
		assert.deepEqual(found, [], found.join('\n\n'));
	});
});
