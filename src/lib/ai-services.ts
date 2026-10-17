import { m } from '$lib/paraglide/messages';
import { CONSTANTS } from '$lib/bindings/constants';
import type { AiService } from '$lib/settings.svelte';

type ServiceText = {
	name: () => string;
	description: () => string;
	consentWhere: () => string;
	consentHandling: () => string;
};

/**
 * サービスごとの表示の文言。種類と並びは Rust 側（ai::AiService::ALL）が決め、生成物から受け取る。
 * 名前は製品名なので訳さない。説明・送り先・扱いは、サービスの規約ごとに違うので、サービスごとに持つ
 */
const SERVICE_TEXT: Record<AiService, ServiceText> = {
	none: {
		name: m.settings_ai_service_none,
		description: m.settings_ai_service_description_none,
		consentWhere: () => '',
		consentHandling: () => ''
	},
	mawok: {
		name: () => 'Mawok',
		description: m.settings_ai_service_description_mawok,
		consentWhere: m.settings_ai_consent_where_mawok,
		consentHandling: m.settings_ai_consent_handling_mawok
	},
	gemini: {
		name: () => 'Gemini',
		description: m.settings_ai_service_description_gemini,
		consentWhere: m.settings_ai_consent_where_gemini,
		consentHandling: m.settings_ai_consent_handling_gemini
	},
	anthropic: {
		name: () => 'Anthropic',
		description: m.settings_ai_service_description_anthropic,
		consentWhere: m.settings_ai_consent_where_anthropic,
		consentHandling: m.settings_ai_consent_handling_anthropic
	},
	openai: {
		name: () => 'OpenAI',
		description: m.settings_ai_service_description_openai,
		consentWhere: m.settings_ai_consent_where_openai,
		consentHandling: m.settings_ai_consent_handling_openai
	}
};

export const AI_SERVICES = CONSTANTS.AI_SERVICES.map((value) => ({
	value,
	...SERVICE_TEXT[value]
}));

/**
 * サービスの項目。一覧に無い値は来ない（Rust 側が知らない名前を読まない）が、来たら先頭のものを使う。
 * OpenAI のベース URL を替えてあれば、送り先は OpenAI でなく互換のサービスなので、名前・説明・送り先・扱いをその URL のものにする
 */
export function aiServiceInfo(service: AiService, baseUrl = '') {
	const info = AI_SERVICES.find(({ value }) => value === service) ?? AI_SERVICES[0];
	if (service !== 'openai' || !baseUrl) return info;
	// 設定に置く URL は Rust が検査してあるが、読めなければ URL のまま出す（画面を落とさない）
	let host = baseUrl;
	try {
		host = new URL(baseUrl).host;
	} catch {
		// 上のまま
	}
	return {
		...info,
		name: () => host,
		description: () => m.settings_ai_service_description_openai_compatible({ host }),
		consentWhere: () => m.settings_ai_consent_where_openai_compatible({ url: baseUrl }),
		consentHandling: m.settings_ai_consent_handling_openai_compatible
	};
}

/**
 * 入れたベース URL を、設定に置く形に揃える（Rust の ai::normalize_base_url と同じ決まり）。受けられなければ null。
 * OpenAI の URL と同じなら空（既定）にする
 */
export function normalizeBaseUrl(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed === '') return '';
	if (trimmed.includes('?') || trimmed.includes('#')) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	const valid =
		(url.protocol === 'http:' || url.protocol === 'https:') &&
		url.hostname !== '' &&
		url.username === '' &&
		url.password === '';
	if (!valid) return null;
	// 置くのは解釈した後の形（ホストを小文字にするなど）
	const normalized = url.href.replace(/\/+$/, '');
	return normalized === CONSTANTS.OPENAI_BASE_URL ? '' : normalized;
}

/** AI サービスごとに設定したモデルのうち、そのサービスのもの。書いていなければ空（既定のモデル） */
export function modelFor(models: Partial<Record<AiService, string>>, service: AiService): string {
	return models[service] ?? '';
}
