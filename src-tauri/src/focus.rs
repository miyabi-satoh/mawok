//! 下書きウィンドウを出してフォーカスを入れ、隠したときに直前のアプリへフォーカスを戻す（docs/platform.md「実装上の注意」）

#[cfg(windows)]
mod platform {
    use tauri::{AppHandle, Runtime, WebviewWindow};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetTopWindow, GetWindow, GetWindowLongW, IsIconic,
        IsWindowVisible, SetForegroundWindow, GWL_EXSTYLE, GW_HWNDNEXT, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    /// 表示する直前に使っていたアプリのウィンドウ
    #[derive(Debug, Default, Clone, Copy)]
    pub struct ReturnTarget(isize);

    /// 前面のウィンドウを戻り先にする。前面が戻っても使えないウィンドウのとき（トレイのメニューを出すと、
    /// tray-icon がメニューの持ち主の見えないウィンドウを前面にする）は、重なり順で上から、戻れるウィンドウを探す。
    /// 設定などの自分のウィンドウも、見えていれば戻り先にする（設定を使っている最中に下書きを出したときは、設定へ戻る）
    pub fn capture<R: Runtime>(window: &WebviewWindow<R>) -> ReturnTarget {
        let draft = window.hwnd().map_or(0, |hwnd| hwnd.0 as isize);
        let usable = |hwnd: HWND| hwnd.0 as isize != draft && can_return_to(hwnd);
        let foreground = unsafe { GetForegroundWindow() };
        let target = if usable(foreground) {
            Some(foreground)
        } else {
            topmost(usable)
        };
        ReturnTarget(target.map_or(0, |hwnd| hwnd.0 as isize))
    }

    fn topmost(usable: impl Fn(HWND) -> bool) -> Option<HWND> {
        let mut next = unsafe { GetTopWindow(None) }.ok();
        while let Some(hwnd) = next {
            if usable(hwnd) {
                return Some(hwnd);
            }
            next = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.ok();
        }
        None
    }

    /// Alt+Tab に出るような、ユーザーが使っているウィンドウか
    fn can_return_to(hwnd: HWND) -> bool {
        if hwnd.is_invalid()
            || !unsafe { IsWindowVisible(hwnd) }.as_bool()
            || unsafe { IsIconic(hwnd) }.as_bool()
        {
            return false;
        }
        let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
        if ex_style & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0 {
            return false;
        }
        // 別の仮想デスクトップのものや、中断したストアアプリの枠は、見えている扱いのまま隠されている
        let mut cloaked = 0u32;
        let cloaked_read = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&raw mut cloaked).cast(),
                size_of::<u32>() as u32,
            )
        };
        if cloaked_read.is_ok() && cloaked != 0 {
            return false;
        }
        let mut class = [0u16; 32];
        let length = unsafe { GetClassNameW(hwnd, &mut class) };
        let class = String::from_utf16_lossy(&class[..length.max(0) as usize]);
        // タスクバー（2台目以降の画面のものも）
        !matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
    }

    pub fn before_show<R: Runtime>(_app: &AppHandle<R>) {}

    // ウィンドウを隠すだけだと、どのウィンドウが前面になるかは OS 任せになる。
    // 自分がまだ前面にいるうちに戻り先を前面にしてから隠す。
    pub fn hide_and_return<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        target: ReturnTarget,
    ) -> tauri::Result<()> {
        if target.0 != 0 {
            let _ = unsafe { SetForegroundWindow(HWND(target.0 as *mut core::ffi::c_void)) };
        }
        window.hide()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use tauri::{AppHandle, Runtime, WebviewWindow};

    /// macOS では、下書きはアプリを前面にしないパネルで出し、前面にしたときも NSApplication.hide が直前のアプリをアクティブにするので、記録は不要
    #[derive(Debug, Default, Clone, Copy)]
    pub struct ReturnTarget;

    pub fn capture<R: Runtime>(_window: &WebviewWindow<R>) -> ReturnTarget {
        ReturnTarget
    }

    pub fn before_show<R: Runtime>(app: &AppHandle<R>) {
        let _ = app.show();
    }

    // 設定を閉じた後のようにアプリを前面にしていると、ウィンドウを隠すだけではアクティブなまま残るので、アプリごと隠す
    pub fn hide_and_return<R: Runtime>(
        app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        _target: ReturnTarget,
    ) -> tauri::Result<()> {
        window.hide()?;
        app.hide()
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use tauri::{AppHandle, Runtime, WebviewWindow};

    #[derive(Debug, Default, Clone, Copy)]
    pub struct ReturnTarget;

    pub fn capture<R: Runtime>(_window: &WebviewWindow<R>) -> ReturnTarget {
        ReturnTarget
    }

    pub fn before_show<R: Runtime>(_app: &AppHandle<R>) {}

    pub fn hide_and_return<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        _target: ReturnTarget,
    ) -> tauri::Result<()> {
        window.hide()
    }
}

use tauri::{AppHandle, Runtime, WebviewWindow};

pub use platform::*;

/// 下書きウィンドウを出して、キーボードのフォーカスを入れる
#[cfg(not(target_os = "macos"))]
pub fn show_draft<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> tauri::Result<()> {
    before_show(app);
    window.show()?;
    if let Err(error) = window.set_focus() {
        log::error!("couldn't focus the draft window: {error}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(DraftPanel {
        config: {
            can_become_key_window: true
        }
    })
}

/// 下書きウィンドウを、アプリを前面にしないパネルにし、今の Space（ほかのアプリのフルスクリーンも含む）に出るようにする。
/// 前面にすると、フルスクリーンの Space から外れてほかのディスプレイに出るため（docs/platform.md「実装上の注意」）
#[cfg(target_os = "macos")]
pub fn make_draft_panel<R: Runtime>(window: &WebviewWindow<R>) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    use tauri_nspanel::WebviewWindowExt;
    let Ok(pointer) = window.ns_window() else {
        log::warn!("couldn't get the NSWindow of the draft window");
        return;
    };
    // SAFETY: Tauri が返す NSWindow を、メインスレッドで動く setup の中で、窓が生きている間に読む
    let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
    let (style, behavior) = (ns_window.styleMask(), ns_window.collectionBehavior());
    let panel = match window.to_panel::<DraftPanel<R>>() {
        Ok(panel) => panel,
        Err(error) => {
            log::warn!("couldn't make the draft window a panel: {error}");
            return;
        }
    };
    if let Err(error) = panel.set_style_mask(style | NSWindowStyleMask::NonactivatingPanel) {
        log::warn!("couldn't make the draft panel non-activating: {error:?}");
    }
    panel.set_collection_behavior(
        behavior
            | NSWindowCollectionBehavior::MoveToActiveSpace
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
}

/// 出ている下書きウィンドウへ、キーボードのフォーカスを戻す。macOS ではアプリを前面にしない
#[cfg(not(target_os = "macos"))]
pub fn refocus_draft<R: Runtime>(_app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let _ = window.set_focus();
}

/// 出ている下書きウィンドウへ、キーボードのフォーカスを戻す。前面にすると、フルスクリーンの Space から外れるため
#[cfg(target_os = "macos")]
pub fn refocus_draft<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    use tauri_nspanel::ManagerExt;
    match app.get_webview_panel(window.label()) {
        Ok(panel) => panel.make_key_window(),
        Err(_) => {
            let _ = window.set_focus();
        }
    }
}

/// 下書きウィンドウを、アプリを前面にせずに出して、キーボードのフォーカスを入れる。パネルにできていなければ、ふつうのウィンドウとして出す
#[cfg(target_os = "macos")]
pub fn show_draft<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> tauri::Result<()> {
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = app.get_webview_panel(window.label()) {
        // show_and_make_key は使わない。中身のビューを入力先にし直すので、出ている窓を呼び戻すと WebView の入力欄からフォーカスが外れる
        panel.order_front_regardless();
        panel.make_key_window();
        return Ok(());
    }
    before_show(app);
    window.show()?;
    if let Err(error) = window.set_focus() {
        log::error!("couldn't focus the draft window: {error}");
    }
    Ok(())
}
