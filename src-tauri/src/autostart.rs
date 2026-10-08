//! OS のログイン項目への登録（ログイン時の起動）。いつ登録するか・外すかは lib.rs の `settle_autostart` などが決める。
//!
//! - macOS: ログイン項目（`SMAppService` の mainAppService、macOS 13 から）。登録はアプリの束（bundle）に結びつくので、置き場所を変えても登録先はずれない。
//! - Windows（MSIX 版）: マニフェストの `StartupTask`（`src-tauri/msix/AppxManifest.xml`）。MSIX の中から HKCU に書いても、
//!   パッケージごとの場所に回されて効かないため。
//! - Windows（EXE 版）: tauri-plugin-autostart（HKCU の Run と `Explorer\StartupApproved\Run`）

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

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_autostart::ManagerExt as _;

    use super::SetError;
    use crate::package::packaged;

    /// OS のログイン項目に登録されていて、有効か。タスクマネージャーや Windows の設定で切られていれば有効ではない
    pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
        #[cfg(windows)]
        if packaged() {
            return startup_task::is_enabled();
        }
        app.autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())
    }

    /// OS のログイン項目に登録する・外す
    pub fn set(app: &AppHandle, enabled: bool) -> Result<(), SetError> {
        #[cfg(windows)]
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

    #[cfg(windows)]
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
