//! macOS で、メニューバーのアイコンを VoiceOver などのアクセシビリティから「押した」ときにメニューを開く。
//!
//! tray-icon（0.25 以降）は、アイコンにメニューを付けるのをマウスで押している間だけにしている
//! （macOS 27 で、メニューを付けたままだとクリックのイベントが届かないため。tray-icon#365）。
//! アクセシビリティの押す操作（AXPress）はマウスのイベントを通らず、ボタンの action を送るだけなので、
//! メニューの付いていないアイコンでは何も起きない。VoiceOver で状況メニューを開く操作（VO-M-M → VO-Space）は
//! macOS の標準なので、ボタンの action でメニューを開く

use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::NSStatusItem;

struct Ivars {
    on_press: Box<dyn Fn()>,
    // メニューを開く処理がもう一度ボタンを押すので、その間に届いた action では開き直さない
    pressing: Cell<bool>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MawokTrayPressTarget"]
    #[ivars = Ivars]
    struct PressTarget;

    impl PressTarget {
        #[unsafe(method(press:))]
        fn press(&self, _sender: Option<&AnyObject>) {
            let ivars = self.ivars();
            if ivars.pressing.replace(true) {
                return;
            }
            (ivars.on_press)();
            ivars.pressing.set(false);
        }
    }
);

impl PressTarget {
    fn new(mtm: MainThreadMarker, on_press: impl Fn() + 'static) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars {
            on_press: Box::new(on_press),
            pressing: Cell::new(false),
        });
        // SAFETY: NSObject の init は引数を取らず、初期化した自分を返す
        unsafe { msg_send![super(this), init] }
    }
}

/// アイコンのボタンが action を送ったときに `on_press` を呼ぶ。メインスレッドで呼ぶ
pub fn on_press(status_item: &NSStatusItem, on_press: impl Fn() + 'static) {
    let Some(mtm) = MainThreadMarker::new() else {
        log::error!("tray press: not on the main thread");
        return;
    };
    let Some(button) = status_item.button(mtm) else {
        log::error!("tray press: the status item has no button");
        return;
    };
    let target = PressTarget::new(mtm, on_press);
    // SAFETY: target は press: を持ち、下の forget でアプリが動いている間生きている
    unsafe {
        button.setTarget(Some(&target));
        button.setAction(Some(sel!(press:)));
    }
    // ボタンは target を弱く持つだけなので、手放さずに持ち続ける。アイコンはアプリが動いている間ずっと出ている
    std::mem::forget(target);
}
