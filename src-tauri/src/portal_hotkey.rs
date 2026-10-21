//! Wayland のホットキーを、デスクトップの GlobalShortcuts portal に登録する（GNOME 48 以降・KDE）。
//! どのキーにするかはデスクトップが決め、利用者が確かめる。portal が無い・キーが付かないデスクトップ（Hyprland など）は、
//! デスクトップのキー設定から `mawok --toggle` を呼んでもらう（toggle.rs）

use std::sync::Mutex;

use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut},
    Session,
};
use futures_util::StreamExt;

/// portal に渡すショートカットの id。デスクトップの設定画面では description のほうが出る
const SHORTCUT_ID: &str = "toggle";

/// portal で割り当てたホットキーの今の状態
#[derive(Default)]
pub struct PortalHotkey {
    /// デスクトップが付けたキーの表示（「Ctrl+Shift+Space」など）。付いていなければ None
    pub trigger: Mutex<Option<String>>,
    /// デスクトップの割り当ての画面を開けるか（portal の version 2 以降）
    pub configurable: std::sync::atomic::AtomicBool,
    session: tokio::sync::Mutex<Option<(GlobalShortcuts, Session<GlobalShortcuts>)>>,
}

/// 設定のホットキー（`CommandOrControl+Shift+Space`）を、portal に希望として渡す書き方（XDG の shortcuts の書き方、
/// `CTRL+SHIFT+space`）にする。書き直せないキーは None にし、希望を出さずにデスクトップに任せる
pub fn preferred_trigger(hotkey: &str) -> Option<String> {
    let mut parts: Vec<&str> = hotkey.split('+').collect();
    let code = parts.pop()?;
    let mut trigger: Vec<String> = parts
        .into_iter()
        .map(|modifier| match modifier {
            "CommandOrControl" | "Control" => Some("CTRL"),
            "Shift" => Some("SHIFT"),
            "Alt" => Some("ALT"),
            "Super" => Some("LOGO"),
            _ => None,
        })
        .map(|modifier| modifier.map(str::to_string))
        .collect::<Option<_>>()?;
    let key = if let Some(letter) = code.strip_prefix("Key") {
        letter.to_lowercase()
    } else if let Some(digit) = code.strip_prefix("Digit") {
        digit.to_string()
    } else {
        match code {
            "Space" => "space",
            "Enter" => "Return",
            "ArrowUp" => "Up",
            "ArrowDown" => "Down",
            "ArrowLeft" => "Left",
            "ArrowRight" => "Right",
            "Comma" => "comma",
            "Period" => "period",
            "Slash" => "slash",
            code if code.starts_with('F') && code[1..].parse::<u8>().is_ok() => code,
            _ => return None,
        }
        .to_string()
    };
    trigger.push(key);
    Some(trigger.join("+"))
}

fn trigger_of(shortcuts: &[Shortcut]) -> Option<String> {
    shortcuts
        .iter()
        .find(|shortcut| shortcut.id() == SHORTCUT_ID)
        .map(|shortcut| shortcut.trigger_description().trim().to_string())
        .filter(|trigger| !trigger.is_empty())
}

/// portal にホットキーを登録し、押されたら `on_activated` を、デスクトップでキーが変わったら `on_changed` を呼び続ける。
/// portal が無ければ Err を返す。デスクトップが確かめの画面を出すので、利用者が答えるまで返らない
pub async fn start(
    state: &PortalHotkey,
    app_id: &str,
    description: &str,
    hotkey: &str,
    on_activated: impl Fn(Option<String>) + Send + 'static,
    on_changed: impl Fn() + Send + 'static,
) -> Result<(), ashpd::Error> {
    // サンドボックスの外のアプリは、portal を使う前に自分のアプリ ID を名乗る。名乗らないと GlobalShortcuts は断る
    let app_id: ashpd::AppID = app_id.parse()?;
    ashpd::register_host_app(app_id).await?;
    let portal = GlobalShortcuts::new().await?;
    state
        .configurable
        .store(portal.version() >= 2, std::sync::atomic::Ordering::Relaxed);
    let session = portal.create_session(Default::default()).await?;
    let shortcut = NewShortcut::new(SHORTCUT_ID, description)
        .preferred_trigger(preferred_trigger(hotkey).as_deref());
    let bound = portal
        .bind_shortcuts(&session, &[shortcut], None, Default::default())
        .await?
        .response()?;
    *state.trigger.lock().unwrap() = trigger_of(bound.shortcuts());

    let mut activated = portal.receive_activated().await?;
    tokio::spawn(async move {
        while let Some(event) = activated.next().await {
            if event.shortcut_id() != SHORTCUT_ID {
                continue;
            }
            // 窓を前に出すための印。Wayland では、印の無い窓は前に出られない
            let token = event
                .options()
                .get("activation_token")
                .and_then(|value| <&str>::try_from(value).ok())
                .map(str::to_string);
            on_activated(token);
        }
    });
    let mut changed = portal.receive_shortcuts_changed().await?;
    tokio::spawn(async move {
        while changed.next().await.is_some() {
            on_changed();
        }
    });
    *state.session.lock().await = Some((portal, session));
    Ok(())
}

/// デスクトップが付けているキーを読み直す
pub async fn refresh(state: &PortalHotkey) -> Result<(), ashpd::Error> {
    let session = state.session.lock().await;
    let Some((portal, session)) = session.as_ref() else {
        return Ok(());
    };
    let listed = portal
        .list_shortcuts(session, Default::default())
        .await?
        .response()?;
    *state.trigger.lock().unwrap() = trigger_of(listed.shortcuts());
    Ok(())
}

/// デスクトップの、ホットキーを割り当て直す画面を開く
pub async fn configure(state: &PortalHotkey) -> Result<(), ashpd::Error> {
    let session = state.session.lock().await;
    let Some((portal, session)) = session.as_ref() else {
        return Ok(());
    };
    portal
        .configure_shortcuts(session, None, Default::default())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hotkey_becomes_an_xdg_shortcut() {
        assert_eq!(
            preferred_trigger("CommandOrControl+Shift+Space").as_deref(),
            Some("CTRL+SHIFT+space")
        );
        assert_eq!(
            preferred_trigger("Super+Alt+KeyM").as_deref(),
            Some("LOGO+ALT+m")
        );
        assert_eq!(
            preferred_trigger("CommandOrControl+Digit1").as_deref(),
            Some("CTRL+1")
        );
        assert_eq!(
            preferred_trigger("CommandOrControl+F12").as_deref(),
            Some("CTRL+F12")
        );
    }

    #[test]
    fn a_key_without_a_known_name_leaves_the_choice_to_the_desktop() {
        assert_eq!(preferred_trigger("CommandOrControl+Backquote"), None);
        assert_eq!(preferred_trigger(""), None);
    }
}
