//! このデバイスだけの設定（docs/config.md「デバイスの手元に置くもの」）。設定の置き場を替えても、同期しても
//! 動かないよう、OS 標準のアプリ設定フォルダーに置く

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::atomic_file;

pub const FILE_NAME: &str = "device.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Device {
    /// 履歴のファイルの名前に使う、このデバイスの見分け。置き場を同期しているほかのデバイスと重ならないよう、ランダムに作る
    pub id: String,
    /// 利用者が選んだ設定の置き場。None なら OS 標準のアプリ設定フォルダー
    pub settings_dir: Option<PathBuf>,
    /// ログイン時に起動するか。None なら既定（起動する）
    pub autostart: Option<bool>,
}

/// 読む。無ければ既定。読めなければ、読めない理由を返す（呼ぶ側は既定で動かし、書き直さずにログに出す）
pub fn load(path: &Path) -> Result<Device, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Device::default()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save(path: &Path, device: &Device) -> io::Result<()> {
    let text = serde_json::to_string_pretty(device).expect("device serializes");
    atomic_file::write(path, text.as_bytes())
}

/// 見分けが無ければ作る。作ったかを返す
pub fn ensure_id(device: &mut Device) -> Result<bool, String> {
    if valid_id(&device.id) {
        return Ok(false);
    }
    device.id = crate::hex::random_hex::<8>()?;
    Ok(true)
}

/// 履歴のファイルの名前に使うので、ファイル名として安全な文字だけ
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn round_trips_and_makes_an_id_once() {
        let dir = TempDir::new("device-round-trip");
        let path = dir.join(FILE_NAME);
        let mut device = load(&path).unwrap();
        assert_eq!(device, Device::default());
        assert!(ensure_id(&mut device).unwrap());
        assert!(!ensure_id(&mut device).unwrap());
        device.settings_dir = Some(dir.join("Dropbox"));
        save(&path, &device).unwrap();
        assert_eq!(load(&path).unwrap(), device);
    }

    #[test]
    fn replaces_an_id_that_is_not_safe_as_a_file_name() {
        let mut device = Device {
            id: "../x".to_string(),
            ..Device::default()
        };
        assert!(ensure_id(&mut device).unwrap());
        assert!(valid_id(&device.id));
    }
}
