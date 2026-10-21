//! Wayland のホットキーを、デスクトップの GlobalShortcuts portal に登録する（GNOME 48 以降・KDE）。
//! どのキーにするかはデスクトップが決め、利用者が確かめる。portal が無い・キーが付かないデスクトップ（Hyprland など）は、
//! デスクトップのキー設定から `mawok --toggle` を呼んでもらう（toggle.rs）

use std::sync::{Arc, Mutex};

use ashpd::desktop::{
    global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut},
    Session,
};
use futures_util::StreamExt;

/// portal に渡すショートカットの id。デスクトップの設定画面では description のほうが出る
const SHORTCUT_ID: &str = "toggle";

type Registered = (GlobalShortcuts, Session<GlobalShortcuts>);

/// portal で割り当てたホットキーの今の状態
#[derive(Default)]
pub struct PortalHotkey {
    /// デスクトップが付けたキーの表示（「Ctrl+Shift+Space」など）。付いていなければ None
    pub trigger: Mutex<Option<String>>,
    /// デスクトップの割り当ての画面を開けるか（portal の version 2 以降）
    pub configurable: std::sync::atomic::AtomicBool,
    /// 登録できた portal とセッション。割り当ての画面は開いている間ずっと返らないので、ロックの外で使えるよう Arc で持つ
    session: Mutex<Option<Arc<Registered>>>,
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

/// デスクトップが返すキーの表示（GNOME は `<Shift><Control>space を押す`、KDE は `Ctrl+Shift+Space` の形）を、
/// 設定のホットキーと同じ書き方（`CommandOrControl+Shift+Space`）にする。読めなければ None で、画面は表示をそのまま出す
pub fn accelerator_from_trigger(trigger: &str) -> Option<String> {
    // 「を押す」「Press」のような言葉は言語で変わるので、キーの組み合わせの部分だけを拾う
    let first = trigger
        .split_whitespace()
        .find(|word| word.contains('<') || word.contains('+'))?;
    let parts: Vec<&str> = if first.starts_with('<') {
        first
            .split(['<', '>'])
            .filter(|part| !part.is_empty())
            .collect()
    } else {
        first.split('+').collect()
    };
    let (key, modifiers) = parts.split_last()?;
    let mut accelerator = Vec::new();
    for modifier in ["CommandOrControl", "Super", "Alt", "Shift"] {
        let present = modifiers
            .iter()
            .any(|part| match part.to_ascii_lowercase().as_str() {
                "control" | "ctrl" | "primary" => modifier == "CommandOrControl",
                "super" | "meta" | "logo" => modifier == "Super",
                "alt" | "mod1" => modifier == "Alt",
                "shift" => modifier == "Shift",
                _ => false,
            });
        if present {
            accelerator.push(modifier.to_string());
        }
    }
    if accelerator.len() != modifiers.len() {
        return None;
    }
    let lower = key.to_ascii_lowercase();
    let code = match lower.as_str() {
        "space" => "Space".to_string(),
        "return" | "enter" => "Enter".to_string(),
        "up" => "ArrowUp".to_string(),
        "down" => "ArrowDown".to_string(),
        "left" => "ArrowLeft".to_string(),
        "right" => "ArrowRight".to_string(),
        "comma" => "Comma".to_string(),
        "period" => "Period".to_string(),
        "slash" => "Slash".to_string(),
        _ if lower.len() == 1 && lower.as_bytes()[0].is_ascii_lowercase() => {
            format!("Key{}", lower.to_ascii_uppercase())
        }
        _ if lower.len() == 1 && lower.as_bytes()[0].is_ascii_digit() => format!("Digit{lower}"),
        _ if lower.starts_with('f') && lower[1..].parse::<u8>().is_ok() => {
            lower.to_ascii_uppercase()
        }
        _ => return None,
    };
    accelerator.push(code);
    Some(accelerator.join("+"))
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
    // 知らせを受ける用意は、登録より先に済ませる。登録の後で失敗すると、デスクトップに登録だけが残る
    let mut activated = portal.receive_activated().await?;
    let mut changed = portal.receive_shortcuts_changed().await?;
    let session = portal.create_session(Default::default()).await?;
    let shortcut = NewShortcut::new(SHORTCUT_ID, description)
        .preferred_trigger(preferred_trigger(hotkey).as_deref());
    let bound = match portal
        .bind_shortcuts(&session, &[shortcut], None, Default::default())
        .await
        .and_then(|request| request.response())
    {
        Ok(bound) => bound,
        Err(error) => {
            // 利用者が確かめの画面で断ったときなど。セッションを残すと、デスクトップの側に登録の申し込みが残る
            let _ = session.close().await;
            return Err(error);
        }
    };
    *state.trigger.lock().unwrap() = trigger_of(bound.shortcuts());
    state
        .configurable
        .store(portal.version() >= 2, std::sync::atomic::Ordering::Relaxed);

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
    tokio::spawn(async move {
        while changed.next().await.is_some() {
            on_changed();
        }
    });
    *state.session.lock().unwrap() = Some(Arc::new((portal, session)));
    Ok(())
}

fn registered(state: &PortalHotkey) -> Option<Arc<Registered>> {
    state.session.lock().unwrap().clone()
}

/// デスクトップが付けているキーを読み直す
pub async fn refresh(state: &PortalHotkey) -> Result<(), ashpd::Error> {
    let Some(registered) = registered(state) else {
        return Ok(());
    };
    let (portal, session) = registered.as_ref();
    let listed = portal
        .list_shortcuts(session, Default::default())
        .await?
        .response()?;
    *state.trigger.lock().unwrap() = trigger_of(listed.shortcuts());
    Ok(())
}

/// デスクトップの、ホットキーを割り当て直す画面を開く
pub async fn configure(state: &PortalHotkey) -> Result<(), ashpd::Error> {
    let Some(registered) = registered(state) else {
        return Ok(());
    };
    let (portal, session) = registered.as_ref();
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
    fn a_desktop_trigger_becomes_a_hotkey() {
        assert_eq!(
            accelerator_from_trigger("<Shift><Control>space を押す").as_deref(),
            Some("CommandOrControl+Shift+Space")
        );
        assert_eq!(
            accelerator_from_trigger("Press <Super>m").as_deref(),
            Some("Super+KeyM")
        );
        assert_eq!(
            accelerator_from_trigger("Ctrl+Shift+Space").as_deref(),
            Some("CommandOrControl+Shift+Space")
        );
        assert_eq!(
            accelerator_from_trigger("Meta+F5").as_deref(),
            Some("Super+F5")
        );
    }

    #[test]
    fn an_unknown_trigger_is_left_as_written() {
        assert_eq!(accelerator_from_trigger("<Hyper>x"), None);
        assert_eq!(accelerator_from_trigger("Ctrl+Backquote"), None);
        assert_eq!(accelerator_from_trigger(""), None);
    }

    #[test]
    fn a_key_without_a_known_name_leaves_the_choice_to_the_desktop() {
        assert_eq!(preferred_trigger("CommandOrControl+Backquote"), None);
        assert_eq!(preferred_trigger(""), None);
    }
}
