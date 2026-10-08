//! AI のアクションで使う AI サービスのキーを、OS の資格情報管理に置く。
//! macOS はログインのキーチェーン、Windows は資格情報マネージャー。設定ファイルは人に見せることがあるので、キーは書かない。
//!
//! キーチェーンは、読むときに OS が許可を求めることがあり（ad-hoc 署名の版を入れ直した後など）、答えるまで呼んだスレッドが止まる。
//! ここの関数はどれも、メインスレッドから呼ばずに spawn_blocking などで呼ぶ

use std::sync::Arc;

use keyring_core::{api::CredentialStore, Entry, Error};

/// 資格情報の service。user に AI サービスごとの名前（`gemini-api-key` など）を入れて、サービスごとに分けて置く
const SERVICE: &str = "com.amiiby.mawok";

/// キーを読めなかった理由
#[derive(Debug)]
pub enum ReadError {
    /// 置いていない
    NotFound,
    /// 置いてあるかもしれないが読めない（キーチェーンの許可を拒んだ、資格情報管理が使えないなど）。詳しい中身はログに残す
    Unreadable(String),
}

#[cfg(target_os = "macos")]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    let store: Arc<CredentialStore> = apple_native_keyring_store::keychain::Store::new()?;
    Ok(store)
}

#[cfg(windows)]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    let store: Arc<CredentialStore> = windows_native_keyring_store::Store::new()?;
    Ok(store)
}

/// 対応していない OS（開発で Linux の型チェックをするときなど）
#[cfg(not(any(target_os = "macos", windows)))]
fn store() -> keyring_core::Result<Arc<CredentialStore>> {
    Err(Error::NotSupportedByStore(
        "no credential store on this OS".to_string(),
    ))
}

fn entry(user: &str) -> keyring_core::Result<Entry> {
    store()?.build(SERVICE, user, None)
}

/// キーを読む
pub fn read(user: &str) -> Result<String, ReadError> {
    match entry(user).and_then(|entry| entry.get_password()) {
        Ok(key) => Ok(key),
        Err(Error::NoEntry) => Err(ReadError::NotFound),
        Err(error) => Err(ReadError::Unreadable(error.to_string())),
    }
}

/// キーを置く。すでにあれば置き換える
pub fn write(user: &str, key: &str) -> Result<(), String> {
    entry(user)
        .and_then(|entry| entry.set_password(key))
        .map_err(|error| error.to_string())
}

/// キーを消す。もともとなければ何もしない
pub fn delete(user: &str) -> Result<(), String> {
    match entry(user).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// キーが置いてあるか。設定画面を開いただけで許可を求めないよう、中身は読まない。
/// macOS は属性だけを引く検索にする（中身を読む find_generic_password は、許可を求めることがある）
#[cfg(target_os = "macos")]
pub fn exists(user: &str) -> Result<bool, String> {
    let spec = std::collections::HashMap::from([("service", SERVICE), ("user", user)]);
    store()
        .and_then(|store| store.search(&spec))
        .map(|found| !found.is_empty())
        .map_err(|error| error.to_string())
}

/// キーが置いてあるか。Windows の資格情報マネージャーは読むときに許可を求めないので、属性を読んで確かめる
#[cfg(not(target_os = "macos"))]
pub fn exists(user: &str) -> Result<bool, String> {
    match entry(user).and_then(|entry| entry.get_attributes()) {
        Ok(_) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}
