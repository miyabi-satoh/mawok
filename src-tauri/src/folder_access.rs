//! macOS のサンドボックスで、コンテナの外のフォルダーを読み書きする許可（docs/config.md「macOS のサンドボックス」）。
//!
//! サンドボックスでは、利用者がフォルダーの窓で選んだものしか読めず、その許可はプロセスが終わると消える。
//! 窓で選んだ直後にブックマーク（security-scoped bookmark）を作って device.json に残し、起動のたびに許可を戻す。
//! ブックマークを作り・戻すのは macOS だけで、ほかの OS では何もしない。読めるかの見分け（`Reach`）と、
//! 選んだフォルダーが symlink の先を含むかの見分けは、どの OS でも同じ関数で行う

use std::{
    collections::BTreeSet,
    fs, io,
    path::{Component, Path, PathBuf},
    sync::{Mutex, PoisonError},
};

/// 置き場のフォルダーや、設定のファイルの symlink の先を読めるか
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Readable,
    /// 無い（ドライブがつながっていない・dotfiles でファイルの無いブランチにした など）
    Missing,
    /// あるが、サンドボックスが読ませない。許可したフォルダーに含まれれば読める
    Denied,
}

/// 断られたことを、許可で直せるものとして分けるか。サンドボックスで動くのは macOS だけで、ほかの OS は
/// 断られたものを、これまでどおり無いものとして扱う
const DENIAL_IS_GRANTABLE: bool = cfg!(target_os = "macos");

/// 読もうとした結果から決める。サンドボックスは、先が外の symlink を読むと、窓を出さずに EPERM で断る
fn reach_from(result: io::Result<()>, denial_is_grantable: bool) -> Reach {
    match result {
        Ok(()) => Reach::Readable,
        Err(error) if denial_is_grantable && error.kind() == io::ErrorKind::PermissionDenied => {
            Reach::Denied
        }
        Err(_) => Reach::Missing,
    }
}

/// ファイル（symlink なら先）を読めるか。属性を見たうえで、macOS では開いてみる。サンドボックスは、属性は
/// 見せても中身を読ませないことがあるため。中身は読まない（クラウドストレージのファイルを落とさないため）
pub fn file_reach(path: &Path) -> Reach {
    match fs::metadata(path) {
        Err(error) => reach_from(Err(error), DENIAL_IS_GRANTABLE),
        Ok(_) if DENIAL_IS_GRANTABLE => {
            reach_from(fs::File::open(path).map(drop), DENIAL_IS_GRANTABLE)
        }
        Ok(_) => Reach::Readable,
    }
}

/// フォルダー（symlink なら先）を読めるか。フォルダーでなければ無いとみる
pub fn dir_reach(path: &Path) -> Reach {
    match fs::metadata(path) {
        Err(error) => reach_from(Err(error), DENIAL_IS_GRANTABLE),
        Ok(metadata) if !metadata.is_dir() => Reach::Missing,
        Ok(_) if DENIAL_IS_GRANTABLE => {
            reach_from(fs::read_dir(path).map(drop), DENIAL_IS_GRANTABLE)
        }
        Ok(_) => Reach::Readable,
    }
}

/// symlink の先のパス。相対の先は symlink のあるフォルダーから読み、`..` を畳む。先を読めないと
/// 実体のパス（canonicalize）は取れないが、symlink そのものはサンドボックスの中にあるので読める
pub fn link_target(link: &Path) -> Option<PathBuf> {
    let target = fs::read_link(link).ok()?;
    let base = link.parent().unwrap_or(Path::new(""));
    Some(normalize(&base.join(target)))
}

/// `.` と `..` を、ファイルシステムを見ずに畳む
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

/// 許可を求める窓を最初に開く場所。先の入っているフォルダーにし、利用者は「開く」を押すだけで済むようにする
pub fn grant_start(target: &Path) -> PathBuf {
    target
        .parent()
        .map_or_else(|| target.to_path_buf(), Path::to_path_buf)
}

/// 選んだフォルダーが、読みたい先を含むか。窓は実体のパスを返すが、先のパスは symlink を含むことがある
/// （`~/dotfiles` そのものが別の場所への symlink など）ので、選んだ後に読めるようになった実体のパスでも比べる
pub fn contains(folder: &Path, target: &Path) -> bool {
    if normalize(target).starts_with(normalize(folder)) {
        return true;
    }
    match (fs::canonicalize(folder), fs::canonicalize(target)) {
        (Ok(folder), Ok(target)) => target.starts_with(folder),
        _ => false,
    }
}

/// 窓で選んだ直後のフォルダーのブックマーク（16 進）。macOS 以外は要らないので None
pub fn bookmark(path: &Path) -> Result<Option<String>, String> {
    Ok(platform::bookmark(path)?.map(|bytes| crate::hex::to_hex(&bytes)))
}

/// このプロセスで許可を戻したブックマーク。起動の後も、置き場が現れるのを待つ間に戻し直すので、
/// 戻したものに start を重ねないため（対になる stop は呼ばず、プロセスが終わるまで許可を持つ）
static STARTED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// ブックマークから読み書きの許可を戻す。戻り値は、古くなっていたので作り直したブックマーク（device.json に
/// 書き直す）。このプロセスで戻し済みなら何もしない。つながっていない外付けのディスクなどはマウントしない
/// （待って起動が遅れないよう、現れるのを待つ間に戻し直す）
pub fn restore(bookmark: &str) -> Result<Option<String>, String> {
    if STARTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(bookmark)
    {
        return Ok(None);
    }
    let bytes = crate::hex::from_hex(bookmark).ok_or("the bookmark isn't hex")?;
    let renewed = platform::restore(&bytes)?.map(|bytes| crate::hex::to_hex(&bytes));
    let mut started = STARTED.lock().unwrap_or_else(PoisonError::into_inner);
    started.insert(bookmark.to_string());
    if let Some(renewed) = &renewed {
        started.insert(renewed.clone());
    }
    Ok(renewed)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::Path;

    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
    };

    /// 置き場のファイルを書くので、読み書きの許可を持つブックマークにする（読むだけにする印を付けない）
    fn create(url: &NSURL) -> Result<Vec<u8>, String> {
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope,
            None,
            None,
        )
        .map(|data| data.to_vec())
        .map_err(|error| format!("{error:?}"))
    }

    pub fn bookmark(path: &Path) -> Result<Option<Vec<u8>>, String> {
        let url =
            NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&path.to_string_lossy()), true);
        create(&url).map(Some)
    }

    pub fn restore(bookmark: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let data = NSData::with_bytes(bookmark);
        let mut stale = Bool::NO;
        // SAFETY: `stale` は呼び出しの間だけ生きている有効なポインター
        let url: Retained<NSURL> = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope
                    | NSURLBookmarkResolutionOptions::WithoutUI
                    | NSURLBookmarkResolutionOptions::WithoutMounting,
                None,
                &mut stale,
            )
        }
        .map_err(|error| format!("{error:?}"))?;
        // SAFETY: 解決したばかりの URL に対する呼び出しで、前提は無い
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return Err("startAccessingSecurityScopedResource returned false".to_string());
        }
        // フォルダーが動いた・名前が変わったなどで古くなったブックマークは、戻せても作り直しを求められる
        if stale.as_bool() {
            return create(&url).map(Some);
        }
        Ok(None)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::Path;

    pub fn bookmark(_path: &Path) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }

    pub fn restore(_bookmark: &[u8]) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied() -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    #[test]
    fn tells_a_denied_place_from_a_missing_one_only_where_access_can_be_granted() {
        let missing = Err(io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(reach_from(Ok(()), true), Reach::Readable);
        assert_eq!(reach_from(denied(), true), Reach::Denied);
        assert_eq!(reach_from(missing, true), Reach::Missing);
        // サンドボックスの無い OS では、断られたものもこれまでどおり無いものとみる
        assert_eq!(reach_from(denied(), false), Reach::Missing);
    }

    #[test]
    fn resolves_relative_link_targets_and_starts_the_grant_in_their_folder() {
        assert_eq!(
            normalize(Path::new(
                "/Users/me/Library/Application Support/com.amiiby.mawok/../../../dotfiles/./mawok/settings.toml"
            )),
            PathBuf::from("/Users/me/dotfiles/mawok/settings.toml")
        );
        assert_eq!(
            grant_start(Path::new("/Users/me/dotfiles/mawok/settings.toml")),
            PathBuf::from("/Users/me/dotfiles/mawok")
        );
    }

    #[test]
    fn a_folder_contains_targets_under_it_but_not_a_sibling_with_a_longer_name() {
        let target = Path::new("/Users/me/dotfiles/mawok/settings.toml");
        assert!(contains(Path::new("/Users/me/dotfiles/mawok"), target));
        assert!(contains(Path::new("/Users/me"), target));
        assert!(contains(
            Path::new("/Users/me/dotfiles/mawok"),
            Path::new("/Users/me/dotfiles/mawok")
        ));
        assert!(!contains(Path::new("/Users/me/dotfiles/maw"), target));
        assert!(!contains(Path::new("/Users/me/Documents"), target));
    }

    // Windows は symlink を張るのに権限が要るので、Unix だけで確かめる
    #[cfg(unix)]
    #[test]
    fn reads_the_target_of_a_relative_link_and_compares_real_paths() {
        let root = crate::test_support::TempDir::new("folder-access-links");
        let dotfiles = root.join("dotfiles");
        let config = root.join("config");
        fs::create_dir_all(&dotfiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::write(dotfiles.join("mawok.toml"), "").unwrap();
        std::os::unix::fs::symlink("../dotfiles/mawok.toml", config.join("settings.toml")).unwrap();
        let target = link_target(&config.join("settings.toml")).unwrap();
        assert_eq!(target, normalize(&dotfiles.join("mawok.toml")));
        assert_eq!(file_reach(&config.join("settings.toml")), Reach::Readable);
        assert_eq!(dir_reach(&dotfiles), Reach::Readable);
        assert_eq!(dir_reach(&dotfiles.join("mawok.toml")), Reach::Missing);
        // 先のパスが symlink を通っていても、実体のパスで含むとみる
        std::os::unix::fs::symlink(&dotfiles, root.join("linked")).unwrap();
        assert!(contains(&dotfiles, &root.join("linked").join("mawok.toml")));
        fs::remove_file(dotfiles.join("mawok.toml")).unwrap();
        assert_eq!(file_reach(&config.join("settings.toml")), Reach::Missing);
    }

    /// サンドボックスの外（テスト）でも、作ったブックマークから戻せる
    #[cfg(target_os = "macos")]
    #[test]
    fn a_bookmark_restores_outside_the_sandbox() {
        let dir = crate::test_support::TempDir::new("folder-access-bookmark");
        let bookmark = bookmark(dir.path())
            .expect("ブックマークを作れるはず")
            .expect("macOS では作るはず");
        assert_eq!(restore(&bookmark), Ok(None));
        // 2回目は、戻し済みとして何もしない
        assert_eq!(restore(&bookmark), Ok(None));
    }
}
