//! アカウントごとの秘密鍵。窓口には、この鍵から導いた見分けの印だけを渡す。

use hkdf::Hkdf;
use sha2::Sha256;

use crate::{lan::to_hex, secrets};

pub const CREDENTIAL_USER: &str = "mawok-account-key";
const KEY_ID_INFO: &[u8] = b"mawok key id v1";
const LAN_INFO: &[u8] = b"mawok lan v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub enum Status {
    None,
    Ready,
    NeedsPairing,
}

pub fn derive(key: &[u8; 32], info: &[u8]) -> [u8; 32] {
    let hkdf = Hkdf::<Sha256>::from_prk(key).expect("a 32-byte account key is a valid HKDF PRK");
    let mut output = [0; 32];
    hkdf.expand(info, &mut output)
        .expect("the fixed HKDF output length is valid");
    output
}

pub fn key_id(key: &[u8; 32]) -> String {
    to_hex(&derive(key, KEY_ID_INFO))
}

pub fn lan_psk(key: &[u8; 32]) -> [u8; 32] {
    derive(key, LAN_INFO)
}

pub fn decide(server_key_id: Option<&str>, local: Option<&[u8; 32]>) -> Status {
    match (server_key_id, local) {
        (Some(_), None) => Status::NeedsPairing,
        (Some(server), Some(key)) if server != key_id(key) => Status::NeedsPairing,
        (_, Some(_)) => Status::Ready,
        (None, None) => Status::None,
    }
}

/// 窓口へつながらない間は、手元にある鍵だけで LAN を使えるか決める。
pub fn offline_status(local: Option<&[u8; 32]>) -> Status {
    if local.is_some() {
        Status::Ready
    } else {
        Status::None
    }
}

pub fn generate() -> Result<[u8; 32], String> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|error| error.to_string())?;
    Ok(key)
}

pub fn decode(text: &str) -> Result<[u8; 32], String> {
    let bytes = crate::lan::from_hex(text)
        .ok_or_else(|| "the account key is not hexadecimal".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "the account key has the wrong length".to_string())
}

pub fn load() -> Result<Option<[u8; 32]>, String> {
    match secrets::read(CREDENTIAL_USER) {
        Ok(value) => decode(&value).map(Some),
        Err(secrets::ReadError::NotFound) => Ok(None),
        Err(secrets::ReadError::Unreadable(error)) => Err(error),
    }
}

pub fn store(key: &[u8; 32]) -> Result<(), String> {
    secrets::write(CREDENTIAL_USER, &to_hex(key))
}

pub fn clear() -> Result<(), String> {
    secrets::delete(CREDENTIAL_USER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_distinct_fixed_values() {
        let key = [9; 32];
        assert_eq!(key_id(&key).len(), 64);
        assert!(key_id(&key)
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(derive(&key, KEY_ID_INFO), lan_psk(&key));
        assert_eq!(
            key_id(&key),
            "baa89c7b50d27cffc5f43a114d1d2877cd9627a0d09755aaf6f867fa4cac5eda"
        );
    }

    #[test]
    fn decides_status_from_server_and_local_key() {
        let key = [2; 32];
        assert_eq!(decide(None, None), Status::None);
        assert_eq!(decide(Some("id"), None), Status::NeedsPairing);
        assert_eq!(decide(None, Some(&key)), Status::Ready);
        assert_eq!(decide(Some(&key_id(&key)), Some(&key)), Status::Ready);
        assert_eq!(decide(Some("old"), Some(&key)), Status::NeedsPairing);
    }

    #[test]
    fn keeps_a_local_key_ready_while_the_server_is_unreachable() {
        assert_eq!(offline_status(Some(&[2; 32])), Status::Ready);
        assert_eq!(offline_status(None), Status::None);
    }
}
