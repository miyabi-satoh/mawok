//! macOS の窓の位置と大きさの記録。window-state プラグインでなく、AppKit の frame autosave に任せる（docs/platform.md「macOS の窓の位置と大きさ」）

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindow};
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
    // 同じ名前の窓がアプリの中にほかにあると断られる。閉じた窓は、Tauri が片付けるまで名前を持ったまま残り、
    // 閉じてすぐ開き直すとその窓が名前を持っているので、先に外す（記録は動かすたびに済んでいる）
    release_name_held_by_closed_windows(ns_window, &name);
    if !ns_window.setFrameAutosaveName(&name) {
        log::warn!(
            "couldn't keep track of the frame of the {} window",
            window.label()
        );
    }
}

fn release_name_held_by_closed_windows(window: &NSWindow, name: &NSString) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    for other in NSApplication::sharedApplication(mtm).windows() {
        if &*other != window && !other.isVisible() && *other.frameAutosaveName() == *name {
            other.setFrameAutosaveName(&NSString::from_str(""));
        }
    }
}
