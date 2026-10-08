//! Windows の MSIX のパッケージの中で動いているか（→ docs/platform.md「Windows の MSIX 版」）

/// MSIX のパッケージの中で動いているか。AUMID が取れるかで見る（パッケージの中の判定を1つにするため）
#[cfg(windows)]
pub fn packaged() -> bool {
    app_user_model_id().is_some()
}

#[cfg(not(windows))]
pub fn packaged() -> bool {
    false
}

/// パッケージの中で動いているときの、このアプリの AUMID（`<パッケージ ファミリー名>!Mawok`）。EXE 版では None。
/// MSIX 版の通知は、差出人をこれにしないと出ない
#[cfg(windows)]
pub fn app_user_model_id() -> Option<&'static str> {
    static ID: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
        use windows::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId;

        let mut len = 0;
        // SAFETY: 長さだけを問い合わせる（書き込み先を渡さない）。パッケージの外では APPMODEL_ERROR_NO_APPLICATION が返る
        if unsafe { GetCurrentApplicationUserModelId(&mut len, None) } != ERROR_INSUFFICIENT_BUFFER
        {
            return None;
        }
        let mut buffer = vec![0u16; len as usize];
        // SAFETY: 終端の NUL を含めて len 文字の書き込み先を渡す
        let result =
            unsafe { GetCurrentApplicationUserModelId(&mut len, Some(PWSTR(buffer.as_mut_ptr()))) };
        if result != ERROR_SUCCESS {
            return None;
        }
        // len は終端の NUL を含む
        String::from_utf16(&buffer[..(len as usize).saturating_sub(1)]).ok()
    })
    .as_deref()
}

/// エクスプローラーで見せるときのパス。MSIX 版では、AppData の下に新しく作ったファイルがパッケージごとの場所に回され、
/// パッケージの外で動くエクスプローラーからは元のパスでは見えない。回された先にあれば、そちらを返す。
/// `roaming`・`local` は実際の `%APPDATA%`・`%LOCALAPPDATA%`
#[cfg(windows)]
pub fn path_for_explorer(
    path: std::path::PathBuf,
    roaming: &std::path::Path,
    local: &std::path::Path,
) -> std::path::PathBuf {
    let Some(family) = app_user_model_id()
        .and_then(|id| id.split_once('!'))
        .map(|(family, _)| family)
    else {
        return path;
    };
    match redirected(&path, roaming, local, family) {
        Some(redirected) if redirected.exists() => redirected,
        _ => path,
    }
}

/// AppData の下のパスが、パッケージ ファミリー名 `family` の MSIX 版で回される先
/// （`%LOCALAPPDATA%\Packages\<family>\LocalCache\{Roaming,Local}\…`）。AppData の下でなければ None
#[cfg(windows)]
fn redirected(
    path: &std::path::Path,
    roaming: &std::path::Path,
    local: &std::path::Path,
    family: &str,
) -> Option<std::path::PathBuf> {
    let cache = local.join("Packages").join(family).join("LocalCache");
    // %LOCALAPPDATA%\Packages の下は回されないので、そのまま返さずに None にする
    if path.starts_with(local.join("Packages")) {
        return None;
    }
    if let Ok(rest) = path.strip_prefix(roaming) {
        return Some(cache.join("Roaming").join(rest));
    }
    path.strip_prefix(local)
        .ok()
        .map(|rest| cache.join("Local").join(rest))
}

#[cfg(all(windows, test))]
mod tests {
    use super::redirected;
    use std::path::{Path, PathBuf};

    const FAMILY: &str = "amiiby.Mawok_tv82n7df3ay6j";

    fn redirect(path: &str) -> Option<PathBuf> {
        redirected(
            Path::new(path),
            Path::new(r"C:\Users\u\AppData\Roaming"),
            Path::new(r"C:\Users\u\AppData\Local"),
            FAMILY,
        )
    }

    #[test]
    fn roaming_and_local_go_to_the_package_cache() {
        assert_eq!(
            redirect(r"C:\Users\u\AppData\Roaming\com.amiiby.mawok\config.toml"),
            Some(PathBuf::from(format!(
                r"C:\Users\u\AppData\Local\Packages\{FAMILY}\LocalCache\Roaming\com.amiiby.mawok\config.toml"
            )))
        );
        assert_eq!(
            redirect(r"C:\Users\u\AppData\Local\com.amiiby.mawok\logs"),
            Some(PathBuf::from(format!(
                r"C:\Users\u\AppData\Local\Packages\{FAMILY}\LocalCache\Local\com.amiiby.mawok\logs"
            )))
        );
    }

    #[test]
    fn paths_outside_app_data_are_not_redirected() {
        assert_eq!(redirect(r"C:\Users\u\Documents\config.toml"), None);
        assert_eq!(
            redirect(&format!(
                r"C:\Users\u\AppData\Local\Packages\{FAMILY}\LocalState\x"
            )),
            None
        );
    }
}
