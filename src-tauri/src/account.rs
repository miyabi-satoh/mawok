//! Mawok のアカウントの窓口（mawok.amiiby.com。docs/account-server.md「窓口（mawok.amiiby.com）」）とのやり取り。
//! AI サービスの「Mawok」で使う。アカウントと結んで受け取ったトークンは、API キーと同じく OS の資格情報管理に置く。
//! トークンはログにも URL にも載せない

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::actions::{ActionError, Failure};
use crate::ai::Prompt;

/// 窓口の URL。開発版は手元で動かす窓口（`just dev-account-server`）を使う
#[cfg(not(debug_assertions))]
pub const ACCOUNT_URL: &str = "https://mawok.amiiby.com";
#[cfg(debug_assertions)]
pub const ACCOUNT_URL: &str = "http://127.0.0.1:8787";

/// 結ぶ申し込みの値（docs/account-server.md「Mawok とアカウントを結ぶ」）。
/// `verifier` は Mawok だけが持ち、窓口には SHA-256 の `challenge` を渡す。`state` は戻ってきた要求が自分の申し込みかを見る
pub struct LinkRequest {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl LinkRequest {
    pub fn new() -> Result<Self, String> {
        let verifier = random_hex::<32>()?;
        Ok(Self {
            challenge: crate::lan::to_hex(&Sha256::digest(verifier.as_bytes())),
            verifier,
            state: random_hex::<16>()?,
        })
    }

    /// ブラウザで開く、窓口の結ぶ画面の URL。`port` は Mawok が待ち受けている 127.0.0.1 のポート
    pub fn url(&self, port: u16, name: &str, lang: &str) -> String {
        let port = port.to_string();
        reqwest::Url::parse_with_params(
            &format!("{ACCOUNT_URL}/account/link"),
            [
                ("port", port.as_str()),
                ("state", self.state.as_str()),
                ("challenge", self.challenge.as_str()),
                ("name", name),
                ("lang", lang),
            ],
        )
        .map(String::from)
        .unwrap_or_default()
    }
}

/// 待ち受けに届いた要求の1行目（`GET /callback?code=…&state=… HTTP/1.1`）から、結んだときのコードを読む。
/// `state` の申し込みの、結ぶ画面から戻った要求でなければ `None`
pub fn code_from(state: &str, request_line: &str) -> Option<String> {
    let target = request_line.strip_prefix("GET ")?.split(' ').next()?;
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let param = |key: &str| {
        url.query_pairs()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
    };
    (param("state")? == state)
        .then(|| param("code"))
        .flatten()
        .filter(|code| !code.is_empty())
}

fn random_hex<const N: usize>() -> Result<String, String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(crate::lan::to_hex(&bytes))
}

/// 窓口に問い合わせて分かった、アカウントの様子
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub email: String,
    /// 残りの割合（切り上げ。使い切ったときだけ 0）
    pub remaining_percent: u32,
    /// LAN で同じアカウントかを見分けるための、窓口のランダムなアカウントID
    pub account_id: String,
    pub pro: ProStatus,
}

/// 窓口が答えた Pro の状態。試用中も active になる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ProStatus {
    pub active: bool,
    pub until: Option<u64>,
    pub plan: Option<String>,
    pub trial: bool,
}

/// 窓口とのやり取りの失敗
#[derive(Debug)]
pub enum AccountError {
    /// トークンが外された（窓口の画面で外した、アカウントを消したなど）。サインインし直す
    SignedOut,
    /// つながらない、または窓口が思わない答えを返した。詳しい中身はログに残す
    Other(String),
}

fn other(error: impl std::fmt::Display) -> AccountError {
    AccountError::Other(error.to_string())
}

/// 結んだときのコードを、アプリ用のトークンに替える。つながらない・混んでいる・窓口の不調のときは、少し待って試し直す
/// （コードは窓口で照らす前に消えるので、断られたときは試し直さない）
pub async fn exchange_code(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
) -> Result<String, AccountError> {
    let mut last = other("not tried");
    for attempt in 0..3u64 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(attempt)).await;
        }
        let response = match client
            .post(format!("{ACCOUNT_URL}/v1/links/token"))
            .json(&json!({ "code": code, "code_verifier": verifier }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last = other(error);
                continue;
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            last = other(format!("HTTP {}", status.as_u16()));
            continue;
        }
        if !status.is_success() {
            return Err(other(format!("HTTP {}", status.as_u16())));
        }
        let body: Value = response.json().await.map_err(other)?;
        return body
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .ok_or_else(|| other("the answer has no token"));
    }
    Err(last)
}

fn bearer(token: &str) -> Result<reqwest::header::HeaderValue, String> {
    let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "the token has characters that can't be sent".to_string())?;
    value.set_sensitive(true);
    Ok(value)
}

/// アカウントのメールアドレス、残り、Pro を問い合わせる
pub async fn status(client: &reqwest::Client, token: &str) -> Result<AccountStatus, AccountError> {
    let response = client
        .get(format!("{ACCOUNT_URL}/v1/balance"))
        .header(
            reqwest::header::AUTHORIZATION,
            bearer(token).map_err(other)?,
        )
        .send()
        .await
        .map_err(other)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AccountError::SignedOut);
    }
    if !response.status().is_success() {
        return Err(other(format!("HTTP {}", response.status().as_u16())));
    }
    let body: Value = response.json().await.map_err(other)?;
    let pro = body
        .get("pro")
        .and_then(Value::as_object)
        .ok_or_else(|| other("the answer has no pro status"))?;
    let active = pro
        .get("active")
        .and_then(Value::as_bool)
        .ok_or_else(|| other("the Pro status has no active value"))?;
    let until = match pro.get("until") {
        Some(Value::Null) | None => None,
        Some(value) => Some(
            value
                .as_u64()
                .ok_or_else(|| other("the Pro status has an invalid until value"))?,
        ),
    };
    let trial = pro
        .get("trial")
        .and_then(Value::as_bool)
        .ok_or_else(|| other("the Pro status has no trial value"))?;
    let plan = match pro.get("plan") {
        Some(Value::Null) | None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|plan| !plan.is_empty())
                .ok_or_else(|| other("the Pro status has an invalid plan value"))?
                .to_string(),
        ),
    };
    let account_id = body
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| other("the answer has no account ID"))?;
    Ok(AccountStatus {
        email: body
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        remaining_percent: body
            .get("remaining_percent")
            .and_then(Value::as_u64)
            .map_or(0, |percent| percent.min(100) as u32),
        account_id,
        pro: ProStatus {
            active,
            until,
            plan,
            trial,
        },
    })
}

/// 同期の最初のページだけを読み、アカウントの鍵の見分けを得る。
pub async fn sync_key_id(
    client: &reqwest::Client,
    token: &str,
) -> Result<Option<String>, AccountError> {
    let response = client
        .get(format!("{ACCOUNT_URL}/v1/sync?since=0&limit=1"))
        .header(
            reqwest::header::AUTHORIZATION,
            bearer(token).map_err(other)?,
        )
        .send()
        .await
        .map_err(other)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AccountError::SignedOut);
    }
    if !response.status().is_success() {
        return Err(other(format!("HTTP {}", response.status().as_u16())));
    }
    let body: Value = response.json().await.map_err(other)?;
    match body.get("key_id") {
        Some(Value::Null) | None => Ok(None),
        Some(Value::String(key_id)) if !key_id.is_empty() => Ok(Some(key_id.clone())),
        _ => Err(other("the sync answer has an invalid key ID")),
    }
}

/// 鍵を失くしたときの同期の作り直し。鍵の見分けだけを窓口へ渡す。
pub async fn reset_sync(
    client: &reqwest::Client,
    token: &str,
    key_id: &str,
) -> Result<(), AccountError> {
    let response = client
        .post(format!("{ACCOUNT_URL}/v1/sync/reset"))
        .header(
            reqwest::header::AUTHORIZATION,
            bearer(token).map_err(other)?,
        )
        .json(&json!({ "key_id": key_id }))
        .send()
        .await
        .map_err(other)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AccountError::SignedOut);
    }
    if response.status().is_success() {
        Ok(())
    } else {
        Err(other(format!("HTTP {}", response.status().as_u16())))
    }
}

/// トークンを外す（Mawok でのサインアウト）。外せなくても、手元のトークンは消す（窓口の画面からも外せる）
pub async fn sign_out(client: &reqwest::Client, token: &str) -> Result<(), AccountError> {
    let response = client
        .delete(format!("{ACCOUNT_URL}/v1/token"))
        .header(
            reqwest::header::AUTHORIZATION,
            bearer(token).map_err(other)?,
        )
        .send()
        .await
        .map_err(other)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(other(format!("HTTP {}", response.status().as_u16())))
    }
}

/// 残高を買い足す入口。紹介サイトの料金ページは日本語だけなので、日本語でないときは
/// 窓口の最終確認の画面を、表示言語を付けて直に開く（条件と料金ページへの戻り道は、そこに揃っている）
pub fn buy_page_url(lang: &str) -> String {
    if lang == "ja" {
        format!("{ACCOUNT_URL}/pricing/")
    } else {
        format!("{ACCOUNT_URL}/account/buy?lang={lang}")
    }
}

/// Pro の料金は紹介サイトにまとめ、表示言語によらず同じ入口を開く。
pub fn pro_page_url() -> String {
    format!("{ACCOUNT_URL}/pricing/")
}

/// 窓口を通して AI に送る。窓口は Gemini の返事をそのまま返すので、読み方は Gemini と同じ
pub async fn send_ai(
    client: &reqwest::Client,
    token: &str,
    prompt: &Prompt,
) -> Result<String, ActionError> {
    let header =
        bearer(token).map_err(|detail| ActionError::new(Failure::SignInRequired, detail))?;
    let response = client
        .post(format!("{ACCOUNT_URL}/v1/ai"))
        .header(reqwest::header::AUTHORIZATION, header)
        .json(&prompt.to_json())
        .send()
        .await
        .map_err(crate::ai::request_error)?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(crate::ai::request_error)?;
    if (200..300).contains(&status) {
        return crate::ai::read_gemini_response(&body);
    }
    Err(classify_error(status, &body))
}

/// 窓口の失敗の返事を分類する（account-server/src/index.ts の `/v1/ai`）
fn classify_error(status: u16, body: &str) -> ActionError {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = value.get("error").and_then(Value::as_str).unwrap_or("");
    let failure = match (status, code) {
        (401, _) => Failure::SignInRequired,
        (402, _) => Failure::NoCredit,
        // 同じアカウントの前の中継が終わっていない（取り消した直後など）
        (409, _) => Failure::PreviousRunning,
        (413, _) => Failure::TextTooLong,
        // Gemini の失敗。状態だけが返る
        (502, "upstream") => match value.get("upstream_status").and_then(Value::as_u64) {
            Some(429) => Failure::RateLimited,
            _ => Failure::ServiceError,
        },
        (500..=599, _) => Failure::ServiceError,
        _ => Failure::Unexpected,
    };
    ActionError::new(
        failure,
        format!("account server: HTTP {status}, error {code:?}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_only_the_challenge_to_the_account_server() {
        let link = LinkRequest::new().unwrap();
        assert_eq!(link.verifier.len(), 64);
        assert_eq!(link.state.len(), 32);
        assert_eq!(
            link.challenge,
            crate::lan::to_hex(&Sha256::digest(link.verifier.as_bytes()))
        );
        let url = reqwest::Url::parse(&link.url(53682, "Taro の Mac", "ja")).unwrap();
        let params: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(params.contains(&("port".into(), "53682".into())));
        assert!(params.contains(&("challenge".into(), link.challenge.clone())));
        assert!(params.contains(&("name".into(), "Taro の Mac".into())));
        assert!(!url.as_str().contains(&link.verifier));
    }

    #[test]
    fn reads_the_code_only_from_its_own_callback() {
        let link = LinkRequest::new().unwrap();
        let line = |target: String| format!("GET {target} HTTP/1.1");
        assert_eq!(
            code_from(
                &link.state,
                &line(format!("/callback?code=abc&state={}", link.state))
            ),
            Some("abc".to_string())
        );
        // ほかの申し込みの戻り、ほかのパス、コードの無い要求は受けない
        assert_eq!(
            code_from(
                &link.state,
                &line("/callback?code=abc&state=other".to_string())
            ),
            None
        );
        assert_eq!(
            code_from(
                &link.state,
                &line(format!("/favicon.ico?state={}", link.state))
            ),
            None
        );
        assert_eq!(
            code_from(
                &link.state,
                &line(format!("/callback?state={}", link.state))
            ),
            None
        );
        assert_eq!(
            code_from(
                &link.state,
                &format!("POST /callback?code=abc&state={} HTTP/1.1", link.state)
            ),
            None
        );
    }

    #[test]
    fn classifies_failures_from_the_account_server() {
        let failure = |status, body: &str| classify_error(status, body).failure;
        assert_eq!(
            failure(401, r#"{"error":"unauthorized"}"#),
            Failure::SignInRequired
        );
        assert_eq!(failure(402, r#"{"error":"no_credit"}"#), Failure::NoCredit);
        assert_eq!(
            failure(409, r#"{"error":"busy"}"#),
            Failure::PreviousRunning
        );
        assert_eq!(
            failure(413, r#"{"error":"too_long"}"#),
            Failure::TextTooLong
        );
        assert_eq!(
            failure(502, r#"{"error":"upstream","upstream_status":429}"#),
            Failure::RateLimited
        );
        assert_eq!(
            failure(502, r#"{"error":"upstream","upstream_status":500}"#),
            Failure::ServiceError
        );
        assert_eq!(failure(500, "Internal Server Error"), Failure::ServiceError);
        assert_eq!(
            failure(400, r#"{"error":"bad_request"}"#),
            Failure::Unexpected
        );
    }

    #[test]
    fn opens_the_pricing_page_only_in_japanese() {
        assert_eq!(buy_page_url("ja"), format!("{ACCOUNT_URL}/pricing/"));
        assert_eq!(
            buy_page_url("en"),
            format!("{ACCOUNT_URL}/account/buy?lang=en")
        );
    }
}
