//! ホットキーの差し替え。新しいキーを登録できたときだけ古いキーを解除し、登録できなければ元のキーのまま使い続ける。
//! 空文字はホットキーを外した状態で、何も登録しない

/// ホットキーを登録・解除する役。アプリでは global-shortcut プラグイン、テストでは偽物を使う
pub trait Registrar {
    fn register(&mut self, hotkey: &str) -> Result<(), String>;
    fn unregister(&mut self, hotkey: &str) -> Result<(), String>;
    fn is_registered(&self, hotkey: &str) -> bool;
}

/// ホットキーを `current` から `new` に差し替える。`new` を登録できたときだけ `current` を解除する
pub fn replace(registrar: &mut impl Registrar, current: &str, new: &str) -> Result<(), String> {
    // 同じキーを登録し直すと、直後の解除で登録がなくなってしまう
    if new == current {
        return Ok(());
    }
    if !new.is_empty() {
        registrar.register(new)?;
    }
    if current.is_empty() {
        return Ok(());
    }
    let Err(error) = registrar.unregister(current) else {
        return Ok(());
    };
    // 古いキーを解除できないまま新しいキーを残すと、2つ登録された状態になる
    if new.is_empty() {
        return Err(error);
    }
    match registrar.unregister(new) {
        Ok(()) => Err(error),
        Err(rollback) => Err(format!("{error} (couldn't undo {new}: {rollback})")),
    }
}

/// `hotkey` が登録されている状態にする。登録されているか（外していれば、困ったことが無いので true）を返す
pub fn ensure_registered(registrar: &mut impl Registrar, hotkey: &str) -> bool {
    if hotkey.is_empty() || registrar.is_registered(hotkey) {
        return true;
    }
    registrar
        .register(hotkey)
        .inspect_err(|error| log::warn!("couldn't register the hotkey {hotkey}: {error}"))
        .is_ok()
}

/// 設定のホットキーを `current` から `new` に変える。登録できたら `save` で保存し、保存できなければ登録も `current` に戻す。
/// 記録のために `current` を止めていることがあるので、成否にかかわらず、最後に設定に残ったキーを登録し直す。
/// 変えた結果と、終わった時点で設定に残ったキーが登録されているかを返す
pub fn change(
    registrar: &mut impl Registrar,
    current: &str,
    new: &str,
    save: impl FnOnce() -> Result<(), String>,
) -> (Result<(), String>, bool) {
    let result = replace(registrar, current, new)
        .inspect_err(|error| log::warn!("couldn't register the hotkey {new}: {error}"))
        .and_then(|()| {
            save().inspect_err(|_| {
                // 保存できなければ設定は元のキーのままなので、登録も元に戻す
                if let Err(error) = replace(registrar, new, current) {
                    log::warn!("couldn't restore the hotkey {current}: {error}");
                }
            })
        });
    let saved = if result.is_ok() { new } else { current };
    let registered = ensure_registered(registrar, saved);
    (result, registered)
}

/// 置かれる文字が配列で変わるキーの、位置の名前（設定に残す形）・US 配列での走査コード・US 配列で出す仮想キー。
/// global-hotkey（Windows）は、この名前をこの仮想キーに決め打ちで読み替えて登録する
const LAYOUT_KEYS: [(&str, u32, u32); 47] = [
    ("Digit1", 0x02, 0x31),
    ("Digit2", 0x03, 0x32),
    ("Digit3", 0x04, 0x33),
    ("Digit4", 0x05, 0x34),
    ("Digit5", 0x06, 0x35),
    ("Digit6", 0x07, 0x36),
    ("Digit7", 0x08, 0x37),
    ("Digit8", 0x09, 0x38),
    ("Digit9", 0x0A, 0x39),
    ("Digit0", 0x0B, 0x30),
    ("Minus", 0x0C, 0xBD),
    ("Equal", 0x0D, 0xBB),
    ("KeyQ", 0x10, 0x51),
    ("KeyW", 0x11, 0x57),
    ("KeyE", 0x12, 0x45),
    ("KeyR", 0x13, 0x52),
    ("KeyT", 0x14, 0x54),
    ("KeyY", 0x15, 0x59),
    ("KeyU", 0x16, 0x55),
    ("KeyI", 0x17, 0x49),
    ("KeyO", 0x18, 0x4F),
    ("KeyP", 0x19, 0x50),
    ("BracketLeft", 0x1A, 0xDB),
    ("BracketRight", 0x1B, 0xDD),
    ("KeyA", 0x1E, 0x41),
    ("KeyS", 0x1F, 0x53),
    ("KeyD", 0x20, 0x44),
    ("KeyF", 0x21, 0x46),
    ("KeyG", 0x22, 0x47),
    ("KeyH", 0x23, 0x48),
    ("KeyJ", 0x24, 0x4A),
    ("KeyK", 0x25, 0x4B),
    ("KeyL", 0x26, 0x4C),
    ("Semicolon", 0x27, 0xBA),
    ("Quote", 0x28, 0xDE),
    ("Backquote", 0x29, 0xC0),
    ("Backslash", 0x2B, 0xDC),
    ("KeyZ", 0x2C, 0x5A),
    ("KeyX", 0x2D, 0x58),
    ("KeyC", 0x2E, 0x43),
    ("KeyV", 0x2F, 0x56),
    ("KeyB", 0x30, 0x42),
    ("KeyN", 0x31, 0x4E),
    ("KeyM", 0x32, 0x4D),
    ("Comma", 0x33, 0xBC),
    ("Period", 0x34, 0xBE),
    ("Slash", 0x35, 0xBF),
];

/// 登録に渡すホットキーを、今のキー配列に合わせて書き換える。設定のキーは押した位置の名前で残るが、
/// global-hotkey は位置の名前を US 配列の仮想キーとして登録するので、配列によっては別の位置のキーになる
/// （JIS 配列の Ctrl+Alt+; が : のキーになる、ドイツ語の配列の Z と Y が入れ替わる など）。
/// `vk_at` は走査コードから今の配列の仮想キーを返す。その仮想キーを登録する名前に替える。
/// 押した位置のキーの仮想キーを登録できる名前が無ければ（JIS の半角/全角のキーなど）、別のキーを登録しないよう `None` を返す
#[cfg_attr(not(windows), allow(dead_code))]
pub fn for_layout(hotkey: &str, vk_at: impl Fn(u32) -> u32) -> Option<String> {
    let (modifiers, key) = hotkey.rsplit_once('+').unwrap_or(("", hotkey));
    let Some(&(_, scan_code, us_vk)) = LAYOUT_KEYS.iter().find(|(name, ..)| *name == key) else {
        return Some(hotkey.to_string());
    };
    let vk = vk_at(scan_code);
    if vk == us_vk {
        return Some(hotkey.to_string());
    }
    let &(name, ..) = LAYOUT_KEYS.iter().find(|(.., us)| *us == vk)?;
    Some(if modifiers.is_empty() {
        name.to_string()
    } else {
        format!("{modifiers}+{name}")
    })
}

/// [`for_layout`] を、このスレッドの今のキー配列で行う
#[cfg(windows)]
pub fn for_current_layout(hotkey: &str) -> Option<String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyboardLayout, MapVirtualKeyExW, MAPVK_VSC_TO_VK,
    };
    let layout = unsafe { GetKeyboardLayout(0) };
    for_layout(hotkey, |scan_code| unsafe {
        MapVirtualKeyExW(scan_code, MAPVK_VSC_TO_VK, Some(layout))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// JIS 配列（kbd106）の、記号のキーの走査コードから仮想キー。ほかは US 配列と同じ
    fn jis(scan_code: u32) -> u32 {
        match scan_code {
            0x0D => 0xDE,
            0x1A => 0xC0,
            0x1B => 0xDB,
            0x27 => 0xBB,
            0x28 => 0xBA,
            0x29 => 0xF3,
            0x2B => 0xDD,
            _ => us(scan_code),
        }
    }

    /// ドイツ語の配列（QWERTZ）。Y と Z の位置が入れ替わる
    fn german(scan_code: u32) -> u32 {
        match scan_code {
            0x15 => 0x5A,
            0x2C => 0x59,
            _ => us(scan_code),
        }
    }

    fn us(scan_code: u32) -> u32 {
        LAYOUT_KEYS
            .iter()
            .find(|(_, scan, _)| *scan == scan_code)
            .map_or(0, |(.., vk)| *vk)
    }

    #[test]
    fn rewrites_keys_to_the_name_the_layout_registers_as() {
        assert_eq!(
            for_layout("CommandOrControl+Alt+Semicolon", jis).as_deref(),
            Some("CommandOrControl+Alt+Equal")
        );
        assert_eq!(
            for_layout("Alt+BracketLeft", jis).as_deref(),
            Some("Alt+Backquote")
        );
        assert_eq!(
            for_layout("Alt+Quote", jis).as_deref(),
            Some("Alt+Semicolon")
        );
        assert_eq!(
            for_layout("Control+Alt+KeyY", german).as_deref(),
            Some("Control+Alt+KeyZ")
        );
    }

    #[test]
    fn keeps_keys_that_register_as_pressed() {
        assert_eq!(
            for_layout("CommandOrControl+Alt+Semicolon", us).as_deref(),
            Some("CommandOrControl+Alt+Semicolon")
        );
        assert_eq!(
            for_layout("CommandOrControl+Shift+Space", jis).as_deref(),
            Some("CommandOrControl+Shift+Space")
        );
        assert_eq!(for_layout("Alt+Comma", jis).as_deref(), Some("Alt+Comma"));
        assert_eq!(for_layout("Alt+KeyY", jis).as_deref(), Some("Alt+KeyY"));
    }

    #[test]
    fn refuses_keys_whose_layout_key_has_no_name_to_register() {
        // 半角/全角のキーの仮想キーは、US 配列のどのキーにも無い。元の名前のままだと @ のキーを登録してしまう
        assert_eq!(for_layout("Alt+Backquote", jis), None);
    }

    /// 登録済みのキーを覚えておく。`taken` のキーは、ほかのアプリが使っているものとして登録を断り、
    /// `stuck` のキーは解除できないものとして扱う
    #[derive(Default)]
    struct FakeRegistrar {
        registered: BTreeSet<String>,
        taken: BTreeSet<String>,
        stuck: BTreeSet<String>,
    }

    impl Registrar for FakeRegistrar {
        fn register(&mut self, hotkey: &str) -> Result<(), String> {
            if self.taken.contains(hotkey) {
                return Err(format!("{hotkey} is used by another app"));
            }
            self.registered.insert(hotkey.to_string());
            Ok(())
        }

        fn unregister(&mut self, hotkey: &str) -> Result<(), String> {
            if self.stuck.contains(hotkey) {
                return Err(format!("{hotkey} cannot be unregistered"));
            }
            self.registered.remove(hotkey);
            Ok(())
        }

        fn is_registered(&self, hotkey: &str) -> bool {
            self.registered.contains(hotkey)
        }
    }

    fn keys(hotkeys: &[&str]) -> BTreeSet<String> {
        hotkeys.iter().map(|hotkey| hotkey.to_string()).collect()
    }

    #[test]
    fn unregisters_old_hotkey_after_new_one_is_registered() {
        let mut registrar = FakeRegistrar {
            registered: keys(&["CommandOrControl+Shift+Space"]),
            ..Default::default()
        };
        replace(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
        )
        .unwrap();
        assert_eq!(registrar.registered, keys(&["CommandOrControl+Alt+KeyK"]));
    }

    #[test]
    fn keeps_old_hotkey_when_new_one_cannot_be_registered() {
        let mut registrar = FakeRegistrar {
            registered: keys(&["CommandOrControl+Shift+Space"]),
            taken: keys(&["CommandOrControl+Shift+KeyK"]),
            ..Default::default()
        };
        let result = replace(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Shift+KeyK",
        );
        assert!(result.is_err());
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
    }

    #[test]
    fn removes_the_new_hotkey_when_the_old_one_cannot_be_unregistered() {
        let mut registrar = FakeRegistrar {
            registered: keys(&["CommandOrControl+Shift+Space"]),
            stuck: keys(&["CommandOrControl+Shift+Space"]),
            ..Default::default()
        };
        let result = replace(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
        );
        assert!(result.is_err());
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
    }

    #[test]
    fn reports_both_reasons_when_the_new_hotkey_cannot_be_unregistered_either() {
        let mut registrar = FakeRegistrar {
            registered: keys(&["CommandOrControl+Shift+Space"]),
            stuck: keys(&["CommandOrControl+Shift+Space", "CommandOrControl+Alt+KeyK"]),
            ..Default::default()
        };
        let error = replace(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
        )
        .unwrap_err();
        assert!(error.contains("CommandOrControl+Shift+Space"), "{error}");
        assert!(error.contains("CommandOrControl+Alt+KeyK"), "{error}");
    }

    #[test]
    fn choosing_the_current_hotkey_keeps_it_registered() {
        let mut registrar = FakeRegistrar {
            registered: keys(&["CommandOrControl+Shift+Space"]),
            ..Default::default()
        };
        replace(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Shift+Space",
        )
        .unwrap();
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
    }

    // 以下の change は、設定画面でキーを記録している間（今のキーを止めて、どれも登録されていない状態）から呼ばれる

    #[test]
    fn change_registers_and_saves_the_new_hotkey() {
        let mut registrar = FakeRegistrar::default();
        let mut saved = false;
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
            || {
                saved = true;
                Ok(())
            },
        );
        assert_eq!(result, Ok(()));
        assert!(saved);
        assert!(registered);
        assert_eq!(registrar.registered, keys(&["CommandOrControl+Alt+KeyK"]));
    }

    #[test]
    fn change_registers_the_current_hotkey_again_when_the_new_one_is_taken() {
        let mut registrar = FakeRegistrar {
            taken: keys(&["CommandOrControl+Alt+KeyK"]),
            ..Default::default()
        };
        let mut saved = false;
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
            || {
                saved = true;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!saved);
        assert!(registered);
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
    }

    #[test]
    fn change_goes_back_to_the_current_hotkey_when_saving_fails() {
        let mut registrar = FakeRegistrar::default();
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
            || Err("disk full".to_string()),
        );
        assert_eq!(result, Err("disk full".to_string()));
        assert!(registered);
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
    }

    #[test]
    fn change_keeps_the_current_hotkey_registered_even_when_the_new_one_cannot_be_undone() {
        // 保存に失敗して戻そうとしたが、新しいキーを解除できなかった。新しいキーが残るのは避けられないが、
        // 設定に残った今のキーは使える状態にしておく
        let mut registrar = FakeRegistrar {
            stuck: keys(&["CommandOrControl+Alt+KeyK"]),
            ..Default::default()
        };
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
            || Err("disk full".to_string()),
        );
        assert_eq!(result, Err("disk full".to_string()));
        assert!(registered);
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space", "CommandOrControl+Alt+KeyK"])
        );
    }

    #[test]
    fn change_to_the_current_hotkey_registers_it_again() {
        let mut registrar = FakeRegistrar::default();
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Shift+Space",
            || Ok(()),
        );
        assert_eq!(result, Ok(()));
        assert!(registered);
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
    }

    #[test]
    fn change_tells_when_no_hotkey_could_be_registered() {
        // 記録している間に、今のキーまでほかのアプリに取られた
        let mut registrar = FakeRegistrar {
            taken: keys(&["CommandOrControl+Shift+Space", "CommandOrControl+Alt+KeyK"]),
            ..Default::default()
        };
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "CommandOrControl+Alt+KeyK",
            || Ok(()),
        );
        assert!(result.is_err());
        assert!(!registered);
        assert!(registrar.registered.is_empty());
    }

    #[test]
    fn clearing_the_hotkey_unregisters_it_and_registers_nothing() {
        let mut registrar = FakeRegistrar {
            registered: keys(&["CommandOrControl+Shift+Space"]),
            ..Default::default()
        };
        let (result, registered) = change(
            &mut registrar,
            "CommandOrControl+Shift+Space",
            "",
            || Ok(()),
        );
        assert_eq!(result, Ok(()));
        assert!(registered);
        assert!(registrar.registered.is_empty());
    }

    #[test]
    fn setting_a_hotkey_after_clearing_registers_only_the_new_one() {
        let mut registrar = FakeRegistrar::default();
        let (result, registered) = change(
            &mut registrar,
            "",
            "CommandOrControl+Shift+Space",
            || Ok(()),
        );
        assert_eq!(result, Ok(()));
        assert!(registered);
        assert_eq!(
            registrar.registered,
            keys(&["CommandOrControl+Shift+Space"])
        );
        assert!(ensure_registered(&mut FakeRegistrar::default(), ""));
    }
}
