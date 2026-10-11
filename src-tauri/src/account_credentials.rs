//! Mawok のアカウントのトークンと鍵を、1つの資格情報の項目に置く。

use std::sync::Mutex;

use log::warn;

use serde::{Deserialize, Serialize};

use crate::secrets::{self, ReadError};

pub const CREDENTIAL_USER: &str = "mawok-account";
const LEGACY_TOKEN_USER: &str = "mawok-account-token";
const LEGACY_KEY_USER: &str = "mawok-account-key";

/// 読んでから書く操作どうしが、片方の値を落とさないようにする。
static ACCESS: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Credentials {
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

fn to_json(credentials: &Credentials) -> String {
    serde_json::to_string(credentials).expect("account credentials are always serializable")
}

fn from_json(value: &str) -> Result<Credentials, String> {
    serde_json::from_str(value).map_err(|error| error.to_string())
}

fn with_key(mut credentials: Credentials, key: Option<&str>) -> Credentials {
    credentials.key = key.map(str::to_string);
    credentials
}

/// 項目の有無だけを確かめる。前のトークンだけがある間も、読む入口で移し替えられるように見つける。
pub fn exists() -> Result<bool, String> {
    if secrets::exists(CREDENTIAL_USER)? {
        return Ok(true);
    }
    secrets::exists(LEGACY_TOKEN_USER)
}

fn read_locked() -> Result<Credentials, ReadError> {
    match secrets::read(CREDENTIAL_USER) {
        Ok(value) => from_json(&value).map_err(ReadError::Unreadable),
        Err(ReadError::NotFound) => migrate_locked(),
        Err(error) => Err(error),
    }
}

/// 前の項目は、トークンを実際に読むときだけ移し替える。
fn migrate_locked() -> Result<Credentials, ReadError> {
    let token = match secrets::read(LEGACY_TOKEN_USER) {
        Ok(token) => token,
        Err(ReadError::NotFound) => return Err(ReadError::NotFound),
        Err(error) => return Err(error),
    };
    let key = match secrets::read(LEGACY_KEY_USER) {
        Ok(key) => Some(key),
        Err(ReadError::NotFound) => None,
        Err(error) => return Err(error),
    };
    let credentials = Credentials { token, key };
    secrets::write(CREDENTIAL_USER, &to_json(&credentials)).map_err(ReadError::Unreadable)?;
    // 新しい項目に書けていれば、値は読める。前の項目を消せなくても、読み取りは失敗にしない
    for user in [LEGACY_TOKEN_USER, LEGACY_KEY_USER] {
        if let Err(error) = secrets::delete(user) {
            warn!("couldn't delete the previous credential {user}: {error}");
        }
    }
    Ok(credentials)
}

pub fn read_token() -> Result<String, ReadError> {
    let _access = ACCESS.lock().unwrap();
    Ok(read_locked()?.token)
}

pub fn read_key() -> Result<Option<String>, ReadError> {
    let _access = ACCESS.lock().unwrap();
    Ok(read_locked()?.key)
}

/// サインインで受け取ったトークンを置く。前の中身は読まずに置き換える。
/// 鍵はサインインの前に消してあり（lib.rs の save_mawok_token）、読めない項目が残っていてもサインインできるようにするため
pub fn write_token(token: &str) -> Result<(), String> {
    let _access = ACCESS.lock().unwrap();
    secrets::write(
        CREDENTIAL_USER,
        &to_json(&Credentials {
            token: token.to_string(),
            key: None,
        }),
    )
}

pub fn write_key(key: &str) -> Result<(), String> {
    let _access = ACCESS.lock().unwrap();
    let credentials = read_locked().map_err(|error| match error {
        ReadError::NotFound => "the account token is missing".to_string(),
        ReadError::Unreadable(error) => error,
    })?;
    secrets::write(CREDENTIAL_USER, &to_json(&with_key(credentials, Some(key))))
}

pub fn clear_key() -> Result<(), String> {
    let _access = ACCESS.lock().unwrap();
    let credentials = match read_locked() {
        Ok(credentials) => credentials,
        Err(ReadError::NotFound) => return Ok(()),
        Err(ReadError::Unreadable(error)) => return Err(error),
    };
    secrets::write(CREDENTIAL_USER, &to_json(&with_key(credentials, None)))
}

pub fn delete() -> Result<(), String> {
    let _access = ACCESS.lock().unwrap();
    // 前の項目を先に消す。残ったまま新しい項目だけを消すと、次に読むときに前のトークンが移されて、サインインした状態に戻る
    secrets::delete(LEGACY_TOKEN_USER)?;
    secrets::delete(LEGACY_KEY_USER)?;
    secrets::delete(CREDENTIAL_USER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_a_token_without_a_key() {
        let credentials = Credentials {
            token: "token".to_string(),
            key: None,
        };
        let value = to_json(&credentials);
        assert_eq!(value, r#"{"token":"token"}"#);
        assert_eq!(from_json(&value), Ok(credentials));
    }

    #[test]
    fn formats_a_token_and_key() {
        let credentials = Credentials {
            token: "token".to_string(),
            key: Some("key".to_string()),
        };
        let value = to_json(&credentials);
        assert_eq!(value, r#"{"token":"token","key":"key"}"#);
        assert_eq!(from_json(&value), Ok(credentials));
    }

    #[test]
    fn removes_the_key_without_changing_the_token() {
        let credentials = from_json(r#"{"token":"token","key":"key"}"#).unwrap();
        assert_eq!(
            to_json(&with_key(credentials, None)),
            r#"{"token":"token"}"#
        );
    }

    #[test]
    fn rejects_broken_json() {
        assert!(from_json("{").is_err());
    }

    #[test]
    fn rejects_a_value_without_a_token() {
        assert!(from_json(r#"{"key":"key"}"#).is_err());
    }
}
