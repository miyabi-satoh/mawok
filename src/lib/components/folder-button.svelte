<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import HouseIcon from '@lucide/svelte/icons/house';
	import type { FolderMenu } from '$lib/bindings/FolderMenu';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { m } from '$lib/paraglide/messages';

	/**
	 * テキストウィンドウの左下の、コマンドを動かすフォルダーのボタン（docs/actions.md「作業フォルダー」）。
	 * 今のフォルダーの名前を出し、押すと最近のフォルダーと「フォルダーを選ぶ...」のメニューを開く（VS Code の下のバーと同じ作り）。
	 * 最近のフォルダーが無くホームにいるときは、メニューを出さずにすぐ選ぶ画面を開く。キーの Cmd/Ctrl+D の欄とは別の入口
	 */
	type Props = {
		menu: FolderMenu;
		disabled: boolean;
		/** メニューを開く前に呼ぶ。消えたフォルダーを外すため、中身を取り直す */
		onopen: () => void;
		/** 最近のフォルダーへ移る。ホームへ戻るときは空文字 */
		onchange: (path: string) => void;
		onpick: () => void;
		/** メニューを移らずに閉じたとき（Esc・外を押す・今のフォルダーを選ぶ）。下書きにフォーカスを戻す */
		onclose: () => void;
	};

	let { menu, disabled, onopen, onchange, onpick, onclose }: Props = $props();

	const name = $derived(menu.atHome ? m.folder_home() : menu.current.name);
	const label = $derived(m.folder_button({ path: menu.current.display }));
	const direct = $derived(menu.atHome && menu.recent.length === 0);
	// 押せる幅を名前に合わせて広げすぎない。長い名前は切って、全体はマウスを重ねたときに出す
	const triggerClass = 'max-w-48 min-w-0';
</script>

{#if direct}
	<Button
		tabindex={-1}
		variant="ghost"
		size="sm"
		class={triggerClass}
		aria-label={label}
		title={menu.current.display}
		{disabled}
		onclick={onpick}
	>
		<FolderIcon data-icon="inline-start" />
		<span class="truncate">{name}</span>
	</Button>
{:else}
	<DropdownMenu.Root onOpenChange={(open) => open && onopen()}>
		<DropdownMenu.Trigger
			tabindex={-1}
			class={[buttonVariants({ variant: 'ghost', size: 'sm' }), triggerClass]}
			aria-label={label}
			title={menu.current.display}
			{disabled}
		>
			<FolderIcon data-icon="inline-start" />
			<span class="truncate">{name}</span>
			<ChevronDownIcon data-icon="inline-end" />
		</DropdownMenu.Trigger>
		<!-- 閉じたときにボタンへフォーカスを戻さない。ボタンにあると、下書きの Esc や Cmd+Enter が効かなくなる -->
		<DropdownMenu.Content
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				onclose();
			}}
			align="start"
			side="top"
			class="w-auto max-w-[min(24rem,calc(100vw-1rem))]"
		>
			{#if menu.recent.length > 0}
				<DropdownMenu.Group>
					<DropdownMenu.Label>{m.folder_menu_recent()}</DropdownMenu.Label>
					{#each menu.recent as folder (folder.path)}
						{@const current = folder.path === menu.current.path}
						<DropdownMenu.Item onSelect={() => !current && onchange(folder.path)}>
							<CheckIcon class={current ? '' : 'invisible'} />
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{folder.name}</span>
								<span class="truncate text-xs text-muted-foreground">{folder.display}</span>
							</span>
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Group>
				<DropdownMenu.Separator />
			{/if}
			<DropdownMenu.Item onSelect={onpick}>
				<FolderOpenIcon />
				{m.folder_menu_pick()}
			</DropdownMenu.Item>
			{#if !menu.atHome}
				<DropdownMenu.Item onSelect={() => onchange('')}>
					<HouseIcon />
					{m.folder_menu_home()}
				</DropdownMenu.Item>
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
