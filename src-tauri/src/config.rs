//! 設定ファイル（TOML）の読み込みと書き出し（docs/config.md「設定ファイル」）

use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{
    de::{value::StrDeserializer, DeserializeOwned, IntoDeserializer},
    Deserialize, Serialize,
};
use toml_edit::{
    Array, ArrayOfTables, DocumentMut, InlineTable, Item, Table, TableLike, TomlError, Value,
};

use crate::{
    ai::AiService,
    atomic_file,
    draft_keys::{self, DraftAction, DraftKeys, Platform},
    text::{CharWidths, KatakanaWidth, PunctuationStyle, Replacement, WidthStyle},
};

pub const FILE_NAME: &str = "config.toml";
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

/// 定型文の1件。下書きで定型文のキー（既定は Cmd+J、Windows は Ctrl+J）で出す一覧から選び、カーソルの位置に差し込む
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(default)]
pub struct Snippet {
    /// 同期でこの1件を見分けるランダムな値
    pub id: String,
    /// 一覧で選ぶときの見出し。空なら、画面側で本文の最初の空でない行を代わりに出す
    pub name: String,
    /// 差し込む文。複数行にできる
    pub body: String,
    /// ほかのデバイスと同期するか
    pub sync: bool,
}

impl Default for Snippet {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            body: String::new(),
            sync: true,
        }
    }
}

/// アクションの結果の出し方。
/// コマンドが下書きを使うか、結果を返すかは Mawok から見分けられないので、アクションごとに持つ
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

impl ActionOutput {
    /// 設定ファイルでの名前
    pub fn name(self) -> &'static str {
        match self {
            Self::Replace => "replace",
            Self::Insert => "insert",
            Self::None => "none",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        [Self::Replace, Self::Insert, Self::None]
            .into_iter()
            .find(|output| output.name() == name)
    }
}

/// コマンドのアクションとやりとりする文字コード（docs/actions.md「コマンド」）。標準入力へ渡す文と、標準出力を読むときに使う。
/// Windows の `sort` のように、UTF-8 ではなくシステムの文字コード（日本語なら Shift_JIS）で読み書きするコマンドがあるため、アクションごとに持つ
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
    const ALL: [Self; 5] = [
        Self::Utf8,
        Self::ShiftJis,
        Self::EucJp,
        Self::Iso2022Jp,
        Self::Utf16Le,
    ];

    /// 設定ファイルでの名前（serde の名前と揃える）
    pub fn name(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::ShiftJis => "shift_jis",
            Self::EucJp => "euc-jp",
            Self::Iso2022Jp => "iso-2022-jp",
            Self::Utf16Le => "utf-16le",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|encoding| encoding.name() == name)
    }
}

/// アクションの1件。一覧から選ぶと、コマンドの行を実行して結果を下書きに出す
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(default)]
pub struct Action {
    /// 同期でこの1件を見分けるランダムな値
    pub id: String,
    /// 一覧で選ぶときの見出し。空なら、画面側でコマンドの行を代わりに出す
    pub name: String,
    /// 1行のコマンド。行頭が `@ai` なら AI のアクション（actions.rs の ai_instruction）。空なら一覧に出さない
    pub command: String,
    pub output: ActionOutput,
    /// コマンドの標準入力と標準出力の文字コード。`@ai` の行では使わない
    pub encoding: ActionEncoding,
    /// 消さずに一覧から外せるようにするため、1件ずつ切れる（置き換え辞書と同じ）
    pub enabled: bool,
    /// ほかのデバイスと同期するか
    pub sync: bool,
}

impl Default for Action {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            command: String::new(),
            output: ActionOutput::default(),
            encoding: ActionEncoding::default(),
            enabled: true,
            sync: true,
        }
    }
}

/// 同じアカウントで見つけた自分のデバイス（docs/lan.md「同じ LAN の自分のデバイスへ送る」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(default, rename_all = "camelCase")]
pub struct Device {
    /// ペアリングか生存確認で相手が名乗った名前
    pub name: String,
    /// 相手の公開鍵（小文字の16進）。この鍵を持つ相手とだけ送り合う
    pub public_key: String,
    /// 最後に相手へ送れた、または生存確認したときのアドレス。起動した直後で、相手の名乗りがまだ届いていないときに使う
    pub address: String,
    /// 送信先にチェックを入れているか。送るキーとボタンは、チェックしたデバイスへ送る
    pub send_to: bool,
}

/// 項目がない設定ファイル（送信先を選べるようになる前のもの）は、チェックを入れて読む。
/// 新しく見つけたデバイスは送信先に加える
impl Default for Device {
    fn default() -> Self {
        Self {
            name: String::new(),
            public_key: String::new(),
            address: String::new(),
            send_to: true,
        }
    }
}

/// 読み込みは `parse`、書き出しは `apply` で項目ごとに行う。項目名は `key` にまとめてある
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub hotkey: String,
    /// 下書きウィンドウの操作を呼ぶキー（draft_keys.rs）
    pub text_window_keys: DraftKeys,
    /// 設定ファイルに書いてなかった操作のうち、既定のキーが重なって起動時に黙って外したもの。設定ファイルには書かない。
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
    /// 下書きの履歴の件数。0 なら覚えず、履歴本文は app_local_data_dir/history.json に書かない
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
    /// 同じアカウントで見つけた自分のデバイス
    pub devices: Vec<Device>,
    /// 下書きの入力欄に出す案内。None なら既定の案内（画面側で今の言語とホットキーから作る）、空文字なら出さない。
    /// 既定のままのときは、設定ファイルに書かない
    pub input_guidance: Option<String>,
    /// AI のアクションに使う AI サービス
    pub ai_service: AiService,
    /// 送る内容と扱いを了解した AI サービス。AI サービスを替えたら了解を取り直す
    pub ai_consent: Option<AiService>,
    /// AI サービスごとのモデル。書いていないサービスは既定のモデルを使う。空文字は持たない
    pub ai_models: BTreeMap<AiService, String>,
    /// アクションの並び。None なら既定のアクション（今の表示言語のもの、actions::default_actions）、空の並びならアクションなし
    pub actions: Option<Vec<Action>>,
}

impl Config {
    /// AI が使えるか。サービス・キー・了解の記録がそろっていること。キーが未確認なら使えるものとして扱う
    pub fn ai_available(&self, key_available: Option<bool>) -> bool {
        self.ai_service != AiService::None
            && key_available != Some(false)
            && self.ai_consent == Some(self.ai_service)
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
/// 小さすぎて読めない値や、大きすぎて1文字も入らない値を、設定ファイルを直接編集して入れられないようにする
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
            language: Language::default(),
            theme: Theme::default(),
            text_window_always_on_top: true,
            hide_text_window_on_blur: true,
            show_text_window_buttons: true,
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
            devices: Vec::new(),
            input_guidance: None,
            ai_service: AiService::default(),
            ai_consent: None,
            ai_models: BTreeMap::new(),
            actions: None,
        }
    }
}

/// 設定ファイルをそのまま読めなかった理由
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadProblem {
    /// ファイルを読めない、TOML として解釈できない、またはファイルがなくて作れない。設定全体を既定値にした
    Unreadable(String),
    /// 型の合わない項目を既定値に直して読み進めた。設定ファイルでの項目名（`theme`、`replacements[3]` など）を読んだ順に持つ
    Repaired(Vec<String>),
}

/// 設定ファイルでの項目名。読み込み（`parse`）と書き出し（`apply`）で同じ名前を使う
mod key {
    pub const HOTKEY: &str = "hotkey";
    pub const TEXT_WINDOW_KEYS: &str = "text_window_keys";
    pub const AUTOSTART: &str = "autostart";
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
    pub const DEVICES: &str = "devices";
    pub const INPUT_GUIDANCE: &str = "input_guidance";
    pub const AI_SERVICE: &str = "ai_service";
    pub const AI_CONSENT: &str = "ai_consent";
    pub const AI_MODELS: &str = "ai_models";
    pub const ACTIONS: &str = "actions";
}

/// 項目を1つずつ読み、読めなかった項目の名前を集める
struct Reader {
    table: Table,
    repaired: Vec<String>,
}

impl Reader {
    /// 項目があれば `convert` で読む。読めなければ既定値のまま残し、項目名を控える
    fn read_with<T>(
        &mut self,
        key: &str,
        target: &mut T,
        convert: impl FnOnce(&Item) -> Option<T>,
    ) {
        let Some(item) = self.table.remove(key) else {
            return;
        };
        match convert(&item) {
            Some(value) => *target = value,
            None => self.repaired.push(key.to_string()),
        }
    }

    fn read_str(&mut self, key: &str, target: &mut String) {
        self.read_with(key, target, |item| item.as_str().map(str::to_string));
    }

    fn read_bool(&mut self, key: &str, target: &mut bool) {
        self.read_with(key, target, Item::as_bool);
    }

    /// AI サービスごとのモデルの表。知らない AI サービスは読み飛ばしてログにだけ出し、文字列でない値はそのサービスだけ既定に戻す。
    /// 空文字は既定のモデルと同じ扱いにする
    fn read_ai_models(&mut self, target: &mut BTreeMap<AiService, String>) {
        let Some(item) = self.table.remove(key::AI_MODELS) else {
            return;
        };
        let Some(table) = item.as_table_like() else {
            self.repaired.push(key::AI_MODELS.to_string());
            return;
        };
        for (name, value) in table.iter() {
            let Some(service) = AiService::from_name(name) else {
                log::info!(
                    "ignored an unknown AI service in {}: {name}",
                    key::AI_MODELS
                );
                continue;
            };
            match value.as_str() {
                Some("") => {}
                Some(model) => {
                    target.insert(service, model.to_string());
                }
                None => self.repaired.push(format!("{}.{name}", key::AI_MODELS)),
            }
        }
    }

    /// 選択肢の項目。書き方は画面とのやり取りと同じ名前（`dark`、`kutouten` など）
    fn read_choice<T: DeserializeOwned>(&mut self, key: &str, target: &mut T) {
        self.read_with(key, target, |item| {
            let name = item.as_str()?;
            let deserializer: StrDeserializer<'_, serde::de::value::Error> =
                name.into_deserializer();
            T::deserialize(deserializer).ok()
        });
    }

    /// 置き換え辞書や定型文のような行の並びは、型の合わない行だけを読み飛ばす。1行の書き間違いで全体を失わないようにする。
    /// 並びは `[[replacements]]` の表の並びでも、`replacements = [{ … }]` のインラインの配列でも読む
    fn read_rows<T: Row>(&mut self, key: &str, target: &mut Vec<T>) {
        let Some(item) = self.table.remove(key) else {
            return;
        };
        let Some(rows) = rows(&item) else {
            self.repaired.push(key.to_string());
            return;
        };
        *target = rows
            .into_iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let read = row.and_then(T::read);
                if read.is_none() {
                    self.repaired.push(format!("{key}[{index}]"));
                }
                read
            })
            .collect();
    }
}

/// 並びの行。行が表でなければ None
fn rows(item: &Item) -> Option<Vec<Option<&dyn TableLike>>> {
    match item {
        Item::ArrayOfTables(tables) => Some(
            tables
                .iter()
                .map(|table| Some(table as &dyn TableLike))
                .collect(),
        ),
        Item::Value(Value::Array(values)) => Some(
            values
                .iter()
                .map(|value| value.as_inline_table().map(|table| table as &dyn TableLike))
                .collect(),
        ),
        _ => None,
    }
}

/// 並びの1行（置き換え辞書・定型文・アクション・見つけたデバイス）
trait Row: Sized + PartialEq {
    /// 行を読む。省いた項目は既定値として読み、型の合わない項目があれば None
    fn read(table: &dyn TableLike) -> Option<Self>;
    /// 書き出す項目。行はすべての項目を書く（手で直すときに、どの項目があるか分かるように）
    fn fields(&self) -> Vec<(&'static str, Value)>;
}

/// 行の文字列の項目。省いていれば既定値
fn text_field(table: &dyn TableLike, name: &str, default: String) -> Option<String> {
    match table.get(name) {
        None => Some(default),
        Some(item) => item.as_str().map(str::to_string),
    }
}

/// 同期の行の ID は、文字列でなければ空と同じく新しく振り直す。
///
/// ほかの列まで正しければ、その行を丸ごと捨てずに同期へ移れるようにする。
fn item_id_field(table: &dyn TableLike) -> String {
    table
        .get("id")
        .and_then(Item::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 行の真偽値の項目。省いていれば既定値
fn bool_field(table: &dyn TableLike, name: &str, default: bool) -> Option<bool> {
    match table.get(name) {
        None => Some(default),
        Some(item) => item.as_bool(),
    }
}

fn valid_item_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn new_item_id() -> Result<String, String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("random item id: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn repair_item_ids<T>(
    items: &mut [T],
    id: impl Fn(&T) -> &str,
    set_id: impl Fn(&mut T, String),
) -> Result<bool, String> {
    let mut seen = std::collections::HashSet::new();
    let mut changed = false;
    for item in items {
        let item_id = id(item);
        if !valid_item_id(item_id) || !seen.insert(item_id.to_string()) {
            let next = loop {
                let next = new_item_id()?;
                if seen.insert(next.clone()) {
                    break next;
                }
            };
            set_id(item, next);
            changed = true;
        }
    }
    Ok(changed)
}

/// 空・不正・重複の ID を、種類ごとに新しいランダムな値へ替える。
///
/// 画面から足した行もこの入口を通るので、ID は Rust 側だけで作る。
pub fn repair_item_ids_in_config(config: &mut Config) -> Result<bool, String> {
    let replacements = repair_item_ids(
        &mut config.replacements,
        |item| &item.id,
        |item, id| item.id = id,
    )?;
    let snippets = repair_item_ids(
        &mut config.snippets,
        |item| &item.id,
        |item, id| item.id = id,
    )?;
    let actions = match &mut config.actions {
        Some(actions) => repair_item_ids(actions, |item| &item.id, |item, id| item.id = id)?,
        None => false,
    };
    Ok(replacements || snippets || actions)
}

impl Row for Replacement {
    fn read(table: &dyn TableLike) -> Option<Self> {
        let default = Replacement::default();
        Some(Self {
            id: item_id_field(table),
            from: text_field(table, "from", default.from)?,
            to: text_field(table, "to", default.to)?,
            enabled: bool_field(table, "enabled", default.enabled)?,
            sync: bool_field(table, "sync", default.sync)?,
        })
    }

    fn fields(&self) -> Vec<(&'static str, Value)> {
        vec![
            ("id", Value::from(self.id.clone())),
            ("from", Value::from(self.from.clone())),
            ("to", Value::from(self.to.clone())),
            ("enabled", Value::from(self.enabled)),
            ("sync", Value::from(self.sync)),
        ]
    }
}

impl Row for Snippet {
    fn read(table: &dyn TableLike) -> Option<Self> {
        Some(Self {
            id: item_id_field(table),
            name: text_field(table, "name", String::new())?,
            body: text_field(table, "body", String::new())?,
            sync: bool_field(table, "sync", true)?,
        })
    }

    fn fields(&self) -> Vec<(&'static str, Value)> {
        vec![
            ("id", Value::from(self.id.clone())),
            ("name", Value::from(self.name.clone())),
            ("body", Value::from(self.body.clone())),
            ("sync", Value::from(self.sync)),
        ]
    }
}

impl Row for Action {
    /// 知らない出し方や文字コードの行は、型の合わない行として読み飛ばす
    fn read(table: &dyn TableLike) -> Option<Self> {
        let output = match table.get("output") {
            None => ActionOutput::default(),
            Some(item) => ActionOutput::from_name(item.as_str()?)?,
        };
        let encoding = match table.get("encoding") {
            None => ActionEncoding::default(),
            Some(item) => ActionEncoding::from_name(item.as_str()?)?,
        };
        Some(Self {
            id: item_id_field(table),
            name: text_field(table, "name", String::new())?,
            command: text_field(table, "command", String::new())?,
            output,
            encoding,
            enabled: bool_field(table, "enabled", true)?,
            sync: bool_field(table, "sync", true)?,
        })
    }

    fn fields(&self) -> Vec<(&'static str, Value)> {
        vec![
            ("id", Value::from(self.id.clone())),
            ("name", Value::from(self.name.clone())),
            ("command", Value::from(self.command.clone())),
            ("output", Value::from(self.output.name().to_string())),
            ("encoding", Value::from(self.encoding.name().to_string())),
            ("enabled", Value::from(self.enabled)),
            ("sync", Value::from(self.sync)),
        ]
    }
}

impl Row for Device {
    fn read(table: &dyn TableLike) -> Option<Self> {
        let default = Device::default();
        Some(Self {
            name: text_field(table, "name", default.name)?,
            public_key: text_field(table, "public_key", default.public_key)?,
            address: text_field(table, "address", default.address)?,
            send_to: bool_field(table, "send_to", default.send_to)?,
        })
    }

    fn fields(&self) -> Vec<(&'static str, Value)> {
        vec![
            ("name", Value::from(self.name.clone())),
            ("public_key", Value::from(self.public_key.clone())),
            ("address", Value::from(self.address.clone())),
            ("send_to", Value::from(self.send_to)),
        ]
    }
}

/// 数の項目。TOML では整数と小数が別の型なので、どちらも数として読む
fn number(item: &Item) -> Option<f64> {
    item.as_integer()
        .map(|number| number as f64)
        .or_else(|| item.as_float())
        .filter(|number| number.is_finite())
}

/// 文字の大きさ。数でなければ読めない値とする。範囲の外や小数は値としては読めるので、知らせずに範囲内の整数へ収める
fn font_size(item: &Item) -> Option<u16> {
    number(item).map(|size| {
        size.round()
            .clamp(MIN_DRAFT_FONT_SIZE as f64, MAX_DRAFT_FONT_SIZE as f64) as u16
    })
}

/// 履歴の件数。数でないか負の数なら読めない値とする。負の数は打ち間違いとみて、0（履歴を使わず、ディスクの履歴も消す）には収めない。
/// 上限を超える値や小数は、文字の大きさと同じく知らせずに範囲内の整数へ収める
fn history_size(item: &Item) -> Option<u16> {
    number(item)
        .filter(|size| !size.is_sign_negative())
        .map(|size| size.round().min(MAX_DRAFT_HISTORY_SIZE as f64) as u16)
}

/// TOML として読めなかった理由を1行にする（トレイに出すため）。行と桁は1から数える
fn describe_parse_error(text: &str, error: &TomlError) -> String {
    let message = error.message().trim();
    let Some(before) = error.span().and_then(|span| text.get(..span.start)) else {
        return message.to_string();
    };
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    format!("line {line}, column {column}: {message}")
}

/// 設定ファイルの中身を読む。型の合わない項目は既定値のまま読み進め、その項目名を返す。
/// TOML として読めなければ Err。知らない項目は読み飛ばし、ログにだけ出す
fn parse(text: &str) -> Result<(Config, Vec<String>, bool), String> {
    let document: DocumentMut = text
        .parse()
        .map_err(|error| describe_parse_error(text, &error))?;
    let mut reader = Reader {
        table: document.into_table(),
        repaired: Vec::new(),
    };
    let mut config = Config::default();
    reader.read_str(key::HOTKEY, &mut config.hotkey);
    reader.read_bool(key::AUTOSTART, &mut config.autostart);
    reader.read_choice(key::LANGUAGE, &mut config.language);
    reader.read_choice(key::THEME, &mut config.theme);
    reader.read_bool(
        key::TEXT_WINDOW_ALWAYS_ON_TOP,
        &mut config.text_window_always_on_top,
    );
    reader.read_bool(
        key::HIDE_TEXT_WINDOW_ON_BLUR,
        &mut config.hide_text_window_on_blur,
    );
    reader.read_bool(
        key::SHOW_TEXT_WINDOW_BUTTONS,
        &mut config.show_text_window_buttons,
    );
    reader.read_with(
        key::TEXT_HISTORY_SIZE,
        &mut config.text_history_size,
        history_size,
    );
    reader.read_bool(
        key::TRIM_TRAILING_WHITESPACE,
        &mut config.trim_trailing_whitespace,
    );
    reader.read_rows(key::REPLACEMENTS, &mut config.replacements);
    reader.read_rows(key::SNIPPETS, &mut config.snippets);
    reader.read_choice(key::PUNCTUATION_STYLE, &mut config.punctuation_style);
    reader.read_choice(key::ALPHABET_WIDTH, &mut config.char_widths.alphabet);
    reader.read_choice(key::DIGIT_WIDTH, &mut config.char_widths.digit);
    reader.read_choice(key::SPACE_WIDTH, &mut config.char_widths.space);
    reader.read_choice(key::SYMBOL_WIDTH, &mut config.char_widths.symbol);
    reader.read_choice(key::KATAKANA_WIDTH, &mut config.char_widths.katakana);
    reader.read_bool(
        key::EXCLUDE_FROM_CLIPBOARD_HISTORY,
        &mut config.exclude_from_clipboard_history,
    );
    reader.read_str(key::TEXT_FONT_FAMILY, &mut config.text_font_family);
    reader.read_with(key::TEXT_FONT_SIZE, &mut config.text_font_size, font_size);
    reader.read_with(
        key::TEXT_COLOR_LIGHT,
        &mut config.text_color_light,
        |item| item.as_str().and_then(normalize_text_color),
    );
    reader.read_with(key::TEXT_COLOR_DARK, &mut config.text_color_dark, |item| {
        item.as_str().and_then(normalize_text_color)
    });
    // 項目がなければ既定の案内。TOML には null がないので、既定に戻すときは項目を消す
    reader.read_with(key::INPUT_GUIDANCE, &mut config.input_guidance, |item| {
        item.as_str().map(|text| Some(text.to_string()))
    });
    reader.read_rows(key::DEVICES, &mut config.devices);
    // 知らない AI サービスの名前は、型の合わない値と同じく既定に戻す
    reader.read_with(key::AI_SERVICE, &mut config.ai_service, |item| {
        item.as_str().and_then(AiService::from_name)
    });
    reader.read_with(key::AI_CONSENT, &mut config.ai_consent, |item| {
        item.as_str().and_then(AiService::from_name).map(Some)
    });
    reader.read_ai_models(&mut config.ai_models);
    // 項目がなければ既定のアクション。空の並び（`actions = []`）は、利用者が全部消したものとして空のまま
    if reader.table.contains_key(key::ACTIONS) {
        let mut actions = Vec::new();
        let before = reader.repaired.len();
        reader.read_rows(key::ACTIONS, &mut actions);
        // 並びでない値（`actions = "…"` など）は、既定のアクションに戻す
        let not_rows = reader.repaired[before..]
            .iter()
            .any(|name| name == key::ACTIONS);
        config.actions = (!not_rows).then_some(actions);
    }
    let platform = Platform::current();
    let parsed = draft_keys::parse(
        reader.table.remove(key::TEXT_WINDOW_KEYS).as_ref(),
        platform,
    );
    config.text_window_keys = parsed.keys;
    reader.repaired.extend(parsed.repaired);
    // ホットキーを読んでから見る。重なったキーは、ホットキーと先の操作に残す
    let resolved = draft_keys::resolve_conflicts(
        &mut config.text_window_keys,
        &config.hotkey,
        platform,
        &parsed.written,
    );
    reader.repaired.extend(resolved.removed);
    config.yielded_draft_keys = resolved.yielded;
    let unknown: Vec<&str> = reader.table.iter().map(|(name, _)| name).collect();
    if !unknown.is_empty() {
        log::info!("ignored unknown settings: {}", unknown.join(", "));
    }
    let repaired_item_ids = repair_item_ids_in_config(&mut config)?;
    Ok((config, reader.repaired, repaired_item_ids))
}

/// 選択肢の名前。serde の `rename_all` で決めた書き方で、設定ファイルと画面とのやり取りで同じ名前を使う（`read_choice` の逆）
pub fn choice_name<T: Serialize>(choice: &T) -> String {
    serde_json::to_value(choice)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .expect("a choice serializes to a string")
}

/// 同じ値か。書き方（`'…'` と `"…"`、コメント）は見ない
fn same_value(current: &Value, next: &Value) -> bool {
    match (current, next) {
        (Value::String(a), Value::String(b)) => a.value() == b.value(),
        (Value::Integer(a), Value::Integer(b)) => a.value() == b.value(),
        (Value::Float(a), Value::Float(b)) => a.value() == b.value(),
        (Value::Boolean(a), Value::Boolean(b)) => a.value() == b.value(),
        _ => false,
    }
}

/// 値を書く。すでにある項目は、その項目のコメント（前の行と、値の後ろ）と書き方を残して値だけを替える。
/// `Table::insert` や `table[key] = value` は、既にある項目のコメントを消すので使わない
fn set_value(table: &mut dyn TableLike, key: &str, next: Value) {
    if !table.contains_key(key) {
        table.insert(key, Item::Value(next));
        return;
    }
    let item = table.get_mut(key).expect("checked above");
    match item.as_value_mut() {
        Some(current) => {
            if same_value(current, &next) {
                return;
            }
            let decor = current.decor().clone();
            *current = next;
            *current.decor_mut() = decor;
        }
        None => *item = Item::Value(next),
    }
}

/// 1つの項目を、既定値なら消し、そうでなければ書く
fn sync_value(table: &mut Table, key: &str, next: Option<Value>) {
    match next {
        Some(value) => set_value(table, key, value),
        None => {
            table.remove(key);
        }
    }
}

/// 並びを書く。ファイルの行と比べて、先頭と末尾で同じ行はそのまま残し、間の行だけを書き換える。
/// 行ごとの見出しや項目のコメントを、変えていない行では残すため
fn sync_rows<T: Row>(root: &mut Table, key: &str, rows: &[T]) {
    if rows.is_empty() {
        // 空の並びは表の並びとして書けないので、項目ごと消す
        root.remove(key);
        return;
    }
    let as_table = |row: &T| {
        let mut table = Table::new();
        for (name, value) in row.fields() {
            table.insert(name, Item::Value(value));
        }
        table
    };
    if let Some(array) = root
        .get_mut(key)
        .and_then(Item::as_value_mut)
        .and_then(Value::as_array_mut)
    {
        // インラインの配列で書いてあれば、インラインのまま書き換える。
        // 表の並びに書き直すと、キーの前のコメントや配列の中のコメントが消えるため
        sync_inline_rows(array, rows);
        return;
    }
    let Some(tables) = root.get_mut(key).and_then(Item::as_array_of_tables_mut) else {
        // ない、または並びでない値が書いてあった。表の並びとして書く
        let mut tables = ArrayOfTables::new();
        for row in rows {
            tables.push(as_table(row));
        }
        // 置き換えずに消してから足す。`key = [...]` の書き方（キーの後ろの空白）が `[[key ]]` に残るため
        root.remove(key);
        root.insert(key, Item::ArrayOfTables(tables));
        return;
    };
    let current: Vec<Option<T>> = tables
        .iter()
        .map(|table| T::read(table as &dyn TableLike))
        .collect();
    let RowDiff {
        prefix,
        common,
        current_middle,
        next_middle,
    } = RowDiff::new(&current, rows);
    for offset in 0..common {
        let table = tables
            .get_mut(prefix + offset)
            .expect("the row is within the current rows");
        for (name, value) in rows[prefix + offset].fields() {
            set_value(table, name, value);
        }
    }
    for _ in common..current_middle {
        tables.remove(prefix + common);
    }
    for offset in common..next_middle {
        tables.insert(prefix + offset, as_table(&rows[prefix + offset]));
    }
    place_new_rows(tables);
}

/// 今の行と書く行の違い。先頭と末尾で同じ行（`prefix` 行と、末尾の行）は残し、間の行だけを書き換える
struct RowDiff {
    /// 先頭で同じ行の数
    prefix: usize,
    /// 間の行のうち、今の行を書き換えて使う数
    common: usize,
    /// 今の行のうち、間の行の数
    current_middle: usize,
    /// 書く行のうち、間の行の数
    next_middle: usize,
}

impl RowDiff {
    fn new<T: PartialEq>(current: &[Option<T>], rows: &[T]) -> Self {
        let shorter = current.len().min(rows.len());
        let prefix = (0..shorter)
            .take_while(|&index| current[index].as_ref() == Some(&rows[index]))
            .count();
        let suffix = (0..shorter - prefix)
            .take_while(|&offset| {
                current[current.len() - 1 - offset].as_ref() == Some(&rows[rows.len() - 1 - offset])
            })
            .count();
        let current_middle = current.len() - prefix - suffix;
        let next_middle = rows.len() - prefix - suffix;
        Self {
            prefix,
            common: current_middle.min(next_middle),
            current_middle,
            next_middle,
        }
    }
}

/// インラインの配列で書いた並びを、インラインのまま書き換える。表の並びと同じく、変えていない行はそのまま残す
fn sync_inline_rows<T: Row>(array: &mut Array, rows: &[T]) {
    let as_inline_table = |row: &T| {
        let mut table = InlineTable::new();
        for (name, value) in row.fields() {
            table.insert(name, value);
        }
        Value::InlineTable(table)
    };
    let current: Vec<Option<T>> = array
        .iter()
        .map(|value| {
            value
                .as_inline_table()
                .and_then(|table| T::read(table as &dyn TableLike))
        })
        .collect();
    let RowDiff {
        prefix,
        common,
        current_middle,
        next_middle,
    } = RowDiff::new(&current, rows);
    for offset in 0..common {
        let index = prefix + offset;
        let row = &rows[index];
        let value = array
            .get_mut(index)
            .expect("the row is within the current rows");
        match value.as_inline_table_mut() {
            Some(table) => {
                for (name, field) in row.fields() {
                    set_value(table, name, field);
                }
            }
            // 表でない行（読み飛ばした行）は、行の前後の書き方を残して表に替える
            None => {
                let decor = value.decor().clone();
                *value = as_inline_table(row);
                *value.decor_mut() = decor;
            }
        }
    }
    for _ in common..current_middle {
        array.remove(prefix + common);
    }
    for offset in common..next_middle {
        insert_inline_row(
            array,
            prefix + offset,
            as_inline_table(&rows[prefix + offset]),
        );
    }
}

/// インラインの配列に行を足す。隣の行のコメントは写さず、字下げだけを揃える
/// （隣の行が行を分けて書いてあれば改行と同じ字下げ、1行に並べてあれば空白1つ）
fn insert_inline_row(array: &mut Array, index: usize, mut value: Value) {
    let neighbor = array
        .get(index.saturating_sub(1))
        .or_else(|| array.get(index));
    let multiline_indent = neighbor
        .and_then(|neighbor| neighbor.decor().prefix())
        .and_then(|prefix| prefix.as_str())
        .and_then(|prefix| prefix.rfind('\n').map(|at| prefix[at..].to_string()));
    match (&multiline_indent, index) {
        (Some(indent), _) => value.decor_mut().set_prefix(indent.clone()),
        (None, 0) => {
            // 1行の配列の先頭に足す。元の先頭の行は2つ目になるので、前に空白を空ける
            value.decor_mut().set_prefix("");
            if let Some(first) = array.get_mut(0) {
                if first.decor().prefix().and_then(|p| p.as_str()) == Some("") {
                    first.decor_mut().set_prefix(" ");
                }
            }
        }
        (None, _) => value.decor_mut().set_prefix(" "),
    }
    value.decor_mut().set_suffix("");
    if index == array.len() && index > 0 {
        // 末尾に足す。元の最後の行の後ろの改行（`]` の前の改行）は、配列の後ろへ移す。
        // 行の後ろに残すと、足した行の前のカンマが1行だけの行に出る
        let last = array.get_mut(index - 1).expect("the array is not empty");
        let suffix = last
            .decor()
            .suffix()
            .and_then(|suffix| suffix.as_str())
            .unwrap_or("")
            .to_string();
        if suffix.contains('\n') {
            last.decor_mut().set_suffix("");
            let trailing = array.trailing().as_str().unwrap_or("").to_string();
            array.set_trailing(format!("{suffix}{trailing}"));
        }
    }
    array.insert_formatted(index, value);
}

/// 足した行に、書き出す位置を与える。toml_edit は位置のない表を、直前に訪ねた表（別の並びのこともある）の位置で
/// 書き出すので、並びが別の並びの表で分断されているファイルでは、先頭に足した行が並びの順から外れて出る。
/// 前の行と同じ位置（先頭なら、後ろで最初に位置のある行と同じ位置）を与える。
/// 同じ位置どうしは訪ねた順（並びの順）に出るので、並びの順が保たれる
fn place_new_rows(tables: &mut ArrayOfTables) {
    let positions: Vec<Option<isize>> = tables.iter().map(Table::position).collect();
    let mut previous = None;
    for (index, table) in tables.iter_mut().enumerate() {
        let position = positions[index]
            .or(previous)
            .or_else(|| positions[index..].iter().flatten().next().copied());
        if positions[index].is_none() && position.is_some() {
            table.set_position(position);
        }
        previous = position;
    }
}

/// 名前ごとの値の表（`[text_window_keys]` や `[ai_models]`）を書く。`written` は書く名前と値で、`names` のうち
/// `written` にない名前の行は消す。`names` にない名前の行は残す（新しい版で足した名前を、古い版で消さないため）。
/// 表が空になったら表ごと消す
fn sync_subtable(root: &mut Table, key: &str, names: &[&str], written: &[(&str, String)]) {
    let table_like = root
        .get(key)
        .is_some_and(|item| item.as_table_like().is_some());
    if !table_like {
        // 置き換えずに消してから足す。`key = …` の書き方（キーの後ろの空白）が `[key ]` に残るため
        root.remove(key);
        if written.is_empty() {
            return;
        }
        let mut table = Table::new();
        for (name, value) in written {
            table.insert(name, Item::Value(Value::from(value.clone())));
        }
        root.insert(key, Item::Table(table));
        return;
    }
    let table = root
        .get_mut(key)
        .and_then(Item::as_table_like_mut)
        .expect("checked above");
    for &name in names {
        match written.iter().find(|(written, _)| *written == name) {
            Some((_, value)) => set_value(table, name, Value::from(value.clone())),
            None => {
                table.remove(name);
            }
        }
    }
    if table.is_empty() {
        root.remove(key);
    }
}

/// 下書きウィンドウのキーを書く。既定のキーの操作と、起動時に黙って外したまま（`yielded`）の操作は書かない
/// （書いていない操作は既定のキーを使う）
fn sync_draft_keys(root: &mut Table, keys: &DraftKeys, yielded: &[DraftAction]) {
    let defaults = DraftKeys::default();
    let written: Vec<(&str, String)> = DraftAction::ALL
        .into_iter()
        .filter(|&action| keys.get(action) != defaults.get(action))
        .filter(|action| !(yielded.contains(action) && keys.get(*action).is_empty()))
        .map(|action| (action.name(), keys.get(action).to_string()))
        .collect();
    let names = DraftAction::ALL.map(DraftAction::name);
    sync_subtable(root, key::TEXT_WINDOW_KEYS, &names, &written);
}

/// 空の並びも書く並び（アクション。項目がないのは既定、空の並びはアクションなし、と分けるため）。
/// 空なら `key = []` にする。インラインの配列で書いてあれば、その書き方のまま行を消す
fn sync_rows_keeping_empty<T: Row>(root: &mut Table, key: &str, rows: &[T]) {
    if !rows.is_empty() {
        sync_rows(root, key, rows);
        return;
    }
    if let Some(array) = root
        .get_mut(key)
        .and_then(Item::as_value_mut)
        .and_then(Value::as_array_mut)
    {
        sync_inline_rows(array, rows);
        return;
    }
    // 置き換えずに消してから足す。表の並びの見出しの書き方が残らないようにする
    root.remove(key);
    root.insert(key, Item::Value(Value::Array(Array::new())));
}

/// AI サービスごとのモデルの表を書く。既定のモデルと同じものは書かない
fn sync_ai_models(root: &mut Table, models: &BTreeMap<AiService, String>) {
    let written: Vec<(&str, String)> = models
        .iter()
        .filter(|(service, model)| !model.is_empty() && model.as_str() != service.default_model())
        .map(|(service, model)| (service.name(), model.clone()))
        .collect();
    let names = AiService::ALL.map(AiService::name);
    sync_subtable(root, key::AI_MODELS, &names, &written);
}

/// 書き出すときに、どの項目を書き直すか
enum Changes<'a> {
    /// すべての項目（新しく書くとき）
    All,
    /// `old` から変わった項目と、起動時に型を直した項目（`repaired`）
    Since {
        old: &'a Config,
        repaired: &'a [String],
    },
}

impl Changes<'_> {
    /// `differs` は、保存する前の設定と比べて変わったか
    fn includes(&self, key: &str, differs: impl Fn(&Config) -> bool) -> bool {
        match self {
            Changes::All => true,
            Changes::Since { old, repaired } => {
                differs(old)
                    || repaired
                        .iter()
                        .any(|name| name.split(['.', '[']).next() == Some(key))
            }
        }
    }
}

/// 設定を文書に当てる。書き直す項目は、既定値なら消し、そうでなければ書く
fn apply(root: &mut Table, config: &Config, changes: &Changes<'_>) {
    let defaults = Config::default();
    macro_rules! scalar {
        ($key:expr, $($field:ident).+, $to_value:expr) => {
            if changes.includes($key, |old| old.$($field).+ != config.$($field).+) {
                let next = (config.$($field).+ != defaults.$($field).+)
                    .then(|| $to_value(&config.$($field).+));
                sync_value(root, $key, next);
            }
        };
    }
    scalar!(key::HOTKEY, hotkey, |v: &String| Value::from(v.clone()));
    scalar!(key::AUTOSTART, autostart, |v: &bool| Value::from(*v));
    scalar!(key::LANGUAGE, language, |v: &Language| Value::from(
        choice_name(v)
    ));
    scalar!(key::THEME, theme, |v: &Theme| Value::from(choice_name(v)));
    scalar!(
        key::TEXT_WINDOW_ALWAYS_ON_TOP,
        text_window_always_on_top,
        |v: &bool| { Value::from(*v) }
    );
    scalar!(
        key::HIDE_TEXT_WINDOW_ON_BLUR,
        hide_text_window_on_blur,
        |v: &bool| { Value::from(*v) }
    );
    scalar!(
        key::SHOW_TEXT_WINDOW_BUTTONS,
        show_text_window_buttons,
        |v: &bool| { Value::from(*v) }
    );
    scalar!(key::TEXT_HISTORY_SIZE, text_history_size, |v: &u16| {
        Value::from(i64::from(*v))
    });
    scalar!(
        key::TRIM_TRAILING_WHITESPACE,
        trim_trailing_whitespace,
        |v: &bool| Value::from(*v)
    );
    scalar!(
        key::PUNCTUATION_STYLE,
        punctuation_style,
        |v: &PunctuationStyle| Value::from(choice_name(v))
    );
    let width = |v: &WidthStyle| Value::from(choice_name(v));
    scalar!(key::ALPHABET_WIDTH, char_widths.alphabet, width);
    scalar!(key::DIGIT_WIDTH, char_widths.digit, width);
    scalar!(key::SPACE_WIDTH, char_widths.space, width);
    scalar!(key::SYMBOL_WIDTH, char_widths.symbol, width);
    scalar!(
        key::KATAKANA_WIDTH,
        char_widths.katakana,
        |v: &KatakanaWidth| Value::from(choice_name(v))
    );
    scalar!(
        key::EXCLUDE_FROM_CLIPBOARD_HISTORY,
        exclude_from_clipboard_history,
        |v: &bool| Value::from(*v)
    );
    scalar!(key::TEXT_FONT_FAMILY, text_font_family, |v: &String| {
        Value::from(v.clone())
    });
    scalar!(key::TEXT_FONT_SIZE, text_font_size, |v: &u16| Value::from(
        i64::from(*v)
    ));
    scalar!(key::TEXT_COLOR_LIGHT, text_color_light, |v: &String| {
        Value::from(v.clone())
    });
    scalar!(key::TEXT_COLOR_DARK, text_color_dark, |v: &String| {
        Value::from(v.clone())
    });
    if changes.includes(key::INPUT_GUIDANCE, |old| {
        old.input_guidance != config.input_guidance
    }) {
        sync_value(
            root,
            key::INPUT_GUIDANCE,
            config.input_guidance.clone().map(Value::from),
        );
    }
    // 黙って外した操作に割り当てなしを選び直したときは、キーは変わらず、黙って外した扱いだけが変わる
    if changes.includes(key::TEXT_WINDOW_KEYS, |old| {
        old.text_window_keys != config.text_window_keys
            || old.yielded_draft_keys != config.yielded_draft_keys
    }) {
        sync_draft_keys(root, &config.text_window_keys, &config.yielded_draft_keys);
    }
    if changes.includes(key::REPLACEMENTS, |old| {
        old.replacements != config.replacements
    }) {
        sync_rows(root, key::REPLACEMENTS, &config.replacements);
    }
    if changes.includes(key::SNIPPETS, |old| old.snippets != config.snippets) {
        sync_rows(root, key::SNIPPETS, &config.snippets);
    }
    if changes.includes(key::AI_SERVICE, |old| old.ai_service != config.ai_service) {
        let next = (config.ai_service != defaults.ai_service)
            .then(|| Value::from(config.ai_service.name().to_string()));
        sync_value(root, key::AI_SERVICE, next);
    }
    if changes.includes(key::AI_CONSENT, |old| old.ai_consent != config.ai_consent) {
        sync_value(
            root,
            key::AI_CONSENT,
            config
                .ai_consent
                .map(|service| Value::from(service.name().to_string())),
        );
    }
    if changes.includes(key::AI_MODELS, |old| old.ai_models != config.ai_models) {
        sync_ai_models(root, &config.ai_models);
    }
    if changes.includes(key::ACTIONS, |old| old.actions != config.actions) {
        match &config.actions {
            None => {
                root.remove(key::ACTIONS);
            }
            Some(actions) => sync_rows_keeping_empty(root, key::ACTIONS, actions),
        }
    }
    if changes.includes(key::DEVICES, |old| old.devices != config.devices) {
        sync_rows(root, key::DEVICES, &config.devices);
    }
}

/// 設定を新しいファイルとして書く。既定と違う項目だけを書く
pub fn save(path: &Path, config: &Config) -> io::Result<()> {
    let mut document = DocumentMut::new();
    apply(document.as_table_mut(), config, &Changes::All);
    atomic_file::write(path, document.to_string().as_bytes())
}

/// 読めた行ごとに、振り直した ID だけを書く。ほかの項目の既定値まで足すと、手書きの書式を読み込みだけで変えてしまう。
fn write_repaired_item_ids<T: Row>(
    root: &mut Table,
    key: &str,
    rows: &[T],
    id: impl Fn(&T) -> &str,
) {
    let mut next = rows.iter();
    let Some(item) = root.get_mut(key) else {
        return;
    };
    let mut write = |table: &mut dyn TableLike| {
        if T::read(table).is_none() {
            return;
        }
        let row = next.next().expect("every read row is in the config");
        let id = id(row);
        if item_id_field(table) != id {
            set_value(table, "id", Value::from(id.to_string()));
        }
    };
    match item {
        Item::ArrayOfTables(tables) => {
            for table in tables.iter_mut() {
                write(table);
            }
        }
        Item::Value(Value::Array(array)) => {
            for value in array.iter_mut() {
                if let Some(table) = value.as_inline_table_mut() {
                    write(table);
                }
            }
        }
        _ => {}
    }
}

/// 既存の設定ファイルを読んだ直後に、同期する行へ足した ID だけを書き戻す。
fn save_repaired_item_ids(path: &Path, text: &str, config: &Config) -> io::Result<()> {
    let mut document: DocumentMut = text.parse().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            describe_parse_error(text, &error),
        )
    })?;
    let root = document.as_table_mut();
    write_repaired_item_ids(root, key::REPLACEMENTS, &config.replacements, |row| &row.id);
    write_repaired_item_ids(root, key::SNIPPETS, &config.snippets, |row| &row.id);
    if let Some(actions) = &config.actions {
        write_repaired_item_ids(root, key::ACTIONS, actions, |row| &row.id);
    }
    atomic_file::write(path, document.to_string().as_bytes())
}

/// 設定ファイルを読む。ファイルがなければ既定値で作る。
/// そのまま読めなかった場合は、読めた分（読めなければ既定値）とその理由を返す。
/// 同期する行に足した ID だけは、次の起動でも同じ行を見分けられるよう書き戻す。
pub fn load_or_create(path: &Path) -> (Config, Option<LoadProblem>) {
    let unreadable = |error: &dyn std::fmt::Display| {
        LoadProblem::Unreadable(format!("{}: {error}", path.display()))
    };
    match fs::read_to_string(path) {
        Ok(text) => match parse(&text) {
            Ok((config, repaired, repaired_item_ids)) => {
                if repaired_item_ids {
                    if let Err(error) = save_repaired_item_ids(path, &text, &config) {
                        log::warn!("couldn't save repaired item IDs: {error}");
                    }
                }
                if repaired.is_empty() {
                    (config, None)
                } else {
                    (config, Some(LoadProblem::Repaired(repaired)))
                }
            }
            Err(error) => {
                log::warn!("couldn't parse {}: {error}", path.display());
                (Config::default(), Some(unreadable(&error)))
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let config = Config::default();
            let written = save(path, &config);
            (config, written.err().map(|error| unreadable(&error)))
        }
        Err(error) => (Config::default(), Some(unreadable(&error))),
    }
}

/// 設定ファイルがまだないか（初めての起動か）。`load_or_create` はファイルを作るので、その前に見る。
/// 読めない（権限がないなど）だけのときは、初めての起動とは扱わない
pub fn is_missing(path: &Path) -> bool {
    matches!(fs::metadata(path), Err(error) if error.kind() == io::ErrorKind::NotFound)
}

/// そのまま読めなかったファイルを、上書きする前に同じフォルダーの `<名前>.broken-YYYYMMDD-HHMMSS.<拡張子>` へ写す
/// （設定ファイルなら `config.broken-….toml`、下書きの履歴なら `history.broken-….json`）。
/// 写した先を返す。写す元がなければ何もせず None
pub fn back_up(path: &Path, now: SystemTime) -> io::Result<Option<PathBuf>> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .expect("the file to back up has a stem");
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .expect("the file to back up has an extension");
    let stamp = utc_stamp(now);
    // 同じ秒に写したものがあっても上書きしないよう、あれば番号を付ける
    for attempt in 0.. {
        let name = match attempt {
            0 => format!("{stem}.broken-{stamp}.{extension}"),
            _ => format!("{stem}.broken-{stamp}-{attempt}.{extension}"),
        };
        let target = path.with_file_name(name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        // 写しは持ち主が見るためのもの。下書きの履歴も写すので、unix では所有者だけが読めるようにする
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(&target) {
            Ok(mut file) => {
                // 書きかけの写しを残すと、元の内容が残っているように見えてしまう
                if let Err(error) = file.write_all(&contents) {
                    drop(file);
                    if let Err(remove_error) = fs::remove_file(&target) {
                        log::warn!(
                            "couldn't remove the incomplete backup {}: {remove_error}",
                            target.display()
                        );
                    }
                    return Err(error);
                }
                return Ok(Some(target));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!("the attempts never run out")
}

/// 設定画面から保存するときに、起動時に設定ファイルをどう読めたか
pub enum Loaded<'a> {
    /// 読めた。`old` は今の設定（保存する前）。`repaired` は起動時に型を直した項目で、空でなければ上書きする前に写す
    Read {
        old: &'a Config,
        repaired: &'a [String],
    },
    /// 読めなかった。上書きする前に写し、新しいファイルとして書く
    Unreadable,
}

/// 設定を保存する。保存のたびに設定ファイルを読み直し、変わった項目だけを書き換える。
/// 手で書いたコメントや並び、起動した後に手で直したほかの項目を残すため。
/// 起動時にそのまま読めなかったとき、または読み直したファイルが読めないとき（起動した後に壊されたとき）は、
/// 上書きする前に元のファイルを写す。直した項目の元の値や読めなかった辞書を失わないよう、写せなければ書き込まない。写した先を返す
pub fn save_with_backup(
    path: &Path,
    config: &Config,
    loaded: Loaded<'_>,
    now: SystemTime,
) -> io::Result<Option<PathBuf>> {
    // 生のバイトで読む。UTF-8 でないファイル（Shift_JIS で保存し直したなど）も、読めないファイルとして写してから書き直すため
    let exists = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            log::error!("couldn't read the settings file before saving: {error}");
            return Err(error);
        }
    };
    let document = match (&loaded, exists.as_deref()) {
        (Loaded::Read { .. }, Some(bytes)) => match std::str::from_utf8(bytes) {
            Ok(text) => match text.parse::<DocumentMut>() {
                Ok(document) => Some(document),
                Err(error) => {
                    log::warn!(
                        "the settings file became unreadable, so it will be rewritten: {}",
                        describe_parse_error(text, &error)
                    );
                    None
                }
            },
            Err(error) => {
                log::warn!("the settings file became unreadable, so it will be rewritten: {error}");
                None
            }
        },
        _ => None,
    };
    let back_up_first = match &loaded {
        Loaded::Unreadable => true,
        Loaded::Read { repaired, .. } => {
            !repaired.is_empty() || (exists.is_some() && document.is_none())
        }
    };
    let backed_up = if back_up_first {
        back_up(path, now).inspect_err(|error| {
            log::error!("couldn't back up the settings file: {error}");
        })?
    } else {
        None
    };
    let text = match (document, &loaded) {
        (Some(mut document), Loaded::Read { old, repaired }) => {
            apply(
                document.as_table_mut(),
                config,
                &Changes::Since { old, repaired },
            );
            document.to_string()
        }
        _ => {
            let mut document = DocumentMut::new();
            apply(document.as_table_mut(), config, &Changes::All);
            document.to_string()
        }
    };
    atomic_file::write(path, text.as_bytes()).inspect_err(|error| {
        log::error!("couldn't save the settings: {error}");
        // 保存できなければ元のファイルはそのまま残り、次の保存でまた写す。
        // 写しを消しておかないと、辞書の表のように打つたびに保存する所で、失敗のたびに写しが溜まる
        if let Some(path) = &backed_up {
            if let Err(remove_error) = fs::remove_file(path) {
                log::warn!(
                    "couldn't remove the backup {}: {remove_error}",
                    path.display()
                );
            }
        }
    })?;
    Ok(backed_up)
}

/// UTC の `YYYYMMDD-HHMMSS`。ログの時刻に揃えて UTC にする。日付の計算は Howard Hinnant の civil_from_days
fn utc_stamp(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let (hour, minute, second) = (seconds / 3600 % 24, seconds / 60 % 60, seconds % 60);
    let days = (seconds / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn has_valid_ids(ids: impl IntoIterator<Item = String>) -> bool {
        let ids: Vec<_> = ids.into_iter().collect();
        ids.iter().all(|id| valid_item_id(id))
            && ids.iter().collect::<std::collections::HashSet<_>>().len() == ids.len()
    }

    fn item_id(character: char) -> String {
        character.to_string().repeat(32)
    }

    /// テスト用の設定ファイルの場所。落ちたテストでも一時フォルダーに残さないよう、手放すときにフォルダーごと消す
    struct TempPath(PathBuf);

    impl std::ops::Deref for TempPath {
        type Target = PathBuf;

        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    impl AsRef<Path> for TempPath {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempPath {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    fn temp_path(name: &str) -> TempPath {
        let dir =
            std::env::temp_dir().join(format!("mawok-config-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        TempPath(dir.join(FILE_NAME))
    }

    /// 設定ファイルを置く
    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn repaired(keys: &[&str]) -> Option<LoadProblem> {
        Some(LoadProblem::Repaired(
            keys.iter().map(|key| key.to_string()).collect(),
        ))
    }

    const NOW: SystemTime = UNIX_EPOCH;

    /// 設定画面からの保存と同じく、今の設定を変えて保存する
    fn save_change(path: &Path, change: impl FnOnce(&mut Config)) -> Config {
        let (old, problem) = load_or_create(path);
        assert_eq!(problem, None);
        let mut next = old.clone();
        change(&mut next);
        let loaded = Loaded::Read {
            old: &old,
            repaired: &[],
        };
        assert_eq!(save_with_backup(path, &next, loaded, NOW).unwrap(), None);
        next
    }

    #[test]
    fn reports_problem_when_file_cannot_be_created() {
        // 初めての起動で下書きを出すかは、作れたかどうかで決めるので、作れなかったことを返すのを確かめる
        let path = temp_path("unwritable");
        let parent = path.parent().unwrap();
        // フォルダーを作るはずの場所に同じ名前のファイルを置き、設定ファイルを作れなくする
        fs::write(parent, "").unwrap();
        let (config, problem) = load_or_create(&path);
        let _ = fs::remove_file(parent);
        assert_eq!(config, Config::default());
        assert!(matches!(problem, Some(LoadProblem::Unreadable(_))));
    }

    #[test]
    fn tells_missing_file_until_created() {
        let path = temp_path("first-launch");
        assert!(is_missing(&path));
        let _ = load_or_create(&path);
        assert!(!is_missing(&path));
    }

    #[test]
    fn creates_default_file_when_missing() {
        // 既定と違う値だけを書くので、既定値で作ったファイルは空になる
        let path = temp_path("missing");
        assert_eq!(load_or_create(&path), (Config::default(), None));
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        assert_eq!(load_or_create(&path), (Config::default(), None));
    }

    #[test]
    fn fills_missing_fields_with_defaults() {
        let path = temp_path("partial");
        write(&path, "autostart = false\n");
        let (config, error) = load_or_create(&path);
        assert_eq!(config.hotkey, DEFAULT_HOTKEY);
        assert!(!config.autostart);
        assert!(config.hide_text_window_on_blur);
        assert!(config.show_text_window_buttons);
        assert!(config.trim_trailing_whitespace);
        assert!(config.exclude_from_clipboard_history);
        assert_eq!(config.replacements, Vec::new());
        assert_eq!(error, None);
    }

    #[test]
    fn reads_an_empty_file_as_defaults() {
        let path = temp_path("empty");
        write(&path, "");
        assert_eq!(load_or_create(&path), (Config::default(), None));
    }

    #[test]
    fn ignores_unknown_settings() {
        // 知らない項目はログにだけ出し、トレイには出さない
        let path = temp_path("unknown");
        write(&path, "autostart = false\nno_such_setting = 1\n");
        let (config, error) = load_or_create(&path);
        assert!(!config.autostart);
        assert_eq!(error, None);
    }

    #[test]
    fn reads_draft_keys_and_reports_conflicts() {
        // 読めないキーは既定に戻し、ホットキーと重なったキーは外す。ほかの設定は巻き添えにしない
        let path = temp_path("draft-keys");
        write(
            &path,
            r#"hotkey = "CommandOrControl+Alt+KeyK"
autostart = false

[text_window_keys]
copy = "CommandOrControl+KeyK"
send = 1
snippets = "CommandOrControl+Alt+KeyK"
"#,
        );
        let (config, error) = load_or_create(&path);
        assert!(!config.autostart);
        assert_eq!(config.text_window_keys.copy, "CommandOrControl+KeyK");
        // アクションの一覧の既定のキー（Cmd+K）は、書いたコピーのキーに譲り、知らせない
        assert_eq!(config.text_window_keys.actions, "");
        assert_eq!(config.text_window_keys.send, DraftKeys::default().send);
        assert_eq!(config.text_window_keys.snippets, "");
        assert_eq!(
            error,
            repaired(&["text_window_keys.send", "text_window_keys.snippets"])
        );

        // text_window_keys のない設定ファイルで、ホットキーが既定のキーと重なっても知らせない
        write(&path, "hotkey = \"CommandOrControl+KeyL\"\n");
        let (config, error) = load_or_create(&path);
        assert_eq!(config.text_window_keys.send_targets, "");
        assert_eq!(error, None);
    }

    #[test]
    fn clamps_font_size_out_of_range() {
        // 設定ファイルを直接編集して、読めない大きさを入れられても収める
        let path = temp_path("font-size");
        for (toml, expected) in [
            ("text_font_size = 999", MAX_DRAFT_FONT_SIZE),
            ("text_font_size = -1", MIN_DRAFT_FONT_SIZE),
            ("text_font_size = 16.5", 17),
            ("text_font_size = 24", 24),
        ] {
            write(&path, toml);
            assert_eq!(
                load_or_create(&path),
                (
                    Config {
                        text_font_size: expected,
                        ..Config::default()
                    },
                    None
                ),
                "{toml}"
            );
        }
    }

    #[test]
    fn repairs_broken_draft_font_settings() {
        // 1つの項目の書き間違いで、ホットキーや辞書まで既定値に戻らないようにする
        let path = temp_path("font-broken");
        for (broken, key) in [
            (r#"text_font_size = "大""#, "text_font_size"),
            ("text_font_family = true", "text_font_family"),
            ("text_font_family = 16", "text_font_family"),
        ] {
            write(
                &path,
                &format!("hotkey = \"CommandOrControl+Alt+KeyK\"\n{broken}\n"),
            );
            let (config, error) = load_or_create(&path);
            assert_eq!(config.hotkey, "CommandOrControl+Alt+KeyK", "{broken}");
            assert_eq!(config.text_font_family, "", "{broken}");
            assert_eq!(config.text_font_size, DEFAULT_DRAFT_FONT_SIZE, "{broken}");
            assert_eq!(error, repaired(&[key]), "{broken}");
        }
    }

    #[test]
    fn normalizes_text_color() {
        for (value, expected) in [
            ("#2F4F4F", Some("#2f4f4f")),
            ("#AbC", Some("#aabbcc")),
            ("  #123456 ", Some("#123456")),
            ("\t#abc\r\n", Some("#aabbcc")),
            // 垂直タブは is_ascii_whitespace に含まれないので取り除かない（画面側の正規表現も同じ集合）
            ("\u{0B}#abc", None),
            // ASCII でない空白は取り除かない（画面側の normalizeTextColor と同じ結果にするため）
            ("\u{FEFF}#abc", None),
            ("#abc\u{0085}", None),
            ("\u{3000}#abc", None),
            ("#abc\u{00A0}", None),
            ("", Some("")),
            ("red", None),
            ("123456", None),
            ("#12345", None),
            ("#ggg", None),
            ("#ａｂｃ", None),
        ] {
            assert_eq!(normalize_text_color(value).as_deref(), expected, "{value}");
        }
    }

    #[test]
    fn repairs_broken_text_colors() {
        // 書き間違えた色は、その項目だけ標準の色に戻し、ホットキーや辞書まで巻き添えにしない
        let path = temp_path("text-color");
        write(
            &path,
            "hotkey = \"CommandOrControl+Alt+KeyK\"\ntext_color_light = \"#ABC\"\ntext_color_dark = \"red\"\n",
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(config.hotkey, "CommandOrControl+Alt+KeyK");
        assert_eq!(config.text_color_light, "#aabbcc");
        assert_eq!(config.text_color_dark, "");
        assert_eq!(error, repaired(&["text_color_dark"]));

        write(
            &path,
            "text_color_light = 16\ntext_color_dark = [\"#abc\"]\n",
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(config.text_color_light, "");
        assert_eq!(config.text_color_dark, "");
        assert_eq!(error, repaired(&["text_color_light", "text_color_dark"]));
    }

    #[test]
    fn reads_draft_guidance() {
        let path = temp_path("guidance");
        for (toml, expected) in [
            ("", None),
            (r#"input_guidance = """#, Some("")),
            (r#"input_guidance = "自分用のメモ""#, Some("自分用のメモ")),
        ] {
            write(&path, toml);
            let (config, error) = load_or_create(&path);
            assert_eq!(config.input_guidance.as_deref(), expected, "{toml}");
            assert_eq!(error, None, "{toml}");
        }
    }

    #[test]
    fn repairs_broken_guidance() {
        // 案内の書き間違いで、ホットキーや辞書まで既定値に戻らないようにする
        let path = temp_path("guidance-broken");
        write(
            &path,
            "hotkey = \"CommandOrControl+Alt+KeyK\"\ninput_guidance = 16\n",
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(config.hotkey, "CommandOrControl+Alt+KeyK");
        assert_eq!(config.input_guidance, None);
        assert_eq!(error, repaired(&["input_guidance"]));
    }

    #[test]
    fn repairs_each_mismatched_field_and_keeps_the_rest() {
        // 型の合わない項目だけを既定値にし、辞書などほかの項目は読み進める。設定ファイルは書き換えない
        let path = temp_path("mismatched");
        let toml = r#"hotkey = 1
autostart = "no"
language = "ja"
theme = "blue"
trim_trailing_whitespace = false
punctuation_style = true
exclude_from_clipboard_history = false

[[replacements]]
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"
sync = true
"#;
        write(&path, toml);
        let (config, error) = load_or_create(&path);
        assert_eq!(
            config,
            Config {
                language: Language::Ja,
                trim_trailing_whitespace: false,
                replacements: vec![Replacement {
                    id: item_id('a'),
                    from: "濃度".to_string(),
                    to: "Node.js".to_string(),
                    enabled: true,
                    sync: true,
                }],
                exclude_from_clipboard_history: false,
                ..Config::default()
            }
        );
        assert_eq!(
            error,
            repaired(&["hotkey", "autostart", "theme", "punctuation_style"])
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), toml);
    }

    #[test]
    fn skips_only_broken_replacement_rows() {
        let path = temp_path("replacements-broken");
        write(
            &path,
            r#"replacements = [
    { id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", from = "濃度", to = "Node.js" },
    { from = 1, to = "x" },
    "滑ると",
    { id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", from = "滑ると", to = "svelte", enabled = false },
]
"#,
        );
        let expected = vec![
            Replacement {
                id: item_id('a'),
                from: "濃度".to_string(),
                to: "Node.js".to_string(),
                enabled: true,
                sync: true,
            },
            Replacement {
                id: item_id('b'),
                from: "滑ると".to_string(),
                to: "svelte".to_string(),
                enabled: false,
                sync: true,
            },
        ];
        let (config, error) = load_or_create(&path);
        assert_eq!(config.replacements, expected);
        assert_eq!(error, repaired(&["replacements[1]", "replacements[2]"]));

        // 表の並びでも同じ
        write(
            &path,
            r#"[[replacements]]
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"

[[replacements]]
from = 1
to = "x"

[[replacements]]
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
from = "滑ると"
to = "svelte"
enabled = false
"#,
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(config.replacements, expected);
        assert_eq!(error, repaired(&["replacements[1]"]));

        write(&path, "[replacements]\nfrom = \"濃度\"\n");
        let (config, error) = load_or_create(&path);
        assert_eq!(config.replacements, Vec::new());
        assert_eq!(error, repaired(&["replacements"]));
    }

    #[test]
    fn skips_only_broken_snippet_rows() {
        // 辞書と同じく、型の合わない行だけを読み飛ばす。name か body を省いた行は空として読む
        let path = temp_path("snippets-broken");
        write(
            &path,
            r#"[[snippets]]
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
name = "確認"
body = "一つずつ質問してください。"

[[snippets]]
name = 1
body = "x"

[[snippets]]
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
body = "git status"
"#,
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(
            config.snippets,
            vec![
                Snippet {
                    id: item_id('a'),
                    name: "確認".to_string(),
                    body: "一つずつ質問してください。".to_string(),
                    sync: true,
                },
                Snippet {
                    id: item_id('b'),
                    name: String::new(),
                    body: "git status".to_string(),
                    sync: true,
                },
            ]
        );
        assert_eq!(error, repaired(&["snippets[1]"]));

        write(&path, "snippets = \"git status\"\n");
        let (config, error) = load_or_create(&path);
        assert_eq!(config.snippets, Vec::new());
        assert_eq!(error, repaired(&["snippets"]));
    }

    #[test]
    fn writes_only_values_that_differ_from_defaults() {
        // 版を上げて既定値を変えたときに、変えていない人へ新しい既定値が届くよう、既定のままの項目は書かない
        let path = temp_path("non-default");
        save(
            &path,
            &Config {
                autostart: false,
                ..Config::default()
            },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "autostart = false\n");
    }

    #[test]
    fn reads_draft_history_size() {
        // 設定ファイルを直接編集して上限を超える値や小数を入れられても収める。0 は履歴を使わない値としてそのまま読む
        let path = temp_path("history-size");
        for (toml, expected) in [
            ("", DEFAULT_DRAFT_HISTORY_SIZE),
            ("text_history_size = 0", 0),
            ("text_history_size = 20", 20),
            ("text_history_size = 20.4", 20),
            ("text_history_size = 999", MAX_DRAFT_HISTORY_SIZE),
        ] {
            write(&path, toml);
            let (config, error) = load_or_create(&path);
            assert_eq!(config.text_history_size, expected, "{toml}");
            assert_eq!(error, None, "{toml}");
        }
    }

    #[test]
    fn repairs_broken_draft_history_size() {
        // 件数の書き間違いで、ホットキーや辞書まで既定値に戻らないようにする。
        // 負の数も書き間違いとして既定値に戻す。0 に収めると、起動したときにディスクの履歴を消してしまう
        let path = temp_path("history-size-broken");
        for broken in [r#""50""#, "[]", "true", "-5", "-0.4", "-0.0"] {
            write(
                &path,
                &format!("hotkey = \"CommandOrControl+Alt+KeyK\"\ntext_history_size = {broken}\n"),
            );
            let (config, error) = load_or_create(&path);
            assert_eq!(config.hotkey, "CommandOrControl+Alt+KeyK", "{broken}");
            assert_eq!(
                config.text_history_size, DEFAULT_DRAFT_HISTORY_SIZE,
                "{broken}"
            );
            assert_eq!(error, repaired(&["text_history_size"]), "{broken}");
        }
    }

    #[test]
    fn reads_language_and_theme() {
        let path = temp_path("appearance");
        write(&path, "language = \"ja\"\ntheme = \"dark\"\n");
        let (config, error) = load_or_create(&path);
        assert_eq!(config.language, Language::Ja);
        assert_eq!(config.theme, Theme::Dark);
        assert_eq!(error, None);
    }

    /// 既定値と違う値を、すべての項目に入れた設定
    fn customized() -> Config {
        Config {
            hotkey: "CommandOrControl+Alt+KeyK".to_string(),
            text_window_keys: DraftKeys {
                copy: "CommandOrControl+Shift+KeyJ".to_string(),
                snippets: String::new(),
                history_older: "CommandOrControl+KeyU".to_string(),
                ..DraftKeys::default()
            },
            // 設定ファイルには書かず、読んだときに決まる
            yielded_draft_keys: Vec::new(),
            autostart: false,
            language: Language::En,
            theme: Theme::Light,
            text_window_always_on_top: false,
            hide_text_window_on_blur: false,
            show_text_window_buttons: false,
            text_history_size: 10,
            trim_trailing_whitespace: false,
            replacements: vec![Replacement {
                id: "1".repeat(32),
                from: "濃度".to_string(),
                to: "Node.js".to_string(),
                enabled: false,
                sync: false,
            }],
            snippets: vec![Snippet {
                id: "2".repeat(32),
                name: "確認".to_string(),
                body: "一つずつ質問してください。\n以上です。".to_string(),
                sync: false,
            }],
            punctuation_style: PunctuationStyle::Comma,
            char_widths: CharWidths {
                alphabet: WidthStyle::Half,
                digit: WidthStyle::Full,
                space: WidthStyle::Keep,
                symbol: WidthStyle::Half,
                katakana: KatakanaWidth::Full,
            },
            exclude_from_clipboard_history: false,
            text_font_family: "HackGen Console NF".to_string(),
            text_font_size: 20,
            text_color_light: "#2f4f4f".to_string(),
            text_color_dark: "#e0e0e0".to_string(),
            devices: vec![Device {
                name: "Mac".to_string(),
                public_key: "ab".repeat(32),
                address: "192.168.0.10".to_string(),
                send_to: false,
            }],
            input_guidance: Some("自分用のメモ".to_string()),
            ai_service: AiService::Gemini,
            ai_consent: Some(AiService::Gemini),
            ai_models: BTreeMap::from([(AiService::Gemini, "gemini-3.8-flash".to_string())]),
            actions: Some(vec![
                Action {
                    id: "3".repeat(32),
                    name: "敬語".to_string(),
                    command: "@ai 丁寧に書き直してください。\n書き直した文だけを返してください。"
                        .to_string(),
                    output: ActionOutput::Insert,
                    encoding: ActionEncoding::Utf8,
                    enabled: true,
                    sync: false,
                },
                Action {
                    id: "4".repeat(32),
                    name: "並べ替え".to_string(),
                    command: "sort | uniq".to_string(),
                    output: ActionOutput::None,
                    encoding: ActionEncoding::ShiftJis,
                    enabled: true,
                    sync: false,
                },
            ]),
        }
    }

    #[test]
    fn saved_settings_read_back_the_same() {
        // 読み込みと書き出しは項目名を別々に書いているので、食い違いをここで捕まえる。
        // 既定値のままだと、書き出せていなくても既定値で埋まって往復が通ってしまうので、すべて既定と違う値にする。
        // temp_path はフォルダーを消すので、保存先のフォルダーがない状態から保存する
        let path = temp_path("save");
        let config = customized();
        save(&path, &config).unwrap();
        assert_eq!(load_or_create(&path), (config.clone(), None));

        // 画面から変えた差分として当てても、同じく読み戻せる
        let diffed = temp_path("save-diff");
        save(&diffed, &Config::default()).unwrap();
        assert_eq!(save_change(&diffed, |next| *next = config.clone()), config);
        assert_eq!(load_or_create(&diffed), (config.clone(), None));

        // すべて既定に戻すと、項目はすべて消える
        save_change(&diffed, |next| *next = Config::default());
        assert_eq!(fs::read_to_string(&diffed).unwrap().trim(), "");
    }

    #[test]
    fn writes_multiline_text_as_multiline_strings() {
        // 定型文の本文のような複数行を、\n ではなくそのまま読める形で書く
        let path = temp_path("multiline");
        save(&path, &customized()).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("一つずつ質問してください。\n以上です。"),
            "{text}"
        );
    }

    #[test]
    fn keeps_comments_and_layout_when_saving_a_change() {
        let path = temp_path("keep-comments");
        let original = r#"# 自分用のメモ
theme = 'dark'   # 夜に使うので
hotkey = "CommandOrControl+Alt+KeyK"

# 辞書
[[replacements]]
# よく間違える
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"
sync = true

[[replacements]]
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
from = "滑ると"
to = "svelte"
sync = true
"#;
        write(&path, original);

        save_change(&path, |config| {
            config.hotkey = "CommandOrControl+Alt+KeyL".to_string()
        });

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            original.replace("KeyK", "KeyL"),
            "only the hotkey changes"
        );

        // 値の後ろのコメントと、変えていない項目の書き方（'…'）も残す
        save_change(&path, |config| config.theme = Theme::Light);
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("theme = \"light\"   # 夜に使うので"),
            "{text}"
        );
        assert!(text.starts_with("# 自分用のメモ\n"), "{text}");
    }

    #[test]
    fn keeps_row_order_when_rows_are_split_by_another_list() {
        // 同じ並びの行が、別の並びの表で分断されて書かれていても、足した行は並びの順に出す。
        // 置き換え辞書は、左側が同じ項目では並びで最初のものを使うので、順番が変わると結果が変わる
        let path = temp_path("split-rows");
        write(
            &path,
            r#"[[snippets]]
id = "cccccccccccccccccccccccccccccccc"
name = "1"
body = "a"

[[replacements]]
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "A"
to = "a"

[[snippets]]
id = "dddddddddddddddddddddddddddddddd"
name = "2"
body = "b"

[[replacements]]
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
from = "B"
to = "b"
"#,
        );
        let row = |from: &str| Replacement {
            id: match from {
                "A" => item_id('a'),
                "B" => item_id('b'),
                "X" => item_id('c'),
                "Y" => item_id('d'),
                "Z" => item_id('e'),
                _ => unreachable!(),
            },
            from: from.to_string(),
            to: from.to_lowercase(),
            enabled: true,
            sync: true,
        };
        // 先頭に足す（変えていない後ろの行はそのまま残り、新しい表を先頭に差し込む）
        save_change(&path, |config| config.replacements.insert(0, row("X")));
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(config.replacements, vec![row("X"), row("A"), row("B")]);
        // 間と末尾に足す
        save_change(&path, |config| {
            config.replacements.insert(2, row("Y"));
            config.replacements.push(row("Z"));
        });
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(
            config.replacements,
            vec![row("X"), row("A"), row("Y"), row("B"), row("Z")]
        );
        let text = fs::read_to_string(&path).unwrap();
        let at = |from: &str| text.find(&format!("from = \"{from}\"")).unwrap();
        assert!(
            at("X") < at("A") && at("A") < at("Y") && at("Y") < at("B") && at("B") < at("Z"),
            "{text}"
        );
        // 分断していた定型文もそのまま読める
        assert_eq!(config.snippets.len(), 2);
    }

    #[test]
    fn treats_a_file_that_is_not_utf8_as_unreadable() {
        // Shift_JIS などで保存されたファイル。起動時は読めない扱いにし、設定画面から保存したら写してから新しく書く
        let path = temp_path("not-utf8");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        let shift_jis: &[u8] = b"theme = \"\x83e\x81[\x83}\"\n";
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, shift_jis).unwrap();

        let (config, problem) = load_or_create(&path);
        assert_eq!(config, Config::default());
        assert!(
            matches!(problem, Some(LoadProblem::Unreadable(_))),
            "{problem:?}"
        );
        assert_eq!(fs::read(&path).unwrap(), shift_jis);

        let next = Config {
            autostart: false,
            ..Config::default()
        };
        let backed_up = save_with_backup(&path, &next, Loaded::Unreadable, now).unwrap();
        assert_eq!(fs::read(backed_up.unwrap()).unwrap(), shift_jis);
        assert_eq!(load_or_create(&path), (next.clone(), None));

        // 起動したときは読めたが、その後に UTF-8 でない内容で保存し直された
        fs::write(&path, shift_jis).unwrap();
        let later = Config {
            theme: Theme::Dark,
            ..next.clone()
        };
        let loaded = Loaded::Read {
            old: &next,
            repaired: &[],
        };
        let backed_up = save_with_backup(&path, &later, loaded, now).unwrap();
        assert_eq!(fs::read(backed_up.unwrap()).unwrap(), shift_jis);
        assert_eq!(load_or_create(&path), (later, None));
    }

    #[test]
    fn keeps_comments_of_unchanged_rows() {
        let path = temp_path("keep-row-comments");
        write(
            &path,
            r#"[[replacements]]
# 1件目
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"
enabled = true
sync = true

[[replacements]]
# 2件目
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
from = "滑ると"
to = "svelte"
enabled = true
sync = true

[[replacements]]
# 3件目
id = "cccccccccccccccccccccccccccccccc"
from = "異臭"
to = "issue"
enabled = true
sync = true
"#,
        );

        // 真ん中の行を消しても、前後の行のコメントは残す
        save_change(&path, |config| {
            config.replacements.remove(1);
        });
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"[[replacements]]
# 1件目
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"
enabled = true
sync = true

[[replacements]]
# 3件目
id = "cccccccccccccccccccccccccccccccc"
from = "異臭"
to = "issue"
enabled = true
sync = true
"#
        );

        // 行を編集しても、その行のコメントは残す
        save_change(&path, |config| {
            config.replacements[1].to = "イシュー".to_string();
        });
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"[[replacements]]
# 1件目
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"
enabled = true
sync = true

[[replacements]]
# 3件目
id = "cccccccccccccccccccccccccccccccc"
from = "異臭"
to = "イシュー"
enabled = true
sync = true
"#
        );

        // 行を足すと、表の並びの続きに足す
        save_change(&path, |config| {
            config.replacements.push(Replacement {
                id: item_id('d'),
                from: "ドット円部".to_string(),
                to: ".env".to_string(),
                enabled: true,
                sync: true,
            });
        });
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(
            config.replacements,
            vec![
                Replacement {
                    id: item_id('a'),
                    from: "濃度".to_string(),
                    to: "Node.js".to_string(),
                    enabled: true,
                    sync: true,
                },
                Replacement {
                    id: item_id('c'),
                    from: "異臭".to_string(),
                    to: "イシュー".to_string(),
                    enabled: true,
                    sync: true,
                },
                Replacement {
                    id: item_id('d'),
                    from: "ドット円部".to_string(),
                    to: ".env".to_string(),
                    enabled: true,
                    sync: true,
                },
            ]
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"[[replacements]]
# 1件目
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
from = "濃度"
to = "Node.js"
enabled = true
sync = true

[[replacements]]
# 3件目
id = "cccccccccccccccccccccccccccccccc"
from = "異臭"
to = "イシュー"
enabled = true
sync = true

[[replacements]]
id = "dddddddddddddddddddddddddddddddd"
from = "ドット円部"
to = ".env"
enabled = true
sync = true
"#
        );

        // すべて消すと、項目ごと消える
        save_change(&path, |config| config.replacements.clear());
        assert!(!fs::read_to_string(&path).unwrap().contains("replacements"));
    }

    #[test]
    fn indents_rows_added_to_inline_arrays() {
        let path = temp_path("inline-add");
        let row = |from: &str| Replacement {
            id: match from {
                "a" => item_id('a'),
                "b" => item_id('b'),
                "c" => item_id('c'),
                "z" => item_id('d'),
                _ => unreachable!(),
            },
            from: from.to_string(),
            to: "x".to_string(),
            enabled: true,
            sync: true,
        };
        let add = |path: &Path, from: &str| {
            save_change(path, |config| config.replacements.push(row(from)));
            fs::read_to_string(path).unwrap()
        };

        // 1行の配列
        write(
            &path,
            "replacements = [{ id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" }]\n",
        );
        assert_eq!(
            add(&path, "b"),
            "replacements = [{ id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" }, { id = \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\", from = \"b\", to = \"x\", enabled = true, sync = true }]\n"
        );

        // 末尾のカンマのない、行を分けた配列
        write(
            &path,
            "replacements = [\n    { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" }\n]\n",
        );
        assert_eq!(
            add(&path, "b"),
            "replacements = [\n    { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" },\n    { id = \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\", from = \"b\", to = \"x\", enabled = true, sync = true }\n]\n"
        );

        // コメントの付いた行の後ろに足しても、コメントは増えない
        write(
            &path,
            "replacements = [\n    # 1件目\n    { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" },\n]\n",
        );
        add(&path, "b");
        let text = add(&path, "c");
        assert_eq!(text.matches("# 1件目").count(), 1, "{text}");
        assert_eq!(
            text,
            "replacements = [\n    # 1件目\n    { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" },\n    { id = \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\", from = \"b\", to = \"x\", enabled = true, sync = true },\n    { id = \"cccccccccccccccccccccccccccccccc\", from = \"c\", to = \"x\", enabled = true, sync = true },\n]\n"
        );

        // 1行の配列の先頭に足す
        write(
            &path,
            "replacements = [{ id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" }]\n",
        );
        save_change(&path, |config| config.replacements.insert(0, row("z")));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "replacements = [{ id = \"dddddddddddddddddddddddddddddddd\", from = \"z\", to = \"x\", enabled = true, sync = true }, { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"a\", to = \"x\" }]\n"
        );
    }

    #[test]
    fn keeps_inline_rows_inline_with_their_comments() {
        // インラインの配列で書いた並びは、インラインのまま書き換える。キーの前と配列の中のコメントを残す
        let path = temp_path("inline-rows");
        let original = r#"# 辞書（インラインで書く）
replacements = [
    # 1件目
    { id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", from = "濃度", to = "Node.js" },
    { id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", from = "滑ると", to = "svelte" },  # 2件目
]
"#;
        write(&path, original);
        save_change(&path, |config| {
            config.replacements[0].enabled = false;
        });
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert!(!config.replacements[0].enabled);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# 辞書（インラインで書く）\nreplacements = [\n    # 1件目\n    { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"濃度\", to = \"Node.js\" , enabled = false, sync = true },\n    { id = \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\", from = \"滑ると\", to = \"svelte\" },  # 2件目\n]\n"
        );

        // 足した行は、隣の行と同じく行を分けて書く。読めない行は、書き換えると表の行に替わる
        save_change(&path, |config| {
            config.replacements.push(Replacement {
                id: item_id('c'),
                from: "異臭".to_string(),
                to: "issue".to_string(),
                enabled: true,
                sync: true,
            });
        });
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(
            config.replacements,
            vec![
                Replacement {
                    id: item_id('a'),
                    from: "濃度".to_string(),
                    to: "Node.js".to_string(),
                    enabled: false,
                    sync: true,
                },
                Replacement {
                    id: item_id('b'),
                    from: "滑ると".to_string(),
                    to: "svelte".to_string(),
                    enabled: true,
                    sync: true,
                },
                Replacement {
                    id: item_id('c'),
                    from: "異臭".to_string(),
                    to: "issue".to_string(),
                    enabled: true,
                    sync: true,
                },
            ]
        );
        // 最後の行のカンマの後ろのコメントは配列の後ろに付いているので、末尾に足した行に付いて見える（仕様に書いてある）
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# 辞書（インラインで書く）\nreplacements = [\n    # 1件目\n    { id = \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", from = \"濃度\", to = \"Node.js\" , enabled = false, sync = true },\n    { id = \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\", from = \"滑ると\", to = \"svelte\" },\n    { id = \"cccccccccccccccccccccccccccccccc\", from = \"異臭\", to = \"issue\", enabled = true, sync = true },  # 2件目\n]\n"
        );

        write(&path, "replacements = [\"滑ると\"]\n");
        let (old, problem) = load_or_create(&path);
        assert_eq!(problem, repaired(&["replacements[0]"]));
        let next = Config {
            replacements: vec![Replacement {
                id: item_id('a'),
                from: "滑ると".to_string(),
                to: "svelte".to_string(),
                enabled: true,
                sync: true,
            }],
            ..old.clone()
        };
        let keys = ["replacements[0]".to_string()];
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        save_with_backup(
            &path,
            &next,
            Loaded::Read {
                old: &old,
                repaired: &keys,
            },
            now,
        )
        .unwrap();
        assert_eq!(load_or_create(&path), (next, None));
    }

    #[test]
    fn changes_one_draft_key_and_keeps_the_others() {
        let path = temp_path("draft-key-change");
        write(
            &path,
            "[text_window_keys]\n# 自分の癖\ncopy = \"CommandOrControl+KeyJ\"\n",
        );
        save_change(&path, |config| {
            config.text_window_keys.send = String::new();
        });
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("# 自分の癖\ncopy = \"CommandOrControl+KeyJ\""),
            "{text}"
        );
        assert!(text.contains("send = \"\""), "{text}");

        // 既定のキーに戻した操作は書かない。すべて戻せば表ごと消える
        save_change(&path, |config| {
            config.text_window_keys = DraftKeys::default()
        });
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("text_window_keys"));
    }

    #[test]
    fn keeps_yielded_draft_keys_out_of_the_file() {
        // ホットキーが送信先の一覧の既定のキーと重なり、起動時に黙って外した
        let path = temp_path("draft-key-yielded");
        write(&path, "hotkey = \"CommandOrControl+KeyL\"\n");
        let (config, _) = load_or_create(&path);
        assert_eq!(config.text_window_keys.send_targets, "");
        assert_eq!(config.yielded_draft_keys, [DraftAction::SendTargets]);

        // ほかのキーを変えても、外したキーは書かない
        save_change(&path, |config| {
            config.text_window_keys.copy = "CommandOrControl+KeyU".to_string();
        });
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("send_targets"), "{text}");

        // 割り当てなしを選び直したら、書いた操作として書く
        let (config, _) = load_or_create(&path);
        let mut next = config.clone();
        next.yielded_draft_keys.clear();
        let loaded = Loaded::Read {
            old: &config,
            repaired: &[],
        };
        save_with_backup(&path, &next, loaded, NOW).unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("send_targets = \"\""));
        fs::write(&path, &text).unwrap();

        // 重なりが解ければ、既定のキーに戻る
        write(
            &path,
            &text.replace("CommandOrControl+KeyL", "CommandOrControl+Alt+KeyK"),
        );
        let (config, _) = load_or_create(&path);
        assert_eq!(
            config.text_window_keys.send_targets,
            DraftKeys::default().send_targets
        );
        assert!(config.yielded_draft_keys.is_empty());
    }

    #[test]
    fn removes_guidance_when_reset_to_default() {
        let path = temp_path("guidance-reset");
        write(
            &path,
            "input_guidance = \"自分用のメモ\"\nautostart = false\n",
        );
        save_change(&path, |config| config.input_guidance = None);
        assert_eq!(fs::read_to_string(&path).unwrap(), "autostart = false\n");
    }

    #[test]
    fn keeps_edits_made_after_launch() {
        // 起動した後に手で直したほかの項目は、設定画面から保存しても消さない
        let path = temp_path("edited-after-launch");
        write(&path, "autostart = false\n");
        let (old, _) = load_or_create(&path);
        write(&path, "autostart = false\ntheme = \"dark\"\n");
        let next = Config {
            hotkey: "CommandOrControl+Alt+KeyK".to_string(),
            ..old.clone()
        };
        let loaded = Loaded::Read {
            old: &old,
            repaired: &[],
        };
        assert_eq!(save_with_backup(&path, &next, loaded, NOW).unwrap(), None);
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(config.theme, Theme::Dark);
        assert_eq!(config.hotkey, "CommandOrControl+Alt+KeyK");
    }

    #[test]
    fn reads_ai_settings_and_actions_and_repairs_broken_ones() {
        let path = temp_path("actions");
        write(
            &path,
            r#"ai_service = "gemini"
ai_consent = "gemini"

[ai_models]
gemini = "gemini-3.8-flash"
mistral = "mistral-large"

[[actions]]
id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
name = "敬語"
command = "@ai 丁寧に: {{t}}"
output = "insert"

[[actions]]
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
command = "date"
encoding = "euc-jp"
enabled = false

[[actions]]
id = "cccccccccccccccccccccccccccccccc"
name = "コマンドがない"
output = "none"

[[actions]]
command = "sort"
output = "append"

[[actions]]
name = 1
command = "sort"

[[actions]]
command = ["sort"]

[[actions]]
command = "sort"
encoding = "cp932"
"#,
        );
        let (config, error) = load_or_create(&path);
        assert!(config.ai_available(Some(true)));
        assert_eq!(config.ai_model(), "gemini-3.8-flash");
        assert_eq!(
            config.actions,
            Some(vec![
                Action {
                    id: item_id('a'),
                    name: "敬語".to_string(),
                    command: "@ai 丁寧に: {{t}}".to_string(),
                    output: ActionOutput::Insert,
                    encoding: ActionEncoding::Utf8,
                    enabled: true,
                    sync: true,
                },
                // 出し方を省いたら置き換える。切った行も読む
                Action {
                    id: item_id('b'),
                    name: String::new(),
                    command: "date".to_string(),
                    output: ActionOutput::Replace,
                    encoding: ActionEncoding::EucJp,
                    enabled: false,
                    sync: true,
                },
                // コマンドの行を省いた行は、空の行として読む（一覧には出さない）。文字コードを省いたら UTF-8
                Action {
                    id: item_id('c'),
                    name: "コマンドがない".to_string(),
                    command: String::new(),
                    output: ActionOutput::None,
                    encoding: ActionEncoding::Utf8,
                    enabled: true,
                    sync: true,
                },
            ])
        );
        // 知らない AI サービスのモデルは読み飛ばすだけで、知らせない
        assert_eq!(
            error,
            repaired(&["actions[3]", "actions[4]", "actions[5]", "actions[6]"])
        );

        // 知らない AI サービスの名前、文字列でないモデル、並びでないアクションは既定に戻す
        write(
            &path,
            r#"ai_service = "mistral"
ai_consent = 1
actions = "丁寧に"

[ai_models]
gemini = 3
"#,
        );
        let (config, error) = load_or_create(&path);
        // 既定は「使わない」なので、読めなかった AI サービスの名前も「使わない」に戻る
        assert_eq!(config.ai_service, AiService::None);
        assert_eq!(config.ai_consent, None);
        assert_eq!(config.ai_model(), AiService::None.default_model());
        assert_eq!(config.actions, None);
        assert_eq!(
            error,
            repaired(&["ai_service", "ai_consent", "ai_models.gemini", "actions"])
        );
    }

    #[test]
    fn ai_none_round_trips_and_is_not_available() {
        let path = temp_path("ai-none");
        save(&path, &Config::default()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "");

        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(config.ai_service, AiService::None);
        assert!(!config.ai_available(Some(true)));
        assert!(!config.ai_available(Some(false)));

        write(&path, "ai_service = \"none\"\n");
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(config.ai_service, AiService::None);
        save(&path, &config).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "");
    }

    #[test]
    fn ai_requires_consent_and_treats_unknown_key_as_available() {
        let config = Config {
            ai_service: AiService::Gemini,
            ai_consent: Some(AiService::Gemini),
            ..Config::default()
        };
        assert!(config.ai_available(Some(true)));
        assert!(config.ai_available(None));
        assert!(!config.ai_available(Some(false)));

        let without_consent = Config {
            ai_service: AiService::Gemini,
            ..Config::default()
        };
        assert!(!without_consent.ai_available(Some(true)));
        assert!(!without_consent.ai_available(None));
    }

    #[test]
    fn keeps_empty_actions_apart_from_the_default() {
        // 項目がないのは既定のアクション、空の並びは利用者が全部消したもの。空にしても項目を消さない
        let path = temp_path("actions-empty");
        write(
            &path,
            "[[actions]]\nname = \"敬語\"\ncommand = \"@ai 丁寧に\"\n",
        );
        save_change(&path, |config| config.actions = Some(Vec::new()));
        assert_eq!(fs::read_to_string(&path).unwrap(), "actions = []\n");
        assert_eq!(load_or_create(&path).0.actions, Some(Vec::new()));

        // インラインの配列で書いた並びは、書き方とコメントを残して空にする
        write(
            &path,
            "# アクション\nactions = [\n  { name = \"敬語\", command = \"@ai 丁寧に\" },\n]\n",
        );
        save_change(&path, |config| config.actions = Some(Vec::new()));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# アクション\nactions = ["), "{text}");
        assert_eq!(load_or_create(&path).0.actions, Some(Vec::new()));

        // 既定に戻すと項目を消す
        save_change(&path, |config| config.actions = None);
        assert_eq!(fs::read_to_string(&path).unwrap().trim(), "");
    }

    #[test]
    fn writes_only_models_that_differ_from_the_default() {
        let path = temp_path("ai-models");
        write(
            &path,
            "[ai_models]\n# 速いほう\ngemini = \"gemini-3.8-flash\"\nmistral = \"mistral-large\"\n",
        );
        // 既定のモデルに戻すとその行を消す。知らない AI サービスの行は、新しい版で足したものかもしれないので残す
        save_change(&path, |config| {
            config.ai_models.insert(
                AiService::Gemini,
                AiService::Gemini.default_model().to_string(),
            );
        });
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[ai_models]\nmistral = \"mistral-large\"\n"
        );

        // 書いていなかったモデルを書く
        let path = temp_path("ai-models-new");
        save(&path, &Config::default()).unwrap();
        save_change(&path, |config| {
            config
                .ai_models
                .insert(AiService::Gemini, "gemini-3.8-flash".to_string());
        });
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[ai_models]\ngemini = \"gemini-3.8-flash\"\n"
        );
    }

    #[test]
    fn describes_parse_errors_in_one_line() {
        let path = temp_path("parse-error");
        write(&path, "autostart = false\ntheme = \n");
        let (_, error) = load_or_create(&path);
        let Some(LoadProblem::Unreadable(message)) = error else {
            panic!("{error:?}");
        };
        assert!(!message.contains('\n'), "{message}");
        assert!(message.contains("line 2, column"), "{message}");
    }

    #[test]
    fn reads_devices_without_send_to_as_checked() {
        // 送信先を選べるようになる前の設定ファイルには send_to がない。見つけたデバイスを送信先にする既定で読む
        let path = temp_path("paired-devices");
        write(
            &path,
            "[[devices]]\nname = \"Mac\"\npublic_key = \"ab\"\naddress = \"192.168.0.10\"\n",
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(error, None);
        assert_eq!(
            config.devices,
            vec![Device {
                name: "Mac".to_string(),
                public_key: "ab".to_string(),
                address: "192.168.0.10".to_string(),
                send_to: true,
            }]
        );
    }

    #[test]
    fn fills_replacement_enabled_with_default() {
        // 設定ファイルを直接編集するときに enabled を省けるようにしてある
        let path = temp_path("replacements");
        write(
            &path,
            "[[replacements]]\nfrom = \"濃度\"\nto = \"Node.js\"\n",
        );
        let (config, error) = load_or_create(&path);
        assert_eq!(config.replacements[0].from, "濃度");
        assert_eq!(config.replacements[0].to, "Node.js");
        assert!(config.replacements[0].enabled);
        assert!(config.replacements[0].sync);
        assert!(valid_item_id(&config.replacements[0].id));
        assert_eq!(error, None);
    }

    #[test]
    fn repairs_item_ids_and_keeps_sync_values_for_every_synced_list() {
        let path = temp_path("item-ids");
        let valid_replacement = "a".repeat(32);
        let valid_snippet = "b".repeat(32);
        let valid_action = "c".repeat(32);
        let invalid_id = "A".repeat(32);
        write(
            &path,
            &format!(
                r#"[[replacements]]
id = "{valid_replacement}"
from = "keep"
to = "kept"
sync = false

[[replacements]]
id = "{valid_replacement}"
from = "duplicate"
to = "new"

[[replacements]]
id = "{invalid_id}"
from = "invalid"
to = "new"

[[replacements]]
id = ""
from = "empty"
to = "new"

[[replacements]]
from = "missing"
to = "new"

[[snippets]]
id = "{valid_snippet}"
name = "keep"
body = "kept"
sync = false

[[snippets]]
name = "missing"
body = "new"

[[snippets]]
id = ""
name = "empty"
body = "new"

[[snippets]]
id = "{valid_snippet}"
name = "duplicate"
body = "new"

[[snippets]]
id = "{invalid_id}"
name = "invalid"
body = "new"

[[actions]]
id = "{valid_action}"
name = "keep"
command = "echo kept"
sync = false

[[actions]]
id = "{valid_action}"
name = "duplicate"
command = "echo new"

[[actions]]
id = 123
name = "invalid"
command = "echo new"

[[actions]]
id = ""
name = "empty"
command = "echo new"

[[actions]]
name = "missing"
command = "echo new"
"#
            ),
        );

        let (config, problem) = load_or_create(&path);
        assert_eq!(problem, None);
        assert_eq!(config.replacements[0].id, valid_replacement);
        assert_eq!(config.snippets[0].id, valid_snippet);
        assert_eq!(config.actions.as_ref().unwrap()[0].id, valid_action);
        assert!(has_valid_ids(
            config.replacements.iter().map(|row| row.id.clone())
        ));
        assert!(has_valid_ids(
            config.snippets.iter().map(|row| row.id.clone())
        ));
        assert!(has_valid_ids(
            config
                .actions
                .as_ref()
                .unwrap()
                .iter()
                .map(|row| row.id.clone())
        ));
        assert!(!config.replacements[0].sync);
        assert!(config.replacements.iter().skip(1).all(|row| row.sync));
        assert!(!config.snippets[0].sync);
        assert!(config.snippets.iter().skip(1).all(|row| row.sync));
        assert!(!config.actions.as_ref().unwrap()[0].sync);
        assert!(config
            .actions
            .as_ref()
            .unwrap()
            .iter()
            .skip(1)
            .all(|row| row.sync));

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("sync = false"), "{text}");
        assert_eq!(load_or_create(&path), (config, None));
    }

    #[test]
    fn leaves_valid_item_ids_and_their_file_layout_unchanged() {
        let path = temp_path("valid-item-ids");
        let text = r#"# ここは残す
replacements = [{ id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", from = "濃度", to = "Node.js" }]

[[snippets]]
id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
name = "確認"
body = "以上です。"

[[actions]]
id = "cccccccccccccccccccccccccccccccc"
name = "大文字"
command = "tr a-z A-Z"
"#;
        write(&path, text);

        let (config, problem) = load_or_create(&path);

        assert_eq!(problem, None);
        assert_eq!(config.replacements[0].id, item_id('a'));
        assert_eq!(config.snippets[0].id, item_id('b'));
        assert_eq!(config.actions.as_ref().unwrap()[0].id, item_id('c'));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn writes_only_item_ids_when_reading_old_synced_rows() {
        let path = temp_path("repair-item-ids");
        let text = r#"# ここは残す
[[replacements]]
# 辞書のコメント
from = "濃度"
to = "Node.js"

[[snippets]]
name = "確認"
body = "以上です。"

[[actions]]
name = "大文字"
command = "tr a-z A-Z"
"#;
        write(&path, text);

        let (config, problem) = load_or_create(&path);

        assert_eq!(problem, None);
        let mut written = fs::read_to_string(&path).unwrap();
        for id in [
            &config.replacements[0].id,
            &config.snippets[0].id,
            &config.actions.as_ref().unwrap()[0].id,
        ] {
            written = written.replace(id, "<generated>");
        }
        assert_eq!(
            written,
            r#"# ここは残す
[[replacements]]
# 辞書のコメント
from = "濃度"
to = "Node.js"
id = "<generated>"

[[snippets]]
name = "確認"
body = "以上です。"
id = "<generated>"

[[actions]]
name = "大文字"
command = "tr a-z A-Z"
id = "<generated>"
"#
        );
        assert!(!written.contains("sync"), "{written}");
    }

    #[test]
    fn falls_back_to_defaults_on_invalid_toml() {
        let path = temp_path("invalid");
        for toml in [
            "hotkey = ",
            "[text_window_keys",
            "theme = \"dark\"\ntheme = \"light\"\n",
        ] {
            write(&path, toml);
            let (config, error) = load_or_create(&path);
            assert_eq!(config, Config::default(), "{toml}");
            assert!(
                matches!(error, Some(LoadProblem::Unreadable(_))),
                "{toml}: {error:?}"
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), toml);
        }
    }

    #[test]
    fn saves_through_a_temporary_file() {
        let path = temp_path("save-temp");
        let temp = path.with_extension("toml.tmp");
        save(&path, &Config::default()).unwrap();
        let config = save_change(&path, |config| config.autostart = false);
        assert_eq!(load_or_create(&path), (config, None));
        assert!(!temp.exists());

        // 差し替えられなければ、一時ファイルを残さず、元のものもそのまま
        let blocked = temp_path("save-blocked");
        fs::create_dir_all(blocked.join("inside")).unwrap();
        assert!(save(&blocked, &Config::default()).is_err());
        assert!(blocked.join("inside").is_dir());
        assert!(!blocked.with_extension("toml.tmp").exists());
    }

    #[test]
    fn backs_up_without_overwriting() {
        let path = temp_path("back-up");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        assert_eq!(back_up(&path, now).unwrap(), None);

        write(&path, "hotkey = ");
        let first = back_up(&path, now).unwrap().unwrap();
        assert_eq!(
            first,
            path.with_file_name("config.broken-20260913-063005.toml")
        );
        assert_eq!(fs::read_to_string(&first).unwrap(), "hotkey = ");

        // 同じ秒にもう一度写しても、先に写したものは残す
        fs::write(&path, "theme = ").unwrap();
        let second = back_up(&path, now).unwrap().unwrap();
        assert_eq!(
            second,
            path.with_file_name("config.broken-20260913-063005-1.toml")
        );
        assert_eq!(fs::read_to_string(&first).unwrap(), "hotkey = ");
        assert_eq!(fs::read_to_string(&second).unwrap(), "theme = ");
    }

    /// 設定ファイルと同じフォルダーにある写しのファイル名
    fn backups(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("config.broken-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn saves_without_backup_when_the_file_was_read() {
        let path = temp_path("save-no-backup");
        save(&path, &Config::default()).unwrap();
        let config = save_change(&path, |config| config.autostart = false);
        assert_eq!(load_or_create(&path), (config, None));
        assert!(backups(&path).is_empty());
    }

    #[test]
    fn backs_up_the_unread_file_before_overwriting() {
        let path = temp_path("save-backup");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        write(&path, "hotkey = ");
        let config = Config {
            autostart: false,
            ..Config::default()
        };

        let backed_up = save_with_backup(&path, &config, Loaded::Unreadable, now).unwrap();

        assert_eq!(
            backed_up,
            Some(path.with_file_name("config.broken-20260913-063005.toml"))
        );
        assert_eq!(fs::read_to_string(backed_up.unwrap()).unwrap(), "hotkey = ");
        assert_eq!(load_or_create(&path), (config, None));
    }

    #[test]
    fn backs_up_and_rewrites_repaired_fields() {
        // 型を直した項目は、最初の保存で写してから書き直す。ほかの項目のコメントは残す
        let path = temp_path("save-repaired");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        let original = "theme = 1\n# メモ\nautostart = false\n";
        write(&path, original);
        let (old, problem) = load_or_create(&path);
        assert_eq!(problem, repaired(&["theme"]));
        let next = Config {
            hotkey: "CommandOrControl+Alt+KeyK".to_string(),
            ..old.clone()
        };
        let keys = ["theme".to_string()];
        let loaded = Loaded::Read {
            old: &old,
            repaired: &keys,
        };

        let backed_up = save_with_backup(&path, &next, loaded, now).unwrap();

        assert_eq!(fs::read_to_string(backed_up.unwrap()).unwrap(), original);
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("theme"), "{text}");
        assert!(text.contains("# メモ"), "{text}");
        assert_eq!(load_or_create(&path), (next, None));
    }

    #[test]
    fn backs_up_a_file_broken_after_launch() {
        // 起動したときは読めたが、その後に手で壊された。写してから新しく書く
        let path = temp_path("broken-after-launch");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        write(&path, "autostart = false\n");
        let (old, _) = load_or_create(&path);
        fs::write(&path, "autostart = ").unwrap();
        let next = Config {
            theme: Theme::Dark,
            ..old.clone()
        };
        let loaded = Loaded::Read {
            old: &old,
            repaired: &[],
        };

        let backed_up = save_with_backup(&path, &next, loaded, now).unwrap();

        assert_eq!(
            fs::read_to_string(backed_up.unwrap()).unwrap(),
            "autostart = "
        );
        assert_eq!(load_or_create(&path), (next, None));
    }

    #[test]
    fn removes_the_backup_when_saving_fails() {
        let path = temp_path("save-backup-fails");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        write(&path, "hotkey = ");
        // 一時ファイルの場所をフォルダーでふさいで、写した後の保存だけを失敗させる
        fs::create_dir_all(path.with_extension("toml.tmp")).unwrap();

        assert!(save_with_backup(&path, &Config::default(), Loaded::Unreadable, now).is_err());

        // 写しは溜めず、元のファイルもそのまま残す
        assert!(backups(&path).is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "hotkey = ");

        // 次の保存でまた写す
        fs::remove_dir(path.with_extension("toml.tmp")).unwrap();
        let backed_up =
            save_with_backup(&path, &Config::default(), Loaded::Unreadable, now).unwrap();
        assert_eq!(fs::read_to_string(backed_up.unwrap()).unwrap(), "hotkey = ");
        assert_eq!(backups(&path), ["config.broken-20260913-063005.toml"]);
    }

    #[test]
    fn names_choices_as_written_in_the_file() {
        for (language, name) in [
            (Language::System, "system"),
            (Language::Ja, "ja"),
            (Language::En, "en"),
        ] {
            assert_eq!(choice_name(&language), name);
        }
        for (theme, name) in [
            (Theme::System, "system"),
            (Theme::Light, "light"),
            (Theme::Dark, "dark"),
        ] {
            assert_eq!(choice_name(&theme), name);
        }
        for (style, name) in [
            (PunctuationStyle::Keep, "keep"),
            (PunctuationStyle::Kutouten, "kutouten"),
            (PunctuationStyle::Comma, "comma"),
        ] {
            assert_eq!(choice_name(&style), name);
        }
        for (style, name) in [
            (WidthStyle::Keep, "keep"),
            (WidthStyle::Full, "full"),
            (WidthStyle::Half, "half"),
        ] {
            assert_eq!(choice_name(&style), name);
        }
        for (style, name) in [(KatakanaWidth::Keep, "keep"), (KatakanaWidth::Full, "full")] {
            assert_eq!(choice_name(&style), name);
        }
    }

    #[test]
    fn syncs_a_subtable_keeping_comments_and_unknown_names() {
        let names = ["a", "b", "c"];
        let synced = |text: &str, written: &[(&str, String)]| {
            let mut document: DocumentMut = text.parse().unwrap();
            sync_subtable(document.as_table_mut(), "t", &names, written);
            document.to_string()
        };
        let written = |pairs: &[(&'static str, &str)]| -> Vec<(&'static str, String)> {
            pairs
                .iter()
                .map(|(name, value)| (*name, value.to_string()))
                .collect()
        };

        // 書いてある行は、コメントを残して値だけを替える。書かない名前は消し、知らない名前は残す
        assert_eq!(
            synced(
                "[t]\n# メモ\na = \"1\" # 後ろ\nb = \"2\"\nnew = \"x\"\n",
                &written(&[("a", "9"), ("c", "3")]),
            ),
            "[t]\n# メモ\na = \"9\" # 後ろ\nnew = \"x\"\nc = \"3\"\n"
        );
        // 表が空になったら表ごと消す
        assert_eq!(synced("x = 1\n[t]\na = \"1\"\n", &[]), "x = 1\n");
        // 表でない値は、表に書き直す。書くものがなければ消すだけ
        assert_eq!(
            synced("t = \"broken\"\n", &written(&[("b", "2")])),
            "[t]\nb = \"2\"\n"
        );
        assert_eq!(synced("t = \"broken\"\n", &[]), "");
    }

    #[test]
    fn formats_utc_stamp() {
        for (seconds, expected) in [
            (0, "19700101-000000"),
            (946_684_799, "19991231-235959"),
            (1_709_164_800, "20240229-000000"),
            (1_789_281_005, "20260913-063005"),
        ] {
            assert_eq!(
                utc_stamp(UNIX_EPOCH + Duration::from_secs(seconds)),
                expected,
                "{seconds}"
            );
        }
    }
}
