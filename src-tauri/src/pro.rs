//! Pro の状態を、設定とは別に覚える。トークンは資格情報管理に置き、ここには期限とアカウントの見分けだけを置く。

use std::{
    fs, io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{account::ProStatus, atomic_file, lan};

pub const STATE_FILE_NAME: &str = "pro-state.json";
const GRACE_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub account_id: String,
    pub until: Option<u64>,
    pub active: bool,
}

impl State {
    pub fn from_status(account_id: String, pro: &ProStatus) -> Self {
        Self {
            account_id,
            until: pro.until,
            active: pro.active,
        }
    }

    /// 窓口が最後に Pro だと答えたときだけ、期限の7日後までは通信不能でも使える。
    pub fn available_at(&self, now: u64) -> bool {
        self.active
            && self
                .until
                .is_some_and(|until| now <= until.saturating_add(GRACE_SECONDS))
    }

    /// LAN へはアカウントIDをそのまま流さず、同じアカウントでだけ同じになる固定長の印にする。
    pub fn account_tag(&self) -> [u8; lan::ACCOUNT_TAG_LEN] {
        Sha256::digest(self.account_id.as_bytes()).into()
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn load(path: &Path) -> Result<Option<State>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save(path: &Path, state: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    atomic_file::write(path, &bytes).map_err(|error| error.to_string())
}

pub fn clear(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_available_through_the_offline_grace_period() {
        let state = State {
            account_id: "account".to_string(),
            until: Some(1_000),
            active: true,
        };
        assert!(state.available_at(1_000));
        assert!(state.available_at(1_000 + GRACE_SECONDS));
        assert!(!state.available_at(1_001 + GRACE_SECONDS));
    }

    #[test]
    fn does_not_grant_grace_after_the_server_says_pro_is_inactive() {
        let state = State {
            account_id: "account".to_string(),
            until: Some(10_000),
            active: false,
        };
        assert!(!state.available_at(1_000));
    }

    #[test]
    fn hashes_the_account_id_before_sending_it_over_lan() {
        let state = State {
            account_id: "account".to_string(),
            until: None,
            active: true,
        };
        assert_ne!(state.account_tag().as_slice(), state.account_id.as_bytes());
        assert_eq!(state.account_tag(), state.account_tag());
    }
}
