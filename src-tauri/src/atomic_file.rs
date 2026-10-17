//! ファイルを、書きかけで壊さないように書く。下書きの履歴・Pro の状態などで使う。読めなかったファイルの写しも作る

use std::{
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// 同じフォルダーの一時ファイルに書き切ってから差し替える。置き場所のフォルダーがなければ作る。
/// fs::write は先にファイルを切り詰めるので、ディスクの空きがないなどで書き込みが途中で失敗すると、元のファイルが壊れてしまう。
/// ディスクへの書き切り（sync_all）は待たない。下書きの履歴は打つたびに保存するので、待つと入力が引っかかる
pub fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with(path, contents, false)
}

/// `write` と同じく書き、unix では所有者だけが読めるようにする。差し替える前にディスクへ書き切る。
/// 新しく作った一時ファイルで差し替えるので、元のファイルの権限は引き継がない
pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with(path, contents, true)
}

/// ファイルを消す。もう無ければ、消えているので成功にする
pub fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// 一時ファイルの場所。`history.json` なら `history.json.tmp`
fn temp_path(path: &Path) -> PathBuf {
    match path.extension() {
        Some(extension) => {
            let mut extension = extension.to_os_string();
            extension.push(".tmp");
            path.with_extension(extension)
        }
        None => path.with_extension("tmp"),
    }
}

fn write_with(path: &Path, contents: &[u8], private: bool) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = temp_path(path);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(contents)?;
        if private {
            file.sync_all()?;
        }
        drop(file);
        // 前の失敗で一時ファイルが残っていると、作るときの権限は当たらないので、当て直す
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        // 残っても次に書くときに書き直すので、消せなくても溜まらない
        let _ = fs::remove_file(&temp);
    }
    result
}

/// そのまま読めなかったファイルを、上書きする前に同じフォルダーの `<名前>.broken-YYYYMMDD-HHMMSS.<拡張子>` へ写す
/// （設定の置き場なら `settings.broken-….db`、下書きの履歴なら `history.broken-….json`）。
/// 写した先を返す。写す元がなければ何もせず None
pub fn back_up(path: &Path, now: SystemTime) -> io::Result<Option<PathBuf>> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .expect("the file to back up has a stem");
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .expect("the file to back up has an extension");
    let stamp = utc_stamp(now);
    // 同じ秒に写したものがあっても上書きしないよう、あれば番号を付ける
    for attempt in 0.. {
        let name = match attempt {
            0 => format!("{stem}.broken-{stamp}.{extension}"),
            _ => format!("{stem}.broken-{stamp}-{attempt}.{extension}"),
        };
        let target = path.with_file_name(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        // 写しは持ち主が見るためのもの。下書きの履歴も写すので、unix では所有者だけが読めるようにする
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(&target) {
            Ok(mut file) => {
                // 書きかけの写しを残すと、元の内容が残っているように見えてしまう
                if let Err(error) = file.write_all(&contents) {
                    drop(file);
                    if let Err(remove_error) = fs::remove_file(&target) {
                        log::warn!(
                            "couldn't remove the incomplete backup {}: {remove_error}",
                            target.display()
                        );
                    }
                    return Err(error);
                }
                return Ok(Some(target));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!("the attempts never run out")
}

/// UTC の `YYYYMMDD-HHMMSS`。ログの時刻に揃えて UTC にする。日付の計算は Howard Hinnant の civil_from_days
pub fn utc_stamp(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let (hour, minute, second) = (seconds / 3600 % 24, seconds / 60 % 60, seconds % 60);
    let days = (seconds / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn names_the_temporary_file_after_the_extension() {
        assert_eq!(
            temp_path(Path::new("dir/history.json")),
            Path::new("dir/history.json.tmp")
        );
        assert_eq!(
            temp_path(Path::new("dir/history.json")),
            Path::new("dir/history.json.tmp")
        );
        assert_eq!(
            temp_path(Path::new("dir/device-key")),
            Path::new("dir/device-key.tmp")
        );
    }

    #[test]
    fn creates_the_folder_and_replaces_an_existing_file() {
        let dir = TempDir::new("atomic-file-replace");
        let path = dir.join("inside").join("file.txt");
        write(&path, b"first").unwrap();
        write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!temp_path(&path).exists());
    }

    #[test]
    fn leaves_the_file_and_no_temporary_file_when_it_cannot_replace() {
        let dir = TempDir::new("atomic-file-blocked");
        // 差し替える先がフォルダーなので、差し替えだけが失敗する
        let path = dir.join("file.txt");
        fs::create_dir_all(path.join("inside")).unwrap();
        assert!(write(&path, b"text").is_err());
        assert!(path.join("inside").is_dir());
        assert!(!temp_path(&path).exists());
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_readable_only_by_the_owner() {
        let dir = TempDir::new("atomic-file-private");
        let path = dir.join("key");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        // 誰でも読める元のファイルの権限を引き継がない
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        // 前の失敗で残った、誰でも読める一時ファイルの権限も引き継がない
        fs::write(temp_path(&path), b"stale").unwrap();
        fs::set_permissions(temp_path(&path), fs::Permissions::from_mode(0o644)).unwrap();

        write_private(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(mode(&path), 0o600);
        assert!(!temp_path(&path).exists());
    }
}
