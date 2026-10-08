//! AI のアクション。
//! 利用者が選んだ AI サービスへ、アクションの指示文と実行する文を送り、結果の文を受け取る。
//! 送った内容と受け取った結果はログに書かない。記録するのは、始めた・終えた・取り消した・失敗の種類だけ

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::actions::{ActionError, Failure, TEXT_MARK};

/// AI のアクションに使う AI サービス。足すときは、ここに名前・既定のモデル・資格情報の名前・送る処理を足す
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "lowercase")]
pub enum AiService {
    #[default]
    None,
    /// Mawok のアカウントの残高で、作者のキーで使う（窓口を通して Gemini へ送る。account.rs）
    Mawok,
    Gemini,
    Anthropic,
    OpenAi,
}

impl AiService {
    pub const ALL: [AiService; 5] = [
        AiService::None,
        AiService::Mawok,
        AiService::Gemini,
        AiService::Anthropic,
        AiService::OpenAi,
    ];

    /// 設定ファイルと画面とのやり取りでの名前
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Mawok => "mawok",
            Self::Gemini => "gemini",
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|service| service.name() == name)
    }

    /// 既定のモデル。軽くて速い安定版にする（2026-09 の時点で、Gemini API の docs/models で安定版として出ているもの、
    /// Claude API の models の一覧で最も軽いもの、OpenAI の models で最も安い系列のうち、推論の既定が none のもの。
    /// OpenAI は推論の量を送らずに済むものにする。送ると、受け付けないモデルに替えたときに断られるため）
    pub fn default_model(self) -> &'static str {
        match self {
            // モデルは窓口が決める
            Self::None | Self::Mawok => "",
            Self::Gemini => "gemini-3.5-flash-lite",
            Self::Anthropic => "claude-haiku-4-5",
            Self::OpenAi => "gpt-5.4-nano",
        }
    }

    /// 資格情報管理に置くときの名前（secrets.rs の user）
    pub fn credential_user(self) -> &'static str {
        match self {
            Self::None => "",
            // キーの代わりに、アカウントと結んで受け取ったトークンを置く
            Self::Mawok => "mawok-account-token",
            Self::Gemini => "gemini-api-key",
            Self::Anthropic => "anthropic-api-key",
            Self::OpenAi => "openai-api-key",
        }
    }
}

/// 問い合わせの時間の上限。つながらないときは早めに知らせ、返事は長めの文の書き直しでも待てるだけ待つ
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// Gemini の Interactions API（ai.google.dev/gemini-api/docs/interactions、api/interactions-api、2026-09 に確かめた）。
/// generateContent は Legacy の扱いで、新しいモデルは Interactions API で出すとあるので、こちらを使う
const GEMINI_INTERACTIONS_URL: &str = "https://generativelanguage.googleapis.com/v1/interactions";

/// Interactions API に送る本文。`store: false` で、やり取りを Google 側に保存させない
/// （保存は既定で有効。止めても、不正利用の監視のための保持は規約どおり残る）
fn gemini_request_body(model: &str, prompt: &Prompt) -> Value {
    let mut body = json!({
        "model": model,
        "input": prompt.user,
        "store": false,
    });
    if let Some(system) = &prompt.system {
        body["system_instruction"] = json!(system);
    }
    body
}

/// Claude API の Messages API（platform.claude.com/docs の api/messages、2026-09 に確かめた）
const ANTHROPIC_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// 返事の長さの上限（Messages API では必須）。書き直した文は元の文と同じくらいの長さなので、長めの下書きでも足りるだけ取る。
/// 止まらない返事を切るための天井で、実際に効くのは `TIMEOUT`（60 秒）のほう。上限まで書くほど長い結果は、先に時間切れになる
const ANTHROPIC_MAX_TOKENS: u32 = 16000;

/// OpenAI の Responses API（developers.openai.com の api/reference の responses/create、2026-09 に確かめた）。
/// 新しく作るアプリには、Chat Completions より Responses API を使うよう勧めている
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
/// Responses API に送る本文。`store: false` で、返事を OpenAI 側に保存させない
/// （保存は既定で有効で、30 日以上残る。止めても、不正利用の監視のための最大 30 日の保持は規約どおり残る）
/// `max_output_tokens` は送らない。モデルを自由に替えられるので、固定の値だと出力の上限が小さいモデル（gpt-4o は 16,384）と食い違う。
/// 送らなければモデルの上限まで書け、止まらない返事は `TIMEOUT` で切れる
fn openai_request_body(model: &str, prompt: &Prompt) -> Value {
    let mut body = json!({
        "model": model,
        "input": prompt.user,
        "store": false,
    });
    if let Some(system) = &prompt.system {
        body["instructions"] = json!(system);
    }
    body
}

/// Messages API に送る本文
fn anthropic_request_body(model: &str, prompt: &Prompt) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "messages": [{ "role": "user", "content": prompt.user }],
    });
    if let Some(system) = &prompt.system {
        body["system"] = json!(system);
    }
    body
}

/// AI サービスへ送る中身（docs/actions.md「AI（`@ai`）」）
#[derive(Debug, PartialEq, Eq)]
pub struct Prompt {
    /// 指示文。system（サービスごとの呼び名は system_instruction・instructions）として送る
    system: Option<String>,
    /// 利用者の発言として送る文
    user: String,
}

impl Prompt {
    /// 窓口へ送る形（account-server/src/ai.ts の Prompt）
    pub fn to_json(&self) -> Value {
        match &self.system {
            Some(system) => json!({ "system": system, "user": self.user }),
            None => json!({ "user": self.user }),
        }
    }

    /// 指示文に `{{t}}` があれば、実行する文に置き換えた指示文だけを送る。無ければ、指示文を system に、実行する文を利用者の発言にする。
    /// 実行する文が空なら、指示文だけを利用者の発言として送る
    pub fn new(instruction: &str, text: &str) -> Self {
        if instruction.contains(TEXT_MARK) {
            return Self {
                system: None,
                user: instruction.replace(TEXT_MARK, text),
            };
        }
        if text.is_empty() {
            return Self {
                system: None,
                user: instruction.to_string(),
            };
        }
        Self {
            system: Some(instruction.to_string()),
            user: text.to_string(),
        }
    }
}

/// キーをヘッダーに載せる値にする。ヘッダーに使えない文字を含むキーは、送るまでもなく無効
fn key_header(key: &str) -> Result<reqwest::header::HeaderValue, ActionError> {
    let mut key = reqwest::header::HeaderValue::from_str(key).map_err(|_| {
        ActionError::new(
            Failure::InvalidKey,
            "the key has characters that can't be sent",
        )
    })?;
    key.set_sensitive(true);
    Ok(key)
}

/// AI のアクションを実行する。`client` は使い回す
pub async fn send(
    client: &reqwest::Client,
    service: AiService,
    key: &str,
    model: &str,
    prompt: &Prompt,
) -> Result<String, ActionError> {
    if service == AiService::None {
        return Err(ActionError::new(
            Failure::Disabled,
            "no AI service selected",
        ));
    }
    if service == AiService::Mawok {
        return crate::account::send_ai(client, key, prompt).await;
    }
    // キーは URL に載せずにヘッダーで渡す（URL はプロキシなどのログに残ることがあるため）
    let request = match service {
        AiService::None | AiService::Mawok => unreachable!("handled above"),
        AiService::Gemini => client
            .post(GEMINI_INTERACTIONS_URL)
            .header("x-goog-api-key", key_header(key)?)
            .json(&gemini_request_body(model, prompt)),
        AiService::Anthropic => client
            .post(ANTHROPIC_MESSAGES_URL)
            .header("x-api-key", key_header(key)?)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&anthropic_request_body(model, prompt)),
        AiService::OpenAi => client
            .post(OPENAI_RESPONSES_URL)
            .header(
                reqwest::header::AUTHORIZATION,
                key_header(&format!("Bearer {key}"))?,
            )
            .json(&openai_request_body(model, prompt)),
    };
    let response = request.send().await.map_err(request_error)?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(request_error)?;
    match (service, (200..300).contains(&status)) {
        (AiService::None | AiService::Mawok, _) => unreachable!("handled above"),
        (AiService::Gemini, true) => read_gemini_response(&body),
        (AiService::Gemini, false) => Err(classify_gemini_error(status, &body)),
        (AiService::Anthropic, true) => read_anthropic_response(&body),
        (AiService::Anthropic, false) => Err(classify_anthropic_error(status, &body)),
        (AiService::OpenAi, true) => read_openai_response(&body),
        (AiService::OpenAi, false) => Err(classify_openai_error(status, &body)),
    }
}

/// 送れなかった、または返事を受け取りきれなかった
pub(crate) fn request_error(error: reqwest::Error) -> ActionError {
    // つなぐ間の時間切れは is_timeout と is_connect の両方が立つ。返事を待つ時間切れではなく、つながらなかったものとして扱う
    let failure = if error.is_connect() {
        Failure::Network
    } else if error.is_timeout() {
        Failure::Timeout
    } else if error.is_builder() {
        Failure::Unexpected
    } else {
        Failure::Network
    };
    // reqwest のエラーの文には URL が入るが、キーは URL に載せていない
    ActionError::new(failure, error.to_string())
}

/// 返事の本文を JSON として読む
fn parse_response(body: &str) -> Result<Value, ActionError> {
    serde_json::from_str(body).map_err(|error| {
        ActionError::new(Failure::Unexpected, format!("unreadable response: {error}"))
    })
}

/// 取り出した文の前後の空白と改行を取り除く（モデルが末尾に改行を付けることがあるため）。
/// 空なら失敗にし、`context`（返事の status など）をログに残す
fn output_text(text: &str, context: std::fmt::Arguments<'_>) -> Result<String, ActionError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ActionError::new(
            Failure::Unexpected,
            format!("no text in the response ({context})"),
        ));
    }
    Ok(text.to_string())
}

/// 失敗の返事の `error` の項目。本文が JSON として読めないか、項目がなければ None
fn error_object(body: &str) -> Option<Value> {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|mut value| value.get_mut("error").map(Value::take))
}

/// 成功の返事から、書き直した文を取り出す。
/// 形は `{ "status": "completed", "steps": [{ "type": "model_output", "content": [{ "type": "text", "text": "…" }] }] }`。
/// 考えた過程などほかの step は使わない。文の前後の空白と改行は取り除く（モデルが末尾に改行を付けることがあるため）
pub fn read_gemini_response(body: &str) -> Result<String, ActionError> {
    let value = parse_response(body)?;
    let status = value.get("status").and_then(Value::as_str);
    let error_codes = error_codes(&value);
    match status {
        // 同期の呼び出しでは completed が返る見込み。書いていなくても、文があれば読む
        Some("completed") | None => {}
        Some("failed") => {
            return Err(ActionError::new(
                Failure::ServiceError,
                format!("status failed, errors {error_codes:?}"),
            ))
        }
        // incomplete（出力の上限に達した）、cancelled、budget_exceeded など。途中までの文は使わない
        Some(other) => {
            return Err(ActionError::new(
                Failure::Unexpected,
                format!("status {other}, errors {error_codes:?}"),
            ))
        }
    }
    let text: String = value
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|step| step.get("type").and_then(Value::as_str) == Some("model_output"))
        .filter_map(|step| step.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    output_text(&text, format_args!("status {status:?}"))
}

/// Interaction の `errors[]` の `code`（エラーの種類を表す URI）
fn error_codes(value: &Value) -> Vec<String> {
    value
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|error| error.get("code").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// 失敗の返事（HTTP のエラー）を分類する。分けるのは、公式の文書の表にある HTTP ステータスだけにする
/// （Gemini API の api-errors の表。400 INVALID_ARGUMENT・403 PERMISSION_DENIED・404 NOT_FOUND・429 RESOURCE_EXHAUSTED・5xx）。
/// 本文の中の符号や reason は、Interactions API の文書に形がまとまっておらず、AI サービスの更新で変わりうるので、分類には使わずログにだけ残す。
/// 分けられないものは Unexpected にする。
/// - 400 は、本文の形の誤りのほか、キーが無効なときもこれで返るとされる（公式の表にはない）ので、原因を決めつけない Rejected にする
/// - 401・403 はキーが無効か、キーに権限がない
/// - 404 はモデルが見つからない（エンドポイントは固定なので、見つからないのはモデルと見る。2026-09 に実物で確かめた）
/// - 429 は回数や量の上限
/// - 5xx は AI サービス側
///
/// 詳しい中身（ログに残るほう）には、エラーの message を入れない（送った文の一部を含むことがありうるため）。
/// Rejected（400）のときだけ、message を画面向けの screen_detail に持たせる。ログには残さず、
/// 利用者自身の下書きの断片が返ってきても、本人の画面に出すだけなので構わない（原因の見分けの助けになる）
pub fn classify_gemini_error(status: u16, body: &str) -> ActionError {
    let error = error_object(body);
    let field = |name: &str| {
        error
            .as_ref()
            .and_then(|error| error.get(name))
            .map(|value| {
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_string)
            })
            .unwrap_or_default()
    };
    let failure = match status {
        400 => Failure::Rejected,
        401 | 403 => Failure::InvalidKey,
        404 => Failure::ModelNotFound,
        429 => Failure::RateLimited,
        500..=599 => Failure::ServiceError,
        _ => Failure::Unexpected,
    };
    ActionError::new(
        failure,
        format!(
            "HTTP {status}, code {:?}, status {:?}",
            field("code"),
            field("status")
        ),
    )
    .with_service_message(field("message"))
}

/// 成功の返事から、書き直した文を取り出す。
/// 形は `{ "type": "message", "content": [{ "type": "text", "text": "…" }], "stop_reason": "end_turn" }`。
/// 考えた過程（thinking）などほかの種類の部分は使わない。文の前後の空白と改行は取り除く
pub fn read_anthropic_response(body: &str) -> Result<String, ActionError> {
    let value = parse_response(body)?;
    let stop_reason = value.get("stop_reason").and_then(Value::as_str);
    match stop_reason {
        Some("end_turn") | Some("stop_sequence") | None => {}
        // max_tokens（出力の上限に達した）、refusal（安全上の理由で断られた）など。途中までの文は使わない
        Some(other) => {
            return Err(ActionError::new(
                Failure::Unexpected,
                format!("stop reason {other}"),
            ))
        }
    }
    let text: String = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    output_text(&text, format_args!("stop reason {stop_reason:?}"))
}

/// 失敗の返事（HTTP のエラー）を分類する。Gemini と同じく、公式の文書の表にある HTTP ステータスだけで分ける
/// （Claude API の errors の表。400 invalid_request_error・401 authentication_error・402 billing_error・
/// 403 permission_error・404 not_found_error・413 request_too_large・429 rate_limit_error・500 api_error・529 overloaded_error）。
/// - 400・413（大きすぎる）は断られた（Rejected）
/// - 402（支払いの問題）は利用額やクレジットの上限（Billing）
/// - 401・403 はキーが無効か、キーに権限がない
/// - 404 はモデルが見つからない（使えないモデルも同じ返事になる）
/// - 429 は回数や量の上限
/// - 5xx（混んでいるときの 529 を含む）は AI サービス側
///
/// 詳しい中身（ログに残るほう）には、エラーの type だけを入れ、message は入れない（送った文の一部を含むことがありうるため）。
/// Rejected（400・413）のときだけ、message を画面向けの screen_detail に持たせる（Gemini と同じ理由。classify_gemini_error を参照）
pub fn classify_anthropic_error(status: u16, body: &str) -> ActionError {
    let error = error_object(body);
    let error_type = error
        .as_ref()
        .and_then(|error| error.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    let failure = match status {
        400 | 413 => Failure::Rejected,
        402 => Failure::Billing,
        401 | 403 => Failure::InvalidKey,
        404 => Failure::ModelNotFound,
        429 => Failure::RateLimited,
        500..=599 => Failure::ServiceError,
        _ => Failure::Unexpected,
    };
    let message = error
        .as_ref()
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    ActionError::new(failure, format!("HTTP {status}, type {error_type:?}"))
        .with_service_message(message)
}

/// 成功の返事から、書き直した文を取り出す。
/// 形は `{ "status": "completed", "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "…" }] }] }`。
/// SDK にある output_text は生の返事には無いので、message の output_text をつなぐ。推論（reasoning）などほかの項目は使わない。
/// 200 でも status が incomplete（出力の上限など）や failed のことがあり、断ったときは content に refusal が入る
pub fn read_openai_response(body: &str) -> Result<String, ActionError> {
    let value = parse_response(body)?;
    let status = value.get("status").and_then(Value::as_str);
    match status {
        Some("completed") => {}
        Some("failed") => {
            let code = value
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(ActionError::new(
                Failure::ServiceError,
                format!("status failed, code {code:?}"),
            ));
        }
        // status は必ず入るので、無いものは崩れた返事として扱う
        None => return Err(ActionError::new(Failure::Unexpected, "status missing")),
        // incomplete（出力の上限など）、cancelled など。途中までの文は使わない
        Some(other) => {
            let reason = value
                .get("incomplete_details")
                .and_then(|details| details.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(ActionError::new(
                Failure::Unexpected,
                format!("status {other}, reason {reason:?}"),
            ));
        }
    }
    let parts: Vec<&Value> = value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .collect();
    if parts
        .iter()
        .any(|part| part.get("type").and_then(Value::as_str) == Some("refusal"))
    {
        return Err(ActionError::new(Failure::Unexpected, "refused"));
    }
    let text: String = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    output_text(&text, format_args!("status {status:?}"))
}

/// 利用額やクレジットの上限を表す、OpenAI のエラーの code。429 で返るが、やり直しても直らない
/// （developers.openai.com の api/docs/guides/error-codes。type は insufficient_quota のこともある）
const OPENAI_BILLING_CODES: [&str; 4] = [
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
];

/// 失敗の返事（HTTP のエラー）を分類する。Gemini・Anthropic と同じく、公式の文書の表にある HTTP ステータスで分ける
/// （OpenAI の error-codes のガイド。400・401・403・429・500・503）。
/// - 400 は断られた（Rejected）
/// - 401 はキーが無効。403 は、キーに権限がない（権限を絞ったキー）か、対応していない地域から呼んだ
/// - 404 はモデルが見つからない（公式のガイドには無いが、存在しないか使えないモデルでこれが返る）
/// - 429 は回数や量の上限。ただし公式のガイドが code で見分けるよう書いている、利用額やクレジットの上限は Billing
/// - 5xx は AI サービス側
///
/// 詳しい中身（ログに残るほう）には、エラーの type と code だけを入れ、message は入れない（送った文の一部を含むことがありうるため）。
/// Rejected（400）のときだけ、message を画面向けの screen_detail に持たせる（Gemini と同じ理由。classify_gemini_error を参照）
pub fn classify_openai_error(status: u16, body: &str) -> ActionError {
    let error = error_object(body);
    let field = |name: &str| {
        error
            .as_ref()
            .and_then(|error| error.get(name))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let (error_type, code) = (field("type"), field("code"));
    let failure = match status {
        400 => Failure::Rejected,
        401 | 403 => Failure::InvalidKey,
        404 => Failure::ModelNotFound,
        429 if error_type == "insufficient_quota"
            || OPENAI_BILLING_CODES.contains(&code.as_str()) =>
        {
            Failure::Billing
        }
        429 => Failure::RateLimited,
        500..=599 => Failure::ServiceError,
        _ => Failure::Unexpected,
    };
    ActionError::new(
        failure,
        format!("HTTP {status}, type {error_type:?}, code {code:?}"),
    )
    .with_service_message(field("message"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_the_text_into_the_instruction_or_after_it() {
        assert_eq!(
            Prompt::new("指示", "下書き"),
            Prompt {
                system: Some("指示".into()),
                user: "下書き".into()
            }
        );
        assert_eq!(
            Prompt::new("「{{t}}」を{{t}}の順に", "文"),
            Prompt {
                system: None,
                user: "「文」を文の順に".into()
            }
        );
        assert_eq!(
            Prompt::new("献立を考えて", ""),
            Prompt {
                system: None,
                user: "献立を考えて".into()
            }
        );
        // system が無ければ、どのサービスにも送らない
        let prompt = Prompt::new("献立を考えて", "");
        assert!(gemini_request_body("m", &prompt)
            .get("system_instruction")
            .is_none());
        assert!(anthropic_request_body("m", &prompt).get("system").is_none());
        assert!(openai_request_body("m", &prompt)
            .get("instructions")
            .is_none());
    }

    #[test]
    fn builds_the_request_without_storing_it() {
        let body = gemini_request_body("gemini-3.5-flash-lite", &Prompt::new("指示", "下書き"));
        assert_eq!(
            body,
            json!({
                "model": "gemini-3.5-flash-lite",
                "system_instruction": "指示",
                "input": "下書き",
                "store": false,
            })
        );
    }

    #[test]
    fn reads_the_model_output_text() {
        let body = r#"{
            "id": "abc",
            "status": "completed",
            "steps": [
                { "type": "user_input", "content": [{ "type": "text", "text": "下書き" }] },
                { "type": "thought", "content": [{ "type": "text", "text": "考え中" }] },
                { "type": "model_output", "content": [
                    { "type": "text", "text": "リライトした" },
                    { "type": "text", "text": "文です。\n" }
                ] }
            ]
        }"#;
        assert_eq!(read_gemini_response(body).unwrap(), "リライトした文です。");
    }

    #[test]
    fn treats_an_unfinished_or_empty_response_as_a_failure() {
        for (body, failure) in [
            (
                r#"{ "status": "incomplete", "steps": [{ "type": "model_output", "content": [{ "type": "text", "text": "途中" }] }] }"#,
                Failure::Unexpected,
            ),
            (
                r#"{ "status": "completed", "steps": [] }"#,
                Failure::Unexpected,
            ),
            (
                r#"{ "status": "failed", "errors": [{ "code": "https://example/internal", "message": "x" }] }"#,
                Failure::ServiceError,
            ),
            ("not json", Failure::Unexpected),
        ] {
            assert_eq!(
                read_gemini_response(body).unwrap_err().failure,
                failure,
                "{body}"
            );
        }
    }

    #[test]
    fn classifies_error_responses() {
        let google = |code: u16, status: &str, reason: &str| {
            format!(
                r#"{{ "error": {{ "code": {code}, "message": "送った文を含むかもしれない", "status": "{status}", "details": [{{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "{reason}" }}] }} }}"#
            )
        };
        for (status, body, failure) in [
            (
                400,
                google(400, "INVALID_ARGUMENT", "API_KEY_INVALID"),
                Failure::Rejected,
            ),
            (
                403,
                google(403, "PERMISSION_DENIED", ""),
                Failure::InvalidKey,
            ),
            (404, google(404, "NOT_FOUND", ""), Failure::ModelNotFound),
            (
                429,
                google(429, "RESOURCE_EXHAUSTED", ""),
                Failure::RateLimited,
            ),
            (503, google(503, "UNAVAILABLE", ""), Failure::ServiceError),
            // 2026-09 に存在しないモデルで実物が返した形
            (
                404,
                r#"{ "error": { "code": "not_found", "message": "x" } }"#.to_string(),
                Failure::ModelNotFound,
            ),
            // 本文の符号では分けない
            (
                418,
                r#"{ "error": { "code": "safety_blocked", "message": "x" } }"#.to_string(),
                Failure::Unexpected,
            ),
            (
                502,
                "<html>Bad Gateway</html>".to_string(),
                Failure::ServiceError,
            ),
        ] {
            let error = classify_gemini_error(status, &body);
            assert_eq!(error.failure, failure, "{status} {body}");
            assert!(
                !error.detail.contains("送った文"),
                "the message isn't logged"
            );
            // Rejected のときだけ、画面向けに message を持つ（ログには残さない）
            if failure == Failure::Rejected {
                assert_eq!(
                    error.screen_detail.as_deref(),
                    Some("送った文を含むかもしれない"),
                    "{status} {body}"
                );
            } else {
                assert_eq!(error.screen_detail, None, "{status} {body}");
            }
        }
    }

    #[test]
    fn builds_the_anthropic_request() {
        let body = anthropic_request_body("claude-haiku-4-5", &Prompt::new("指示", "下書き"));
        assert_eq!(
            body,
            json!({
                "model": "claude-haiku-4-5",
                "max_tokens": 16000,
                "system": "指示",
                "messages": [{ "role": "user", "content": "下書き" }],
            })
        );
    }

    #[test]
    fn reads_the_anthropic_text() {
        let body = r#"{
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "", "signature": "x" },
                { "type": "text", "text": "リライトした" },
                { "type": "text", "text": "文です。\n" }
            ],
            "stop_reason": "end_turn"
        }"#;
        assert_eq!(
            read_anthropic_response(body).unwrap(),
            "リライトした文です。"
        );
    }

    #[test]
    fn treats_an_unfinished_or_empty_anthropic_response_as_a_failure() {
        for body in [
            r#"{ "content": [{ "type": "text", "text": "途中" }], "stop_reason": "max_tokens" }"#,
            r#"{ "content": [{ "type": "text", "text": "x" }], "stop_reason": "refusal" }"#,
            r#"{ "content": [], "stop_reason": "end_turn" }"#,
            r#"{ "content": [{ "type": "text", "text": "  \n" }], "stop_reason": "end_turn" }"#,
            "not json",
        ] {
            assert_eq!(
                read_anthropic_response(body).unwrap_err().failure,
                Failure::Unexpected,
                "{body}"
            );
        }
    }

    #[test]
    fn classifies_anthropic_error_responses() {
        let anthropic = |kind: &str| {
            format!(
                r#"{{ "type": "error", "error": {{ "type": "{kind}", "message": "送った文を含むかもしれない" }}, "request_id": "req_01" }}"#
            )
        };
        for (status, body, failure) in [
            (400, anthropic("invalid_request_error"), Failure::Rejected),
            (401, anthropic("authentication_error"), Failure::InvalidKey),
            (402, anthropic("billing_error"), Failure::Billing),
            (403, anthropic("permission_error"), Failure::InvalidKey),
            (404, anthropic("not_found_error"), Failure::ModelNotFound),
            (413, anthropic("request_too_large"), Failure::Rejected),
            (429, anthropic("rate_limit_error"), Failure::RateLimited),
            (500, anthropic("api_error"), Failure::ServiceError),
            (529, anthropic("overloaded_error"), Failure::ServiceError),
            (418, anthropic("something_new"), Failure::Unexpected),
            (
                502,
                "<html>Bad Gateway</html>".to_string(),
                Failure::ServiceError,
            ),
        ] {
            let error = classify_anthropic_error(status, &body);
            assert_eq!(error.failure, failure, "{status} {body}");
            assert!(
                !error.detail.contains("送った文"),
                "the message isn't logged"
            );
            if failure == Failure::Rejected {
                assert_eq!(
                    error.screen_detail.as_deref(),
                    Some("送った文を含むかもしれない"),
                    "{status} {body}"
                );
            } else {
                assert_eq!(error.screen_detail, None, "{status} {body}");
            }
        }
    }

    #[test]
    fn builds_the_openai_request_without_storing_it() {
        let body = openai_request_body("gpt-5.4-nano", &Prompt::new("指示", "下書き"));
        assert_eq!(
            body,
            json!({
                "model": "gpt-5.4-nano",
                "instructions": "指示",
                "input": "下書き",
                "store": false,
            })
        );
    }

    #[test]
    fn reads_the_openai_text() {
        let body = r#"{
            "id": "resp_01",
            "object": "response",
            "status": "completed",
            "error": null,
            "output": [
                { "type": "reasoning", "id": "rs_01", "summary": [] },
                { "type": "message", "role": "assistant", "content": [
                    { "type": "output_text", "text": "リライトした", "annotations": [] },
                    { "type": "output_text", "text": "文です。\n", "annotations": [] }
                ] }
            ]
        }"#;
        assert_eq!(read_openai_response(body).unwrap(), "リライトした文です。");
    }

    #[test]
    fn treats_an_unfinished_refused_or_empty_openai_response_as_a_failure() {
        for (body, failure) in [
            (
                r#"{ "status": "incomplete", "incomplete_details": { "reason": "max_output_tokens" }, "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "途中" }] }] }"#,
                Failure::Unexpected,
            ),
            (
                r#"{ "status": "completed", "output": [{ "type": "message", "content": [{ "type": "refusal", "refusal": "できません" }] }] }"#,
                Failure::Unexpected,
            ),
            (
                r#"{ "status": "failed", "error": { "code": "server_error", "message": "x" }, "output": [] }"#,
                Failure::ServiceError,
            ),
            (
                r#"{ "status": "completed", "output": [] }"#,
                Failure::Unexpected,
            ),
            (
                r#"{ "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "文" }] }] }"#,
                Failure::Unexpected,
            ),
            ("not json", Failure::Unexpected),
        ] {
            assert_eq!(
                read_openai_response(body).unwrap_err().failure,
                failure,
                "{body}"
            );
        }
    }

    #[test]
    fn classifies_openai_error_responses() {
        let openai = |kind: &str, code: &str| {
            format!(
                r#"{{ "error": {{ "message": "送った文を含むかもしれない", "type": "{kind}", "param": null, "code": "{code}" }} }}"#
            )
        };
        for (status, body, failure) in [
            (400, openai("invalid_request_error", ""), Failure::Rejected),
            (
                401,
                openai("invalid_request_error", "invalid_api_key"),
                Failure::InvalidKey,
            ),
            (
                403,
                openai(
                    "invalid_request_error",
                    "unsupported_country_region_territory",
                ),
                Failure::InvalidKey,
            ),
            (
                404,
                openai("invalid_request_error", "model_not_found"),
                Failure::ModelNotFound,
            ),
            (
                429,
                openai("requests", "rate_limit_exceeded"),
                Failure::RateLimited,
            ),
            (
                429,
                openai("insufficient_quota", "credit_balance_exhausted"),
                Failure::Billing,
            ),
            (
                429,
                openai("insufficient_quota", "insufficient_quota"),
                Failure::Billing,
            ),
            (
                429,
                openai("requests", "project_spend_limit_exceeded"),
                Failure::Billing,
            ),
            (500, openai("server_error", ""), Failure::ServiceError),
            (
                503,
                openai("service_unavailable_error", "server_is_overloaded"),
                Failure::ServiceError,
            ),
            (418, openai("something_new", ""), Failure::Unexpected),
        ] {
            let error = classify_openai_error(status, &body);
            assert_eq!(error.failure, failure, "{status} {body}");
            assert!(
                !error.detail.contains("送った文"),
                "the message isn't logged"
            );
            if failure == Failure::Rejected {
                assert_eq!(
                    error.screen_detail.as_deref(),
                    Some("送った文を含むかもしれない"),
                    "{status} {body}"
                );
            } else {
                assert_eq!(error.screen_detail, None, "{status} {body}");
            }
        }
    }

    #[test]
    fn service_names_round_trip() {
        for service in AiService::ALL {
            assert_eq!(AiService::from_name(service.name()), Some(service));
        }
        assert_eq!(AiService::from_name("mistral"), None);
        assert_eq!(AiService::from_name("OpenAI"), None);
        assert_eq!(AiService::from_name("Anthropic"), None);
    }
}
