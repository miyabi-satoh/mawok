//! コマンドのアクションを動かすフォルダー（テキストウィンドウで移る作業フォルダー。docs/actions.md「作業フォルダー」）。
//! 今のフォルダーは起動している間だけ覚え、起動し直すとホームフォルダーに戻る。最近移ったフォルダーの一覧は、メニューに出すため保存する

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// 補うときに足す区切り。Windows は `/` も受けるが、エクスプローラーと同じ `\` を足す
const SEPARATOR: char = if cfg!(windows) { '\\' } else { '/' };

/// 最近移ったフォルダーを覚える数。メニューで一目で選べる数で、Explorer のアドレスバーの履歴と同じ
pub const RECENT_LIMIT: usize = 5;

/// 最近のフォルダーを書いておくファイル（app_local_data_dir の中）
pub const RECENT_FILE_NAME: &str = "recent-folders.json";
const RECENT_VERSION: u8 = 1;

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
    let input = unquote(input.trim());
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

/// エクスプローラーの「パスのコピー」が付ける前後の `"` を外す（resolve と complete で共通）
fn unquote(input: &str) -> &str {
    input
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(input)
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
    /// 打ったパスの、最後の名前より前の部分。候補を選んだら、これに候補をつないで欄に入れる
    pub base: String,
    /// 当てはまるフォルダーが2つ以上のときの名前と区切り（並べ替えて、上限まで）
    pub candidates: Vec<String>,
    /// 当てはまるフォルダーの数
    pub total: u32,
}

/// 打ちかけのパスの最後の名前を、当てはまるフォルダーの名前で補う（docs/actions.md「作業フォルダー」）。
/// 大文字と小文字は区別せずに拾い、補った所は実際の名前の書き方にする（大文字と小文字を区別するファイルシステムでも移れるように。
/// 2つ以上のときは最初の候補の書き方）。
/// 1つなら名前と区切りまで、2つ以上なら共通する所まで補い、候補を返す。
/// 隠したフォルダー（`.` で始まる名前と、Windows の隠しの属性）は、`.` を打ったときか、ほかに当てはまるものが無いときだけ候補にする。
/// Windows の隠しとシステムの両方の属性のフォルダーは候補にしない
pub fn complete(current: &Path, home: &Path, input: &str) -> FolderCompletion {
    // 末尾の空白は、`Program Files` の `Program ` のように打ちかけの名前の一部なので残す
    let input = unquote(input.trim_start());
    let split = input
        .rfind(|c| c == '/' || (cfg!(windows) && c == '\\'))
        .map_or(0, |index| index + 1);
    let (folder_part, prefix) = input.split_at(split);
    let unchanged = || FolderCompletion {
        input: input.to_string(),
        base: folder_part.to_string(),
        candidates: Vec::new(),
        total: 0,
    };
    if input == "~" {
        return FolderCompletion {
            input: format!("~{SEPARATOR}"),
            ..unchanged()
        };
    }
    let Ok(folder) = expand(current, home, folder_part) else {
        return unchanged();
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return unchanged();
    };
    let lowered = prefix.to_lowercase();
    let mut visible = Vec::new();
    let mut hidden = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.to_lowercase().starts_with(&lowered) {
            continue;
        }
        // 名前の一覧と一緒に返る種類で見て、フォルダーの数だけ stat しない。
        // シンボリックリンクだけは先を見て、フォルダーなら候補にする（移るときもリンクのまま移れる）
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !(file_type.is_dir() || file_type.is_symlink() && entry.path().is_dir()) {
            continue;
        }
        match visibility(&name, &entry) {
            Visibility::Protected => {}
            Visibility::Hidden if !prefix.starts_with('.') => hidden.push(name),
            _ => visible.push(name),
        }
    }
    let mut names = if visible.is_empty() { hidden } else { visible };
    names.sort_by_cached_key(|name| name.to_lowercase());
    match names.as_slice() {
        [] => unchanged(),
        [name] => FolderCompletion {
            input: format!("{folder_part}{name}{SEPARATOR}"),
            ..unchanged()
        },
        _ => FolderCompletion {
            input: format!("{folder_part}{}", completed_part(&names, prefix)),
            total: names.len() as u32,
            candidates: names
                .into_iter()
                .take(CANDIDATE_LIMIT)
                .map(|name| format!("{name}{SEPARATOR}"))
                .collect(),
            ..unchanged()
        },
    }
}

/// 2つ以上の名前で補った後の、最後の名前の部分。打った所は、候補どうしで書き方が揃っていればそれに合わせ、
/// 揃っていなければ（`desktop` と `Documents` に `D` など）打ったとおりに残す
fn completed_part(names: &[String], prefix: &str) -> String {
    let common = common_prefix(names);
    let typed = prefix.chars().count();
    let head: String = common.chars().take(typed).collect();
    if names.iter().all(|name| name.starts_with(&head)) {
        common.to_string()
    } else {
        prefix.chars().chain(common.chars().skip(typed)).collect()
    }
}

enum Visibility {
    Shown,
    /// `.` で始まる名前と、Windows の隠しの属性（エクスプローラーが既定で出さないもの）
    Hidden,
    /// Windows の隠しとシステムの両方の属性（エクスプローラーが「保護されたオペレーティング システム ファイル」として出さないもの）。
    /// `Application Data` のような中を開けない古い名前の転送先なども含み、移っても使えないので候補にしない
    #[cfg_attr(not(windows), allow(dead_code))]
    Protected,
}

fn visibility(name: &str, entry: &std::fs::DirEntry) -> Visibility {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        let attributes = entry
            .metadata()
            .map_or(0, |metadata| metadata.file_attributes());
        if attributes & FILE_ATTRIBUTE_HIDDEN != 0 {
            return if attributes & FILE_ATTRIBUTE_SYSTEM != 0 {
                Visibility::Protected
            } else {
                Visibility::Hidden
            };
        }
    }
    #[cfg(not(windows))]
    let _ = entry;
    if name.starts_with('.') {
        Visibility::Hidden
    } else {
        Visibility::Shown
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

/// テキストウィンドウの下のフォルダーのボタンとメニューに出すもの
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct FolderMenu {
    pub current: FolderItem,
    /// 今のフォルダーがホームか。ボタンには名前でなく「ホーム」と出す
    pub at_home: bool,
    /// 最近移ったフォルダー（新しい順。今のフォルダーも含み、消えたものとホームは含まない）
    pub recent: Vec<FolderItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
pub struct FolderItem {
    /// フォルダーの名前（パスの最後）
    pub name: String,
    /// タイトルバーと同じ形のパス（display）
    pub display: String,
    /// 移るときに change_folder に渡すパス
    pub path: String,
}

fn item(path: &Path, home: &Path) -> FolderItem {
    let display = display(path, home);
    FolderItem {
        name: path.file_name().map_or_else(
            || display.clone(),
            |name| name.to_string_lossy().into_owned(),
        ),
        display,
        path: path.to_string_lossy().into_owned(),
    }
}

/// フォルダーのボタンとメニューに出すものを作る
pub fn menu(current: &Path, home: &Path, recent: &[PathBuf]) -> FolderMenu {
    FolderMenu {
        current: item(current, home),
        at_home: current == home,
        recent: recent
            .iter()
            .filter(|folder| folder.is_dir())
            .map(|folder| item(folder, home))
            .collect(),
    }
}

/// 移った先を、最近のフォルダーの先頭に入れる。ホームは入れない（メニューの「ホームフォルダーに戻る」で戻れる）
pub fn remember(recent: &mut Vec<PathBuf>, folder: &Path, home: &Path) {
    if folder == home {
        return;
    }
    recent.retain(|known| known != folder);
    recent.insert(0, folder.to_path_buf());
    recent.truncate(RECENT_LIMIT);
}

#[derive(Serialize, serde::Deserialize)]
struct RecentFile {
    version: u8,
    folders: Vec<String>,
}

/// 最近のフォルダーを読む。無い・読めない・形が違うときは空にする（覚え直せば済むものなので、利用者に知らせない）
pub fn load_recent(path: &Path) -> Vec<PathBuf> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<RecentFile>(&text).ok())
        .filter(|file| file.version == RECENT_VERSION)
        .map(|file| {
            let mut folders: Vec<PathBuf> = file.folders.into_iter().map(PathBuf::from).collect();
            folders.truncate(RECENT_LIMIT);
            folders
        })
        .unwrap_or_default()
}

/// 最近のフォルダーを書く。名前を文字列にできないフォルダー（Windows の壊れた名前など）は書かない
pub fn save_recent(path: &Path, recent: &[PathBuf]) -> std::io::Result<()> {
    let file = RecentFile {
        version: RECENT_VERSION,
        folders: recent
            .iter()
            .filter_map(|folder| folder.to_str().map(str::to_string))
            .collect(),
    };
    let json = serde_json::to_string(&file).expect("recent folders are serializable");
    crate::atomic_file::write(path, json.as_bytes())
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
            "My Folder",
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

    /// 補った後の期待値。打った区切りは打ったとおりに残り、補って足す末尾の区切りだけが OS のものになる
    fn sep(path: &str) -> String {
        format!("{}{SEPARATOR}", path.strip_suffix('/').unwrap())
    }

    #[test]
    fn completes_a_single_match_up_to_the_separator() {
        let d = completion_dirs("complete-single");
        let completion = complete(&d.home, &d.home, "wo");
        assert_eq!(completion.input, sep("work/"));
        assert!(completion.candidates.is_empty());
        // 末尾の空白は名前の一部として残す
        assert_eq!(complete(&d.home, &d.home, " My ").input, sep("My Folder/"));
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
        // 候補どうしで書き方が揃っていれば、打った所も合わせる。ファイルの Docs.txt は候補にしない
        let completion = complete(&d.home, &d.home, "docu");
        assert_eq!(completion.input, "Documents");
        // 候補は、選んだら土台につないで欄に入れられるよう、区切りまで付ける
        assert_eq!(
            completion.candidates,
            [sep("Documents/"), sep("Documents-old/")]
        );
        assert_eq!(completion.total, 2);
        assert_eq!(complete(&d.home, &d.home, "work/../docu").base, "work/../");
        // 揃っていなければ、打ったとおりに残す
        let completion = complete(&d.home, &d.home, "D");
        assert_eq!(completion.input, "D");
        assert_eq!(
            completion.candidates,
            ["desktop/", "Documents/", "Documents-old/", "Downloads/"].map(sep)
        );
    }

    #[test]
    fn offers_dot_folders_only_after_a_dot() {
        let d = completion_dirs("complete-dot");
        assert!(!complete(&d.home, &d.home, "")
            .candidates
            .contains(&sep(".config/")));
        assert_eq!(complete(&d.home, &d.home, ".c").input, sep(".config/"));
        // ほかに当てはまるものが無ければ候補にする
        fs::create_dir_all(d.home.join("only-hidden/.git")).unwrap();
        assert_eq!(
            complete(&d.home, &d.home, "only-hidden/").input,
            sep("only-hidden/.git/")
        );
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

    #[test]
    fn remembers_recent_folders_newest_first_without_home() {
        let home = Path::new("/home/someone");
        let mut recent = Vec::new();
        for name in ["a", "b", "a", "c", "d", "e", "f"] {
            remember(&mut recent, &home.join(name), home);
        }
        remember(&mut recent, home, home);
        assert_eq!(
            recent,
            ["f", "e", "d", "c", "a"].map(|name| home.join(name))
        );
    }

    #[test]
    fn saves_and_loads_recent_folders() {
        let d = Dirs::new("recent");
        let file = d.home.join(RECENT_FILE_NAME);
        assert!(load_recent(&file).is_empty());
        save_recent(&file, std::slice::from_ref(&d.work)).unwrap();
        assert_eq!(load_recent(&file), std::slice::from_ref(&d.work));
        fs::write(&file, "{").unwrap();
        assert!(load_recent(&file).is_empty());
    }

    #[test]
    fn menu_leaves_out_missing_folders() {
        let d = Dirs::new("menu");
        let gone = d.home.join("gone");
        let menu = menu(&d.work, &d.home, &[gone, d.work.clone()]);
        assert_eq!(menu.current.name, "work");
        assert!(!menu.at_home);
        assert_eq!(menu.recent, std::slice::from_ref(&menu.current));
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
