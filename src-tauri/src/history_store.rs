//! 下書きの履歴を app_local_data_dir/history.json に保存する処理。

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};

use crate::{atomic_file, config};

pub const FILE_NAME: &str = "history.json";
const VERSION: u8 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct FileFormat {
    version: u8,
    entries: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadProblem {
    InvalidJson,
    UnknownVersion,
    InvalidShape,
}

impl std::fmt::Display for ReadProblem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidJson => "invalid JSON",
            Self::UnknownVersion => "unknown version",
            Self::InvalidShape => "invalid data shape",
        })
    }
}

/// JSON の本文を読み、上限を超えた古い履歴を切り詰める。
pub fn parse(text: &str, max_entries: usize) -> Result<Vec<String>, ReadProblem> {
    let file: FileFormat = serde_json::from_str(text).map_err(|error| {
        if error.is_data() {
            ReadProblem::InvalidShape
        } else {
            ReadProblem::InvalidJson
        }
    })?;
    if file.version != VERSION {
        return Err(ReadProblem::UnknownVersion);
    }
    Ok(truncate(file.entries, max_entries))
}

/// 履歴を保存用の JSON にする。
pub fn format(entries: &[String]) -> String {
    serde_json::to_string(&FileFormat {
        version: VERSION,
        entries: entries.to_vec(),
    })
    .expect("history entries are serializable")
}

pub fn truncate(mut entries: Vec<String>, max_entries: usize) -> Vec<String> {
    if entries.len() > max_entries {
        entries.drain(..entries.len() - max_entries);
    }
    entries
}

/// ファイルがなければ空を返す。ほかの読み込み失敗は理由の種類だけを
/// 返す。
pub fn load(path: &Path, max_entries: usize) -> Result<Vec<String>, LoadError> {
    match fs::read_to_string(path) {
        Ok(text) => parse(&text, max_entries).map_err(LoadError::Invalid),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(LoadError::Io(error.kind())),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadError {
    Invalid(ReadProblem),
    Io(io::ErrorKind),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(problem) => problem.fmt(formatter),
            Self::Io(kind) => write!(formatter, "I/O error ({kind:?})"),
        }
    }
}

/// 一時ファイルへ書いてから差し替える。unix では履歴本文を所有者だけが
/// 読めるようにする。
pub fn save(path: &Path, entries: &[String]) -> io::Result<()> {
    atomic_file::write_private(path, format(entries).as_bytes())
}

pub fn clear(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 読めなかった履歴を同じフォルダーの `history.broken-YYYYMMDD-HHMMSS.json` へ写してから消す。
/// 空で始めると次のコピーで上書きするので、先に写す。元を残すと、コピーせずに起動し直すたびに
/// 同じ中身の写しが増える。写した先を返す。元がなければ何もせず None
pub fn set_aside(path: &Path, now: SystemTime) -> io::Result<Option<PathBuf>> {
    let Some(backup) = config::back_up(path, now)? else {
        return Ok(None);
    };
    clear(path)?;
    Ok(Some(backup))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::{
        fs,
        time::{Duration, UNIX_EPOCH},
    };

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("mawok-history-test-{}-{name}", std::process::id()))
    }

    #[test]
    fn round_trips() {
        let entries = vec!["old".to_string(), "new".to_string()];
        assert_eq!(parse(&format(&entries), 10), Ok(entries));
    }

    #[test]
    fn rejects_broken_json_and_unknown_versions() {
        assert_eq!(parse("{", 10), Err(ReadProblem::InvalidJson));
        assert_eq!(
            parse(r#"{"version": 2, "entries": []}"#, 10),
            Err(ReadProblem::UnknownVersion)
        );
    }

    #[test]
    fn rejects_wrong_shape() {
        assert_eq!(
            parse(r#"{"version": 1, "entries": [1]}"#, 10),
            Err(ReadProblem::InvalidShape)
        );
    }

    #[test]
    fn truncates_old_entries_and_zero_keeps_none() {
        let entries = vec!["1".into(), "2".into(), "3".into()];
        assert_eq!(
            parse(&format(&entries), 2),
            Ok(vec!["2".into(), "3".into()])
        );
        assert_eq!(parse(&format(&entries), 0), Ok(Vec::new()));
    }

    #[test]
    fn missing_file_is_empty() {
        let path = temp_path("missing");
        let _ = fs::remove_file(&path);
        assert_eq!(load(&path, 10), Ok(Vec::new()));
    }

    #[test]
    fn saves_atomically_and_with_private_permissions() {
        let path = temp_path("save");
        let _ = fs::remove_file(&path);
        save(&path, &["draft".into()]).unwrap();
        assert_eq!(load(&path, 10), Ok(vec!["draft".into()]));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn sets_aside_unreadable_history() {
        let dir = temp_path("set-aside");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        assert_eq!(set_aside(&path, now).unwrap(), None);

        fs::write(&path, r#"{"version": 2, "entries": ["draft"]}"#).unwrap();
        let backup = set_aside(&path, now).unwrap().unwrap();
        assert_eq!(backup, dir.join("history.broken-20260913-063005.json"));
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            r#"{"version": 2, "entries": ["draft"]}"#
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
