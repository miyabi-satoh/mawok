//! macOS で、アプリのメニュー（トレイのメニューなど）を開いている・閉じたを知る。
//!
//! メニューを開いている間、AppKit はメニューの操作だけを待つので、グローバルホットキー（Carbon の
//! RegisterEventHotKey）のイベントは配られずに溜まり、メニューが閉じた直後に届く。項目を選んだ操作と
//! 続けて効いてしまうので、開いている間はホットキーの登録を外す。Tauri にはメニューの開閉を知らせる API が
//! ないため（tauri#9138）、AppKit の NSMenuDidBeginTracking / NSMenuDidEndTracking の通知を受ける。
//! 同じ現象を KeyboardShortcuts（sindresorhus/KeyboardShortcuts#1）も、この通知で開いている間だけ
//! ホットキーを外して避けている

use block2::RcBlock;
use objc2_app_kit::{NSMenuDidBeginTrackingNotification, NSMenuDidEndTrackingNotification};
use objc2_foundation::{NSNotificationCenter, NSNotificationName};

/// メニューを開いたときに `on_begin`、閉じたときに `on_end` を呼ぶ。どちらもメインスレッドで呼ばれる。
/// どのメニューかは絞らない（下書きの入力欄の右クリックのメニューでも呼ばれる。開いている間ホットキーが効かないだけで困らない）。
/// アプリが動いている間ずっと受けるので、登録は解かない
pub fn observe(on_begin: impl Fn() + 'static, on_end: impl Fn() + 'static) {
    // SAFETY: 通知の名前は AppKit が定義する定数で、アプリが動いている間は有効
    let (begin, end) = unsafe {
        (
            NSMenuDidBeginTrackingNotification,
            NSMenuDidEndTrackingNotification,
        )
    };
    add_observer(begin, on_begin);
    add_observer(end, on_end);
}

fn add_observer(name: &NSNotificationName, callback: impl Fn() + 'static) {
    let block = RcBlock::new(move |_| callback());
    let center = NSNotificationCenter::defaultCenter();
    // queue を渡さないので、通知を出したスレッド（メニューを扱うメインスレッド）でそのまま呼ばれる。
    // SAFETY: object は nil（どのメニューからの通知も受ける）で、block はメインスレッドでだけ呼ばれる
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
    };
    // 登録は NotificationCenter が持つ。返る値は登録を解くときに使うもので、解くことはないが、
    // 実機で確かめたときの形のまま、手放さずにアプリが動いている間持ち続ける
    std::mem::forget(token);
}
