//! コマンドのアクションを動かすフォルダー（テキストウィンドウで移る作業フォルダー。docs/actions.md「作業フォルダー」）。
//! 移った先は起動している間だけ覚え、起動し直すとホームフォルダーに戻る

use std::path::{Path, PathBuf};

/// 移れなかった理由。画面は符号で文言を選ぶ
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderError {
    NotFound,
    NotAFolder,
}

impl FolderError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "folder.not_found",
            Self::NotAFolder => "folder.not_a_folder",
        }
    }
}

/// 打たれたパスを、今のフォルダー `current` から見た実在のフォルダーにする。
/// 空ならホーム、`~` で始まればホームから、相対パスなら今のフォルダーから。`..` とシンボリックリンクは解いた形にする
pub fn resolve(current: &Path, home: &Path, input: &str) -> Result<PathBuf, FolderError> {
    let input = input.trim();
    let path = if input.is_empty() || input == "~" {
        home.to_path_buf()
    } else if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        current.join(input)
    };
    // Windows の canonicalize は `\\?\` を付けた形を返し、cmd の作業フォルダーにも見せる名前にも向かないので、付けない形にする
    let resolved = dunce::canonicalize(&path).map_err(|_| FolderError::NotFound)?;
    if !resolved.is_dir() {
        return Err(FolderError::NotAFolder);
    }
    Ok(resolved)
}

/// タイトルバーに出す形。macOS はホームの中を `~` で縮める（ターミナルと同じ）。Windows は `~` を使わないので、そのままにする
pub fn display(path: &Path, home: &Path) -> String {
    #[cfg(not(windows))]
    if let Ok(rest) = path.strip_prefix(home) {
        return if rest.as_os_str().is_empty() {
            "~".to_string()
        } else {
            format!("~/{}", rest.display())
        };
    }
    #[cfg(windows)]
    let _ = home;
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// ホームに見立てたフォルダーと、その中の work フォルダーと file.txt。手放すときにフォルダーごと消す
    struct Dirs {
        home: PathBuf,
        work: PathBuf,
    }

    impl Dirs {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("mawok-folder-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("work")).unwrap();
            fs::write(root.join("file.txt"), "").unwrap();
            let home = dunce::canonicalize(&root).unwrap();
            let work = home.join("work");
            Self { home, work }
        }
    }

    impl Drop for Dirs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn empty_input_and_tilde_go_home() {
        let d = Dirs::new("home");
        assert_eq!(resolve(&d.work, &d.home, "").unwrap(), d.home);
        assert_eq!(resolve(&d.work, &d.home, "  ~ ").unwrap(), d.home);
        assert_eq!(resolve(&d.home, &d.home, "~/work").unwrap(), d.work);
    }

    #[test]
    fn relative_paths_start_from_the_current_folder() {
        let d = Dirs::new("relative");
        assert_eq!(resolve(&d.home, &d.home, "work").unwrap(), d.work);
        assert_eq!(resolve(&d.work, &d.home, "..").unwrap(), d.home);
        assert_eq!(
            resolve(&d.home, &d.home, d.work.to_str().unwrap()).unwrap(),
            d.work
        );
    }

    #[test]
    fn refuses_missing_paths_and_files() {
        let d = Dirs::new("missing");
        assert_eq!(
            resolve(&d.home, &d.home, "nowhere"),
            Err(FolderError::NotFound)
        );
        assert_eq!(
            resolve(&d.home, &d.home, "file.txt"),
            Err(FolderError::NotAFolder)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn shortens_the_home_folder_to_a_tilde() {
        let home = Path::new("/Users/someone");
        assert_eq!(display(home, home), "~");
        assert_eq!(display(&home.join("notes/a"), home), "~/notes/a");
        assert_eq!(display(Path::new("/tmp"), home), "/tmp");
    }

    #[cfg(windows)]
    #[test]
    fn shows_full_paths_on_windows() {
        let home = Path::new(r"C:\Users\someone");
        assert_eq!(
            display(&home.join("notes"), home),
            r"C:\Users\someone\notes"
        );
    }
}
