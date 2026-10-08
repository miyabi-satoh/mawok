//! ファイルを、書きかけで壊さないように書く。設定ファイル・下書きの履歴・この機器の鍵で使う

use std::{
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
};

/// 同じフォルダーの一時ファイルに書き切ってから差し替える。置き場所のフォルダーがなければ作る。
/// fs::write は先にファイルを切り詰めるので、ディスクの空きがないなどで書き込みが途中で失敗すると、元のファイルが壊れてしまう。
/// ディスクへの書き切り（sync_all）は待たない。設定ファイルは打つたびにメインスレッドで保存するので、待つと入力が引っかかる
pub fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with(path, contents, false)
}

/// `write` と同じく書き、unix では所有者だけが読めるようにする。差し替える前にディスクへ書き切る。
/// 新しく作った一時ファイルで差し替えるので、元のファイルの権限は引き継がない
pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_with(path, contents, true)
}

/// 一時ファイルの場所。`config.toml` なら `config.toml.tmp`
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

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    /// 落ちたテストでも一時フォルダーに残さないよう、手放すときにフォルダーごと消す
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mawok-atomic-file-test-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn names_the_temporary_file_after_the_extension() {
        assert_eq!(
            temp_path(Path::new("dir/config.toml")),
            Path::new("dir/config.toml.tmp")
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
        let dir = TempDir::new("replace");
        let path = dir.0.join("inside").join("file.txt");
        write(&path, b"first").unwrap();
        write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!temp_path(&path).exists());
    }

    #[test]
    fn leaves_the_file_and_no_temporary_file_when_it_cannot_replace() {
        let dir = TempDir::new("blocked");
        // 差し替える先がフォルダーなので、差し替えだけが失敗する
        let path = dir.0.join("file.txt");
        fs::create_dir_all(path.join("inside")).unwrap();
        assert!(write(&path, b"text").is_err());
        assert!(path.join("inside").is_dir());
        assert!(!temp_path(&path).exists());
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_readable_only_by_the_owner() {
        let dir = TempDir::new("private");
        let path = dir.0.join("key");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        // 誰でも読める元のファイルの権限を引き継がない
        fs::create_dir_all(&dir.0).unwrap();
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
