//! コマンドのアクションを動かすフォルダー（テキストウィンドウで移る作業フォルダー。docs/actions.md「作業フォルダー」）。
//! 移った先は起動している間だけ覚え、起動し直すとホームフォルダーに戻る

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// 補うときに足す区切り。Windows は `/` も受けるが、エクスプローラーと同じ `\` を足す
const SEPARATOR: char = if cfg!(windows) { '\\' } else { '/' };

/// 欄の下に並べる候補の上限。それより多いときは、絞り込むよう件数だけを添える
const CANDIDATE_LIMIT: usize = 100;

/// 移れなかった理由。画面は符号で文言を選ぶ
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderError {
    NotFound,
    NotAFolder,
    /// `\\server\share` のようなネットワークのパス（Windows。docs/actions.md「作業フォルダー」）
    #[cfg_attr(not(windows), allow(dead_code))]
    Network,
}

impl FolderError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "folder.not_found",
            Self::NotAFolder => "folder.not_a_folder",
            Self::Network => "folder.network",
        }
    }
}

/// 打たれたパスを、今のフォルダー `current` から見た実在のフォルダーにする。
/// 空ならホーム、`~` で始まればホームから、相対パスなら今のフォルダーから（今のフォルダーが消えていればホームから）。
/// 前後の `"` を外し、`..` は文字の上で解いてシンボリックリンクは解かない（docs/actions.md「作業フォルダー」）
pub fn resolve(current: &Path, home: &Path, input: &str) -> Result<PathBuf, FolderError> {
    let trimmed = input.trim();
    let input = trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(trimmed);
    let resolved = if input.is_empty() || input == "~" {
        home.to_path_buf()
    } else {
        expand(current, home, input)?
    };
    match resolved.metadata() {
        Err(_) => Err(FolderError::NotFound),
        Ok(metadata) if !metadata.is_dir() => Err(FolderError::NotAFolder),
        Ok(_) => Ok(resolved),
    }
}

/// 打たれたパスを、`~` と今のフォルダーから見た絶対パスにする（resolve と complete で共通）。
/// 空なら今のフォルダー（今のフォルダーが消えていればホーム）
fn expand(current: &Path, home: &Path, input: &str) -> Result<PathBuf, FolderError> {
    let base = if current.is_dir() { current } else { home };
    let path = if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        base.join(input)
    };
    let resolved = normalize(&path);
    // Windows の `C:foo`（ドライブ相対）は join で今のフォルダーに付かず、そのドライブの別のフォルダーから見られるので断る
    if !resolved.is_absolute() {
        return Err(FolderError::NotFound);
    }
    #[cfg(windows)]
    if resolved.to_string_lossy().starts_with(r"\\") {
        return Err(FolderError::Network);
    }
    Ok(resolved)
}

/// 欄で Tab を押したときに補った結果
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
pub struct FolderCompletion {
    /// 補った後の欄の中身
    pub input: String,
    /// 当てはまるフォルダーが2つ以上のときの名前（並べ替えて、上限まで）
    pub candidates: Vec<String>,
    /// 当てはまるフォルダーの数
    pub total: u32,
}

/// 打ちかけのパスの最後の名前を、当てはまるフォルダーの名前で補う（docs/actions.md「作業フォルダー」）。
/// 大文字と小文字は区別せずに拾う。1つなら実際の名前と区切りに置き換え（大文字と小文字を区別するファイルシステムでも移れるように）、
/// 2つ以上なら打った所を残して共通する所まで補い、候補を返す。
/// `.` で始まるフォルダーは、`.` を打ったときだけ候補にする
pub fn complete(current: &Path, home: &Path, input: &str) -> FolderCompletion {
    let trimmed = input.trim_start();
    let input = trimmed
        .strip_prefix('"')
        .map_or(trimmed, |rest| rest.strip_suffix('"').unwrap_or(rest));
    let unchanged = || FolderCompletion {
        input: input.to_string(),
        candidates: Vec::new(),
        total: 0,
    };
    if input == "~" {
        return FolderCompletion {
            input: format!("~{SEPARATOR}"),
            ..unchanged()
        };
    }
    let split = input
        .rfind(|c| c == '/' || (cfg!(windows) && c == '\\'))
        .map_or(0, |index| index + 1);
    let (folder_part, prefix) = input.split_at(split);
    let Ok(folder) = expand(current, home, folder_part) else {
        return unchanged();
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return unchanged();
    };
    let lowered = prefix.to_lowercase();
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if name.starts_with('.') && !prefix.starts_with('.') {
                return None;
            }
            // シンボリックリンクの先がフォルダーなら候補にする（移るときもリンクのまま移れる）
            (name.to_lowercase().starts_with(&lowered) && entry.path().is_dir()).then_some(name)
        })
        .collect();
    names.sort_by_cached_key(|name| name.to_lowercase());
    match names.as_slice() {
        [] => unchanged(),
        [name] => FolderCompletion {
            input: format!("{folder_part}{name}{SEPARATOR}"),
            ..unchanged()
        },
        _ => FolderCompletion {
            // 打った所は打ったとおりに残し、その先だけを最初の名前の書き方で足す
            input: format!(
                "{folder_part}{prefix}{}",
                common_prefix(&names)
                    .chars()
                    .skip(prefix.chars().count())
                    .collect::<String>()
            ),
            total: names.len() as u32,
            candidates: names.into_iter().take(CANDIDATE_LIMIT).collect(),
        },
    }
}

/// 名前に共通する頭の部分。大文字と小文字は区別せず、最初の名前の書き方で返す
fn common_prefix(names: &[String]) -> &str {
    let first = &names[0];
    let end = names[1..]
        .iter()
        .map(|name| {
            first
                .char_indices()
                .zip(name.chars())
                .take_while(|((_, a), b)| a.to_lowercase().eq(b.to_lowercase()))
                .last()
                .map_or(0, |((index, a), _)| index + a.len_utf8())
        })
        .min()
        .unwrap_or(first.len());
    &first[..end]
}

/// `.` を除き、`..` を一つ前の名前と打ち消す。ルートより上へは戻らない
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            other => normalized.push(other),
        }
    }
    normalized
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
            let work = root.join("work");
            Self { home: root, work }
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

    #[test]
    fn strips_the_quotes_of_a_copied_path() {
        let d = Dirs::new("quotes");
        let quoted = format!("\"{}\"", d.work.display());
        assert_eq!(resolve(&d.home, &d.home, &quoted).unwrap(), d.work);
    }

    #[test]
    fn starts_from_home_when_the_current_folder_is_gone() {
        let d = Dirs::new("gone");
        let gone = d.work.join("gone");
        assert_eq!(resolve(&gone, &d.home, "work").unwrap(), d.work);
    }

    #[test]
    fn resolves_dots_without_going_above_the_root() {
        assert_eq!(
            normalize(Path::new("/a/./b/../c")),
            Path::new("/a/c").to_path_buf()
        );
        assert_eq!(
            normalize(Path::new("/a/../..")),
            Path::new("/").to_path_buf()
        );
    }

    #[cfg(windows)]
    #[test]
    fn refuses_drive_relative_paths() {
        let d = Dirs::new("drive-relative");
        assert_eq!(
            resolve(&d.home, &d.home, "C:Windows"),
            Err(FolderError::NotFound)
        );
    }

    #[cfg(windows)]
    #[test]
    fn refuses_network_paths() {
        let d = Dirs::new("network");
        assert_eq!(
            resolve(&d.home, &d.home, r"\\server\share"),
            Err(FolderError::Network)
        );
    }

    /// 補う先のフォルダー。手放すときにフォルダーごと消す
    fn completion_dirs(name: &str) -> Dirs {
        let d = Dirs::new(name);
        for folder in [
            "Documents",
            "Documents-old",
            "Downloads",
            "desktop",
            ".config",
            "work/inner",
        ] {
            fs::create_dir_all(d.home.join(folder)).unwrap();
        }
        fs::write(d.home.join("Docs.txt"), "").unwrap();
        d
    }

    fn sep(path: &str) -> String {
        path.replace('/', &SEPARATOR.to_string())
    }

    #[test]
    fn completes_a_single_match_up_to_the_separator() {
        let d = completion_dirs("complete-single");
        let completion = complete(&d.home, &d.home, "wo");
        assert_eq!(completion.input, sep("work/"));
        assert!(completion.candidates.is_empty());
        // 1つなら、打った大文字と小文字を実際の名前に合わせる
        assert_eq!(complete(&d.home, &d.home, "WO").input, sep("work/"));
        assert_eq!(
            complete(&d.home, &d.home, "work/").input,
            sep("work/inner/")
        );
        assert_eq!(
            complete(&d.work, &d.home, "../wo").input,
            format!("..{}", sep("/work/"))
        );
    }

    #[test]
    fn completes_the_common_part_of_several_matches_ignoring_case() {
        let d = completion_dirs("complete-several");
        // 打った所は打ったとおりに残す。ファイルの Docs.txt は候補にしない
        let completion = complete(&d.home, &d.home, "docu");
        assert_eq!(completion.input, "documents");
        assert_eq!(completion.candidates, ["Documents", "Documents-old"]);
        assert_eq!(completion.total, 2);
        let completion = complete(&d.home, &d.home, "D");
        assert_eq!(completion.input, "D");
        assert_eq!(
            completion.candidates,
            ["desktop", "Documents", "Documents-old", "Downloads"]
        );
    }

    #[test]
    fn offers_dot_folders_only_after_a_dot() {
        let d = completion_dirs("complete-dot");
        assert!(!complete(&d.home, &d.home, "")
            .candidates
            .contains(&".config".to_string()));
        assert_eq!(complete(&d.home, &d.home, ".c").input, sep(".config/"));
    }

    #[test]
    fn completes_from_home_after_a_tilde() {
        let d = completion_dirs("complete-tilde");
        assert_eq!(complete(&d.work, &d.home, "~").input, sep("~/"));
        assert_eq!(complete(&d.work, &d.home, "~/wo").input, sep("~/work/"));
    }

    #[test]
    fn leaves_the_input_when_nothing_matches() {
        let d = completion_dirs("complete-none");
        let completion = complete(&d.home, &d.home, "nowhere/x");
        assert_eq!(completion.input, "nowhere/x");
        assert!(completion.candidates.is_empty());
        assert_eq!(completion.total, 0);
    }

    #[test]
    fn drops_the_quotes_of_a_copied_path() {
        let d = completion_dirs("complete-quotes");
        let quoted = format!("\"{}\"", d.home.join("wo").display());
        assert_eq!(
            complete(&d.home, &d.home, &quoted).input,
            format!("{}{SEPARATOR}", d.work.display())
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
