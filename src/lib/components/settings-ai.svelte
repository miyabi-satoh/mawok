<script lang="ts">
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import { untrack } from 'svelte';
	import SettingsModifiedMark from '$lib/components/settings-modified-mark.svelte';
	import SettingsRow from '$lib/components/settings-row.svelte';
	import SettingsSection from '$lib/components/settings-section.svelte';
	import SettingSyncToggle from '$lib/components/setting-sync-toggle.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import { isImeKey } from '$lib/keys';
	import { mawokRemainingText } from '$lib/mawok-account';
	import { modifiedName } from '$lib/modified-settings';
	import { m } from '$lib/paraglide/messages';
	import type { SnippetsEditor } from '$lib/snippets-editor.svelte';
	import { AI_SERVICES, aiServiceInfo, normalizeBaseUrl } from '$lib/ai-services';
	import { CONSTANTS } from '$lib/bindings/constants';
	import type { AccountStatus } from '$lib/bindings/AccountStatus';
	import type { AiService, SettingsView } from '$lib/settings.svelte';

	/**
	 * 設定画面の「AI」の分類。宛先 `@ai` が使う AI サービスと、そのキー・モデル・了解。
	 * 設定画面は、この分類を開いたときだけ描く。キーがあるかの確認でキーチェーンの許可を求められうるので、開いたときに確かめる。
	 * モデルの編集中の内容は、分類を移っても消えないよう、設定画面の本体が持つ
	 */
	let {
		view,
		editor,
		mawokAccountStatus,
		onopenaccount
	}: {
		view: SettingsView;
		editor: SnippetsEditor;
		mawokAccountStatus: AccountStatus | null | undefined;
		onopenaccount: () => void;
	} = $props();

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
		if (service !== 'none' && hasKey === true && !view.aiConsented && consent === null) {
			consentService = service;
			consentBaseUrl = view.aiBaseUrl;
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
	/** 了解を求めている送り先のベース URL。出している間に替わっても、読んでもらった送り先への了解として送る */
	let consentBaseUrl = '';
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
		await editor.call('consent_ai', { service, baseUrl: consentBaseUrl });
	}

	/** 今の AI サービスの既定のモデル */
	const defaultModel = $derived(view.defaultAiModels[editor.modelService] ?? '');
	/**
	 * モデルの欄を打って空にしている途中か。欄は既定のときも既定のモデルを値として見せる（空の欄では、既定が効いているのか分からないため）が、
	 * 打って消している途中にまで既定を出すと、消した端から戻って打ち直せない。離れたら既定を出す
	 */
	let modelCleared = $state(false);

	/**
	 * ベース URL の欄。打っている間は保存せず、離れたときか Enter で保存する。送り先が変わると了解を取り直すので、
	 * 打つたびに保存すると、打ち終える前に了解を求めてしまう。欄は既定のときも OpenAI の URL を値として見せる（モデルの欄と同じ）
	 */
	let baseUrlInput = $state(untrack(() => view.aiBaseUrl || CONSTANTS.OPENAI_BASE_URL));
	let baseUrlError = $state('');
	let editingBaseUrl = false;
	$effect(() => {
		const url = view.aiBaseUrl;
		if (untrack(() => editingBaseUrl)) return;
		baseUrlInput = url || CONSTANTS.OPENAI_BASE_URL;
		baseUrlError = '';
	});

	async function saveBaseUrl() {
		const url = normalizeBaseUrl(baseUrlInput);
		if (url === null) {
			baseUrlError = m.settings_ai_base_url_invalid();
			return;
		}
		baseUrlError = '';
		baseUrlInput = url || CONSTANTS.OPENAI_BASE_URL;
		if (url === view.aiBaseUrl) return;
		// 保存できなければ、欄を今の送り先に戻す。打った URL のままだと、送り先が替わったように見える
		if (!(await editor.call('set_ai_base_url', { url })).ok) {
			baseUrlInput = view.aiBaseUrl || CONSTANTS.OPENAI_BASE_URL;
			return;
		}
		// キーは送り先ごとに置くので、替えた先のキーを確かめ直す
		await checkKey(view.aiService);
	}

	async function setService(service: AiService) {
		consentService = null;
		await editor.call('set_ai_service', { service });
	}
</script>

<SettingsSection>
	<SettingsRow modified={modifiedName(view, 'ai_service')}>
		<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
			<div class="flex flex-auto items-center gap-1">
				<Field.Title id="ai-service">{m.settings_ai_service()}</Field.Title>
				<SettingSyncToggle
					{view}
					name="ai_service"
					label={m.settings_ai_service()}
					call={editor.call}
				/>
			</div>
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
			{aiServiceInfo(view.aiService, view.aiBaseUrl).description()}
		</Field.Description>
		<!-- キーとモデルは選んだ AI サービスのものなので、サービスの下に字下げして置く。区切りの線は引かない -->
		{#if view.aiService === 'mawok'}
			<div class="mt-2 flex flex-col gap-5 pl-4">
				<Field.Content>
					<Field.Field orientation="horizontal" class="min-h-8 flex-wrap">
						<!-- クレジットは Mawok の AI を使うときだけのものなので、残りと買い足しはここにだけ出す -->
						{#if view.mawokAccountSignedIn}
							<Field.Title>{mawokRemainingText(mawokAccountStatus)}</Field.Title>
							<Button variant="outline" onclick={() => editor.call('open_mawok_buy_page')}>
								{m.settings_mawok_buy()}
							</Button>
						{:else}
							<Field.Title>{m.settings_ai_mawok_sign_in()}</Field.Title>
							<Button variant="outline" onclick={onopenaccount}>
								{m.settings_account_open()}
							</Button>
						{/if}
					</Field.Field>
				</Field.Content>
			</div>
		{:else if view.aiService !== 'none'}
			{@const modified = modifiedName(view, 'ai_models')}
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
									{m.common_cancel()}
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
				<Field.Content class="relative" data-modified={modified}>
					{#if modified}
						<SettingsModifiedMark class="inset-y-0 -left-4" />
					{/if}
					<!-- 題名は縮めない。Field の horizontal が題名に flex-auto を当てるので、! で上書きする -->
					<Field.Field
						orientation="horizontal"
						class="min-h-8 *:data-[slot=field-label]:flex-none!"
					>
						<Field.Label for="ai-model">{m.settings_ai_model()}</Field.Label>
						<SettingSyncToggle
							{view}
							name="ai_models"
							label={m.settings_ai_model()}
							call={editor.call}
						/>
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
				{#if view.aiService === 'openai'}
					{@const baseUrlModified = modifiedName(view, 'ai_base_url')}
					<Field.Content class="relative" data-modified={baseUrlModified}>
						{#if baseUrlModified}
							<SettingsModifiedMark class="inset-y-0 -left-4" />
						{/if}
						<Field.Field
							orientation="horizontal"
							class="min-h-8 *:data-[slot=field-label]:flex-none!"
						>
							<Field.Label for="ai-base-url">{m.settings_ai_base_url()}</Field.Label>
							<SettingSyncToggle
								{view}
								name="ai_base_url"
								label={m.settings_ai_base_url()}
								call={editor.call}
							/>
							<Input
								id="ai-base-url"
								class="w-72 min-w-0 font-mono text-sm"
								autocomplete="off"
								spellcheck={false}
								aria-invalid={baseUrlError !== ''}
								bind:value={baseUrlInput}
								onfocus={() => (editingBaseUrl = true)}
								onblur={() => {
									editingBaseUrl = false;
									saveBaseUrl();
								}}
								onkeydown={(event) => {
									if (event.key === 'Enter' && !isImeKey(event)) saveBaseUrl();
								}}
							/>
						</Field.Field>
						{#if baseUrlError}
							<Field.Error>{baseUrlError}</Field.Error>
						{/if}
						<Field.Description class="leading-snug">
							{m.settings_ai_base_url_description()}
						</Field.Description>
					</Field.Content>
				{/if}
			</div>
		{/if}
	</SettingsRow>
</SettingsSection>

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
					service: aiServiceInfo(consentService ?? view.aiService, view.aiBaseUrl).name()
				})}
			</AlertDialog.Title>
			<AlertDialog.Description>
				<div class="flex flex-col gap-2 text-left">
					<p>{m.settings_ai_consent_what()}</p>
					<p>{aiServiceInfo(consentService ?? view.aiService, view.aiBaseUrl).consentWhere()}</p>
					<p>{aiServiceInfo(consentService ?? view.aiService, view.aiBaseUrl).consentHandling()}</p>
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
