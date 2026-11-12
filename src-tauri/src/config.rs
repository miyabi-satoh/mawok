//! 設定の型と、設定のファイル（settings_files.rs）に書く項目の値（docs/config.md）

use std::collections::BTreeMap;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::{
    draft_keys::{self, DraftAction, DraftKeys, Platform},
    text::{CharWidths, PunctuationStyle, Replacement},
};

pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+Space";

/// 表示言語。System は OS の言語に従う
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    Ja,
    En,
}

/// テーマ。System は OS の設定に従う
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// テキストウィンドウを出すディスプレイ。Last は前回の位置のまま、Pointer はマウスポインターのあるディスプレイ
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "lowercase")]
pub enum TextWindowDisplay {
    #[default]
    Last,
    Pointer,
}

/// 隠してからどれだけたったら、次に出すときに入力欄を空から始めるか。Never なら空にしない。
/// 選べる長さは、ホットキーで出すメモのアプリ（Drafts の New Draft After）と同じ幅にする
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
pub enum ClearTextAfter {
    #[default]
    #[serde(rename = "never")]
    Never,
    #[serde(rename = "30s")]
    Seconds30,
    #[serde(rename = "1m")]
    Minutes1,
    #[serde(rename = "5m")]
    Minutes5,
    #[serde(rename = "15m")]
    Minutes15,
    #[serde(rename = "1h")]
    Hours1,
}

impl ClearTextAfter {
    pub fn duration(self) -> Option<std::time::Duration> {
        let seconds = match self {
            Self::Never => return None,
            Self::Seconds30 => 30,
            Self::Minutes1 => 60,
            Self::Minutes5 => 5 * 60,
            Self::Minutes15 => 15 * 60,
            Self::Hours1 => 60 * 60,
        };
        Some(std::time::Duration::from_secs(seconds))
    }
}

/// 定型文の1件。下書きで定型文のキーで出す一覧から選ぶと、本文を挿入する
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(default)]
pub struct Snippet {
    /// 一覧で選ぶときの見出し。空なら、画面側で本文の最初の空でない行を代わりに出す
    pub name: String,
    /// 登録した文。選ぶと挿入する
    pub body: String,
    /// 消さずに一覧から外せるようにするため、1件ずつ切れる（置き換え辞書と同じ）
    pub enabled: bool,
}

impl Default for Snippet {
    fn default() -> Self {
        Self {
            name: String::new(),
            body: String::new(),
            enabled: true,
        }
    }
}

/// 置き場には `stored_entries` で項目ごとに書き、`from_entries` で読む。項目名は `key` にまとめてある
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub hotkey: String,
    /// 下書きウィンドウの操作を呼ぶキー（draft_keys.rs）
    pub text_window_keys: DraftKeys,
    /// 書いてなかった操作のうち、既定のキーが重なって起動時に黙って外したもの。置き場には書かない。
    /// 割り当てなしのままなら保存しても書かず、書いていない操作として既定のキーを使う扱いを保つ
    pub yielded_draft_keys: Vec<DraftAction>,
    pub autostart: bool,
    pub language: Language,
    pub theme: Theme,
    /// 下書きウィンドウを常に最前面に表示するか
    pub text_window_always_on_top: bool,
    /// 下書きウィンドウからフォーカスが外れたら、コピーせずに隠すか
    pub hide_text_window_on_blur: bool,
    /// 下書きの入力欄の上下に、操作のボタンを出すか
    pub show_text_window_buttons: bool,
    /// 下書きウィンドウを出すディスプレイ
    pub text_window_display: TextWindowDisplay,
    /// 隠してからこれだけたったら、次に出すときに入力欄を空から始める
    pub clear_text_after: ClearTextAfter,
    /// 下書きの履歴の件数。0 なら覚えない（docs/config.md「履歴」）
    pub text_history_size: u16,
    /// クリップボードへ渡すときに、末尾の空白文字を取り除くか
    pub trim_trailing_whitespace: bool,
    /// クリップボードへ渡すときに適用する置き換え辞書。最長一致で適用し、左側が同じ項目は並びで最初を使う
    pub replacements: Vec<Replacement>,
    /// 定型文。一覧には登録した順に並べる
    pub snippets: Vec<Snippet>,
    /// クリップボードへ渡すときに、句読点をどちらに揃えるか
    pub punctuation_style: PunctuationStyle,
    /// クリップボードへ渡すときに、全角と半角を文字の種類ごとにどちらへ揃えるか
    pub char_widths: CharWidths,
    /// クリップボードへ渡すときに、クリップボードの履歴・同期・管理アプリに残さないよう印を付けるか
    pub exclude_from_clipboard_history: bool,
    /// 下書きの入力欄のフォント。CSS の font-family の並びをそのまま書ける。空なら OS 標準に任せる
    pub text_font_family: String,
    /// 下書きの入力欄の文字の大きさ（px）
    pub text_font_size: u16,
    /// 下書きの入力欄の文字色（ライト）。小文字の #rrggbb。空なら標準の文字色
    pub text_color_light: String,
    /// 下書きの入力欄の文字色（ダーク）。小文字の #rrggbb。空なら標準の文字色
    pub text_color_dark: String,
    /// 下書きの入力欄に出す案内。None なら既定の案内（画面側で今の言語とホットキーから作る）、空文字なら出さない。
    /// 既定のままのときは、置き場に書かない
    pub input_guidance: Option<String>,
}

/// 文字色を小文字の #rrggbb に揃える。#rgb も受け付ける。空は空（標準の色）のまま。
/// 色として読めなければ None。画面側の src/lib/color.ts の normalizeTextColor と同じ決まり
pub fn normalize_text_color(value: &str) -> Option<String> {
    // 取り除くのは ASCII の空白だけ。Rust の trim は U+0085 を、JS の trim は BOM を取り除き、画面側と結果が食い違うため
    let value = value.trim_matches(|c: char| c.is_ascii_whitespace());
    if value.is_empty() {
        return Some(String::new());
    }
    let hex = value.strip_prefix('#')?;
    if !hex.chars().all(|digit| digit.is_ascii_hexdigit()) {
        return None;
    }
    let full = match hex.len() {
        3 => hex.chars().flat_map(|digit| [digit, digit]).collect(),
        6 => hex.to_string(),
        _ => return None,
    };
    Some(format!("#{}", full.to_ascii_lowercase()))
}

/// 下書きの文字の大きさの既定値と、受け付ける範囲。
/// 小さすぎて読めない値や、大きすぎて1文字も入らない値を入れられないようにする
pub const DEFAULT_DRAFT_FONT_SIZE: u16 = 16;
pub const MIN_DRAFT_FONT_SIZE: u16 = 10;
pub const MAX_DRAFT_FONT_SIZE: u16 = 32;

/// 下書きの履歴の件数の既定値と上限。既定は、何日も前のテキストをたどれるよう、コピーの多い使い方でも
/// 数か月分が残る件数にする。上限は型の幅で、この件数でも保存・ほかのデバイスの履歴との混ぜ合わせ・読み込みは
/// 合わせて 0.1 秒に満たない（2026-11 に Mac で測った）ので、それより絞らない
pub const DEFAULT_DRAFT_HISTORY_SIZE: u16 = 10_000;
pub const MAX_DRAFT_HISTORY_SIZE: u16 = u16::MAX;

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.to_string(),
            text_window_keys: DraftKeys::default(),
            yielded_draft_keys: Vec::new(),
            autostart: true,
            language: Language::default(),
            theme: Theme::default(),
            text_window_always_on_top: true,
            hide_text_window_on_blur: true,
            show_text_window_buttons: true,
            text_window_display: TextWindowDisplay::default(),
            clear_text_after: ClearTextAfter::default(),
            text_history_size: DEFAULT_DRAFT_HISTORY_SIZE,
            trim_trailing_whitespace: true,
            replacements: Vec::new(),
            snippets: Vec::new(),
            punctuation_style: PunctuationStyle::default(),
            char_widths: CharWidths::default(),
            exclude_from_clipboard_history: true,
            text_font_family: String::new(),
            text_font_size: DEFAULT_DRAFT_FONT_SIZE,
            text_color_light: String::new(),
            text_color_dark: String::new(),
            input_guidance: None,
        }
    }
}

/// 設定画面で既定から変えた印を付ける項目。複数の設定を1行に出すものも、行ごとに1つの名前にする。
#[derive(Clone, Copy)]
enum ModifiedSetting {
    Value {
        name: &'static str,
        differs: fn(&Config, &Config) -> bool,
    },
    DraftKey(DraftAction),
}

const MODIFIED_SETTINGS: &[ModifiedSetting] = &[
    ModifiedSetting::Value {
        name: key::HOTKEY,
        differs: |config, defaults| config.hotkey != defaults.hotkey,
    },
    ModifiedSetting::DraftKey(DraftAction::Copy),
    ModifiedSetting::DraftKey(DraftAction::Settings),
    ModifiedSetting::DraftKey(DraftAction::Snippets),
    ModifiedSetting::DraftKey(DraftAction::HistoryOlder),
    ModifiedSetting::DraftKey(DraftAction::HistoryNewer),
    ModifiedSetting::DraftKey(DraftAction::HistorySearch),
    ModifiedSetting::DraftKey(DraftAction::New),
    ModifiedSetting::DraftKey(DraftAction::Delete),
    ModifiedSetting::Value {
        name: key::AUTOSTART,
        differs: |config, defaults| config.autostart != defaults.autostart,
    },
    ModifiedSetting::Value {
        name: key::TEXT_WINDOW_ALWAYS_ON_TOP,
        differs: |config, defaults| {
            config.text_window_always_on_top != defaults.text_window_always_on_top
        },
    },
    ModifiedSetting::Value {
        name: key::HIDE_TEXT_WINDOW_ON_BLUR,
        differs: |config, defaults| {
            config.hide_text_window_on_blur != defaults.hide_text_window_on_blur
        },
    },
    ModifiedSetting::Value {
        name: key::SHOW_TEXT_WINDOW_BUTTONS,
        differs: |config, defaults| {
            config.show_text_window_buttons != defaults.show_text_window_buttons
        },
    },
    ModifiedSetting::Value {
        name: key::TEXT_WINDOW_DISPLAY,
        differs: |config, defaults| config.text_window_display != defaults.text_window_display,
    },
    ModifiedSetting::Value {
        name: key::CLEAR_TEXT_AFTER,
        differs: |config, defaults| config.clear_text_after != defaults.clear_text_after,
    },
    ModifiedSetting::Value {
        name: key::TEXT_HISTORY_SIZE,
        differs: |config, defaults| config.text_history_size != defaults.text_history_size,
    },
    ModifiedSetting::Value {
        name: key::LANGUAGE,
        differs: |config, defaults| config.language != defaults.language,
    },
    ModifiedSetting::Value {
        name: key::THEME,
        differs: |config, defaults| config.theme != defaults.theme,
    },
    ModifiedSetting::Value {
        name: "text_font",
        differs: |config, defaults| {
            config.text_font_family != defaults.text_font_family
                || config.text_font_size != defaults.text_font_size
        },
    },
    ModifiedSetting::Value {
        name: "text_color",
        differs: |config, defaults| {
            config.text_color_light != defaults.text_color_light
                || config.text_color_dark != defaults.text_color_dark
        },
    },
    ModifiedSetting::Value {
        name: key::INPUT_GUIDANCE,
        differs: |config, defaults| config.input_guidance != defaults.input_guidance,
    },
    ModifiedSetting::Value {
        name: key::TRIM_TRAILING_WHITESPACE,
        differs: |config, defaults| {
            config.trim_trailing_whitespace != defaults.trim_trailing_whitespace
        },
    },
    ModifiedSetting::Value {
        name: key::EXCLUDE_FROM_CLIPBOARD_HISTORY,
        differs: |config, defaults| {
            config.exclude_from_clipboard_history != defaults.exclude_from_clipboard_history
        },
    },
    ModifiedSetting::Value {
        name: "char_width",
        differs: |config, defaults| {
            config.char_widths != defaults.char_widths
                || config.punctuation_style != defaults.punctuation_style
        },
    },
];

fn modified_setting_name(setting: ModifiedSetting) -> String {
    match setting {
        ModifiedSetting::Value { name, .. } => name.into(),
        ModifiedSetting::DraftKey(action) => {
            // 画面が行と照らすので、置き場の書き方でなく画面の書き方（`historyOlder` など）
            format!("text_window_keys.{}", choice_name(&action))
        }
    }
}

/// 設定画面で既定から変えた印を付ける項目名の並び。画面側の印とテストで同じ名前を使う。
#[cfg(test)]
pub fn modified_setting_names() -> Vec<String> {
    MODIFIED_SETTINGS
        .iter()
        .copied()
        .map(modified_setting_name)
        .collect()
}

/// 設定画面で既定から変えた印を付ける項目名。置き場に書かない、競合で黙って外した既定のキーは変えた扱いにしない。
pub fn modified_settings(config: &Config) -> Vec<String> {
    let defaults = Config::default();
    MODIFIED_SETTINGS
        .iter()
        .filter(|setting| match setting {
            ModifiedSetting::Value { differs, .. } => differs(config, &defaults),
            ModifiedSetting::DraftKey(action) => {
                !config.yielded_draft_keys.contains(action)
                    && config.text_window_keys.get(*action)
                        != defaults.text_window_keys.get(*action)
            }
        })
        .copied()
        .map(modified_setting_name)
        .collect()
}

/// 設定のファイルでの項目名。読み込み（`from_entries`）と書き出し（`stored_entries`）で同じ名前を使う
pub mod key {
    pub const HOTKEY: &str = "hotkey";
    pub const TEXT_WINDOW_KEYS: &str = "text_window_keys";
    pub const AUTOSTART: &str = "autostart";
    pub const LANGUAGE: &str = "language";
    pub const THEME: &str = "theme";
    pub const TEXT_WINDOW_ALWAYS_ON_TOP: &str = "text_window_always_on_top";
    pub const HIDE_TEXT_WINDOW_ON_BLUR: &str = "hide_text_window_on_blur";
    pub const SHOW_TEXT_WINDOW_BUTTONS: &str = "show_text_window_buttons";
    pub const TEXT_WINDOW_DISPLAY: &str = "text_window_display";
    pub const CLEAR_TEXT_AFTER: &str = "clear_text_after";
    pub const TEXT_HISTORY_SIZE: &str = "text_history_size";
    pub const TRIM_TRAILING_WHITESPACE: &str = "trim_trailing_whitespace";
    pub const REPLACEMENTS: &str = "replacements";
    pub const SNIPPETS: &str = "snippets";
    pub const PUNCTUATION_STYLE: &str = "punctuation_style";
    pub const ALPHABET_WIDTH: &str = "alphabet_width";
    pub const DIGIT_WIDTH: &str = "digit_width";
    pub const SPACE_WIDTH: &str = "space_width";
    pub const SYMBOL_WIDTH: &str = "symbol_width";
    pub const KATAKANA_WIDTH: &str = "katakana_width";
    pub const EXCLUDE_FROM_CLIPBOARD_HISTORY: &str = "exclude_from_clipboard_history";
    pub const TEXT_FONT_FAMILY: &str = "text_font_family";
    pub const TEXT_FONT_SIZE: &str = "text_font_size";
    pub const TEXT_COLOR_LIGHT: &str = "text_color_light";
    pub const TEXT_COLOR_DARK: &str = "text_color_dark";
    pub const INPUT_GUIDANCE: &str = "input_guidance";

    /// 置き場の設定のファイルに書く項目（ログイン時の起動はデバイスの設定に置く）。書くときは、ここに無い名前の項目を
    /// 新しい版が書いたものや手で書いたものとして残す
    pub const IN_FILES: &[&str] = &[
        HOTKEY,
        TEXT_WINDOW_KEYS,
        LANGUAGE,
        THEME,
        TEXT_WINDOW_ALWAYS_ON_TOP,
        HIDE_TEXT_WINDOW_ON_BLUR,
        SHOW_TEXT_WINDOW_BUTTONS,
        TEXT_WINDOW_DISPLAY,
        CLEAR_TEXT_AFTER,
        TEXT_HISTORY_SIZE,
        TRIM_TRAILING_WHITESPACE,
        REPLACEMENTS,
        SNIPPETS,
        PUNCTUATION_STYLE,
        ALPHABET_WIDTH,
        DIGIT_WIDTH,
        SPACE_WIDTH,
        SYMBOL_WIDTH,
        KATAKANA_WIDTH,
        EXCLUDE_FROM_CLIPBOARD_HISTORY,
        TEXT_FONT_FAMILY,
        TEXT_FONT_SIZE,
        TEXT_COLOR_LIGHT,
        TEXT_COLOR_DARK,
        INPUT_GUIDANCE,
    ];
}

/// 置き場に書く項目。既定と違う値だけを持つ（docs/config.md）。
pub fn stored_entries(config: &Config) -> BTreeMap<String, Value> {
    let defaults = Config::default();
    let mut entries = BTreeMap::new();
    let mut put = |name: &str, value: Value, default: Value| {
        if value != default {
            entries.insert(name.to_string(), value);
        }
    };
    macro_rules! field {
        ($name:expr, $($field:ident).+) => {
            put($name, json(&config.$($field).+), json(&defaults.$($field).+))
        };
    }
    field!(key::HOTKEY, hotkey);
    field!(key::AUTOSTART, autostart);
    field!(key::LANGUAGE, language);
    field!(key::THEME, theme);
    field!(key::TEXT_WINDOW_ALWAYS_ON_TOP, text_window_always_on_top);
    field!(key::HIDE_TEXT_WINDOW_ON_BLUR, hide_text_window_on_blur);
    field!(key::SHOW_TEXT_WINDOW_BUTTONS, show_text_window_buttons);
    field!(key::TEXT_WINDOW_DISPLAY, text_window_display);
    field!(key::CLEAR_TEXT_AFTER, clear_text_after);
    field!(key::TEXT_HISTORY_SIZE, text_history_size);
    field!(key::TRIM_TRAILING_WHITESPACE, trim_trailing_whitespace);
    field!(key::REPLACEMENTS, replacements);
    field!(key::SNIPPETS, snippets);
    field!(key::PUNCTUATION_STYLE, punctuation_style);
    field!(key::ALPHABET_WIDTH, char_widths.alphabet);
    field!(key::DIGIT_WIDTH, char_widths.digit);
    field!(key::SPACE_WIDTH, char_widths.space);
    field!(key::SYMBOL_WIDTH, char_widths.symbol);
    field!(key::KATAKANA_WIDTH, char_widths.katakana);
    field!(
        key::EXCLUDE_FROM_CLIPBOARD_HISTORY,
        exclude_from_clipboard_history
    );
    field!(key::TEXT_FONT_FAMILY, text_font_family);
    field!(key::TEXT_FONT_SIZE, text_font_size);
    field!(key::TEXT_COLOR_LIGHT, text_color_light);
    field!(key::TEXT_COLOR_DARK, text_color_dark);
    field!(key::INPUT_GUIDANCE, input_guidance);
    put(
        key::TEXT_WINDOW_KEYS,
        stored_draft_keys(config),
        Value::Object(Default::default()),
    );
    entries
}

pub(crate) fn json<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("settings serialize")
}

/// テキストウィンドウのキー。既定のキーの操作と、起動時に黙って外したまま（`yielded`）の操作は書かない
/// （書いていない操作は既定のキーを使う）
fn stored_draft_keys(config: &Config) -> Value {
    let defaults = DraftKeys::default();
    Value::Object(
        DraftAction::ALL
            .into_iter()
            .filter(|&action| config.text_window_keys.get(action) != defaults.get(action))
            .filter(|action| {
                !(config.yielded_draft_keys.contains(action)
                    && config.text_window_keys.get(*action).is_empty())
            })
            .map(|action| {
                (
                    action.name().to_string(),
                    Value::String(config.text_window_keys.get(action).to_string()),
                )
            })
            .collect(),
    )
}

/// 置き場から読んだ設定
pub struct Loaded {
    pub config: Config,
    /// 読めずに既定のままにした項目と行（`replacements[3]` など）。ログにだけ出す
    pub skipped: Vec<String>,
}

/// 置き場の項目から設定を作る。読めない項目は既定のまま読み進め、知らない項目は読み飛ばす
/// （新しい版が書いた項目を、古い版で開いても動くようにする）
pub fn from_entries(entries: &BTreeMap<String, Value>) -> Loaded {
    let mut config = Config::default();
    let mut skipped = Vec::new();
    for (name, value) in entries {
        match name.as_str() {
            // ホットキーとキー操作は、互いの重なりを見るので最後に組で読む。行は1行ずつ読む
            key::HOTKEY | key::TEXT_WINDOW_KEYS => {}
            key::REPLACEMENTS => config.replacements = read_rows(name, value, &mut skipped),
            key::SNIPPETS => config.snippets = read_rows(name, value, &mut skipped),
            _ => match apply_setting(&mut config, name, value) {
                Some(true) => {}
                Some(false) => skipped.push(name.clone()),
                None => log::info!("ignored an unknown setting: {name}"),
            },
        }
    }
    match entries.get(key::HOTKEY).map(Value::as_str) {
        Some(Some(hotkey)) => config.hotkey = hotkey.to_string(),
        Some(None) => skipped.push(key::HOTKEY.to_string()),
        None => {}
    }
    let platform = Platform::current();
    let parsed = draft_keys::parse(entries.get(key::TEXT_WINDOW_KEYS), platform);
    config.text_window_keys = parsed.keys;
    skipped.extend(parsed.repaired);
    // ホットキーを読んでから見る。重なったキーは、ホットキーと先の操作に残す
    let resolved = draft_keys::resolve_conflicts(
        &mut config.text_window_keys,
        &config.hotkey,
        platform,
        &parsed.written,
    );
    skipped.extend(resolved.removed);
    config.yielded_draft_keys = resolved.yielded;
    Loaded { config, skipped }
}

/// 行の並び。型の合わない行だけを読み飛ばし、1行の読めない値で全体を失わないようにする
fn read_rows<T: DeserializeOwned>(name: &str, value: &Value, skipped: &mut Vec<String>) -> Vec<T> {
    let Some(rows) = value.as_array() else {
        skipped.push(name.to_string());
        return Vec::new();
    };
    rows.iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let read = serde_json::from_value(row.clone()).ok();
            if read.is_none() {
                skipped.push(format!("{name}[{index}]"));
            }
            read
        })
        .collect()
}

/// 1つの設定を、画面から変えるときと同じ検査を通して入れる。入れられない値なら何も変えずに false、知らない項目名なら None。
/// 設定のファイルから読むときに使う。範囲の外の値は収めずに断る（収めて入れると、手で書いた値と違う値が使われるため）。
/// ホットキー・キー操作・行は扱わない
pub fn apply_setting(config: &mut Config, name: &str, value: &Value) -> Option<bool> {
    fn set<T: DeserializeOwned>(target: &mut T, value: &Value) -> bool {
        set_checked(target, value, |_| true)
    }
    fn set_checked<T: DeserializeOwned>(
        target: &mut T,
        value: &Value,
        valid: impl FnOnce(&T) -> bool,
    ) -> bool {
        match serde_json::from_value::<T>(value.clone()) {
            Ok(next) if valid(&next) => {
                *target = next;
                true
            }
            _ => false,
        }
    }
    Some(match name {
        key::AUTOSTART => set(&mut config.autostart, value),
        key::LANGUAGE => set(&mut config.language, value),
        key::THEME => set(&mut config.theme, value),
        key::TEXT_WINDOW_ALWAYS_ON_TOP => set(&mut config.text_window_always_on_top, value),
        key::HIDE_TEXT_WINDOW_ON_BLUR => set(&mut config.hide_text_window_on_blur, value),
        key::SHOW_TEXT_WINDOW_BUTTONS => set(&mut config.show_text_window_buttons, value),
        key::TEXT_WINDOW_DISPLAY => set(&mut config.text_window_display, value),
        key::CLEAR_TEXT_AFTER => set(&mut config.clear_text_after, value),
        // 上限は型の幅（MAX_DRAFT_HISTORY_SIZE）なので、読めた値はどれも受け付ける
        key::TEXT_HISTORY_SIZE => set(&mut config.text_history_size, value),
        key::TRIM_TRAILING_WHITESPACE => set(&mut config.trim_trailing_whitespace, value),
        key::PUNCTUATION_STYLE => set(&mut config.punctuation_style, value),
        key::ALPHABET_WIDTH => set(&mut config.char_widths.alphabet, value),
        key::DIGIT_WIDTH => set(&mut config.char_widths.digit, value),
        key::SPACE_WIDTH => set(&mut config.char_widths.space, value),
        key::SYMBOL_WIDTH => set(&mut config.char_widths.symbol, value),
        key::KATAKANA_WIDTH => set(&mut config.char_widths.katakana, value),
        key::EXCLUDE_FROM_CLIPBOARD_HISTORY => {
            set(&mut config.exclude_from_clipboard_history, value)
        }
        key::TEXT_FONT_FAMILY => set(&mut config.text_font_family, value),
        key::TEXT_FONT_SIZE => set_checked(&mut config.text_font_size, value, |size| {
            (MIN_DRAFT_FONT_SIZE..=MAX_DRAFT_FONT_SIZE).contains(size)
        }),
        key::TEXT_COLOR_LIGHT => set_color(&mut config.text_color_light, value),
        key::TEXT_COLOR_DARK => set_color(&mut config.text_color_dark, value),
        key::INPUT_GUIDANCE => set(&mut config.input_guidance, value),
        _ => return None,
    })
}

/// 文字色。画面と同じ決まりで揃えてから入れる
fn set_color(target: &mut String, value: &Value) -> bool {
    match value.as_str().and_then(normalize_text_color) {
        Some(color) => {
            *target = color;
            true
        }
        None => false,
    }
}

/// 行（定型文・置き換え辞書）を、書いていない項目を既定の値で埋めた形にする。手で書いた行と、画面から書く行を比べるのに使う。
/// 行として読めなければ None
pub fn normalized_row(item_name: &str, row: &Value) -> Option<Value> {
    fn normalize<T: Serialize + DeserializeOwned>(row: &Value) -> Option<Value> {
        serde_json::from_value::<T>(row.clone())
            .ok()
            .map(|row| json(&row))
    }
    match item_name {
        key::SNIPPETS => normalize::<Snippet>(row),
        key::REPLACEMENTS => normalize::<Replacement>(row),
        _ => None,
    }
}

/// 選択肢の名前。serde の `rename_all` で決めた書き方で、設定のファイル・画面とのやり取りで同じ名前を使う
pub fn choice_name<T: Serialize>(choice: &T) -> String {
    serde_json::to_value(choice)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .expect("a choice serializes to a string")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::WidthStyle;
    use serde_json::json;

    fn round_trip(config: &Config) -> Config {
        from_entries(&stored_entries(config)).config
    }

    #[test]
    fn every_stored_item_other_than_autostart_goes_to_the_files() {
        let mut config = Config {
            hotkey: "CommandOrControl+Shift+KeyM".to_string(),
            autostart: false,
            language: Language::En,
            theme: Theme::Dark,
            text_window_always_on_top: false,
            hide_text_window_on_blur: false,
            show_text_window_buttons: false,
            text_window_display: TextWindowDisplay::Pointer,
            clear_text_after: ClearTextAfter::Minutes5,
            text_history_size: 0,
            trim_trailing_whitespace: false,
            replacements: vec![Replacement::default()],
            snippets: vec![Snippet::default()],
            punctuation_style: PunctuationStyle::Comma,
            exclude_from_clipboard_history: false,
            text_font_family: "a".to_string(),
            text_font_size: MIN_DRAFT_FONT_SIZE,
            text_color_light: "#000000".to_string(),
            text_color_dark: "#ffffff".to_string(),
            input_guidance: Some(String::new()),
            ..Config::default()
        };
        config.text_window_keys.copy = "CommandOrControl+KeyJ".to_string();
        config.char_widths = CharWidths {
            alphabet: WidthStyle::Full,
            digit: WidthStyle::Full,
            space: WidthStyle::Full,
            symbol: WidthStyle::Full,
            katakana: crate::text::KatakanaWidth::Full,
        };
        for name in stored_entries(&config).keys() {
            assert!(
                name == key::AUTOSTART || key::IN_FILES.contains(&name.as_str()),
                "{name} is not written to the files"
            );
        }
    }

    #[test]
    fn stores_nothing_for_the_defaults() {
        assert!(stored_entries(&Config::default()).is_empty());
    }

    #[test]
    fn round_trips_every_setting_and_stores_only_the_changed_ones() {
        let config = Config {
            hotkey: "CommandOrControl+Shift+KeyM".to_string(),
            autostart: false,
            language: Language::En,
            theme: Theme::Dark,
            text_window_display: TextWindowDisplay::Pointer,
            clear_text_after: ClearTextAfter::Seconds30,
            text_history_size: 0,
            replacements: vec![Replacement {
                from: "濃度".to_string(),
                to: "Node.js".to_string(),
                enabled: false,
            }],
            char_widths: CharWidths {
                digit: WidthStyle::Half,
                ..CharWidths::default()
            },
            text_font_size: MAX_DRAFT_FONT_SIZE,
            snippets: vec![Snippet {
                name: "挨拶".to_string(),
                body: "お世話になっております。".to_string(),
                ..Snippet::default()
            }],
            text_color_dark: "#123456".to_string(),
            input_guidance: Some(String::new()),
            ..Config::default()
        };
        assert_eq!(round_trip(&config), config);
        let entries = stored_entries(&config);
        assert_eq!(entries["digit_width"], json!("half"));
        assert_eq!(entries["clear_text_after"], json!("30s"));
        assert!(!entries.contains_key("alphabet_width"));
    }

    #[test]
    fn stores_only_the_keys_that_differ_from_their_defaults() {
        let mut config = Config::default();
        config.text_window_keys.copy = "CommandOrControl+KeyJ".to_string();
        let entries = stored_entries(&config);
        assert_eq!(
            entries["text_window_keys"],
            json!({ "copy": "CommandOrControl+KeyJ" })
        );
    }

    #[test]
    fn skips_unreadable_values_and_rows_and_ignores_unknown_settings() {
        let entries = BTreeMap::from([
            ("theme".to_string(), json!(3)),
            ("text_font_size".to_string(), json!(MAX_DRAFT_FONT_SIZE + 1)),
            ("language".to_string(), json!("ja")),
            ("a_setting_of_a_newer_version".to_string(), json!(true)),
            (
                "replacements".to_string(),
                json!([{ "from": "a", "to": "b" }, { "from": 1 }]),
            ),
        ]);
        let loaded = from_entries(&entries);
        assert_eq!(loaded.config.theme, Theme::System);
        assert_eq!(loaded.config.text_font_size, DEFAULT_DRAFT_FONT_SIZE);
        assert_eq!(loaded.config.language, Language::Ja);
        assert_eq!(loaded.config.replacements.len(), 1);
        assert_eq!(
            loaded.skipped,
            ["replacements[1]", "text_font_size", "theme"]
        );
    }

    #[test]
    fn a_hotkey_reassigned_from_a_default_key_does_not_drop_the_stored_keys() {
        // 既定でコピーのキーだったものをホットキーにし、コピーには別のキーを割り当てた
        let mut config = Config::default();
        let copy = config.text_window_keys.copy.clone();
        config.text_window_keys.copy = "CommandOrControl+KeyJ".to_string();
        config.hotkey = copy;
        assert_eq!(round_trip(&config), config);
    }
}
