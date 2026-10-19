//! 同期の鍵（docs/sync.md「同期のパスワード」）。データの鍵はデバイスで作り、利用者が決める同期のパスワードで包んで窓口に置く。
//! 窓口には、包んだ鍵と、この鍵から導いた見分けの印（`key_id`）だけを渡す。

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::{
    account_credentials,
    hex::{from_hex, to_hex},
};

const KEY_ID_INFO: &[u8] = b"mawok key id v1";
/// 包んだ鍵の関連データ。同期の項目の暗号文を、包んだ鍵として読ませないため。
const WRAP_AAD: &[u8] = b"mawok sync key v1";
const WRAP_VERSION: u32 = 1;
const KDF: &str = "argon2id";

/// 同期のパスワードの最短の文字数。画面の検査と同じ値を使う（`src/lib/bindings/constants.ts` へ書き出す）。
pub const MIN_PASSWORD_CHARS: usize = 8;

/// Argon2id のメモリー（KiB）。64 MiB は RFC 9106 の2つ目の推奨（メモリーが限られる環境向け）と Bitwarden の既定と同じで、
/// 8 GB の機械でも包む・開くときだけ確保して離すので、ほかの処理を圧迫しない。
const M_COST: u32 = 64 * 1024;
/// Argon2id の繰り返し。RFC 9106 の2つ目の推奨と同じ 3。パスワードを入れたときの一度だけなので、1 秒未満に収まる重さを選ぶ。
const T_COST: u32 = 3;
/// Argon2id の並列度。RFC 9106 の2つ目の推奨と同じ 4（並列に計算しなくても、結果と必要なメモリーは同じ）。
const P_COST: u32 = 4;
/// salt の長さ。RFC 9106 の推奨の 128 ビット。
const SALT_LEN: usize = 16;
/// 窓口から届いたパラメーターで、開くときに許す上限。窓口が値を大きくして、デバイスのメモリーや時間を使い切らせないため。
/// 下限はこの版が書く値（M_COST・T_COST・P_COST）で、窓口から軽い値を押し付けられて、漏れた包んだ鍵の総当たりが安くならないようにする。
/// 上限は、後の版が値を上げても前の版で開けるよう、メモリーは 4 倍（256 MiB）、繰り返しと並列度はおおむね 2〜4 倍までの幅を残す。
const MAX_M_COST: u32 = 4 * M_COST;
const MAX_T_COST: u32 = 8;
const MAX_P_COST: u32 = 8;

/// 同期の鍵の状態（docs/sync.md「同期のパスワード」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub enum SyncKeyStatus {
    /// Pro でないか、サインインしていない。窓口へつながらず手元にも鍵がないときもこの状態。
    None,
    /// 窓口に包んだ鍵が無い。このアカウントでまだ同期を始めていない。
    NotStarted,
    /// 窓口に包んだ鍵があり、手元の鍵が無いか違う。同期のパスワードを入れると揃う。
    NeedsPassword,
    /// 手元の鍵が窓口の鍵と同じ。窓口へつながらず、手元に鍵があるときもこの状態。
    Ready,
}

pub fn derive(key: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hkdf = Hkdf::<Sha256>::from_prk(key).expect("a 32-byte key is a valid HKDF PRK");
    let mut output = [0; 32];
    hkdf.expand(info, &mut output)
        .expect("the fixed HKDF output length is valid");
    output
}

pub fn key_id(key: &[u8; 32]) -> String {
    to_hex(&derive(key, KEY_ID_INFO))
}

/// 窓口の答え（`key_id` と包んだ鍵があるか）と手元の鍵から、状態を決める。
pub fn decide(
    server_key_id: Option<&str>,
    wrapped: bool,
    local: Option<&[u8; 32]>,
) -> SyncKeyStatus {
    // 包んだ鍵の無い `key_id` は、パスワードを入れても揃えられないので、始めていないのと同じに扱う
    if !wrapped {
        return SyncKeyStatus::NotStarted;
    }
    match (server_key_id, local) {
        (Some(server), Some(key)) if server == key_id(key) => SyncKeyStatus::Ready,
        _ => SyncKeyStatus::NeedsPassword,
    }
}

/// 窓口へつながらない間は、手元にある鍵だけで同期を続けるか決める。
pub fn offline_status(local: Option<&[u8; 32]>) -> SyncKeyStatus {
    if local.is_some() {
        SyncKeyStatus::Ready
    } else {
        SyncKeyStatus::None
    }
}

/// 同期のパスワードとして使える長さか。文字数は Unicode のコードポイントで数える（画面の `[...text].length` と同じ）。
pub fn password_long_enough(password: &str) -> bool {
    password.chars().count() >= MIN_PASSWORD_CHARS
}

pub fn generate() -> Result<[u8; 32], String> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|error| error.to_string())?;
    Ok(key)
}

/// 窓口に置く、包んだ鍵の形。窓口は中身を読まずに置く。salt とパラメーターを一緒に置き、開くときはそれを使う。
#[derive(Debug, Serialize, Deserialize)]
struct Wrapped {
    v: u32,
    kdf: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    key: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UnwrapError {
    /// 開けなかった。パスワードが違う（包んだ鍵が壊れているときも、見分けられないのでこれになる）
    WrongPassword,
    /// 形が違う・知らない版やパラメーター。新しい版が包んだ鍵など
    Unreadable(String),
}

struct Kdf {
    m: u32,
    t: u32,
    p: u32,
}

const KDF_PARAMS: Kdf = Kdf {
    m: M_COST,
    t: T_COST,
    p: P_COST,
};

fn password_key(password: &str, salt: &[u8], kdf: &Kdf) -> Result<[u8; 32], String> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|error| error.to_string())?;
    let mut out = [0; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|error| error.to_string())?;
    Ok(out)
}

/// データの鍵を同期のパスワードで包む。重いので、画面のスレッドでは呼ばない。
pub fn wrap(key: &[u8; 32], password: &str) -> Result<String, String> {
    wrap_with(key, password, &KDF_PARAMS)
}

fn wrap_with(key: &[u8; 32], password: &str, kdf: &Kdf) -> Result<String, String> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut salt).map_err(|error| error.to_string())?;
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new((&password_key(password, &salt, kdf)?).into());
    let sealed = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: key,
                aad: WRAP_AAD,
            },
        )
        .map_err(|_| "couldn't wrap the sync key".to_string())?;
    serde_json::to_string(&Wrapped {
        v: WRAP_VERSION,
        kdf: KDF.to_string(),
        m: kdf.m,
        t: kdf.t,
        p: kdf.p,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        key: STANDARD.encode(sealed),
    })
    .map_err(|error| error.to_string())
}

fn kdf_in_range(m: u32, t: u32, p: u32) -> bool {
    (M_COST..=MAX_M_COST).contains(&m)
        && (T_COST..=MAX_T_COST).contains(&t)
        && (P_COST..=MAX_P_COST).contains(&p)
}

/// 包んだ鍵を同期のパスワードで開く。重いので、画面のスレッドでは呼ばない。
pub fn unwrap(wrapped: &str, password: &str) -> Result<[u8; 32], UnwrapError> {
    let unreadable = |detail: &str| UnwrapError::Unreadable(detail.to_string());
    let wrapped: Wrapped = serde_json::from_str(wrapped)
        .map_err(|error| UnwrapError::Unreadable(error.to_string()))?;
    if wrapped.v != WRAP_VERSION || wrapped.kdf != KDF {
        return Err(unreadable("unknown wrapped key version"));
    }
    if !kdf_in_range(wrapped.m, wrapped.t, wrapped.p) {
        return Err(unreadable("the key derivation parameters are out of range"));
    }
    let decode = |value: &str| STANDARD.decode(value).map_err(|_| unreadable("not base64"));
    let salt = decode(&wrapped.salt)?;
    let nonce = decode(&wrapped.nonce)?;
    let sealed = decode(&wrapped.key)?;
    if salt.len() != SALT_LEN {
        return Err(unreadable("the salt has the wrong length"));
    }
    let kdf = Kdf {
        m: wrapped.m,
        t: wrapped.t,
        p: wrapped.p,
    };
    let cipher = XChaCha20Poly1305::new(
        (&password_key(password, &salt, &kdf).map_err(UnwrapError::Unreadable)?).into(),
    );
    let key = cipher
        .decrypt(
            &XNonce::try_from(nonce.as_slice())
                .map_err(|_| unreadable("the nonce has the wrong length"))?,
            Payload {
                msg: &sealed,
                aad: WRAP_AAD,
            },
        )
        .map_err(|_| UnwrapError::WrongPassword)?;
    key.try_into()
        .map_err(|_| unreadable("the wrapped key has the wrong length"))
}

pub fn decode(text: &str) -> Result<[u8; 32], String> {
    let bytes = from_hex(text).ok_or_else(|| "the sync key is not hexadecimal".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "the sync key has the wrong length".to_string())
}

pub fn load() -> Result<Option<[u8; 32]>, String> {
    match account_credentials::read_key() {
        Ok(value) => value.map(|value| decode(&value)).transpose(),
        Err(crate::secrets::ReadError::NotFound) => Ok(None),
        Err(crate::secrets::ReadError::Unreadable(error)) => Err(error),
    }
}

pub fn store(key: &[u8; 32]) -> Result<(), String> {
    account_credentials::write_key(&to_hex(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_a_fixed_key_id() {
        let key = [9; 32];
        assert_eq!(
            key_id(&key),
            "baa89c7b50d27cffc5f43a114d1d2877cd9627a0d09755aaf6f867fa4cac5eda"
        );
    }

    #[test]
    fn decides_status_from_the_server_and_the_local_key() {
        let key = [2; 32];
        let id = key_id(&key);
        assert_eq!(decide(None, false, None), SyncKeyStatus::NotStarted);
        assert_eq!(decide(None, false, Some(&key)), SyncKeyStatus::NotStarted);
        // 前の版が置いた、包んだ鍵の無い key_id
        assert_eq!(
            decide(Some(&id), false, Some(&key)),
            SyncKeyStatus::NotStarted
        );
        assert_eq!(decide(Some(&id), true, None), SyncKeyStatus::NeedsPassword);
        assert_eq!(
            decide(Some("other"), true, Some(&key)),
            SyncKeyStatus::NeedsPassword
        );
        assert_eq!(decide(Some(&id), true, Some(&key)), SyncKeyStatus::Ready);
    }

    #[test]
    fn keeps_a_local_key_ready_while_the_server_is_unreachable() {
        assert_eq!(offline_status(Some(&[2; 32])), SyncKeyStatus::Ready);
        assert_eq!(offline_status(None), SyncKeyStatus::None);
    }

    #[test]
    fn counts_password_length_in_characters() {
        assert!(!password_long_enough("1234567"));
        assert!(password_long_enough("12345678"));
        // 日本語は1文字を1つと数える（UTF-8 のバイト数ではない）
        assert!(!password_long_enough("あいうえおかき"));
        assert!(password_long_enough("あいうえおかきく"));
    }

    #[test]
    fn unwraps_keys_wrapped_by_earlier_versions() {
        // chacha20poly1305 0.10 で包んだ鍵。版を上げても、窓口に置いた鍵を開けること
        let wrapped = r#"{"v":1,"kdf":"argon2id","m":65536,"t":3,"p":4,"salt":"7RhWLLJE/Rg3iUhaa4/BNg==","nonce":"fqSSF+g/DZTkm152u9L3RUe22jabtoq1","key":"JIvCjIqpETPob7SeteSiRkAKtYQPFVWWw70OhR7znep1CjEatlmftCiPHG7RAMDX"}"#;
        assert_eq!(unwrap(wrapped, "correct horse"), Ok([7; 32]));
    }

    #[test]
    fn unwraps_with_the_same_password_only() {
        let key = [7; 32];
        let wrapped = wrap(&key, "correct horse").unwrap();
        assert_eq!(unwrap(&wrapped, "correct horse"), Ok(key));
        assert_eq!(
            unwrap(&wrapped, "correct hors"),
            Err(UnwrapError::WrongPassword)
        );
    }

    #[test]
    fn wraps_the_same_key_differently_each_time() {
        let key = [7; 32];
        let first = wrap(&key, "password").unwrap();
        let second = wrap(&key, "password").unwrap();
        assert_ne!(first, second);
        assert_eq!(unwrap(&second, "password"), Ok(key));
    }

    #[test]
    fn keeps_the_salt_and_parameters_with_the_wrapped_key() {
        let wrapped = wrap(&[1; 32], "password").unwrap();
        let value: Wrapped = serde_json::from_str(&wrapped).unwrap();
        assert_eq!((value.v, value.kdf.as_str()), (1, "argon2id"));
        assert_eq!((value.m, value.t, value.p), (64 * 1024, 3, 4));
        assert_eq!(STANDARD.decode(&value.salt).unwrap().len(), 16);
        // 開くときは、置いてあるパラメーターを使う
        assert_eq!(unwrap(&wrapped, "password"), Ok([1; 32]));
    }

    #[test]
    fn rejects_unknown_wrapped_keys_and_parameters_out_of_range() {
        let wrapped = wrap(&[1; 32], "password").unwrap();
        let original: serde_json::Value = serde_json::from_str(&wrapped).unwrap();
        let changed = |name: &str, value: serde_json::Value| {
            let mut changed = original.clone();
            changed[name] = value;
            unwrap(&changed.to_string(), "password")
        };
        let unreadable = |result: Result<[u8; 32], UnwrapError>| {
            matches!(result, Err(UnwrapError::Unreadable(_)))
        };
        assert!(unreadable(changed("v", 2.into())));
        // 窓口から軽い値を押し付けられても開かない（この版が書く値より下は断る）
        assert!(unreadable(changed("m", (M_COST - 1).into())));
        assert!(unreadable(changed("t", (T_COST - 1).into())));
        assert!(unreadable(changed("p", (P_COST - 1).into())));
        // 重すぎる値も、デバイスのメモリーや時間を使い切らないよう開かない
        assert!(unreadable(changed("m", (MAX_M_COST + 1).into())));
        assert!(unreadable(changed("t", (MAX_T_COST + 1).into())));
        // salt は長さちょうど
        assert!(unreadable(changed(
            "salt",
            STANDARD.encode([0u8; 17]).into()
        )));
        assert!(kdf_in_range(M_COST, T_COST, P_COST));
        assert!(matches!(
            unwrap("{", "password"),
            Err(UnwrapError::Unreadable(_))
        ));
    }
}
