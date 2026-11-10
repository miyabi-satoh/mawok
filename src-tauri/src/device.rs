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
    /// 選んだ置き場を、macOS のサンドボックスで起動し直しても読み書きできるようにするブックマーク（folder_access.rs）。
    /// 16 進の文字列。macOS 以外は作らない
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_dir_bookmark: Option<String>,
    /// 設定のファイルの symlink の先を読むのに、利用者が許可したフォルダー（docs/config.md「macOS のサンドボックス」）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub granted_folders: Vec<GrantedFolder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantedFolder {
    pub path: PathBuf,
    /// 16 進の文字列にしたブックマーク
    pub bookmark: String,
}

impl Device {
    /// 許可したフォルダーを足す。同じパスがあれば、ブックマークを書き直す
    pub fn grant(&mut self, path: PathBuf, bookmark: String) {
        match self
            .granted_folders
            .iter_mut()
            .find(|folder| folder.path == path)
        {
            Some(folder) => folder.bookmark = bookmark,
            None => self.granted_folders.push(GrantedFolder { path, bookmark }),
        }
    }
}

/// 読む。無ければ既定。読めなければ、読めない理由を返す（呼ぶ側は load_or_recover を使う）
pub fn load(path: &Path) -> Result<Device, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Device::default()),
        Err(error) => Err(error.to_string()),
    }
}

/// 読む。読めなければ、上書きする前に `device.broken-….json` へ写し、読める項目だけを拾う。
/// 拾わないと、選んだ設定の保存先を忘れ、既定の保存先・既定の設定のまま黙って動き続けるため
pub fn load_or_recover(path: &Path) -> Device {
    let error = match load(path) {
        Ok(device) => return device,
        Err(error) => error,
    };
    log::warn!("couldn't read the device settings: {error}");
    match atomic_file::back_up(path, std::time::SystemTime::now()) {
        Ok(Some(copy)) => log::warn!("set aside the device settings to {}", copy.display()),
        Ok(None) => {}
        Err(error) => log::warn!("couldn't set aside the device settings: {error}"),
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .map(|value| salvage(&value))
        .unwrap_or_default()
}

/// 項目ごとに読む。型の合わない項目だけを既定にする
fn salvage(value: &serde_json::Value) -> Device {
    fn field<T: serde::de::DeserializeOwned + Default>(value: &serde_json::Value, name: &str) -> T {
        value
            .get(name)
            .and_then(|field| serde_json::from_value(field.clone()).ok())
            .unwrap_or_default()
    }
    Device {
        id: field(value, "id"),
        settings_dir: field(value, "settings_dir"),
        autostart: field(value, "autostart"),
        settings_dir_bookmark: field(value, "settings_dir_bookmark"),
        granted_folders: field(value, "granted_folders"),
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
        // ブックマークを持たないデバイス（macOS 以外）では、その欄を書かない
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("bookmark") && !text.contains("granted_folders"));
        device.settings_dir_bookmark = Some("00ab".to_string());
        device.grant(dir.join("dotfiles"), "01".to_string());
        save(&path, &device).unwrap();
        assert_eq!(load(&path).unwrap(), device);
    }

    #[test]
    fn grants_a_folder_once_and_renews_its_bookmark() {
        let mut device = Device::default();
        device.grant(PathBuf::from("/Users/me/dotfiles"), "01".to_string());
        device.grant(PathBuf::from("/Users/me/dotfiles"), "02".to_string());
        assert_eq!(
            device.granted_folders,
            vec![GrantedFolder {
                path: PathBuf::from("/Users/me/dotfiles"),
                bookmark: "02".to_string()
            }]
        );
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

    #[test]
    fn recovers_the_readable_items_and_keeps_a_copy_of_an_unreadable_file() {
        let dir = crate::test_support::TempDir::new("device-recover");
        let path = dir.join(FILE_NAME);
        fs::write(
            &path,
            r#"{"id": "a1b2c3d4", "settings_dir": "/Users/me/Dropbox/mawok", "autostart": "yes"}"#,
        )
        .unwrap();
        let device = load_or_recover(&path);
        assert_eq!(device.id, "a1b2c3d4");
        assert_eq!(
            device.settings_dir,
            Some(PathBuf::from("/Users/me/Dropbox/mawok"))
        );
        assert_eq!(device.autostart, None);
        assert!(fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("device.broken-")));
    }
}
