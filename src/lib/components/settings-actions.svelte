<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { untrack } from 'svelte';
	import ReorderableRows from '$lib/components/reorderable-rows.svelte';
	import SettingsMawokAccount from '$lib/components/settings-mawok-account.svelte';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { isImeKey } from '$lib/keys';
	import { m } from '$lib/paraglide/messages';
	import type { ActionsEditor } from '$lib/actions-editor.svelte';
	import { aiInstruction, hasDelayedExpansionChars, TEXT_MARK } from '$lib/action-target';
	import ListFilter from '$lib/components/list-filter.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import { focusFirstField } from '$lib/focus-field';
	import { showsFilter } from '$lib/list-filter';
	import { AI_SERVICES, aiServiceInfo } from '$lib/ai-services';
	import type { ActionEncoding, ActionOutput, AiService, SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定画面の「アクション」の分類。
	 * 設定画面は、この分類を開いたときだけ描く。キーがあるかの確認はこの分類を開いたときに行う。
	 * アクションとモデルの編集中の内容は、分類を移っても消えないよう、設定画面の本体が持つ
	 */
	let { view, editor }: { view: SettingsView; editor: ActionsEditor } = $props();

	/**
	 * キーがあるかを確かめた結果と、どの AI サービスのものか。hasKey は確かめられなかったとき null。
	 * 替える前のサービスの結果を、今のサービスのものとして出さないよう、サービスと組にして持つ
	 */
	let keyState = $state<{ service: AiService; hasKey: boolean | null } | null>(null);
	/** 今の AI サービスのキーがあるか。まだ確かめていなければ undefined、確かめられなかったときは null */
	const hasKey = $derived(keyState?.service === view.aiService ? keyState.hasKey : undefined);
	/**
	 * キーを確かめるたびに振る番号。後から確かめ始めていれば、先の確かめの返事は古いので捨てる
	 * （遅れて返った前のサービスの確かめが、替えた後の表示を上書きしないため）
	 */
	let keyRequest = 0;

	async function checkKey(service: AiService, options?: { keepError?: boolean }) {
		if (service === 'none') {
			keyState = null;
			return;
		}
		const request = ++keyRequest;
		const result = await editor.call<boolean>('has_ai_key', undefined, options);
		if (request !== keyRequest || service !== view.aiService) return;
		keyState = { service, hasKey: result.ok ? result.value : null };
	}

	/**
	 * AI サービスが替わったら（この画面から替えたときも、ほかから替わって settings-changed が届いたときも）、
	 * 替えた先のキーを確かめ直し、モデルの欄を替えた先のものにする。分類を開いたときもここで確かめる。
	 * 了解の記録が無いサービスにキーがあれば、ここで了解を求める。
	 */
	let shownService: AiService | null = null;
	$effect(() => {
		const service = view.aiService;
		if (service === shownService) return;
		shownService = service;
		// 了解を求めているサービスと表示中のサービスが替わったら、前のダイアログをやめる
		if (consentService !== null && consentService !== service) consentService = null;
		if (editingKeyFor !== null && editingKeyFor !== service) cancelEditingKey();
		if (editor.modelService !== service) editor.switchService(view.aiModels, service);
		checkKey(service);
	});
	$effect(() => {
		const service = view.aiService;
		const consent = untrack(() => consentService);
		if (service !== 'none' && hasKey === true && view.aiConsent !== service && consent === null) {
			consentService = service;
		}
	});

	/**
	 * キーを打っている AI サービス。null なら打っていない。打ったキーは保存したら欄から消し、画面に残さない。
	 * サービスが替わったら、打ちかけのキーは前のサービスのものなので、欄を閉じる
	 */
	let editingKeyFor = $state<AiService | null>(null);
	/**
	 * 了解を求めている AI サービス。null ならダイアログを出していない。
	 * 出している間に設定が替わっても、読んでもらったのと同じサービスへの了解として送る（替わっていれば Rust 側が断る）
	 */
	let consentService = $state<AiService | null>(null);
	const editingKey = $derived(editingKeyFor === view.aiService);
	let keyInput = $state('');

	function startEditingKey() {
		keyInput = '';
		editingKeyFor = view.aiService;
	}

	function cancelEditingKey() {
		keyInput = '';
		editingKeyFor = null;
	}

	/**
	 * キーを入れる・消す操作が終わったら、成功でも失敗でも、返事を表示に決めつけずに今の AI サービスのキーを確かめ直す。
	 * Rust 側は返事の時点のサービスのキーを変えるので、待つ間にサービスが替わっていたら、どちらのキーを変えたか分からない。
	 * 確かめ直しは操作が終わった後に読むので、保存を済ませたキーを読める。
	 * キーを保存したら、前に了解していても了解のダイアログを出す。
	 */
	async function saveKey() {
		const key = keyInput.trim();
		if (!key) return;
		const service = view.aiService;
		const saved = (await editor.call('set_ai_key', { key })).ok;
		if (saved && service === view.aiService) cancelEditingKey();
		await checkKey(service, { keepError: !saved });
	}

	async function deleteKey() {
		const deleted = (await editor.call('delete_ai_key')).ok;
		await checkKey(view.aiService, { keepError: !deleted });
	}

	async function acceptConsent() {
		const service = consentService;
		consentService = null;
		if (!service || service === 'none' || service !== view.aiService) return;
		await editor.call('consent_ai', { service });
	}

	/** 今の AI サービスの既定のモデル */
	const defaultModel = $derived(view.defaultAiModels[editor.modelService] ?? '');
	/**
	 * モデルの欄を打って空にしている途中か。欄は既定のときも既定のモデルを値として見せる（空の欄では、既定が効いているのか分からないため）が、
	 * 打って消している途中にまで既定を出すと、消した端から戻って打ち直せない。離れたら既定を出す
	 */
	let modelCleared = $state(false);

	/** 結果の出し方の選択肢 */
	const OUTPUTS: { value: ActionOutput; name: () => string }[] = [
		{ value: 'replace', name: m.settings_actions_output_replace },
		{ value: 'insert', name: m.settings_actions_output_insert },
		{ value: 'none', name: m.settings_actions_output_none }
	];

	/** コマンドの文字コードの選択肢（docs/actions.md「コマンド」）。名前は文字コードの名前なので、表示言語で変えない */
	const ENCODINGS: { value: ActionEncoding; name: string }[] = [
		{ value: 'utf-8', name: 'UTF-8' },
		{ value: 'shift_jis', name: 'Shift_JIS' },
		{ value: 'euc-jp', name: 'EUC-JP' },
		{ value: 'iso-2022-jp', name: 'JIS (ISO-2022-JP)' },
		{ value: 'utf-16le', name: 'UTF-16 LE' }
	];

	async function setService(service: AiService) {
		consentService = null;
		await editor.call('set_ai_service', { service });
	}
</script>

<!-- 画面の題名と同じ見出しをカードに重ねず、説明は題名のすぐ下に一度だけ置く。よく触るアクションの並びを先に出す -->
<div class="flex flex-col gap-5">
	<div class="flex flex-col gap-3">
		<p id="actions-description" class="settings-lead">
			{m.settings_actions_description({ mark: TEXT_MARK })}
		</p>
		<SettingsSection>
			<SettingsRow>
				{#if showsFilter(editor.actions.rows.length, editor.filter)}
					<ListFilter label={m.settings_actions_filter()} bind:value={editor.filter} />
				{/if}
				<ReorderableRows
					list={editor.actions}
					expanded={editor.expanded}
					nameLabel={m.settings_actions_name()}
					preview={(row) => row.command}
					monoPreview
					dimmed={(row) => !row.enabled}
					query={editor.filter}
					searchText={(row) => [row.name, row.command]}
				>
					{#snippet trailing(row)}
						<Switch
							aria-label={row.name || row.command
								? m.settings_actions_enabled({ name: row.name || row.command })
								: m.settings_actions_enabled_unnamed()}
							bind:checked={
								() => row.enabled,
								(enabled) => {
									row.enabled = enabled;
									editor.actions.save();
								}
							}
						/>
					{/snippet}
					{#snippet body(row)}
						<div class="flex flex-col gap-1.5">
							<span id="action-{row.id}-body" class="text-xs text-muted-foreground">
								{m.settings_actions_command()}
							</span>
							<!--
								`@ai` の指示文は長くなりがちなので、折り返して見える複数行の欄にする。コマンドは1行なので、Enter では改行を入れない
							-->
							<Textarea
								class="min-h-16 font-mono text-sm"
								onkeydown={(event) => {
									if (event.key === 'Enter' && !isImeKey(event)) event.preventDefault();
								}}
								autocomplete="off"
								autocapitalize="off"
								spellcheck={false}
								aria-labelledby="action-{row.id}-body"
								aria-describedby={view.platform === 'windows' &&
								hasDelayedExpansionChars(row.command)
									? `actions-description action-${row.id}-special`
									: 'actions-description'}
								bind:value={
									() => row.command,
									(command) => {
										row.command = command ?? '';
										editor.actions.save();
									}
								}
							/>
							{#if view.platform === 'windows' && hasDelayedExpansionChars(row.command)}
								<p id="action-{row.id}-special" class="text-xs leading-snug text-muted-foreground">
									{m.settings_actions_command_special_chars({ mark: TEXT_MARK })}
								</p>
							{/if}
						</div>
						<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
							<Field.Title
								id="action-{row.id}-output"
								class="text-xs font-normal text-muted-foreground"
							>
								{m.settings_actions_output()}
							</Field.Title>
							<ToggleGroup.Root
								type="single"
								variant="outline"
								size="sm"
								aria-labelledby="action-{row.id}-output"
								bind:value={
									() => row.output,
									(output) => {
										if (!output || output === row.output) return;
										row.output = output as ActionOutput;
										editor.actions.save();
									}
								}
							>
								{#each OUTPUTS as { value, name } (value)}
									<ToggleGroup.Item {value}>{name()}</ToggleGroup.Item>
								{/each}
							</ToggleGroup.Root>
						</Field.Field>
						<!-- 文字コードはコマンドの標準入力と標準出力にだけ効くので、`@ai` の行では出さない -->
						{#if aiInstruction(row.command) === null}
							<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
								<Field.Title
									id="action-{row.id}-encoding"
									class="text-xs font-normal text-muted-foreground"
								>
									{m.settings_actions_encoding()}
								</Field.Title>
								<NativeSelect.Root
									size="sm"
									aria-labelledby="action-{row.id}-encoding"
									bind:value={
										() => row.encoding,
										(encoding) => {
											if (!encoding || encoding === row.encoding) return;
											row.encoding = encoding as ActionEncoding;
											editor.actions.save();
										}
									}
								>
									{#each ENCODINGS as { value, name } (value)}
										<NativeSelect.Option {value}>{name}</NativeSelect.Option>
									{/each}
								</NativeSelect.Root>
							</Field.Field>
						{/if}
					{/snippet}
				</ReorderableRows>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						onclick={() => focusFirstField(`row-${editor.addAction()}`)}
					>
						<PlusIcon data-icon="inline-start" />
						{m.settings_actions_add()}
					</Button>
					<Button variant="outline" size="sm" onclick={() => editor.addDefaultActions()}>
						{m.settings_actions_add_defaults()}
					</Button>
				</div>
			</SettingsRow>
		</SettingsSection>
	</div>
	<SettingsSection>
		<SettingsRow>
			<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
				<Field.Title id="ai-service">{m.settings_ai_service()}</Field.Title>
				<!-- 5つ並べると最小の幅に収まらないので、ボタンの並びではなく一覧から選ぶ -->
				<NativeSelect.Root
					aria-labelledby="ai-service"
					bind:value={
						() => view.aiService,
						(service) => {
							if (service && service !== view.aiService) setService(service as AiService);
						}
					}
				>
					{#each AI_SERVICES as { value, name } (value)}
						<NativeSelect.Option {value}>{name()}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
			<Field.Description class="leading-snug">
				{aiServiceInfo(view.aiService).description()}
			</Field.Description>
			<!-- キーとモデルは選んだ AI サービスのものなので、サービスの下に字下げして置く。区切りの線は引かない -->
			{#if view.aiService === 'mawok'}
				<!-- Mawok はキーとモデルの代わりに、アカウントと残りを出す -->
				<div class="mt-2 flex flex-col gap-5 pl-4">
					<SettingsMawokAccount
						call={editor.call}
						signedIn={hasKey}
						onchanged={() => checkKey(view.aiService)}
					/>
				</div>
			{:else if view.aiService !== 'none'}
				<div class="mt-2 flex flex-col gap-5 pl-4">
					<Field.Content>
						<!-- 狭いときは、題名を折らずに操作を次の行へ回す -->
						<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
							<Field.Title>{m.settings_ai_key()}</Field.Title>
							{#if editingKey}
								<div class="flex items-center gap-2">
									<Input
										type="password"
										class="w-56 font-mono text-sm"
										autocomplete="off"
										aria-label={m.settings_ai_key_input()}
										bind:value={keyInput}
										onkeydown={(event) => {
											if (event.key === 'Enter' && !isImeKey(event)) saveKey();
										}}
										{@attach (input) => input.focus()}
									/>
									<Button variant="outline" disabled={!keyInput.trim()} onclick={saveKey}>
										{m.settings_ai_key_save()}
									</Button>
									<Button variant="ghost" onclick={cancelEditingKey}>
										{m.settings_ai_key_cancel()}
									</Button>
								</div>
							{:else if hasKey !== undefined}
								<!-- キーの中身は伏せ字でも出さず、入っているかだけを出す -->
								<div class="flex items-center gap-2">
									<span class="flex items-center gap-1.5 text-sm text-muted-foreground">
										{#if hasKey}
											<CircleCheckIcon aria-hidden="true" class="size-4" />
										{/if}
										<span>
											{hasKey === true
												? m.settings_ai_key_present()
												: hasKey === false
													? m.settings_ai_key_absent()
													: m.settings_ai_key_unknown()}
										</span>
									</span>
									<Button variant="outline" onclick={startEditingKey}>
										{hasKey ? m.settings_ai_key_replace() : m.settings_ai_key_enter()}
									</Button>
									{#if hasKey}
										<Button variant="outline" onclick={deleteKey}>
											{m.settings_ai_key_delete()}
										</Button>
									{/if}
								</div>
							{/if}
						</Field.Field>
					</Field.Content>
					<Field.Content>
						<!-- 題名は縮めない。Field の horizontal が題名に flex-auto を当てるので、! で上書きする -->
						<Field.Field
							orientation="horizontal"
							class="min-h-8 *:data-[slot=field-label]:flex-none!"
						>
							<Field.Label for="ai-model">{m.settings_ai_model()}</Field.Label>
							<Input
								id="ai-model"
								class="w-56 min-w-0 font-mono text-sm"
								autocomplete="off"
								spellcheck={false}
								bind:value={
									() => editor.model || (modelCleared ? '' : defaultModel),
									(value) => {
										modelCleared = value === '';
										// 既定と同じ名前は、既定として保存する。既定が替わったときに付いていけるように
										editor.setModel(value === defaultModel ? '' : value);
									}
								}
								onblur={() => (modelCleared = false)}
							/>
						</Field.Field>
						<Field.Description class="leading-snug">
							{m.settings_ai_model_description()}
						</Field.Description>
					</Field.Content>
				</div>
			{/if}
		</SettingsRow>
	</SettingsSection>
</div>

<!-- 了解は表示中のサービスに対してだけ出す -->
<AlertDialog.Root
	bind:open={
		() => consentService !== null && consentService === view.aiService,
		(open) => {
			if (!open) consentService = null;
		}
	}
>
	<AlertDialog.Content
		onEscapeKeydown={(event) => event.preventDefault()}
		onInteractOutside={(event) => event.preventDefault()}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{m.settings_ai_consent_title({
					service: aiServiceInfo(consentService ?? view.aiService).name()
				})}
			</AlertDialog.Title>
			<AlertDialog.Description>
				<div class="flex flex-col gap-2 text-left">
					<p>{m.settings_ai_consent_what()}</p>
					<p>{aiServiceInfo(consentService ?? view.aiService).consentWhere()}</p>
					<p>{aiServiceInfo(consentService ?? view.aiService).consentHandling()}</p>
				</div>
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Action onclick={acceptConsent}>
				{m.settings_ai_consent_accept()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
