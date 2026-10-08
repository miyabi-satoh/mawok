import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeApp } from './app.mjs';
import { moveWindow, readWindow } from './window.mjs';
import { waitFor } from './wait.mjs';

// 画面の描かれ方 (重なり・はみ出し・省略・潰れ) を、WebView の中で DOM の矩形と `elementFromPoint` から調べる。
// DOM の状態 (ある・見える・文字列) では、z-index の漏れで一覧の上に入力欄が描かれるような崩れに気づけないため。
// 撮った画面は `e2e/screenshots/` に置く (gitignore 済み。見るのは人とエージェントの目)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'screenshots');

/**
 * 画面の描かれ方の崩れを洗い出し、見つけたものを文字列の配列で返す (なければ空)。
 *
 * - `page-scroll`: ページ全体に横か縦のスクロールが出ている (ウィンドウの大きさに収まっていない)
 * - `scroll-x`: 区画の中に横スクロールが出ている
 * - `truncated`: `text-overflow: ellipsis` で文字が省略されている
 * - `clipped`: 文字を持つ要素が `overflow: hidden` で中身を切っている (ボタンや見出しの文字の切れ)
 * - `covered`: 操作できる部品の真ん中を押すと、ほかの要素に当たる (上に何かが重なっている)
 * - `overlap`: 操作できる部品どうしの矩形が重なっている
 * - `squashed`: 操作できる部品が潰れている (幅か高さが 16px 未満。文字の入力欄 (数の欄を除く) は幅 96px 未満、複数行の入力欄は高さ 3 行未満)
 * - `cut-off`: 操作できる部品が、スクロールできないのにウィンドウや区画の外へはみ出して切れている
 * - `narrow-wrap`: 文字が細い幅に押し込まれて縦に折れている (幅が 4 文字未満で 3 行以上)
 * - `overlay-hole`: `overlay` に渡した部品 (一覧・知らせなど上に出すもの) の範囲の点で、ほかの要素が手前に描かれている
 * - `overlay-offscreen`: `overlay` の部品がウィンドウからはみ出している
 * - `offscreen`: `inViewport` に渡した部品 (押せないツールチップなど) がウィンドウからはみ出している
 *
 * スクロールして見えていない部品と、隠れている分類 (hidden) の部品は見ない。
 * 一覧 (`role="dialog"`) が出ているときは、後ろの部品は薄く覆われて押せないのが正しいので、一覧の中の部品だけを見る。
 * 入力欄の中身 (利用者が書いた文字) のはみ出しは見ない
 *
 * @param {WebdriverIO.Browser} client
 * @param {{ overlays?: string[], inViewport?: string[] }} options
 *   `overlays` は上に出す部品、`inViewport` はウィンドウに収まるべき押せない部品の CSS セレクター
 */
export async function findRenderingProblems(client, { overlays = [], inViewport = [] } = {}) {
	return client.execute(
		(overlaySelectors, inViewportSelectors) => {
			const problems = [];
			const TOLERANCE = 1;
			const describe = (element) => {
				const name =
					element.getAttribute('aria-label') ||
					element.getAttribute('title') ||
					element.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
				const tag = element.tagName.toLowerCase();
				const role = element.getAttribute('role');
				return `${tag}${role ? `[role=${role}]` : ''}「${name}」`;
			};
			const isRendered = (element) => {
				if (element.closest('[hidden], [aria-hidden="true"], .sr-only')) return false;
				const style = getComputedStyle(element);
				if (style.visibility !== 'visible' || style.display === 'none') return false;
				if (Number(style.opacity) === 0) return false;
				const rect = element.getBoundingClientRect();
				return rect.width > 1 && rect.height > 1;
			};
			// スクロールする区画の外に出ていて見えていないなら、描かれ方を問わない
			const visibleRect = (element) => {
				let { left, top, right, bottom } = element.getBoundingClientRect();
				for (let parent = element.parentElement; parent; parent = parent.parentElement) {
					const style = getComputedStyle(parent);
					if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
					const clip = parent.getBoundingClientRect();
					left = Math.max(left, clip.left);
					top = Math.max(top, clip.top);
					right = Math.min(right, clip.right);
					bottom = Math.min(bottom, clip.bottom);
				}
				left = Math.max(left, 0);
				top = Math.max(top, 0);
				right = Math.min(right, window.innerWidth);
				bottom = Math.min(bottom, window.innerHeight);
				return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null;
			};
			const fullyVisible = (element) => {
				const rect = element.getBoundingClientRect();
				const visible = visibleRect(element);
				return (
					visible !== null &&
					visible.right - visible.left >= rect.width - TOLERANCE &&
					visible.bottom - visible.top >= rect.height - TOLERANCE
				);
			};
			const hasOwnText = (element) =>
				[...element.childNodes].some(
					(node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ''
				);
			const isField = (element) => element.matches('textarea, input, select');
			// 要素の中の見えている文字の範囲 (なければ null)
			const textBounds = (element) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let bounds = null;
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					if (node.textContent.trim() === '' || !isRendered(node.parentElement)) continue;
					// 中で省略・切り取りしている区画 (一覧の行の本文など) の外に出た分は、見えていないので数えない
					let clipLeft = -Infinity;
					let clipRight = Infinity;
					for (let parent = node.parentElement; parent !== element; parent = parent.parentElement) {
						if (getComputedStyle(parent).overflowX === 'visible') continue;
						const clip = parent.getBoundingClientRect();
						clipLeft = Math.max(clipLeft, clip.left);
						clipRight = Math.min(clipRight, clip.right);
					}
					const range = document.createRange();
					range.selectNodeContents(node);
					for (const r of range.getClientRects()) {
						const left = Math.max(r.left, clipLeft);
						const right = Math.min(r.right, clipRight);
						if (right - left <= 0) continue;
						bounds = bounds
							? { left: Math.min(bounds.left, left), right: Math.max(bounds.right, right) }
							: { left, right };
					}
				}
				return bounds;
			};
			const isTextField = (element) =>
				element.matches(
					'textarea, input:not([type]), input[type="text"], input[type="password"], input[type="search"], input[type="url"]'
				);
			const scrollable = (element) => {
				for (let parent = element.parentElement; parent; parent = parent.parentElement) {
					const style = getComputedStyle(parent);
					if (
						[style.overflowX, style.overflowY].some((value) => ['auto', 'scroll'].includes(value))
					)
						return true;
				}
				return false;
			};

			const root = document.scrollingElement;
			if (root.scrollWidth > root.clientWidth + TOLERANCE) {
				problems.push(`page-scroll: 横 ${root.scrollWidth}px > ${root.clientWidth}px`);
			}
			if (root.scrollHeight > root.clientHeight + TOLERANCE) {
				problems.push(`page-scroll: 縦 ${root.scrollHeight}px > ${root.clientHeight}px`);
			}

			const all = [...document.body.querySelectorAll('*')].filter(isRendered);
			for (const element of all) {
				if (isField(element) || !visibleRect(element)) continue;
				const style = getComputedStyle(element);
				const overflowsX = element.scrollWidth > element.clientWidth + TOLERANCE;
				const overflowsY = element.scrollHeight > element.clientHeight + TOLERANCE;
				if (overflowsX && (style.overflowX === 'auto' || style.overflowX === 'scroll')) {
					problems.push(
						`scroll-x: ${describe(element)} ${element.scrollWidth}px > ${element.clientWidth}px`
					);
				}
				// 一覧の行は、利用者が書いた長い名前や本文を1行に省略して並べる作りなので、省略を問わない
				// (下書きの一覧の選択肢と、設定の定型文・アクションの閉じた行 (reorderable-rows.svelte))
				if (style.textOverflow === 'ellipsis' && overflowsX) {
					if (!element.closest('[role="option"], button[aria-controls^="row-"]')) {
						problems.push(`truncated: ${describe(element)}`);
					}
				} else if (
					hasOwnText(element) &&
					((overflowsX && ['hidden', 'clip'].includes(style.overflowX)) ||
						(overflowsY && ['hidden', 'clip'].includes(style.overflowY)))
				) {
					problems.push(`clipped: ${describe(element)}`);
				}
				if (hasOwnText(element)) {
					const rect = element.getBoundingClientRect();
					const fontSize = parseFloat(style.fontSize);
					const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.5;
					if (rect.width < fontSize * 4 && rect.height > lineHeight * 2.5) {
						problems.push(
							`narrow-wrap: ${describe(element)} ${Math.round(rect.width)}×${Math.round(rect.height)}px`
						);
					}
				}
			}

			const interactive = all.filter(
				(element) =>
					element.matches(
						'button, a[href], input:not([type="hidden"]), textarea, select, [role="switch"], [role="tab"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [role="menuitem"], summary'
					) &&
					// 部品の中の部品 (ボタンの中のチェックボックスなど) は、外側で見る
					!element.parentElement.closest('button, [role="option"], [role="tab"]')
			);
			const dialogs = [...document.querySelectorAll('[role="dialog"]')];
			const active =
				dialogs.length === 0
					? interactive
					: interactive.filter((element) => dialogs.some((dialog) => dialog.contains(element)));
			const box = (rect) =>
				`(${Math.round(rect.left)},${Math.round(rect.top)})-(${Math.round(rect.right)},${Math.round(rect.bottom)}) / ウィンドウ ${window.innerWidth}×${window.innerHeight}`;
			for (const element of active) {
				if (visibleRect(element) && !fullyVisible(element) && !scrollable(element)) {
					problems.push(`cut-off: ${describe(element)} ${box(element.getBoundingClientRect())}`);
				}
			}
			const shown = active.filter(fullyVisible);
			for (const element of shown) {
				const rect = element.getBoundingClientRect();
				if (rect.width < 16 || rect.height < 16) {
					problems.push(
						`squashed: ${describe(element)} ${Math.round(rect.width)}×${Math.round(rect.height)}px`
					);
				} else if (isTextField(element)) {
					const style = getComputedStyle(element);
					const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
					if (rect.width < 96) {
						problems.push(`squashed: ${describe(element)} 幅 ${Math.round(rect.width)}px`);
					}
					if (element.tagName === 'TEXTAREA' && element.clientHeight < lineHeight * 3) {
						problems.push(
							`squashed: ${describe(element)} 高さ ${element.clientHeight}px (3 行 ${Math.round(lineHeight * 3)}px 未満)`
						);
					}
				}
				// 飾りの疑似要素 (タブの下線など) も scrollWidth を押し広げるので、文字そのものの範囲で比べる
				const text = isField(element) ? null : textBounds(element);
				if (text) {
					const style = getComputedStyle(element);
					const inner = {
						left: rect.left + parseFloat(style.borderLeftWidth),
						right: rect.right - parseFloat(style.borderRightWidth)
					};
					if (text.left < inner.left - TOLERANCE || text.right > inner.right + TOLERANCE) {
						problems.push(
							`clipped: ${describe(element)} 文字 ${Math.round(text.right - text.left)}px が枠 ${Math.round(inner.right - inner.left)}px をはみ出す`
						);
					}
				}
				const hit = document.elementFromPoint(
					rect.left + rect.width / 2,
					rect.top + rect.height / 2
				);
				// <label> で包んだ部品は、押すと label に当たることがあるので、同じ label の中なら当たったとみなす
				const sameLabel =
					hit?.closest('label') && hit.closest('label') === element.closest('label');
				if (hit && !element.contains(hit) && !hit.contains(element) && !sameLabel) {
					problems.push(`covered: ${describe(element)} の上に ${describe(hit)}`);
				}
			}
			for (let i = 0; i < shown.length; i++) {
				for (let j = i + 1; j < shown.length; j++) {
					const [a, b] = [shown[i], shown[j]];
					if (a.contains(b) || b.contains(a)) continue;
					const ra = a.getBoundingClientRect();
					const rb = b.getBoundingClientRect();
					const width = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
					const height = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
					// 境界線を共有するつなぎのボタン (-ml-px) は重なりとみなさない
					if (width > 2 && height > 2) {
						problems.push(`overlap: ${describe(a)} と ${describe(b)}`);
					}
				}
			}

			const outside = (rect) =>
				rect.left < -TOLERANCE ||
				rect.top < -TOLERANCE ||
				rect.right > window.innerWidth + TOLERANCE ||
				rect.bottom > window.innerHeight + TOLERANCE;
			for (const selector of inViewportSelectors) {
				const elements = document.querySelectorAll(selector);
				if (elements.length === 0) problems.push(`missing: ${selector}`);
				for (const element of elements) {
					const rect = element.getBoundingClientRect();
					if (outside(rect)) problems.push(`offscreen: ${describe(element)} ${box(rect)}`);
				}
			}

			for (const overlay of overlaySelectors.flatMap((selector) => {
				const found = [...document.querySelectorAll(selector)];
				if (found.length === 0) problems.push(`overlay-missing: ${selector}`);
				return found;
			})) {
				const rect = overlay.getBoundingClientRect();
				if (outside(rect)) problems.push(`overlay-offscreen: ${describe(overlay)} ${box(rect)}`);
				const holes = [];
				const STEPS = 6;
				for (let xi = 0; xi <= STEPS; xi++) {
					for (let yi = 0; yi <= STEPS; yi++) {
						// 角の丸みに当たらないよう、縁から 6px 内側を見る
						const x = rect.left + 6 + ((rect.width - 12) * xi) / STEPS;
						const y = rect.top + 6 + ((rect.height - 12) * yi) / STEPS;
						const hit = document.elementFromPoint(x, y);
						if (hit && !overlay.contains(hit))
							holes.push(`(${Math.round(x)},${Math.round(y)}) ${describe(hit)}`);
					}
				}
				if (holes.length > 0) {
					problems.push(
						`overlay-hole: ${describe(overlay)} の上に ${[...new Set(holes)].slice(0, 5).join('、')}`
					);
				}
			}
			return problems;
		},
		overlays,
		inViewport
	);
}

/**
 * 下書きの入力欄と、その裏でコピー時の置き換えをハイライトする層の、折り返しの幅を比べる。
 * 幅が違うと折り返す位置がずれ、ハイライトが実際の文字の真下から外れる
 * (入力欄にだけ縦のスクロールバーが出て、その分だけ文字の幅が狭まるときなど)
 */
export async function findHighlightProblems(client) {
	return client.execute(() => {
		const textarea = document.querySelector('main textarea');
		const layer = textarea?.parentElement.querySelector(':scope > [aria-hidden="true"]');
		if (!textarea || !layer) return ['highlight: 入力欄かハイライトの層が見つかりません'];
		const contentWidth = (element) => {
			const style = getComputedStyle(element);
			return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		};
		const field = contentWidth(textarea);
		const highlight = contentWidth(layer);
		return Math.abs(field - highlight) > 1
			? [`highlight: 折り返しの幅が違う (入力欄 ${field}px、ハイライト ${highlight}px)`]
			: [];
	});
}

/** 画面を撮って `e2e/screenshots/<name>.png` に置く */
export async function saveScreen(client, name) {
	await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
	await client.saveScreenshot(path.join(SCREENSHOT_DIR, `${name}.png`));
}

/** `e2e/screenshots/` を空にする (前の実行の画面と混ざらないよう、撮る前に呼ぶ) */
export async function clearScreens() {
	await fs.rm(SCREENSHOT_DIR, { recursive: true, force: true });
}

/**
 * テーマと言語を切り替え、画面に行き渡るまで待つ。テーマは `<html>` の `dark` の class、
 * 言語は `<html lang>` で見届ける
 */
export async function applyLook(client, { theme, language }) {
	await invokeApp(client, 'set_theme', { theme });
	await invokeApp(client, 'set_language', { language });
	await waitFor(
		() =>
			client.execute(() => ({
				dark: document.documentElement.classList.contains('dark'),
				lang: document.documentElement.lang
			})),
		(look) => look.dark === (theme === 'dark') && look.lang === language,
		{ label: `テーマ ${theme}・言語 ${language} の反映` }
	);
	// 切り替えのアニメーションと、文言の差し替え後の配置を待つ
	await client.pause(300);
}

/**
 * ウィンドウの中身 (クライアント領域) を論理ピクセルで `width`×`height` にする。
 * `SetWindowPos` は最小の大きさを通り抜けるので、最小より小さくしないこと
 */
export async function resizeClient(hwnd, { width, height }) {
	const before = await readWindow(hwnd);
	const frameWidth = before.window.width - before.client.width;
	const frameHeight = before.window.height - before.client.height;
	await moveWindow(hwnd, {
		x: before.window.x,
		y: before.window.y,
		width: Math.round(width * before.scale) + frameWidth,
		height: Math.round(height * before.scale) + frameHeight
	});
}
