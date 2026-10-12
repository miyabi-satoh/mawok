import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { OpenLoader } from './open-loader.svelte';

/** 開け閉めできる OpenLoader。load は、始めた読み込みの「まだ使ってよいか」を current に積む */
function setup() {
	let open = $state(false);
	const current: (() => boolean)[] = [];
	const load = vi.fn(() => current.push(loader.begin()));
	let loader!: OpenLoader;
	const destroy = $effect.root(() => {
		loader = new OpenLoader(() => open, load);
	});
	const setOpen = (value: boolean) => {
		open = value;
		flushSync();
	};
	flushSync();
	return { load, current, setOpen, reload: () => current.push(loader.begin()), destroy };
}

describe('OpenLoader', () => {
	it('開くたびに読み、閉じている間は読まない', () => {
		const { load, setOpen, destroy } = setup();
		expect(load).not.toHaveBeenCalled();
		setOpen(true);
		expect(load).toHaveBeenCalledTimes(1);
		setOpen(false);
		setOpen(true);
		expect(load).toHaveBeenCalledTimes(2);
		destroy();
	});

	it('閉じた後に届く答えは、使わせない', () => {
		const { current, setOpen, destroy } = setup();
		setOpen(true);
		expect(current[0]()).toBe(true);
		setOpen(false);
		expect(current[0]()).toBe(false);
		destroy();
	});

	it('読み直したら、前の読み込みの答えは使わせない', () => {
		const { current, setOpen, reload, destroy } = setup();
		setOpen(true);
		reload();
		expect(current[0]()).toBe(false);
		expect(current[1]()).toBe(true);
		destroy();
	});
});
