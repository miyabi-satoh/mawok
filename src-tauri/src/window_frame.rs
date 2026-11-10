//! macOS の窓の位置と大きさの記録。window-state プラグインでなく、AppKit の frame autosave に任せる（docs/platform.md「macOS の窓の位置と大きさ」）

use objc2_app_kit::NSWindow;
use objc2_foundation::NSString;
use tauri::{Runtime, WebviewWindow};

/// 記録があれば窓をその位置と大きさにし、以後は動かす・大きさを変えるたびに AppKit が記録する。
/// 出す前に、メインスレッドで呼ぶ。記録が無ければ（初めて開いたとき）、作ったときの大きさで画面の中央に置く。
/// 窓は、Tauri に中央に置かせずに作る（docs/platform.md「macOS の窓の位置と大きさ」）
pub fn restore_and_track<R: Runtime>(window: &WebviewWindow<R>, name: &str) {
    let Ok(pointer) = window.ns_window() else {
        log::warn!("couldn't get the NSWindow of the {} window", window.label());
        return;
    };
    // SAFETY: Tauri が返す NSWindow を、メインスレッドで、窓が生きている間に読む
    let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
    let name = NSString::from_str(name);
    // Tauri には中央に置かせずに作っているので、記録が無ければここで置く
    if !ns_window.setFrameUsingName(&name) {
        ns_window.center();
    }
    // 同じ名前の窓がほかに開いていると断られる。閉じた窓の名前は、閉じたときに空く
    if !ns_window.setFrameAutosaveName(&name) {
        log::warn!(
            "couldn't keep track of the frame of the {} window",
            window.label()
        );
    }
}
