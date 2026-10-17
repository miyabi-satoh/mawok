<script lang="ts">
	import SyncToggle from '$lib/components/sync-toggle.svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ReorderableRows from '$lib/components/reorderable-rows.svelte';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SettingsSyncNote from '$lib/components/settings-sync-note.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { m } from '$lib/paraglide/messages';
	import type { SnippetsEditor } from '$lib/snippets-editor.svelte';
	import { ENCODINGS, OUTPUTS } from '$lib/action-options';
	import { rowAddressee } from '$lib/addressee';
	import { firstLine } from '$lib/snippets';
	import ListFilter from '$lib/components/list-filter.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import { focusFirstField } from '$lib/focus-field';
	import { showsFilter } from '$lib/list-filter';
	import type { ActionEncoding, ActionOutput, SettingsView } from '$lib/settings.svelte';

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
						{#if view.proAvailable && view.syncKinds.snippets}
							<SyncToggle
								pressed={row.sync}
								name={row.name || firstLine(row.body)}
								onchange={(sync) => {
									row.sync = sync;
									editor.snippets.save();
								}}
							/>
						{/if}
						<!-- 一覧から外すスイッチ。消さずに取っておくのは、挿入する文でも実行する行でも同じなので、どの行にも出す -->
						<Switch
							aria-label={row.name || firstLine(row.body)
								? m.settings_snippets_enabled({ name: row.name || firstLine(row.body) })
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
						{@const addressee = rowAddressee(row.body)}
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
						<!-- 結果の出し方は `@ai`・`@sh` の行にだけ、文字コードは `@sh` の標準入力と標準出力にだけ効くので、効く行でだけ出す -->
						{#if addressee}
							<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
								<Field.Title
									id="snippet-{row.key}-output"
									class="text-xs font-normal text-muted-foreground"
								>
									{m.settings_snippets_output()}
								</Field.Title>
								<ToggleGroup.Root
									type="single"
									variant="outline"
									size="sm"
									aria-labelledby="snippet-{row.key}-output"
									bind:value={
										() => row.output,
										(output) => {
											if (!output || output === row.output) return;
											row.output = output as ActionOutput;
											editor.snippets.save();
										}
									}
								>
									{#each OUTPUTS as { value, name } (value)}
										<ToggleGroup.Item {value}>{name()}</ToggleGroup.Item>
									{/each}
								</ToggleGroup.Root>
							</Field.Field>
							{#if !addressee.ai}
								<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
									<Field.Title
										id="snippet-{row.key}-encoding"
										class="text-xs font-normal text-muted-foreground"
									>
										{m.settings_snippets_encoding()}
									</Field.Title>
									<NativeSelect.Root
										size="sm"
										aria-labelledby="snippet-{row.key}-encoding"
										bind:value={
											() => row.encoding,
											(encoding) => {
												if (!encoding || encoding === row.encoding) return;
												row.encoding = encoding as ActionEncoding;
												editor.snippets.save();
											}
										}
									>
										{#each ENCODINGS as { value, name } (value)}
											<NativeSelect.Option {value}>{name}</NativeSelect.Option>
										{/each}
									</NativeSelect.Root>
								</Field.Field>
							{/if}
						{/if}
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
					<Button variant="outline" size="sm" onclick={() => editor.addDefaultSnippets()}>
						{m.settings_snippets_add_defaults()}
					</Button>
				</div>
			</SettingsRow>
		</SettingsSection>
	</div>
</div>
