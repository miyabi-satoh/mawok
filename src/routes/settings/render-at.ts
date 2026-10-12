import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

/** 設定画面を描き、サイドバーで分類を選ぶ。開いたときは「一般」なので、ほかの分類の項目は選ぶまで隠れている */
export async function renderAt(category: () => string) {
	const screen = await render(Page);
	await screen.getByRole('tab', { name: category() }).click();
	return screen;
}
