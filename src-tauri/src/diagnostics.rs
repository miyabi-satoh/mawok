//! 不具合の原因を後から追えるように、アプリの動きをログファイルへ残す。
//! 出力先は OS のログフォルダ（macOS: ~/Library/Logs/com.amiiby.mawok、
//! Windows: %LOCALAPPDATA%\com.amiiby.mawok\logs）。時刻は UTC。
//! WebView のプロセスが落ちたときは、記録に加えて、立て直せるものは立て直す。

use log::LevelFilter;
use tauri::{plugin::TauriPlugin, Runtime};
use tauri_plugin_log::RotationStrategy;

pub fn log_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .level(LevelFilter::Info)
        .max_file_size(1_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .build()
}

/// WebView のプロセスが異常終了したら記録する（macOS は Builder の on_web_content_process_terminate で記録する）
#[cfg(windows)]
pub fn watch_webview_process<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let label = window.label().to_owned();
    let registered = window.with_webview(move |webview| {
        if let Err(error) = webview2::add_process_failed_handler(&webview, label) {
            log::error!("couldn't watch the WebView2 process: {error}");
        }
    });
    if let Err(error) = registered {
        log::error!("couldn't watch the WebView2 process: {error}");
    }
}

#[cfg(not(windows))]
pub fn watch_webview_process<R: Runtime>(_window: &tauri::WebviewWindow<R>) {}

/// 描画プロセスが落ちると画面が空になり、自動では戻らないので、再読み込みする
#[cfg(target_os = "macos")]
pub fn web_content_process_terminated<R: Runtime>(webview: &tauri::Webview<R>) {
    let label = webview.label();
    log::error!("web content process terminated in webview {label}");
    match webview.reload() {
        Ok(()) => log::info!("reloaded webview {label}"),
        Err(error) => log::error!("couldn't reload webview {label}: {error}"),
    }
}

/// WebView2 の COREWEBVIEW2_PROCESS_FAILED_KIND の名前
#[cfg(any(windows, test))]
fn process_failed_kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "BROWSER_PROCESS_EXITED",
        1 => "RENDER_PROCESS_EXITED",
        2 => "RENDER_PROCESS_UNRESPONSIVE",
        3 => "FRAME_RENDER_PROCESS_EXITED",
        4 => "UTILITY_PROCESS_EXITED",
        5 => "SANDBOX_HELPER_PROCESS_EXITED",
        6 => "GPU_PROCESS_EXITED",
        7 => "PPAPI_PLUGIN_PROCESS_EXITED",
        8 => "PPAPI_BROKER_PROCESS_EXITED",
        9 => "UNKNOWN_PROCESS_EXITED",
        _ => "UNRECOGNIZED",
    }
}

/// WebView2 の COREWEBVIEW2_PROCESS_FAILED_REASON の名前
#[cfg(any(windows, test))]
fn process_failed_reason_name(reason: i32) -> &'static str {
    match reason {
        0 => "UNEXPECTED",
        1 => "UNRESPONSIVE",
        2 => "TERMINATED",
        3 => "CRASHED",
        4 => "LAUNCH_FAILED",
        5 => "OUT_OF_MEMORY",
        6 => "PROFILE_DELETED",
        _ => "UNRECOGNIZED",
    }
}

/// 異常終了の種類ごとに、再読み込みで立て直すかを決める。
/// - レンダラーが終了した: 画面が空のまま戻らないので、再読み込みする
/// - レンダラーが応答しない: 回復することがあり、再読み込みすると入力途中の下書きが消えるので、しない
/// - GPU などの補助プロセス: WebView2 が自分で立て直すので、しない
/// - WebView2 本体: 再読み込みでは戻らないので、しない
#[cfg(any(windows, test))]
fn reloads_after_process_failure(kind: i32) -> bool {
    process_failed_kind_name(kind) == "RENDER_PROCESS_EXITED"
}

#[cfg(windows)]
mod webview2 {
    use tauri::webview::PlatformWebview;
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
            COREWEBVIEW2_PROCESS_FAILED_REASON,
        },
        ProcessFailedEventHandler,
    };
    use windows_core::{Interface, Result};

    use super::{
        process_failed_kind_name, process_failed_reason_name, reloads_after_process_failure,
    };

    pub fn add_process_failed_handler(webview: &PlatformWebview, label: String) -> Result<()> {
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            // 終了の理由と終了コードは、新しい版のインターフェースでだけ取れる
            let details = args
                .cast::<ICoreWebView2ProcessFailedEventArgs2>()
                .and_then(|args| {
                    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                    let mut exit_code = 0;
                    unsafe {
                        args.Reason(&mut reason)?;
                        args.ExitCode(&mut exit_code)?;
                    }
                    Ok(format!(
                        ", reason {} ({}), exit code {exit_code}",
                        process_failed_reason_name(reason.0),
                        reason.0
                    ))
                })
                .unwrap_or_default();
            log::error!(
                "WebView2 process failed in window {label}: kind {} ({}){details}",
                process_failed_kind_name(kind.0),
                kind.0
            );

            if let (true, Some(sender)) = (reloads_after_process_failure(kind.0), sender) {
                match unsafe { sender.Reload() } {
                    Ok(()) => log::info!("reloaded the webview in window {label}"),
                    Err(error) => {
                        log::error!("couldn't reload the webview in window {label}: {error}")
                    }
                }
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe {
            webview
                .controller()
                .CoreWebView2()?
                .add_ProcessFailed(&handler, &mut token)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrecognized_values_are_named_as_such() {
        assert_eq!(process_failed_kind_name(-1), "UNRECOGNIZED");
        assert_eq!(process_failed_kind_name(10), "UNRECOGNIZED");
        assert_eq!(process_failed_reason_name(7), "UNRECOGNIZED");
    }

    #[test]
    fn reloads_only_when_the_render_process_exited() {
        assert!(reloads_after_process_failure(1));
        for kind in [0, 2, 3, 4, 5, 6, 7, 8, 9, 10] {
            assert!(!reloads_after_process_failure(kind), "kind {kind}");
        }
    }

    /// 名前の対応が WebView2 の定義と一致しているか。定義は Windows でしか使えないので、Windows で確かめる。
    #[cfg(windows)]
    #[test]
    fn names_match_webview2_constants() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;

        let kinds = [
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                "BROWSER_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                "RENDER_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                "RENDER_PROCESS_UNRESPONSIVE",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
                "FRAME_RENDER_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
                "UTILITY_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
                "SANDBOX_HELPER_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
                "GPU_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
                "PPAPI_PLUGIN_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
                "PPAPI_BROKER_PROCESS_EXITED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
                "UNKNOWN_PROCESS_EXITED",
            ),
        ];
        for (kind, name) in kinds {
            assert_eq!(process_failed_kind_name(kind.0), name);
        }

        let reasons = [
            (COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED, "UNEXPECTED"),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE,
                "UNRESPONSIVE",
            ),
            (COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED, "TERMINATED"),
            (COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED, "CRASHED"),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED,
                "LAUNCH_FAILED",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY,
                "OUT_OF_MEMORY",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED,
                "PROFILE_DELETED",
            ),
        ];
        for (reason, name) in reasons {
            assert_eq!(process_failed_reason_name(reason.0), name);
        }
    }
}
