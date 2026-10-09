//! 下書きウィンドウのキー操作。
//! どの操作をどのキーで呼ぶかを決め、キーの重なりを見る。押したキーとの照らし合わせは画面側（src/lib/keys.ts）で行う

use serde::{Deserialize, Serialize};
use toml_edit::Item;

use crate::config;

/// キーで呼べる操作。設定ファイルでキーが重なったときは、並びの先の操作にキーを残す（設定画面の並びは画面側の src/lib/keys.ts が持つ）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub enum DraftAction {
    Copy,
    Send,
    Settings,
    Snippets,
    Actions,
    HistoryOlder,
    HistoryNewer,
    SendTargets,
    InsertReceived,
    DiscardReceived,
    ChangeFolder,
}

impl DraftAction {
    pub const ALL: [DraftAction; 11] = [
        DraftAction::Copy,
        DraftAction::Send,
        DraftAction::Settings,
        DraftAction::Snippets,
        DraftAction::Actions,
        DraftAction::HistoryOlder,
        DraftAction::HistoryNewer,
        DraftAction::SendTargets,
        DraftAction::InsertReceived,
        DraftAction::DiscardReceived,
        DraftAction::ChangeFolder,
    ];

    /// 設定ファイルでの項目名
    pub fn name(self) -> &'static str {
        match self {
            DraftAction::Copy => "copy",
            DraftAction::Send => "send",
            DraftAction::Settings => "settings",
            DraftAction::Snippets => "snippets",
            DraftAction::Actions => "actions",
            DraftAction::HistoryOlder => "history_older",
            DraftAction::HistoryNewer => "history_newer",
            DraftAction::SendTargets => "send_targets",
            DraftAction::InsertReceived => "insert_received",
            DraftAction::DiscardReceived => "discard_received",
            DraftAction::ChangeFolder => "change_folder",
        }
    }

    /// 既定のキー。記号のキーは配列で位置が変わり、表示と押す位置が食い違うので、英字・数字・Enter・矢印などで決める
    fn default_key(self) -> &'static str {
        match self {
            DraftAction::Copy => "CommandOrControl+Enter",
            DraftAction::Send => "CommandOrControl+Shift+Enter",
            // Comma は JIS 配列でも US 配列でも同じ位置にある
            DraftAction::Settings => "CommandOrControl+Comma",
            DraftAction::Snippets => "CommandOrControl+KeyJ",
            DraftAction::Actions => "CommandOrControl+KeyK",
            DraftAction::HistoryOlder => "CommandOrControl+Alt+ArrowUp",
            DraftAction::HistoryNewer => "CommandOrControl+Alt+ArrowDown",
            DraftAction::SendTargets => "CommandOrControl+KeyL",
            DraftAction::InsertReceived => "CommandOrControl+KeyI",
            // CommandOrControl+Backspace は入力欄の削除（macOS は行頭まで、Windows は前の単語）と重なる
            DraftAction::DiscardReceived => "CommandOrControl+Shift+Backspace",
            // D は Directory。どの OS の入力欄でも、編集の操作に使われていない
            DraftAction::ChangeFolder => "CommandOrControl+KeyD",
        }
    }
}

/// 操作ごとのキー。ホットキーと同じ書き方（`CommandOrControl+Shift+Enter`）で、空文字は割り当てなし
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct DraftKeys {
    pub copy: String,
    pub send: String,
    pub settings: String,
    pub snippets: String,
    pub actions: String,
    pub history_older: String,
    pub history_newer: String,
    pub send_targets: String,
    pub insert_received: String,
    pub discard_received: String,
    pub change_folder: String,
}

impl Default for DraftKeys {
    fn default() -> Self {
        let key = |action: DraftAction| action.default_key().to_string();
        Self {
            copy: key(DraftAction::Copy),
            send: key(DraftAction::Send),
            settings: key(DraftAction::Settings),
            snippets: key(DraftAction::Snippets),
            actions: key(DraftAction::Actions),
            history_older: key(DraftAction::HistoryOlder),
            history_newer: key(DraftAction::HistoryNewer),
            send_targets: key(DraftAction::SendTargets),
            insert_received: key(DraftAction::InsertReceived),
            discard_received: key(DraftAction::DiscardReceived),
            change_folder: key(DraftAction::ChangeFolder),
        }
    }
}

impl DraftKeys {
    pub fn get(&self, action: DraftAction) -> &str {
        match action {
            DraftAction::Copy => &self.copy,
            DraftAction::Send => &self.send,
            DraftAction::Settings => &self.settings,
            DraftAction::Snippets => &self.snippets,
            DraftAction::Actions => &self.actions,
            DraftAction::HistoryOlder => &self.history_older,
            DraftAction::HistoryNewer => &self.history_newer,
            DraftAction::SendTargets => &self.send_targets,
            DraftAction::InsertReceived => &self.insert_received,
            DraftAction::DiscardReceived => &self.discard_received,
            DraftAction::ChangeFolder => &self.change_folder,
        }
    }

    pub fn get_mut(&mut self, action: DraftAction) -> &mut String {
        match action {
            DraftAction::Copy => &mut self.copy,
            DraftAction::Send => &mut self.send,
            DraftAction::Settings => &mut self.settings,
            DraftAction::Snippets => &mut self.snippets,
            DraftAction::Actions => &mut self.actions,
            DraftAction::HistoryOlder => &mut self.history_older,
            DraftAction::HistoryNewer => &mut self.history_newer,
            DraftAction::SendTargets => &mut self.send_targets,
            DraftAction::InsertReceived => &mut self.insert_received,
            DraftAction::DiscardReceived => &mut self.discard_received,
            DraftAction::ChangeFolder => &mut self.change_folder,
        }
    }

    /// キーを割り当てている操作。なければ None
    pub fn action_for(&self, key: &str) -> Option<DraftAction> {
        DraftAction::ALL
            .into_iter()
            .find(|&action| self.get(action) == key)
    }
}

/// 画面が OS ごとにキーの表記や閉じるキーを変えるときも、この名前（`macos`・`windows`）で渡す
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    MacOs,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Windows
        }
    }
}

/// キーを記録できない理由。画面側には `code` の符号で返し、何が重なっているかの案内にする（src/lib/keys.ts）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// 書き方が読めない、修飾キーがない
    Invalid,
    /// 入力欄の標準の編集キー（コピー・貼り付け・カーソルの移動など）
    EditingKey,
    /// ホットキーと同じ
    Hotkey,
    /// ほかの操作に割り当て済み
    Action(DraftAction),
}

impl Rejection {
    pub fn code(self) -> String {
        match self {
            Rejection::Invalid => "keys.invalid".to_string(),
            Rejection::EditingKey => "keys.editing".to_string(),
            Rejection::Hotkey => "keys.hotkey".to_string(),
            // 画面とのやり取りでの名前（camelCase）。設定ファイルの項目名（`DraftAction::name`）とは書き方が違う
            Rejection::Action(action) => format!("keys.action.{}", config::choice_name(&action)),
        }
    }
}

/// 記録できるキーの名前（KeyboardEvent.code）。global-hotkey（0.8.0 の parse_key）が受け付ける名前のうち、
/// KeyboardEvent.code と同じ名前のもの。ホットキーと下書きの操作のキーで共通。画面へは bindings.rs が書き出す
pub const SUPPORTED_CODES: &[&str] = &[
    "Digit0",
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "KeyA",
    "KeyB",
    "KeyC",
    "KeyD",
    "KeyE",
    "KeyF",
    "KeyG",
    "KeyH",
    "KeyI",
    "KeyJ",
    "KeyK",
    "KeyL",
    "KeyM",
    "KeyN",
    "KeyO",
    "KeyP",
    "KeyQ",
    "KeyR",
    "KeyS",
    "KeyT",
    "KeyU",
    "KeyV",
    "KeyW",
    "KeyX",
    "KeyY",
    "KeyZ",
    "Numpad0",
    "Numpad1",
    "Numpad2",
    "Numpad3",
    "Numpad4",
    "Numpad5",
    "Numpad6",
    "Numpad7",
    "Numpad8",
    "Numpad9",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
    "F13",
    "F14",
    "F15",
    "F16",
    "F17",
    "F18",
    "F19",
    "F20",
    "F21",
    "F22",
    "F23",
    "F24",
    "Backquote",
    "Backslash",
    "BracketLeft",
    "BracketRight",
    "Comma",
    "Equal",
    "Minus",
    "Period",
    "Quote",
    "Semicolon",
    "Slash",
    "Backspace",
    "CapsLock",
    "Enter",
    "Space",
    "Tab",
    "Delete",
    "End",
    "Home",
    "Insert",
    "PageDown",
    "PageUp",
    "Pause",
    "PrintScreen",
    "ScrollLock",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "NumLock",
    "NumpadAdd",
    "NumpadDecimal",
    "NumpadDivide",
    "NumpadEnter",
    "NumpadEqual",
    "NumpadMultiply",
    "NumpadSubtract",
    "Escape",
    "AudioVolumeDown",
    "AudioVolumeUp",
    "AudioVolumeMute",
    "MediaPlay",
    "MediaPause",
    "MediaPlayPause",
    "MediaStop",
    "MediaTrackNext",
    "MediaTrackPrevious",
];

fn is_supported_code(code: &str) -> bool {
    SUPPORTED_CODES.contains(&code)
}

/// 書く順。画面側の toAccelerator と同じ並び
const MODIFIERS: [&str; 5] = ["CommandOrControl", "Control", "Super", "Alt", "Shift"];

/// キーの書き方を揃える。修飾キーの並びを直し、テンキーの Enter は Enter とする（画面側の照らし合わせと同じ。
/// main では event.key で見ていて、テンキーの Enter でもコピーできたため）。
/// この OS にない修飾キー（Windows の Control、macOS の Super）、Shift のほかに修飾キーがないもの（普段の文字の入力を奪う）、
/// Esc を含むもの（下書きウィンドウでは修飾キーを見ずに隠す操作になり、設定画面では記録の中止になる）は読めないとして None。
/// 空文字は割り当てなしとしてそのまま返す
pub fn normalize(key: &str, platform: Platform) -> Option<String> {
    if key.is_empty() {
        return Some(String::new());
    }
    let mut parts: Vec<&str> = key.split('+').collect();
    let code = match parts.pop()? {
        "NumpadEnter" => "Enter",
        code => code,
    };
    // 本体のキーは KeyboardEvent.code の名前。知らない名前は押しても当たらず、書き間違いに気づけないので読めないとする
    if !is_supported_code(code) || code == "Escape" {
        return None;
    }
    let unavailable = match platform {
        Platform::MacOs => "Super",
        Platform::Windows => "Control",
    };
    let mut present = [false; MODIFIERS.len()];
    for part in parts {
        let index = MODIFIERS.iter().position(|&name| name == part)?;
        if part == unavailable || present[index] {
            return None;
        }
        present[index] = true;
    }
    // Shift 以外の修飾キーが要る
    if !present[..4].iter().any(|&on| on) {
        return None;
    }
    let mut normalized: Vec<&str> = MODIFIERS
        .iter()
        .zip(present)
        .filter_map(|(&name, on)| on.then_some(name))
        .collect();
    normalized.push(code);
    Some(normalized.join("+"))
}

/// 入力欄の標準の編集キー。割り当てると、コピーや貼り付け、カーソルの移動ができなくなる
fn is_editing_key(key: &str, platform: Platform) -> bool {
    const ARROWS: [&str; 4] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    let common = [
        "KeyA",
        "KeyC",
        "KeyV",
        "KeyX",
        "KeyZ",
        "Backspace",
        "Delete",
    ]
    .map(|code| format!("CommandOrControl+{code}"))
    .into_iter()
    .chain(["CommandOrControl+Shift+KeyZ".to_string()])
    .chain(ARROWS.iter().flat_map(|arrow| {
        [
            format!("CommandOrControl+{arrow}"),
            format!("CommandOrControl+Shift+{arrow}"),
        ]
    }));
    let mut keys: Vec<String> = common.collect();
    match platform {
        Platform::MacOs => {
            // Option で単語ごとに動く・消す
            keys.extend(["Alt+Backspace".to_string(), "Alt+Delete".to_string()]);
            keys.extend(
                ARROWS
                    .iter()
                    .flat_map(|arrow| [format!("Alt+{arrow}"), format!("Alt+Shift+{arrow}")]),
            );
            // Emacs 風の移動と削除（Control+A で行頭、Control+K で行末まで消す など）
            keys.extend(
                "ABDEFHKNOPTVY"
                    .chars()
                    .map(|letter| format!("Control+Key{letter}")),
            );
        }
        Platform::Windows => {
            keys.extend(
                ["KeyY", "Insert", "Home", "End"].map(|code| format!("CommandOrControl+{code}")),
            );
            keys.extend(["Home", "End"].map(|code| format!("CommandOrControl+Shift+{code}")));
        }
    }
    keys.iter().any(|editing| editing == key)
}

/// 操作にキーを割り当てられるか。空文字（割り当てを外す）はいつでもよい。
/// 同じ操作に今のキーを割り当て直すのは重なりとしない
pub fn check(
    keys: &DraftKeys,
    hotkey: &str,
    action: DraftAction,
    key: &str,
    platform: Platform,
) -> Result<String, Rejection> {
    let key = normalize(key, platform).ok_or(Rejection::Invalid)?;
    if key.is_empty() {
        return Ok(key);
    }
    if is_editing_key(&key, platform) {
        return Err(Rejection::EditingKey);
    }
    if key == normalized_hotkey(hotkey, platform) {
        return Err(Rejection::Hotkey);
    }
    match keys.action_for(&key) {
        Some(other) if other != action => Err(Rejection::Action(other)),
        _ => Ok(key),
    }
}

/// ホットキーを、下書きの操作のキーと比べられる書き方にする。設定ファイルに手で書いたホットキーは並びが揃っていないことがあり、
/// OS への登録は並びを問わないので、揃えてから比べる。揃えられない書き方ならそのまま比べる
fn normalized_hotkey(hotkey: &str, platform: Platform) -> String {
    normalize(hotkey, platform)
        .filter(|key| !key.is_empty())
        .or_else(|| hotkey_alias(hotkey, platform))
        .unwrap_or_else(|| hotkey.to_string())
}

/// 設定ファイルに手で書いたホットキーの別名（`Cmd+Shift+Enter`・`Ctrl+Shift+K`・小文字など）を、下書きのキーの書き方に揃える。
/// ホットキーを登録する global-hotkey はこうした別名も受け付けるので、揃えないと下書きのキーとの重なりを見落とす
fn hotkey_alias(hotkey: &str, platform: Platform) -> Option<String> {
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};
    let (command, other) = match platform {
        Platform::MacOs => (Modifiers::SUPER, (Modifiers::CONTROL, "Control")),
        Platform::Windows => (Modifiers::CONTROL, (Modifiers::SUPER, "Super")),
    };
    // global-hotkey は CommandOrControl の別名をビルドした OS で読み替えるので、platform で先に読み替えておく
    let command_name = if command == Modifiers::SUPER {
        "Super"
    } else {
        "Control"
    };
    let hotkey: Vec<&str> = hotkey
        .split('+')
        .map(|part| match part.trim().to_uppercase().as_str() {
            "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => command_name,
            _ => part,
        })
        .collect();
    let shortcut: Shortcut = hotkey.join("+").parse().ok()?;
    let mut parts: Vec<String> = [
        (command, "CommandOrControl"),
        other,
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
    ]
    .into_iter()
    .filter(|(modifier, _)| shortcut.mods.contains(*modifier))
    .map(|(_, name)| name.to_string())
    .collect();
    parts.push(shortcut.key.to_string());
    Some(parts.join("+"))
}

/// ホットキーにできるか。下書きの操作に割り当て済みのキーは、下書きウィンドウに届かなくなるので断る。
/// 空文字（ホットキーを外す）はいつでもよい
pub fn check_hotkey(keys: &DraftKeys, hotkey: &str, platform: Platform) -> Result<(), Rejection> {
    // キーを外した操作も空文字なので、比べると重なりに見えてしまう
    if hotkey.is_empty() {
        return Ok(());
    }
    let hotkey = normalized_hotkey(hotkey, platform);
    // どのアプリでもそのキーを奪い、下書きの中でも貼り付けなどができなくなる。下書きのキーと同じく断る
    if is_editing_key(&hotkey, platform) {
        return Err(Rejection::EditingKey);
    }
    match keys.action_for(&hotkey) {
        Some(action) => Err(Rejection::Action(action)),
        None => Ok(()),
    }
}

/// 設定ファイルの `text_window_keys` を読んだ結果
pub struct Parsed {
    pub keys: DraftKeys,
    /// 読めなかった項目名（`text_window_keys.copy` など）。その操作は既定のキーのまま
    pub repaired: Vec<String>,
    /// 設定ファイルにキーが書いてあった操作。書いてない操作は既定のキーを使う
    pub written: Vec<DraftAction>,
}

/// 設定ファイルの `text_window_keys` を読む。`[text_window_keys]` の表でも、インラインの表でもよい。
/// `text_window_keys` がなければ None を渡す（キーを変えていない設定ファイル）
pub fn parse(item: Option<&Item>, platform: Platform) -> Parsed {
    let mut parsed = Parsed {
        keys: DraftKeys::default(),
        repaired: Vec::new(),
        written: Vec::new(),
    };
    let Some(item) = item else {
        return parsed;
    };
    let Some(table) = item.as_table_like() else {
        parsed.repaired.push("text_window_keys".to_string());
        return parsed;
    };
    for action in DraftAction::ALL {
        let Some(value) = table.get(action.name()) else {
            continue;
        };
        match value.as_str().and_then(|key| normalize(key, platform)) {
            Some(key) => {
                *parsed.keys.get_mut(action) = key;
                parsed.written.push(action);
            }
            None => parsed
                .repaired
                .push(format!("text_window_keys.{}", action.name())),
        }
    }
    let unknown: Vec<&str> = table
        .iter()
        .map(|(name, _)| name)
        .filter(|name| DraftAction::ALL.iter().all(|action| action.name() != *name))
        .collect();
    if !unknown.is_empty() {
        log::info!("ignored unknown draft keys: {}", unknown.join(", "));
    }
    parsed
}

/// `resolve_conflicts` で外した操作
#[derive(Debug, Default, PartialEq)]
pub struct Resolved {
    /// 設定ファイルに書いてあった（`written`）操作の項目名。知らせる
    pub removed: Vec<String>,
    /// 書いてなかった操作。黙って外したので、保存するときも書かない（重なりが解ければ、次の起動で既定のキーに戻る）
    pub yielded: Vec<DraftAction>,
}

/// 重なったキーを外す。編集キー・ホットキーと重なったもの、先の操作と重なったものを割り当てなしにする。
/// 書いてない操作は既定のキーを使っていて、ユーザーが書き換えたものではないので、黙って外す
/// （ホットキーを Cmd+L にしている人に、新しい版で足された操作の既定のキーが Cmd+L でも警告を出さない）。
/// 書いた操作を先に決めてから書いてない操作を見るので、書いてない操作の既定のキーが書いたキーと重なったら、
/// 並びで先にあっても書いてない側を外す（前の履歴を Cmd+K にしていたところへ、新しい版で既定のキーが Cmd+K の操作が足されたなど）
pub fn resolve_conflicts(
    keys: &mut DraftKeys,
    hotkey: &str,
    platform: Platform,
    written: &[DraftAction],
) -> Resolved {
    let hotkey = normalized_hotkey(hotkey, platform);
    let mut used: Vec<String> = Vec::new();
    let mut resolved = Resolved::default();
    for is_written in [true, false] {
        for action in DraftAction::ALL {
            if written.contains(&action) != is_written {
                continue;
            }
            let key = keys.get_mut(action);
            if key.is_empty() {
                continue;
            }
            if is_editing_key(key, platform) || *key == hotkey || used.contains(key) {
                key.clear();
                if is_written {
                    resolved
                        .removed
                        .push(format!("text_window_keys.{}", action.name()));
                } else {
                    resolved.yielded.push(action);
                }
            } else {
                used.push(key.clone());
            }
        }
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用に、TOML の文字列から `text_window_keys` の項目を作る
    fn item(toml: &str) -> Item {
        toml.parse::<toml_edit::DocumentMut>()
            .unwrap()
            .into_table()
            .remove("text_window_keys")
            .unwrap()
    }

    #[test]
    fn names_platforms_for_the_screen() {
        assert_eq!(config::choice_name(&Platform::MacOs), "macos");
        assert_eq!(config::choice_name(&Platform::Windows), "windows");
    }

    const MAC: Platform = Platform::MacOs;
    const WIN: Platform = Platform::Windows;

    #[test]
    fn default_keys_do_not_conflict() {
        for platform in [MAC, WIN] {
            let mut keys = DraftKeys::default();
            assert_eq!(
                resolve_conflicts(
                    &mut keys,
                    crate::config::DEFAULT_HOTKEY,
                    platform,
                    &DraftAction::ALL
                ),
                Resolved::default()
            );
            assert_eq!(keys, DraftKeys::default());
            for action in DraftAction::ALL {
                assert_eq!(
                    normalize(action.default_key(), platform).as_deref(),
                    Some(action.default_key())
                );
            }
        }
    }

    #[test]
    fn normalizes_modifier_order() {
        assert_eq!(
            normalize("Shift+KeyK+", MAC),
            None,
            "an empty key name is not a key"
        );
        assert_eq!(
            normalize("Shift+Alt+CommandOrControl+KeyK", MAC).as_deref(),
            Some("CommandOrControl+Alt+Shift+KeyK")
        );
        assert_eq!(
            normalize("Control+CommandOrControl+Enter", MAC).as_deref(),
            Some("CommandOrControl+Control+Enter")
        );
        assert_eq!(normalize("", WIN).as_deref(), Some(""));
    }

    #[test]
    fn rejects_unreadable_keys() {
        for (key, platform) in [
            ("KeyK", MAC),
            ("Shift+KeyK", MAC),
            ("CommandOrControl", MAC),
            ("CommandOrControl+Escape", WIN),
            ("CommandOrControl+Typo", WIN),
            ("CommandOrControl+Key", WIN),
            ("CommandOrControl+F25", WIN),
            ("CommandOrControl+Digit01", WIN),
            ("CommandOrControl+Shift", MAC),
            ("CommandOrControl+CommandOrControl+KeyK", MAC),
            ("Cmd+KeyK", MAC),
            ("CommandOrControl+,", MAC),
            ("Super+KeyK", MAC),
            ("Control+KeyK", WIN),
        ] {
            assert_eq!(normalize(key, platform), None, "{key}");
        }
        assert_eq!(normalize("Super+KeyK", WIN).as_deref(), Some("Super+KeyK"));
        assert_eq!(
            normalize("Control+KeyK", MAC).as_deref(),
            Some("Control+KeyK")
        );
    }

    #[test]
    fn rejects_editing_keys() {
        let keys = DraftKeys::default();
        for (key, platform) in [
            ("CommandOrControl+KeyV", MAC),
            ("CommandOrControl+Shift+KeyZ", WIN),
            ("CommandOrControl+Backspace", MAC),
            ("CommandOrControl+Shift+ArrowLeft", WIN),
            ("Alt+ArrowLeft", MAC),
            ("Control+KeyK", MAC),
            ("CommandOrControl+KeyY", WIN),
            ("CommandOrControl+Shift+End", WIN),
        ] {
            assert_eq!(
                check(&keys, "", DraftAction::Copy, key, platform),
                Err(Rejection::EditingKey),
                "{key}"
            );
        }
        // Alt+矢印は Windows の入力欄では編集キーではない
        assert_eq!(
            check(&keys, "", DraftAction::Copy, "Alt+ArrowLeft", WIN).as_deref(),
            Ok("Alt+ArrowLeft")
        );
    }

    #[test]
    fn rejects_keys_used_elsewhere() {
        let keys = DraftKeys::default();
        assert_eq!(
            check(
                &keys,
                "CommandOrControl+KeyJ",
                DraftAction::Copy,
                "CommandOrControl+KeyJ",
                MAC
            ),
            Err(Rejection::Hotkey)
        );
        assert_eq!(
            check(&keys, "", DraftAction::Copy, "CommandOrControl+KeyK", MAC),
            Err(Rejection::Action(DraftAction::Actions))
        );
        // 同じ操作に今のキーを選び直すのはよい
        assert_eq!(
            check(
                &keys,
                "",
                DraftAction::Snippets,
                "CommandOrControl+KeyJ",
                MAC
            )
            .as_deref(),
            Ok("CommandOrControl+KeyJ")
        );
        assert_eq!(
            check(&keys, "", DraftAction::Copy, "", MAC).as_deref(),
            Ok("")
        );
        assert_eq!(
            check_hotkey(&keys, "CommandOrControl+KeyL", MAC),
            Err(Rejection::Action(DraftAction::SendTargets))
        );
        assert_eq!(
            check_hotkey(&keys, "CommandOrControl+Shift+Space", MAC),
            Ok(())
        );
        // キーを外した操作があっても、ホットキーを外せる
        let cleared = DraftKeys {
            copy: String::new(),
            ..DraftKeys::default()
        };
        assert_eq!(check_hotkey(&cleared, "", MAC), Ok(()));
    }

    #[test]
    fn hotkey_rejects_editing_keys() {
        let keys = DraftKeys::default();
        assert_eq!(
            check_hotkey(&keys, "CommandOrControl+KeyV", MAC),
            Err(Rejection::EditingKey)
        );
        assert_eq!(
            check_hotkey(&keys, "CommandOrControl+KeyC", WIN),
            Err(Rejection::EditingKey)
        );
    }

    #[test]
    fn hotkey_aliases_still_conflict_with_draft_keys() {
        // 設定ファイルに手で書いた別名でも、下書きのキーと重なれば断る
        let keys = DraftKeys::default();
        for (hotkey, platform) in [
            ("Cmd+Shift+Enter", MAC),
            ("super+shift+enter", MAC),
            ("Ctrl+Shift+Enter", WIN),
            ("control+shift+Enter", WIN),
            ("CmdOrCtrl+Shift+Enter", MAC),
            ("CmdOrCtrl+Shift+Enter", WIN),
        ] {
            assert_eq!(
                check_hotkey(&keys, hotkey, platform),
                Err(Rejection::Action(DraftAction::Send)),
                "{hotkey}"
            );
        }
        assert_eq!(
            check_hotkey(&keys, "Cmd+V", MAC),
            Err(Rejection::EditingKey)
        );
        assert_eq!(check_hotkey(&keys, "Ctrl+Shift+Space", WIN), Ok(()));
    }

    #[test]
    fn rejection_codes() {
        assert_eq!(Rejection::Invalid.code(), "keys.invalid");
        assert_eq!(Rejection::EditingKey.code(), "keys.editing");
        assert_eq!(Rejection::Hotkey.code(), "keys.hotkey");
        assert_eq!(
            Rejection::Action(DraftAction::HistoryOlder).code(),
            "keys.action.historyOlder"
        );
    }

    #[test]
    fn parses_keys_and_repairs_unreadable_ones() {
        let Parsed {
            keys,
            repaired,
            written,
        } = parse(
            Some(&item(
                r#"[text_window_keys]
                copy = "Shift+CommandOrControl+KeyJ"
                send = 1
                snippets = ""
                history_older = "KeyK"
                unknown = "CommandOrControl+KeyL"
                "#,
            )),
            MAC,
        );
        assert_eq!(keys.copy, "CommandOrControl+Shift+KeyJ");
        assert_eq!(keys.send, DraftAction::Send.default_key());
        assert_eq!(keys.snippets, "");
        assert_eq!(keys.history_older, DraftAction::HistoryOlder.default_key());
        assert_eq!(keys.settings, DraftAction::Settings.default_key());
        assert_eq!(
            repaired,
            ["text_window_keys.send", "text_window_keys.history_older"]
        );
        assert_eq!(written, [DraftAction::Copy, DraftAction::Snippets]);

        let parsed = parse(
            Some(&item(r#"text_window_keys = "CommandOrControl+KeyJ""#)),
            MAC,
        );
        assert_eq!(parsed.keys, DraftKeys::default());
        assert_eq!(parsed.repaired, ["text_window_keys"]);

        // インラインの表でも読む
        let parsed = parse(
            Some(&item(
                r#"text_window_keys = { copy = "CommandOrControl+KeyJ" }"#,
            )),
            MAC,
        );
        assert_eq!(parsed.keys.copy, "CommandOrControl+KeyJ");
        assert_eq!(parsed.written, [DraftAction::Copy]);

        let parsed = parse(None, MAC);
        assert_eq!(parsed.keys, DraftKeys::default());
        assert!(parsed.repaired.is_empty() && parsed.written.is_empty());
    }

    #[test]
    fn resolves_conflicts_in_action_order() {
        let mut keys = DraftKeys {
            // 送るがコピーと同じキー、定型文がホットキーと同じキー、設定が編集キー
            send: "CommandOrControl+Enter".to_string(),
            snippets: "CommandOrControl+Shift+Space".to_string(),
            settings: "CommandOrControl+KeyC".to_string(),
            ..DraftKeys::default()
        };
        assert_eq!(
            resolve_conflicts(
                &mut keys,
                "CommandOrControl+Shift+Space",
                MAC,
                &DraftAction::ALL
            )
            .removed,
            [
                "text_window_keys.send",
                "text_window_keys.settings",
                "text_window_keys.snippets"
            ]
        );
        assert_eq!(keys.copy, "CommandOrControl+Enter");
        assert_eq!(keys.send, "");
        assert_eq!(keys.settings, "");
        assert_eq!(keys.snippets, "");
    }

    #[test]
    fn silently_removes_default_keys_that_conflict() {
        // ホットキーが、新しい版で足された操作の既定のキーと同じ人には、外すだけで知らせない
        let mut keys = DraftKeys::default();
        assert_eq!(
            resolve_conflicts(&mut keys, "CommandOrControl+KeyL", MAC, &[]),
            Resolved {
                removed: Vec::new(),
                yielded: vec![DraftAction::SendTargets],
            }
        );
        assert_eq!(keys.send_targets, "");
        assert_eq!(keys.snippets, DraftAction::Snippets.default_key());
    }

    #[test]
    fn default_keys_yield_to_written_keys() {
        // 前の履歴に定型文の既定のキーを書いたら、並びで先にある定型文のほうを黙って外す
        let mut keys = DraftKeys {
            history_older: DraftAction::Snippets.default_key().to_string(),
            ..DraftKeys::default()
        };
        assert_eq!(
            resolve_conflicts(
                &mut keys,
                crate::config::DEFAULT_HOTKEY,
                MAC,
                &[DraftAction::HistoryOlder]
            ),
            Resolved {
                removed: Vec::new(),
                yielded: vec![DraftAction::Snippets],
            }
        );
        assert_eq!(keys.history_older, DraftAction::Snippets.default_key());
        assert_eq!(keys.snippets, "");
    }

    #[test]
    fn compares_hotkeys_written_in_another_order() {
        let mut keys = DraftKeys::default();
        assert_eq!(
            resolve_conflicts(
                &mut keys,
                "Shift+CommandOrControl+Backspace",
                MAC,
                &DraftAction::ALL
            )
            .removed,
            ["text_window_keys.discard_received"]
        );
        assert_eq!(
            check(
                &DraftKeys::default(),
                "Shift+CommandOrControl+KeyJ",
                DraftAction::Copy,
                "CommandOrControl+Shift+KeyJ",
                MAC
            ),
            Err(Rejection::Hotkey)
        );
    }

    #[test]
    fn treats_numpad_enter_as_enter() {
        assert_eq!(
            normalize("CommandOrControl+NumpadEnter", WIN).as_deref(),
            Some("CommandOrControl+Enter")
        );
    }
}
