<script lang="ts">
	import SyncToggle from '$lib/components/sync-toggle.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReorderableRows from '$lib/components/reorderable-rows.svelte';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SettingsSyncNote from '$lib/components/settings-sync-note.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { m } from '$lib/paraglide/messages';
	import type { SnippetsEditor } from '$lib/snippets-editor.svelte';
	import { firstLine, snippetLabel } from '$lib/snippets';
	import ListFilter from '$lib/components/list-filter.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import { focusFirstField } from '$lib/focus-field';
	import { showsFilter } from '$lib/list-filter';
	import type { SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定画面の「定型文」の分類。定型文の並び。
	 * 定型文の編集中の内容は、分類を移っても消えないよう、設定画面の本体が持つ
	 */
	let { view, editor }: { view: SettingsView; editor: SnippetsEditor } = $props();
</script>

<!-- 画面の題名と同じ見出しをカードに重ねない。よく触る定型文の並びを先に出す -->
<div class="flex flex-col gap-5">
	<div class="flex flex-col gap-3">
		{#if view.proAvailable && !view.syncKinds.snippets}
			<SettingsSyncNote text={m.settings_sync_snippets_off()} />
		{/if}
		<SettingsSection>
			<SettingsRow>
				{#if showsFilter(editor.snippets.rows.length, editor.filter)}
					<ListFilter label={m.settings_snippets_filter()} bind:value={editor.filter} />
				{/if}
				<ReorderableRows
					list={editor.snippets}
					expanded={editor.expanded}
					nameLabel={m.settings_snippets_name()}
					preview={(row) => firstLine(row.body)}
					dimmed={(row) => !row.enabled}
					query={editor.filter}
					searchText={(row) => [row.name, row.body]}
				>
					{#snippet trailing(row)}
						{@const label = snippetLabel(row)}
						{#if view.proAvailable && view.syncKinds.snippets}
							<SyncToggle
								pressed={row.sync}
								name={label}
								onchange={(sync) => {
									row.sync = sync;
									editor.snippets.save();
								}}
							/>
						{/if}
						<!-- 一覧から外すスイッチ。消さずに取っておける -->
						<Switch
							aria-label={label
								? m.settings_snippets_enabled({ name: label })
								: m.settings_snippets_enabled_unnamed()}
							bind:checked={
								() => row.enabled,
								(enabled) => {
									row.enabled = enabled;
									editor.snippets.save();
								}
							}
						/>
					{/snippet}
					{#snippet body(row)}
						<div class="flex flex-col gap-1.5">
							<span id="snippet-{row.key}-body" class="text-xs text-muted-foreground">
								{m.settings_snippets_body()}
							</span>
							<Textarea
								class="min-h-16 text-sm"
								autocomplete="off"
								autocapitalize="off"
								spellcheck={false}
								aria-labelledby="snippet-{row.key}-body"
								bind:value={
									() => row.body,
									(body) => {
										row.body = body ?? '';
										editor.snippets.save();
									}
								}
							/>
						</div>
					{/snippet}
				</ReorderableRows>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						onclick={() => focusFirstField(`row-${editor.addSnippet()}`)}
					>
						<PlusIcon data-icon="inline-start" />
						{m.settings_snippets_add()}
					</Button>
				</div>
			</SettingsRow>
		</SettingsSection>
	</div>
</div>
