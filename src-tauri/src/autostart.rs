//! OS のログイン項目への登録（ログイン時の起動）。いつ登録するか・外すかは lib.rs の `settle_autostart` などが決める。
//!
//! - macOS: ログイン項目（`SMAppService` の mainAppService、macOS 13 から）。登録はアプリの束（bundle）に結びつくので、置き場所を変えても登録先はずれない。
//! - Windows（MSIX 版）: マニフェストの `StartupTask`（`src-tauri/msix/AppxManifest.xml`）。MSIX の中から HKCU に書いても、
//!   パッケージごとの場所に回されて効かないため。
//! - Windows（EXE 版）: tauri-plugin-autostart（HKCU の Run と `Explorer\StartupApproved\Run`）
//! - Linux: XDG の自動起動（`~/.config/autostart/Mawok.desktop`）。tauri-plugin-autostart はファイルがあるかしか見ず、
//!   デスクトップの設定で切ったとき（`Hidden=true` など）も有効と読むので、自前で読み書きする。

pub use imp::*;

/// ログイン項目を読めなかった・登録や解除ができなかった理由
#[derive(Clone, Debug)]
pub enum SetError {
    /// OS が返した失敗。OS の文をそのまま出す
    Os(String),
    /// 利用者がタスクマネージャーや Windows の設定（スタートアップ アプリ）でオフにしていて、アプリからは戻せない（MSIX 版）
    #[cfg_attr(not(windows), allow(dead_code))]
    TurnedOffInWindowsSettings,
    /// 組織のポリシーで決められていて、アプリからは変えられない（MSIX 版）
    #[cfg_attr(not(windows), allow(dead_code))]
    SetByPolicy,
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_foundation::NSError;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use tauri::AppHandle;

    use super::SetError;

    /// OS のログイン項目に登録されていて、有効か。システム設定で切られていれば（`RequiresApproval`）有効ではない
    pub fn is_enabled(_app: &AppHandle) -> Result<bool, String> {
        Ok(enabled())
    }

    /// OS のログイン項目に登録する・外す
    pub fn set(_app: &AppHandle, enabled: bool) -> Result<(), SetError> {
        // SAFETY: mainAppService は引数を取らず、このアプリ自身を指すサービスを返す
        let service = unsafe { SMAppService::mainAppService() };
        let current = status();
        if enabled {
            if current == SMAppServiceStatus::Enabled {
                return Ok(());
            }
            if current == SMAppServiceStatus::RequiresApproval {
                // システム設定で切られていると、登録し直しても断られる（kSMErrorLaunchDeniedByUser。その理由をトレイの ⚠ に出す）。
                // Apple の勧めに合わせて、利用者が戻せるようシステム設定のログイン項目を開く
                // SAFETY: 引数を取らず、システム設定を開くだけ
                unsafe { SMAppService::openSystemSettingsLoginItems() };
            }
            // SAFETY: このアプリ自身を登録する
            unsafe { service.registerAndReturnError() }
                .map_err(|error| SetError::Os(describe(&error)))
        } else {
            // 登録されていないものを外すと kSMErrorJobNotFound になるので、登録が残っているときだけ外す
            if current == SMAppServiceStatus::NotRegistered
                || current == SMAppServiceStatus::NotFound
            {
                return Ok(());
            }
            // SAFETY: このアプリ自身の登録を外す。動いているこのアプリは止まらない
            unsafe { service.unregisterAndReturnError() }
                .map_err(|error| SetError::Os(describe(&error)))
        }
    }

    /// 登録先が今のアプリか。ログイン項目はアプリの束に結びつくので、有効なら（有効なときにしか呼ばない）いつも今のアプリを指している
    pub fn registration_is_current(_app: &AppHandle) -> bool {
        true
    }

    fn enabled() -> bool {
        status() == SMAppServiceStatus::Enabled
    }

    fn status() -> SMAppServiceStatus {
        // SAFETY: mainAppService・status は引数を取らず、状態を読むだけ
        unsafe { SMAppService::mainAppService().status() }
    }

    fn describe(error: &NSError) -> String {
        error.localizedDescription().to_string()
    }
}

#[cfg(windows)]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_autostart::ManagerExt as _;

    use super::SetError;
    use crate::package::packaged;

    /// OS のログイン項目に登録されていて、有効か。タスクマネージャーや Windows の設定で切られていれば有効ではない
    pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
        if packaged() {
            return startup_task::is_enabled();
        }
        app.autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())
    }

    /// OS のログイン項目に登録する・外す
    pub fn set(app: &AppHandle, enabled: bool) -> Result<(), SetError> {
        if packaged() {
            return startup_task::set(app, enabled);
        }
        let autolaunch = app.autolaunch();
        let result = if enabled {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        result.map_err(|error| SetError::Os(error.to_string()))
    }

    /// 登録先が今の実行ファイルか。MSIX 版の StartupTask はパッケージに結びつくので、いつも今のアプリを指している。
    /// EXE 版は登録先を比べずに、毎回書き直す。書き直しは Run の値と StartupApproved の「有効」を書くだけで、知らせは出ない。
    /// 有効なときにしか呼ばないので、タスクマネージャーで切った状態を戻すことはない
    pub fn registration_is_current(_app: &AppHandle) -> bool {
        packaged()
    }

    mod startup_task {
        use tauri::AppHandle;
        use tauri_plugin_opener::OpenerExt as _;
        use windows::core::h;
        use windows::ApplicationModel::{StartupTask, StartupTaskState};

        use super::SetError;

        /// src-tauri/msix/AppxManifest.xml の `StartupTask` の `TaskId` と揃える
        fn task() -> Result<StartupTask, String> {
            StartupTask::GetAsync(h!("Mawok"))
                .and_then(|operation| operation.join())
                .map_err(|error| error.to_string())
        }

        fn state(task: &StartupTask) -> Result<StartupTaskState, String> {
            task.State().map_err(|error| error.to_string())
        }

        fn enabled(state: StartupTaskState) -> bool {
            state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
        }

        pub fn is_enabled() -> Result<bool, String> {
            Ok(enabled(state(&task()?)?))
        }

        pub fn set(app: &AppHandle, enabled_now: bool) -> Result<(), SetError> {
            let task = task().map_err(SetError::Os)?;
            if !enabled_now {
                task.Disable()
                    .map_err(|error| SetError::Os(error.to_string()))?;
                return match state(&task).map_err(SetError::Os)? {
                    StartupTaskState::EnabledByPolicy => Err(SetError::SetByPolicy),
                    _ => Ok(()),
                };
            }
            // パッケージのデスクトップアプリからは、同意のダイアログを出さずに有効になる。
            // 利用者がタスクマネージャーや Windows の設定で切ったときは、アプリからは戻せない
            let state = task
                .RequestEnableAsync()
                .and_then(|operation| operation.join())
                .map_err(|error| SetError::Os(error.to_string()))?;
            if enabled(state) {
                return Ok(());
            }
            if state == StartupTaskState::DisabledByUser {
                // macOS でシステム設定のログイン項目を開くのと同じく、利用者が戻せるよう Windows の設定を開く
                let _ = app
                    .opener()
                    .open_url("ms-settings:startupapps", None::<&str>);
                return Err(SetError::TurnedOffInWindowsSettings);
            }
            Err(SetError::SetByPolicy)
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::{Path, PathBuf};

    use tauri::{AppHandle, Manager as _};

    use super::{desktop_entry, enabled_in, exec_in, exec_value, SetError};

    /// 自動起動の .desktop が有り、デスクトップの設定で切られていないか
    pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
        Ok(read(&file(app)?)?.is_some_and(|content| enabled_in(&content)))
    }

    /// 自動起動の .desktop を書く・消す。切られた（`Hidden=true` などの）ファイルも、書き直して有効に戻す
    pub fn set(app: &AppHandle, enabled: bool) -> Result<(), SetError> {
        let file = file(app).map_err(SetError::Os)?;
        let result = if enabled {
            let content = desktop_entry(&app.package_info().name, &exec().map_err(SetError::Os)?);
            file.parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(&file, content))
        } else {
            match std::fs::remove_file(&file) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                result => result,
            }
        };
        result.map_err(|error| SetError::Os(error.to_string()))
    }

    /// 登録先が今の実行ファイルか。.desktop の Exec を比べる。読めなければ書き直すほうに倒す
    pub fn registration_is_current(app: &AppHandle) -> bool {
        let (Ok(file), Ok(exec)) = (file(app), exec()) else {
            return false;
        };
        matches!(read(&file), Ok(Some(content)) if exec_in(&content) == Some(exec.as_str()))
    }

    /// `$XDG_CONFIG_HOME/autostart/<アプリ名>.desktop`。名前は tauri-plugin-autostart と同じにする
    fn file(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .config_dir()
            .map(|dir| {
                dir.join("autostart")
                    .join(format!("{}.desktop", app.package_info().name))
            })
            .map_err(|error| error.to_string())
    }

    fn read(file: &Path) -> Result<Option<String>, String> {
        match std::fs::read_to_string(file) {
            Ok(content) => Ok(Some(content)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn exec() -> Result<String, String> {
        let path = std::env::current_exe().map_err(|error| error.to_string())?;
        let path = path.to_str().ok_or("the executable path is not UTF-8")?;
        // 動いている間に apt で入れ替えると、元のファイルは消えて /proc/self/exe の先に印が付く。入れ替えた後も同じ場所にあるので、印を外す
        let path = path.strip_suffix(" (deleted)").unwrap_or(path);
        Ok(exec_value(path))
    }
}

/// XDG の自動起動の .desktop の中身。名前はデスクトップの自動起動の一覧に出る
#[cfg(any(target_os = "linux", test))]
fn desktop_entry(name: &str, exec: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

/// .desktop の `[Desktop Entry]` の項目の値
#[cfg(any(target_os = "linux", test))]
fn desktop_entry_value<'a>(content: &'a str, key: &str) -> Option<&'a str> {
    let mut in_entry = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some((name, value)) = line.split_once('=') {
            if name.trim_end() == key {
                return Some(value.trim_start());
            }
        }
    }
    None
}

/// 自動起動が有効か。デスクトップの設定で切ると、ファイルを消さずに `Hidden=true`（XDG の決まり）や
/// `X-GNOME-Autostart-enabled=false`（GNOME）を書くものがあり、それを切ってあると読む（docs/platform.md「常駐」）
#[cfg(any(target_os = "linux", test))]
fn enabled_in(content: &str) -> bool {
    desktop_entry_value(content, "Hidden") != Some("true")
        && desktop_entry_value(content, "X-GNOME-Autostart-enabled") != Some("false")
}

#[cfg(any(target_os = "linux", test))]
fn exec_in(content: &str) -> Option<&str> {
    desktop_entry_value(content, "Exec")
}

/// 実行ファイルのパスを Exec の値にする。空白や記号を含むパスは、Desktop Entry の決まりに従って引用符で囲み、
/// 引用符の中で特別な文字を `\` で逃がす。`\` は値の文字列としてもう一度逃がす。`%` はフィールドコードと読まれないよう `%%` にする
#[cfg(any(target_os = "linux", test))]
fn exec_value(path: &str) -> String {
    let path = path.replace('%', "%%");
    let plain = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+%".contains(c));
    if plain {
        return path;
    }
    let mut quoted = String::from("\"");
    for c in path.chars() {
        match c {
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(c);
            }
            '\\' => quoted.push_str("\\\\\\\\"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_entry_is_enabled_and_points_to_the_executable() {
        let content = desktop_entry("Mawok", "/usr/bin/mawok");
        assert!(enabled_in(&content));
        assert_eq!(exec_in(&content), Some("/usr/bin/mawok"));
    }

    #[test]
    fn turned_off_in_the_desktop_settings() {
        let base = desktop_entry("Mawok", "/usr/bin/mawok");
        assert!(!enabled_in(&format!("{base}Hidden=true\n")));
        assert!(!enabled_in(&base.replace(
            "X-GNOME-Autostart-enabled=true",
            "X-GNOME-Autostart-enabled=false"
        )));
        assert!(enabled_in(&format!("{base}Hidden=false\n")));
    }

    #[test]
    fn reads_only_the_desktop_entry_group() {
        let content = "[Desktop Entry]\nExec = /usr/bin/mawok\n[Desktop Action new]\nHidden=true\nExec=/usr/bin/other\n";
        assert!(enabled_in(content));
        assert_eq!(exec_in(content), Some("/usr/bin/mawok"));
        assert_eq!(exec_in("Exec=/usr/bin/mawok\n"), None);
    }

    #[test]
    fn quotes_paths_with_reserved_characters() {
        assert_eq!(exec_value("/usr/bin/mawok"), "/usr/bin/mawok");
        assert_eq!(exec_value("/opt/My Apps/mawok"), "\"/opt/My Apps/mawok\"");
        assert_eq!(exec_value("/opt/a$b/mawok"), "\"/opt/a\\\\$b/mawok\"");
        assert_eq!(exec_value("/opt/100%/mawok"), "/opt/100%%/mawok");
    }
}
