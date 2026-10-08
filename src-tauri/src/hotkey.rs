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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

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
