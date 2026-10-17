//! 設定の型と、設定の置き場（store.rs）に書く項目の値（docs/config.md）

use std::collections::BTreeMap;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ai::AiService,
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

/// 定型文の1件。下書きで定型文のキーで出す一覧から選ぶ。選ぶと、挿入するか、宛先へ出す（docs/actions.md「定型文」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(default)]
pub struct Snippet {
    /// 同期でこの1件を見分けるランダムな値
    pub id: String,
    /// 一覧で選ぶときの見出し。空なら、画面側で本文の最初の空でない行を代わりに出す
    pub name: String,
    /// 登録した文。1行だけで行頭が宛先（`@ai`・`@sh`）なら、選ぶと今のテキストを中身にして出す。
    /// ほかは、選ぶと挿入する（docs/actions.md「定型文」）
    pub body: String,
    /// 宛先が `@ai`・`@sh` の行の、結果の出し方
    pub output: ActionOutput,
    /// 宛先が `@sh` の行の、標準入力と標準出力の文字コード
    pub encoding: ActionEncoding,
    /// 消さずに一覧から外せるようにするため、1件ずつ切れる（置き換え辞書と同じ）
    pub enabled: bool,
    /// ほかのデバイスと同期するか
    pub sync: bool,
}

impl Default for Snippet {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            body: String::new(),
            output: ActionOutput::default(),
            encoding: ActionEncoding::default(),
            enabled: true,
            sync: true,
        }
    }
}

/// 宛先へ出した結果の出し方。
/// コマンドが下書きを使うか、結果を返すかは Mawok から見分けられないので、定型文ごとに持つ
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "lowercase")]
pub enum ActionOutput {
    /// 実行した文（選んだ範囲、なければ全体）を結果で置き換える
    #[default]
    Replace,
    /// 範囲を選んでいたらその後ろに、なければカーソルの位置に結果を入れる
    Insert,
    /// 下書きに出さない。コマンドは終了コードが 0 なら、出力によらず成功
    None,
}

/// `@sh` のコマンドとやりとりする文字コード（docs/actions.md「コマンド」）。標準入力へ渡す文と、標準出力を読むときに使う。
/// Windows の `sort` のように、UTF-8 ではなくシステムの文字コード（日本語なら Shift_JIS）で読み書きするコマンドがあるため、定型文ごとに持つ
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
pub enum ActionEncoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "shift_jis")]
    ShiftJis,
    #[serde(rename = "euc-jp")]
    EucJp,
    #[serde(rename = "iso-2022-jp")]
    Iso2022Jp,
    #[serde(rename = "utf-16le")]
    Utf16Le,
}

impl ActionEncoding {
    /// ログとエラーに出す名前（serde の名前）
    pub fn name(self) -> String {
        choice_name(&self)
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
    /// Pro で、設定をほかのデバイスと同期するか。デバイスごとに選ぶので、この項目は同期しない
    pub sync_settings: bool,
    /// Pro で、キー操作をほかのデバイスと同期するか。デバイスごとに選ぶので、この項目は同期しない
    pub sync_keys: bool,
    /// Pro で、置き換え辞書をほかのデバイスと同期するか。デバイスごとに選ぶので、この項目は同期しない
    pub sync_replacements: bool,
    /// Pro で、定型文をほかのデバイスと同期するか。デバイスごとに選ぶので、この項目は同期しない
    pub sync_snippets: bool,
    /// Pro で、テキストウィンドウの履歴をほかのデバイスと同期するか。同じく同期しない
    pub sync_history: bool,
    /// 種類「設定」から外した設定の項目名。知らない名前は残し、同期では無視する
    pub sync_excluded_settings: Vec<String>,
    pub language: Language,
    pub theme: Theme,
    /// 下書きウィンドウを常に最前面に表示するか
    pub text_window_always_on_top: bool,
    /// 下書きウィンドウからフォーカスが外れたら、コピーせずに隠すか
    pub hide_text_window_on_blur: bool,
    /// 下書きの入力欄の上下に、操作のボタンを出すか
    pub show_text_window_buttons: bool,
    /// 下書きの履歴の件数。0 なら覚えず、履歴本文は app_local_data_dir/history.json に書かない
    pub text_history_size: u16,
    /// クリップボードへ渡すときに、末尾の空白文字を取り除くか
    pub trim_trailing_whitespace: bool,
    /// クリップボードへ渡すときに適用する置き換え辞書。最長一致で適用し、左側が同じ項目は並びで最初を使う
    pub replacements: Vec<Replacement>,
    /// 定型文。一覧には登録した順に並べる。None なら既定の定型文（今の表示言語のもの、actions::default_snippets）、空の並びなら定型文なし
    pub snippets: Option<Vec<Snippet>>,
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
    /// AI のアクションに使う AI サービス
    pub ai_service: AiService,
    /// 送る内容と扱いを了解した AI サービス。AI サービスを替えたら了解を取り直す
    pub ai_consent: Option<AiService>,
    /// OpenAI に了解したときのベース URL（`ai_base_url` と同じ形）。替えたら送り先が変わるので、了解を取り直す。
    /// 了解と同じく同期しない
    pub ai_consent_base_url: String,
    /// AI サービスごとのモデル。書いていないサービスは既定のモデルを使う。空文字は持たない
    pub ai_models: BTreeMap<AiService, String>,
    /// AI サービスが OpenAI のときに送る API の URL（`ai::normalize_base_url` で揃えたもの）。空なら OpenAI。
    /// OpenAI と互換のサービスに送るときに替える。モデルと組で使うので、モデルと同じく同期する
    pub ai_base_url: String,
}

impl Config {
    /// AI が使えるか。サービス・キー・了解の記録がそろっていること。キーが未確認なら使えるものとして扱う
    pub fn ai_available(&self, key_available: Option<bool>) -> bool {
        self.ai_service != AiService::None && key_available != Some(false) && self.ai_consented()
    }

    /// 今の AI サービスと送り先に了解しているか
    pub fn ai_consented(&self) -> bool {
        self.ai_consent == Some(self.ai_service)
            && (self.ai_service != AiService::OpenAi
                || self.ai_consent_base_url == self.ai_base_url)
    }

    /// AI サービスが OpenAI のときに送る API の URL
    pub fn openai_base_url(&self) -> &str {
        if self.ai_base_url.is_empty() {
            crate::ai::OPENAI_BASE_URL
        } else {
            &self.ai_base_url
        }
    }

    /// 今の AI サービスのキーを資格情報管理に置くときの名前。OpenAI のベース URL を替えてあれば、その URL ごとに分ける。
    /// 分けないと、OpenAI のキーを入れたまま送り先を替えたときに、OpenAI のキーを別のサービスへ送ってしまう
    pub fn ai_credential_user(&self) -> String {
        let user = self.ai_service.credential_user();
        if self.ai_service == AiService::OpenAi && !self.ai_base_url.is_empty() {
            format!("{user} {}", self.ai_base_url)
        } else {
            user.to_string()
        }
    }

    /// 今の AI サービスで使うモデル
    pub fn ai_model(&self) -> String {
        self.ai_models
            .get(&self.ai_service)
            .cloned()
            .unwrap_or_else(|| self.ai_service.default_model().to_string())
    }
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

/// 下書きの履歴の件数の既定値と上限。ディスクにも保存するが、扱いやすい上限にとどめる
pub const DEFAULT_DRAFT_HISTORY_SIZE: u16 = 50;
pub const MAX_DRAFT_HISTORY_SIZE: u16 = 100;

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.to_string(),
            text_window_keys: DraftKeys::default(),
            yielded_draft_keys: Vec::new(),
            autostart: true,
            sync_settings: true,
            sync_keys: true,
            sync_replacements: true,
            sync_snippets: true,
            sync_history: true,
            sync_excluded_settings: Vec::new(),
            language: Language::default(),
            theme: Theme::default(),
            text_window_always_on_top: true,
            hide_text_window_on_blur: true,
            show_text_window_buttons: true,
            text_history_size: DEFAULT_DRAFT_HISTORY_SIZE,
            trim_trailing_whitespace: true,
            replacements: Vec::new(),
            snippets: None,
            punctuation_style: PunctuationStyle::default(),
            char_widths: CharWidths::default(),
            exclude_from_clipboard_history: true,
            text_font_family: String::new(),
            text_font_size: DEFAULT_DRAFT_FONT_SIZE,
            text_color_light: String::new(),
            text_color_dark: String::new(),
            input_guidance: None,
            ai_service: AiService::default(),
            ai_consent: None,
            ai_consent_base_url: String::new(),
            ai_models: BTreeMap::new(),
            ai_base_url: String::new(),
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
    ModifiedSetting::DraftKey(DraftAction::ChangeFolder),
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
    ModifiedSetting::Value {
        name: key::AI_SERVICE,
        differs: |config, defaults| config.ai_service != defaults.ai_service,
    },
    ModifiedSetting::Value {
        name: key::AI_MODELS,
        differs: |config, _| {
            config.ai_service != AiService::None
                && config.ai_models.contains_key(&config.ai_service)
        },
    },
    ModifiedSetting::Value {
        name: key::AI_BASE_URL,
        differs: |config, defaults| config.ai_base_url != defaults.ai_base_url,
    },
    ModifiedSetting::Value {
        name: key::SYNC_SETTINGS,
        differs: |config, defaults| config.sync_settings != defaults.sync_settings,
    },
    ModifiedSetting::Value {
        name: key::SYNC_KEYS,
        differs: |config, defaults| config.sync_keys != defaults.sync_keys,
    },
    ModifiedSetting::Value {
        name: key::SYNC_REPLACEMENTS,
        differs: |config, defaults| config.sync_replacements != defaults.sync_replacements,
    },
    ModifiedSetting::Value {
        name: key::SYNC_SNIPPETS,
        differs: |config, defaults| config.sync_snippets != defaults.sync_snippets,
    },
    ModifiedSetting::Value {
        name: key::SYNC_HISTORY,
        differs: |config, defaults| config.sync_history != defaults.sync_history,
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

/// 置き場と同期での項目名。読み込み（`from_entries`）と書き出し（`stored_entries`）で同じ名前を使う
pub mod key {
    pub const HOTKEY: &str = "hotkey";
    pub const TEXT_WINDOW_KEYS: &str = "text_window_keys";
    pub const AUTOSTART: &str = "autostart";
    pub const SYNC_SETTINGS: &str = "sync_settings";
    pub const SYNC_KEYS: &str = "sync_keys";
    pub const SYNC_REPLACEMENTS: &str = "sync_replacements";
    pub const SYNC_SNIPPETS: &str = "sync_snippets";
    pub const SYNC_HISTORY: &str = "sync_history";
    pub const SYNC_EXCLUDED_SETTINGS: &str = "sync_excluded_settings";
    pub const LANGUAGE: &str = "language";
    pub const THEME: &str = "theme";
    pub const TEXT_WINDOW_ALWAYS_ON_TOP: &str = "text_window_always_on_top";
    pub const HIDE_TEXT_WINDOW_ON_BLUR: &str = "hide_text_window_on_blur";
    pub const SHOW_TEXT_WINDOW_BUTTONS: &str = "show_text_window_buttons";
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
    pub const AI_SERVICE: &str = "ai_service";
    pub const AI_CONSENT: &str = "ai_consent";
    pub const AI_CONSENT_BASE_URL: &str = "ai_consent_base_url";
    pub const AI_MODELS: &str = "ai_models";
    pub const AI_BASE_URL: &str = "ai_base_url";
}

/// 置き場に書く項目。既定と違う値だけを持つ（docs/config.md）。
/// 定型文は、既定の定型文のまま（`None`）なら書かず、利用者が変えたら空の並びでも書く
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
    field!(key::SYNC_SETTINGS, sync_settings);
    field!(key::SYNC_KEYS, sync_keys);
    field!(key::SYNC_REPLACEMENTS, sync_replacements);
    field!(key::SYNC_SNIPPETS, sync_snippets);
    field!(key::SYNC_HISTORY, sync_history);
    field!(key::SYNC_EXCLUDED_SETTINGS, sync_excluded_settings);
    field!(key::LANGUAGE, language);
    field!(key::THEME, theme);
    field!(key::TEXT_WINDOW_ALWAYS_ON_TOP, text_window_always_on_top);
    field!(key::HIDE_TEXT_WINDOW_ON_BLUR, hide_text_window_on_blur);
    field!(key::SHOW_TEXT_WINDOW_BUTTONS, show_text_window_buttons);
    field!(key::TEXT_HISTORY_SIZE, text_history_size);
    field!(key::TRIM_TRAILING_WHITESPACE, trim_trailing_whitespace);
    field!(key::REPLACEMENTS, replacements);
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
    field!(key::AI_SERVICE, ai_service);
    field!(key::AI_CONSENT, ai_consent);
    field!(key::AI_CONSENT_BASE_URL, ai_consent_base_url);
    field!(key::AI_BASE_URL, ai_base_url);
    // 既定のモデルと同じものは書かない。版を上げて既定のモデルを替えたときに、変えていない人へ届くようにする
    let models: BTreeMap<&AiService, &String> = config
        .ai_models
        .iter()
        .filter(|(service, model)| !model.is_empty() && model.as_str() != service.default_model())
        .collect();
    put(
        key::AI_MODELS,
        json(&models),
        json(BTreeMap::<AiService, String>::new()),
    );
    put(
        key::TEXT_WINDOW_KEYS,
        stored_draft_keys(config),
        Value::Object(Default::default()),
    );
    if let Some(snippets) = &config.snippets {
        entries.insert(key::SNIPPETS.to_string(), json(snippets));
    }
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
    /// 同期する行の ID を振り直した。同じ行を次も見分けられるよう、呼ぶ側で書き戻す
    pub repaired_item_ids: bool,
}

/// 置き場の項目から設定を作る。読めない項目は既定のまま読み進め、知らない項目は読み飛ばす
/// （新しい版が書いた項目を、古い版で開いても動くようにする）
pub fn from_entries(entries: &BTreeMap<String, Value>) -> Result<Loaded, String> {
    let mut config = Config::default();
    let mut skipped = Vec::new();
    for (name, value) in entries {
        match name.as_str() {
            // ホットキーとキー操作は、互いの重なりを見るので最後に組で読む。行は1行ずつ読む
            key::HOTKEY | key::TEXT_WINDOW_KEYS => {}
            key::REPLACEMENTS => config.replacements = read_rows(name, value, &mut skipped),
            key::SNIPPETS => config.snippets = Some(read_rows(name, value, &mut skipped)),
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
    let repaired_item_ids = repair_item_ids_in_config(&mut config)?;
    Ok(Loaded {
        config,
        skipped,
        repaired_item_ids,
    })
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
/// 置き場から読むときと、同期で届いたときに使う。範囲の外の値は収めずに断る（収めて入れると、届いた値と違う値を書き戻すため）。
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
        key::SYNC_SETTINGS => set(&mut config.sync_settings, value),
        key::SYNC_KEYS => set(&mut config.sync_keys, value),
        key::SYNC_REPLACEMENTS => set(&mut config.sync_replacements, value),
        key::SYNC_SNIPPETS => set(&mut config.sync_snippets, value),
        key::SYNC_HISTORY => set(&mut config.sync_history, value),
        key::SYNC_EXCLUDED_SETTINGS => set(&mut config.sync_excluded_settings, value),
        key::LANGUAGE => set(&mut config.language, value),
        key::THEME => set(&mut config.theme, value),
        key::TEXT_WINDOW_ALWAYS_ON_TOP => set(&mut config.text_window_always_on_top, value),
        key::HIDE_TEXT_WINDOW_ON_BLUR => set(&mut config.hide_text_window_on_blur, value),
        key::SHOW_TEXT_WINDOW_BUTTONS => set(&mut config.show_text_window_buttons, value),
        key::TEXT_HISTORY_SIZE => set_checked(&mut config.text_history_size, value, |size| {
            *size <= MAX_DRAFT_HISTORY_SIZE
        }),
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
        key::AI_SERVICE => set(&mut config.ai_service, value),
        key::AI_CONSENT => set(&mut config.ai_consent, value),
        key::AI_CONSENT_BASE_URL => set_checked(&mut config.ai_consent_base_url, value, |url| {
            crate::ai::normalize_base_url(url).as_deref() == Some(url.as_str())
        }),
        // 空のモデルは持たない。画面でも「既定のモデル」として項目ごと外す
        key::AI_MODELS => set_checked(&mut config.ai_models, value, |models| {
            models
                .values()
                .all(|model| !model.is_empty() && model.trim() == model)
        }),
        key::AI_BASE_URL => set_checked(&mut config.ai_base_url, value, |url| {
            crate::ai::normalize_base_url(url).as_deref() == Some(url.as_str())
        }),
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

pub(crate) fn valid_item_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 空・不正・重複の ID を、新しいランダムな値へ替える。
///
/// 画面から足した行もこの入口を通るので、ID は Rust 側だけで作る。
pub(crate) fn repair_item_ids<T: SyncRow>(items: &mut [T]) -> Result<bool, String> {
    let mut seen = std::collections::HashSet::new();
    let mut changed = false;
    for item in items {
        let item_id = item.id();
        if !valid_item_id(item_id) || !seen.insert(item_id.to_string()) {
            let next = loop {
                let next = crate::hex::random_hex::<16>()?;
                if seen.insert(next.clone()) {
                    break next;
                }
            };
            item.set_id(next);
            changed = true;
        }
    }
    Ok(changed)
}

/// 設定の行の ID を、種類ごとに直す。
fn repair_item_ids_in_config(config: &mut Config) -> Result<bool, String> {
    let replacements = repair_item_ids(&mut config.replacements)?;
    let snippets = match &mut config.snippets {
        Some(snippets) => repair_item_ids(snippets)?,
        None => false,
    };
    Ok(replacements || snippets)
}

/// 同期する行（置き換え辞書・定型文）。ID で同じ行を見分け、行ごとに同期するかを持つ
pub(crate) trait SyncRow: Serialize + for<'a> Deserialize<'a> + Clone {
    fn id(&self) -> &str;
    fn set_id(&mut self, id: String);
    fn sync(&self) -> bool;
    fn set_sync(&mut self, sync: bool);
}
impl SyncRow for Replacement {
    fn id(&self) -> &str {
        &self.id
    }
    fn set_id(&mut self, id: String) {
        self.id = id
    }
    fn sync(&self) -> bool {
        self.sync
    }
    fn set_sync(&mut self, sync: bool) {
        self.sync = sync
    }
}
impl SyncRow for Snippet {
    fn id(&self) -> &str {
        &self.id
    }
    fn set_id(&mut self, id: String) {
        self.id = id
    }
    fn sync(&self) -> bool {
        self.sync
    }
    fn set_sync(&mut self, sync: bool) {
        self.sync = sync
    }
}

/// 選択肢の名前。serde の `rename_all` で決めた書き方で、置き場・同期・画面とのやり取りで同じ名前を使う
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
        from_entries(&stored_entries(config)).unwrap().config
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
            sync_snippets: false,
            sync_excluded_settings: vec!["theme".to_string()],
            language: Language::En,
            theme: Theme::Dark,
            text_history_size: 0,
            replacements: vec![Replacement {
                id: "a".repeat(32),
                from: "濃度".to_string(),
                to: "Node.js".to_string(),
                enabled: false,
                sync: false,
            }],
            char_widths: CharWidths {
                digit: WidthStyle::Half,
                ..CharWidths::default()
            },
            text_font_size: MAX_DRAFT_FONT_SIZE,
            text_color_dark: "#123456".to_string(),
            input_guidance: Some(String::new()),
            ai_service: AiService::Gemini,
            ai_consent: Some(AiService::Gemini),
            ai_models: BTreeMap::from([(AiService::Gemini, "custom-model".to_string())]),
            ai_base_url: "http://localhost:11434/v1".to_string(),
            ..Config::default()
        };
        assert_eq!(round_trip(&config), config);
        let entries = stored_entries(&config);
        assert_eq!(entries["digit_width"], json!("half"));
        assert!(!entries.contains_key("alphabet_width"));
        assert!(!entries.contains_key("snippets"));
    }

    #[test]
    fn keeps_snippets_emptied_by_the_user_apart_from_the_defaults() {
        let emptied = Config {
            snippets: Some(Vec::new()),
            ..Config::default()
        };
        assert_eq!(stored_entries(&emptied)["snippets"], json!([]));
        assert_eq!(round_trip(&emptied).snippets, Some(Vec::new()));
    }

    #[test]
    fn stores_only_the_keys_and_models_that_differ_from_their_defaults() {
        let mut config = Config::default();
        config.text_window_keys.copy = "CommandOrControl+KeyJ".to_string();
        config.ai_models = BTreeMap::from([
            (
                AiService::Gemini,
                AiService::Gemini.default_model().to_string(),
            ),
            (AiService::Anthropic, "custom".to_string()),
        ]);
        let entries = stored_entries(&config);
        assert_eq!(
            entries["text_window_keys"],
            json!({ "copy": "CommandOrControl+KeyJ" })
        );
        assert_eq!(entries["ai_models"], json!({ "anthropic": "custom" }));
    }

    #[test]
    fn consent_to_openai_covers_only_the_base_url_consented_to() {
        let consented = Config {
            ai_service: AiService::OpenAi,
            ai_consent: Some(AiService::OpenAi),
            ai_base_url: "https://api.deepseek.com".to_string(),
            ai_consent_base_url: "https://api.deepseek.com".to_string(),
            ..Config::default()
        };
        assert!(consented.ai_consented());
        // 同期などで送り先が替わったら、了解していないものとして取り直す
        let moved = Config {
            ai_base_url: "http://localhost:11434/v1".to_string(),
            ..consented.clone()
        };
        assert!(!moved.ai_consented());
        // ほかのサービスには、ベース URL は関わらない
        let gemini = Config {
            ai_service: AiService::Gemini,
            ai_consent: Some(AiService::Gemini),
            ..moved
        };
        assert!(gemini.ai_consented());
    }

    #[test]
    fn skips_unreadable_values_and_rows_and_ignores_unknown_settings() {
        let entries = BTreeMap::from([
            ("theme".to_string(), json!(3)),
            ("text_font_size".to_string(), json!(MAX_DRAFT_FONT_SIZE + 1)),
            ("language".to_string(), json!("ja")),
            // 揃えていない形のベース URL
            (
                "ai_base_url".to_string(),
                json!("https://api.deepseek.com/"),
            ),
            ("a_setting_of_a_newer_version".to_string(), json!(true)),
            (
                "replacements".to_string(),
                json!([{ "from": "a", "to": "b" }, { "from": 1 }]),
            ),
        ]);
        let loaded = from_entries(&entries).unwrap();
        assert_eq!(loaded.config.theme, Theme::System);
        assert_eq!(loaded.config.text_font_size, DEFAULT_DRAFT_FONT_SIZE);
        assert_eq!(loaded.config.language, Language::Ja);
        assert_eq!(loaded.config.replacements.len(), 1);
        assert_eq!(
            loaded.skipped,
            ["ai_base_url", "replacements[1]", "text_font_size", "theme"]
        );
        // 行の ID が無かったので振り直し、呼ぶ側が書き戻す
        assert!(loaded.repaired_item_ids);
        assert!(valid_item_id(&loaded.config.replacements[0].id));
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
