import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../lib/setup.mjs';
import { invokeApp, setJapanese, showDraftAndWaitVisible, waitDraftHidden } from '../lib/app.mjs';
import { getDraftWindowHandle } from '../lib/os.mjs';
import { sendKeySequence, VK } from '../lib/input.mjs';
import {
	listMonitors,
	moveWindow,
	readVisibleFrame,
	readWindow,
	setCursorPosition
} from '../lib/window.mjs';
import { beginTestConfig } from '../lib/config.mjs';

// 「表示するディスプレイ」。マウスの位置なら、隠した下書きを、出すときにポインターのあるディスプレイへ移し、
// 作業領域の中での相対的な位置 (右下に寄せていたら右下) を保つ。前回と同じなら動かさない。
// ポインターは SetCursorPos で動かす (クリックしないので、前面もフォーカスも変えない)。
// 位置は、アプリが画面に収めるときと同じく、影を除いた見えている枠で比べる (lib.rs の fit_to_screen)。
// ディスプレイが1枚の機では見られないので飛ばす

const monitors = await listMonitors();
const suite = createSuite();
/** 位置のずれの許し。拡大率の違うディスプレイの間では、窓の大きさと見えない縁が拡大率に合わせて変わり、端数が出る */
const TOLERANCE = 2;

const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const contains = (rect, { x, y }) =>
	x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
/** 窓の中心が載っているディスプレイ */
const monitorOf = (frame) => monitors.findIndex((m) => contains(m.bounds, center(frame)));

function expectInside(frame, area, label) {
	assert.ok(
		frame.x >= area.x - TOLERANCE &&
			frame.y >= area.y - TOLERANCE &&
			frame.x + frame.width <= area.x + area.width + TOLERANCE &&
			frame.y + frame.height <= area.y + area.height + TOLERANCE,
		`${label}: 見えている枠 ${JSON.stringify(frame)} が作業領域 ${JSON.stringify(area)} に収まるはず`
	);
}

/** 見えている枠の右下が、作業領域の右下に寄っているか */
function expectBottomRight(frame, area, label) {
	const gapRight = area.x + area.width - (frame.x + frame.width);
	const gapBottom = area.y + area.height - (frame.y + frame.height);
	assert.ok(
		Math.abs(gapRight) <= TOLERANCE && Math.abs(gapBottom) <= TOLERANCE,
		`${label}: 右下に寄っているはず (右の空き ${gapRight}、下の空き ${gapBottom})`
	);
}

test.describe(
	'表示するディスプレイ',
	{ skip: monitors.length < 2 && 'ディスプレイが1枚なので飛ばす' },
	() => {
		let testConfig;
		let client;
		const [main, other] = monitors;

		test.before(async () => {
			await suite.before();
			testConfig = await beginTestConfig({ hideTextWindowOnBlur: false });
			console.log(`[e2e] ディスプレイ: ${JSON.stringify(monitors)}`);
		});
		test.after(async () => {
			try {
				await testConfig?.restore();
			} finally {
				await suite.after();
			}
		});

		test.beforeEach(async () => {
			client = await suite.newClient();
			await setJapanese(client);
		});
		test.afterEach(async () => {
			try {
				await invokeApp(client, 'set_draft_display', { display: 'last' }).catch(() => {});
				const { x, y } = center(main.workArea);
				await setCursorPosition(x, y);
			} finally {
				await suite.closeClient(client);
			}
		});

		/** 下書きを出し、見えている枠の右下が `monitor` の作業領域の右下に来るよう動かしてから隠す */
		async function placeBottomRightAndHide(monitor) {
			const { x, y } = center(monitor.workArea);
			await setCursorPosition(x, y);
			await showDraftAndWaitVisible();
			const hwnd = await getDraftWindowHandle();
			const area = monitor.workArea;
			// 枠の矩形と見えている枠の差 (影の分) を保って動かす。拡大率の違うディスプレイから移すと、移った所で窓の
			// 大きさが変わって右下からずれるので、変わった大きさでもう一度合わせる
			for (let i = 0; i < 2; i++) {
				const { window } = await readWindow(hwnd);
				const frame = await readVisibleFrame(hwnd);
				const dx = area.x + area.width - (frame.x + frame.width);
				const dy = area.y + area.height - (frame.y + frame.height);
				await moveWindow(hwnd, { ...window, x: window.x + dx, y: window.y + dy });
			}
			const placed = await readVisibleFrame(hwnd);
			expectBottomRight(placed, area, '動かした後');
			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('Esc で隠す');
			return placed;
		}

		/** ポインターを `monitor` の中央へ動かし、ホットキーで出して、見えている枠を返す */
		async function showWithPointerOn(monitor, label) {
			const { x, y } = center(monitor.workArea);
			await setCursorPosition(x, y);
			await showDraftAndWaitVisible(label);
			return readVisibleFrame(await getDraftWindowHandle());
		}

		test('「マウスの位置」なら、ポインターのあるディスプレイへ移り、右下に寄せていた窓は右下に出る。戻すと元のディスプレイの右下に戻る', async () => {
			await invokeApp(client, 'set_draft_display', { display: 'pointer' });
			await placeBottomRightAndHide(main);

			const moved = await showWithPointerOn(other, 'ほかのディスプレイで出す');
			assert.equal(monitorOf(moved), 1, `ほかのディスプレイに出るはず: ${JSON.stringify(moved)}`);
			expectInside(moved, other.workArea, '移った先');
			expectBottomRight(moved, other.workArea, '移った先');

			await sendKeySequence([[VK.ESCAPE]]);
			await waitDraftHidden('Esc で隠す');
			const back = await showWithPointerOn(main, 'メインのディスプレイで出し直す');
			assert.equal(monitorOf(back), 0, `メインのディスプレイに戻るはず: ${JSON.stringify(back)}`);
			expectInside(back, main.workArea, '戻った先');
			expectBottomRight(back, main.workArea, '戻った先');
		});

		test('「前回と同じ」なら、ポインターがほかのディスプレイにあっても動かない', async () => {
			await invokeApp(client, 'set_draft_display', { display: 'last' });
			const before = await placeBottomRightAndHide(main);

			const shown = await showWithPointerOn(other, 'ほかのディスプレイにポインターを置いて出す');
			assert.deepEqual(shown, before, '前回と同じ所に出るはず');
		});
	}
);
