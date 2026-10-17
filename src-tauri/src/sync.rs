//! Pro の設定同期（docs/sync.md）。窓口から来る値は、復号できても画面から変えるときと同じ検査を通してから使う。

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    account, actions,
    ai::AiService,
    config::{self, valid_item_id, Config, Language, Snippet, SyncRow, Theme},
    draft_keys::{DraftAction, DraftKeys, Platform},
    history_store::{self, History},
    i18n::Lang,
    sync_key,
    text::{KatakanaWidth, PunctuationStyle, Replacement, WidthStyle},
};

const KEY_INFO: &[u8] = b"mawok sync v1";
const VERSION: u64 = 1;
const SETTINGS: &str = "settings";
const HISTORY: &str = "history";
const HISTORY_ID: &str = "h";
/// 窓口が1項目に受け付ける暗号文の上限（docs/account-server.md「同期」）。
/// 超える項目を送ると、同じ要求のほかの項目まで断られるので、送る前に同じ値で測って外す。
const MAX_ENCRYPTED_ITEM_BYTES: usize = 256 * 1024;
/// 窓口が1回の書き込みに受け付ける項目数の上限（docs/account-server.md「同期」）。
const WRITE_BATCH_SIZE: usize = 100;
/// `conflict` を受けて書き直す回数の上限（docs/sync.md「1回の同期」）。
/// ほかのデバイスと同じ項目を書き合い続けても、1回の同期を終わらせる。残りは次のきっかけで試す。
const MAX_CONFLICT_RETRIES: usize = 3;
/// 1ページに読む項目数。窓口が受け付ける上限（docs/account-server.md「同期」）にして、往復を減らす。
const READ_LIMIT: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ItemKey {
    pub collection: String,
    pub id: String,
}

impl ItemKey {
    fn new(collection: &str, id: impl Into<String>) -> Self {
        Self {
            collection: collection.to_string(),
            id: id.into(),
        }
    }

    fn name(&self) -> String {
        format!("{}\u{0}{}", self.collection, self.id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plain {
    v: u64,
    // 値が null の項目（既定の `input_guidance`）を、値が無いものと取り違えない
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    value: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    detached: bool,
    /// 書いたデバイスで、その値にした時刻（UNIX のミリ秒）。食い違ったときに後から変えた方を残す（docs/sync.md「食い違い」）。
    /// 変えた時刻の分からない値（初めての同期で書いた手元の値など）は 0
    #[serde(default, skip_serializing_if = "is_zero")]
    at: u64,
}

fn is_zero(at: &u64) -> bool {
    *at == 0
}

fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

impl Plain {
    fn value(value: Value) -> Self {
        Self {
            v: VERSION,
            value: Some(value),
            detached: false,
            at: 0,
        }
    }

    fn detached() -> Self {
        Self {
            v: VERSION,
            value: None,
            detached: true,
            at: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    pub seq: u64,
    /// 揃えたときの値の SHA-256。混ぜて揃える項目（並び・履歴）が、手元を変えたかを見分けるのに使う。
    /// ほかの項目は、手元で変えたかを oplog で見分ける
    pub hash: [u8; 32],
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    pub key_id: String,
    pub since: u64,
    #[serde(default)]
    pub items: BTreeMap<String, Seen>,
    /// 大きすぎて書けなかった項目と、そのときの平文の SHA-256。手元の値が変わるまで書かない。
    #[serde(default)]
    pub too_large: BTreeMap<String, [u8; 32]>,
    /// 窓口で消えた・同期から外れた項目の `seq`。同じ id をもう一度書くときの `base_seq` に使う。
    #[serde(default)]
    pub retired: BTreeMap<String, u64>,
    /// 読み捨てた項目と、その `seq`。新しい版が書いた項目を壊さないよう、窓口の値が変わるまで書かない。
    #[serde(default)]
    pub ignored: BTreeMap<String, u64>,
    /// 読まずに置いてある種類・設定項目ごとの位置（docs/sync.md 冒頭）。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub paused: BTreeMap<String, u64>,
}

impl State {
    fn new(key_id: &str) -> Self {
        Self {
            key_id: key_id.to_string(),
            ..Self::default()
        }
    }

    /// この項目について、もう見た `seq`。これ以下の項目は、自分が書いた項目の読み戻しか、古い暗号文の出し直し。
    fn seen_seq(&self, name: &str) -> Option<u64> {
        [
            self.items.get(name).map(|seen| seen.seq),
            self.retired.get(name).copied(),
            self.ignored.get(name).copied(),
        ]
        .into_iter()
        .flatten()
        .max()
    }

    /// 窓口と揃った。
    fn settle(&mut self, name: String, seq: u64, value: &Value) {
        self.settle_seen(
            name,
            Seen {
                seq,
                hash: hash_plain(value),
            },
        );
    }

    fn settle_seen(&mut self, name: String, seen: Seen) {
        self.retired.remove(&name);
        self.ignored.remove(&name);
        self.items.insert(name, seen);
    }

    /// 窓口に無い項目として、見た記録を外す。
    fn forget(&mut self, name: &str) {
        self.items.remove(name);
        self.retired.remove(name);
    }

    /// 窓口で消えた・同期から外れた。
    fn retire(&mut self, name: String, seq: u64) {
        self.items.remove(&name);
        self.ignored.remove(&name);
        self.retired.insert(name, seq);
    }

    /// この回に読み始める位置。オフにしていた種類をオンに戻した回は、置いてあった位置まで戻る。
    /// もう見た項目は `seq` で飛ばすので、戻って読んでも入れ直さない
    fn read_since(&self, config: &Config) -> u64 {
        std::iter::once(self.since)
            .chain(
                self.paused
                    .iter()
                    .filter(|(group, _)| !paused_group(config, group))
                    .map(|(_, since)| *since),
            )
            .min()
            .unwrap_or(self.since)
    }

    /// 今オフにしている種類に、読まずに置いてある位置を置く（docs/sync.md 冒頭）。もう置いてあれば変えない。
    /// スイッチを切り替えたときと、記録を保存する前に通す。変えたかを返す
    pub fn pause(&mut self, config: &Config) -> bool {
        let mut changed = false;
        for group in paused_groups(config) {
            if !self.paused.contains_key(&group) {
                // 種類「設定」を止めている間に外した項目は、種類を止めたときから読んでいない。
                // 種類のまとまりは、ほかの種類の位置に依らず、止めたときの位置にする
                let settings = self.paused.get(SyncKind::Settings.group());
                let since = match settings {
                    Some(settings) if SyncKind::of_group(&group).is_none() => {
                        self.since.min(*settings)
                    }
                    _ => self.since,
                };
                self.paused.insert(group, since);
                changed = true;
            }
        }
        changed
    }
}

/// 同期する種類（docs/sync.md 冒頭）。オフの種類は読みも書きもしない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SyncKind {
    Settings,
    Keys,
    Replacements,
    Snippets,
    History,
}

impl SyncKind {
    pub const ALL: [Self; 5] = [
        Self::Settings,
        Self::Keys,
        Self::Replacements,
        Self::Snippets,
        Self::History,
    ];

    fn of_group(group: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.group() == group)
    }

    fn group(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Keys => "keys",
            Self::Replacements => "replacements",
            Self::Snippets => "snippets",
            Self::History => "history",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Kinds {
    pub settings: bool,
    pub keys: bool,
    pub replacements: bool,
    pub snippets: bool,
    pub history: bool,
}

impl Kinds {
    pub fn any(self) -> bool {
        self.settings || self.keys || self.replacements || self.snippets || self.history
    }

    /// 履歴のほかの（collection `settings` に置く）種類のどれかを同期するか。
    fn any_settings(self) -> bool {
        self.settings || self.keys || self.replacements || self.snippets
    }

    pub fn enabled(self, kind: SyncKind) -> bool {
        match kind {
            SyncKind::Settings => self.settings,
            SyncKind::Keys => self.keys,
            SyncKind::Replacements => self.replacements,
            SyncKind::Snippets => self.snippets,
            SyncKind::History => self.history,
        }
    }
}

pub fn kinds(config: &Config) -> Kinds {
    Kinds {
        settings: config.sync_settings,
        keys: config.sync_keys,
        replacements: config.sync_replacements,
        snippets: config.sync_snippets,
        history: config.sync_history,
    }
}

/// 記録の名前（`ItemKey::name`）から項目を引く。
fn key_of(name: &str) -> Option<ItemKey> {
    let (collection, id) = name.split_once('\0')?;
    Some(ItemKey::new(collection, id))
}

/// 置き場（store.rs）に置いた記録を読む。読めなければ、記録が無いものとして初めての同期からやり直す
pub fn parse_state(text: &str) -> Option<State> {
    serde_json::from_str(text).ok()
}

pub fn state_text(state: &State) -> String {
    serde_json::to_string(state).expect("sync state serializes")
}

fn derived_key(key: &[u8; 32]) -> [u8; 32] {
    sync_key::derive(key, KEY_INFO)
}

fn associated_data(key_id: &str, item: &ItemKey) -> Vec<u8> {
    let mut out = Vec::new();
    for part in [
        key_id.as_bytes(),
        item.collection.as_bytes(),
        item.id.as_bytes(),
    ] {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(part);
    }
    out
}

fn encode_plain(plain: &Plain) -> Result<Vec<u8>, String> {
    serde_json::to_vec(plain).map_err(|error| error.to_string())
}

fn decode_plain(bytes: &[u8]) -> Option<Plain> {
    let plain: Plain = serde_json::from_slice(bytes).ok()?;
    (plain.v == VERSION && (plain.value.is_some() || plain.detached)).then_some(plain)
}

pub fn encrypt(
    key: &[u8; 32],
    key_id: &str,
    item: &ItemKey,
    plain: &Plain,
) -> Result<String, String> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new((&derived_key(key)).into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &encode_plain(plain)?,
                aad: &associated_data(key_id, item),
            },
        )
        .map_err(|_| "couldn't encrypt a sync item".to_string())?;
    let mut data = nonce.to_vec();
    data.extend(ciphertext);
    Ok(STANDARD.encode(data))
}

pub fn decrypt(key: &[u8; 32], key_id: &str, item: &ItemKey, data: &str) -> Option<Plain> {
    let data = STANDARD.decode(data).ok()?;
    let (nonce, ciphertext) = data.split_at_checked(24)?;
    let cipher = XChaCha20Poly1305::new((&derived_key(key)).into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &associated_data(key_id, item),
            },
        )
        .ok()?;
    decode_plain(&plaintext)
}

fn hash_plain(value: &Value) -> [u8; 32] {
    Sha256::digest(encode_plain(&Plain::value(value.clone())).expect("sync values serialize"))
        .into()
}

/// 窓口が測るのと同じ、base64 にする前の暗号文の大きさ（nonce 24 バイト・平文・認証タグ 16 バイト）。
fn encrypted_len(plain: &Plain) -> usize {
    24 + 16 + encode_plain(plain).map_or(usize::MAX, |bytes| bytes.len())
}

fn platform_suffix() -> &'static str {
    match Platform::current() {
        Platform::MacOs => "macos",
        Platform::Windows => "windows",
    }
}

fn json<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("sync value serializes")
}

fn set(map: &mut BTreeMap<ItemKey, Value>, id: impl Into<String>, value: Value) {
    map.insert(ItemKey::new(SETTINGS, id), value);
}

fn setting_id(name: &str) -> String {
    format!("s_{name}")
}

fn row_id(prefix: char, id: &str) -> String {
    format!("{prefix}_{id}")
}

fn order_id(name: &str) -> String {
    format!("o_{name}")
}

/// キーは OS ごとに別の項目にする。OS で使えるキーが違い、同じ値を両方の OS に入れられないため
fn hotkey_name() -> String {
    format!("hotkey_{}", platform_suffix())
}

fn text_window_keys_name() -> String {
    format!("text_window_keys_{}", platform_suffix())
}

/// このデバイスの OS のホットキーの項目。
pub fn hotkey_item() -> ItemKey {
    setting_item(&hotkey_name())
}

/// このデバイスの OS の、テキストウィンドウのキーの項目。
pub fn text_window_keys_item() -> ItemKey {
    setting_item(&text_window_keys_name())
}

pub fn setting_item(name: &str) -> ItemKey {
    ItemKey::new(SETTINGS, setting_id(name))
}

/// 置き場と同じ項目名で書く。黙って外した操作は、置き場と同じく書かない
/// （書くと、ほかのデバイスで、重なりが解けても既定のキーに戻らなくなる）。
fn draft_keys_value(config: &Config) -> Value {
    Value::Object(
        DraftAction::ALL
            .into_iter()
            .filter(|action| !config.yielded_draft_keys.contains(action))
            .map(|action| {
                (
                    action.name().to_string(),
                    Value::String(config.text_window_keys.get(action).to_string()),
                )
            })
            .collect(),
    )
}

fn valid_wire_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind<'a> {
    Setting(&'a str),
    Replacement(&'a str),
    Snippet(&'a str),
    Order(&'a str),
}

impl Kind<'_> {
    fn sync_kind(self) -> SyncKind {
        match self {
            Self::Setting(name) if is_key_setting(name) => SyncKind::Keys,
            Self::Setting(_) => SyncKind::Settings,
            Self::Replacement(_) | Self::Order("replacements") => SyncKind::Replacements,
            Self::Snippet(_) | Self::Order("snippets") => SyncKind::Snippets,
            Self::Order(_) => unreachable!("only the two row orders are known"),
        }
    }
}

/// 窓口の別用途の項目は、古い版が消したり書き戻したりしないよう最初に除く。
fn kind(key: &ItemKey) -> Option<Kind<'_>> {
    if key.collection != SETTINGS || !valid_wire_id(&key.id) {
        return None;
    }
    if let Some(name) = key.id.strip_prefix("s_") {
        return known_setting(name).then_some(Kind::Setting(name));
    }
    if let Some(id) = key.id.strip_prefix("r_") {
        return valid_item_id(id).then_some(Kind::Replacement(id));
    }
    if let Some(id) = key.id.strip_prefix("n_") {
        return valid_item_id(id).then_some(Kind::Snippet(id));
    }
    match key.id.as_str() {
        "o_replacements" => Some(Kind::Order("replacements")),
        "o_snippets" => Some(Kind::Order("snippets")),
        _ => None,
    }
}

fn is_order(key: &ItemKey) -> bool {
    matches!(kind(key), Some(Kind::Order(_)))
}

/// この項目名の設定を、種類「設定」から外せる。画面に渡す一覧と窓口の id の検査を同じ定義から作る。
pub const SYNCABLE_SETTING_NAMES: &[&str] = &[
    "language",
    "theme",
    "text_window_always_on_top",
    "hide_text_window_on_blur",
    "show_text_window_buttons",
    "text_history_size",
    "trim_trailing_whitespace",
    "punctuation_style",
    "alphabet_width",
    "digit_width",
    "space_width",
    "symbol_width",
    "katakana_width",
    "exclude_from_clipboard_history",
    "text_font_family",
    "text_font_size",
    "text_color_light",
    "text_color_dark",
    "input_guidance",
    "ai_service",
    "ai_models",
    "ai_base_url",
];

pub fn known_syncable_setting(name: &str) -> bool {
    SYNCABLE_SETTING_NAMES.contains(&name)
}

fn is_key_setting(name: &str) -> bool {
    name == hotkey_name() || name == text_window_keys_name()
}

fn sync_enabled(config: &Config, key: &ItemKey) -> bool {
    let Some(kind) = kind(key) else {
        return false;
    };
    if !kinds(config).enabled(kind.sync_kind()) {
        return false;
    }
    !matches!(kind, Kind::Setting(name) if !is_key_setting(name) && config.sync_excluded_settings.iter().any(|excluded| excluded == name))
}

fn paused_groups(config: &Config) -> Vec<String> {
    let mut groups = SyncKind::ALL
        .into_iter()
        .filter(|kind| !kinds(config).enabled(*kind))
        .map(|kind| kind.group().to_string())
        .collect::<Vec<_>>();
    groups.extend(
        config
            .sync_excluded_settings
            .iter()
            .filter(|name| known_syncable_setting(name))
            .map(|name| setting_item(name).name()),
    );
    groups
}

fn paused_group(config: &Config, group: &str) -> bool {
    SyncKind::of_group(group).is_some_and(|kind| !kinds(config).enabled(kind))
        || config
            .sync_excluded_settings
            .iter()
            .filter(|name| known_syncable_setting(name))
            .any(|name| setting_item(name).name() == group)
        // 種類「設定」がオフの間に除外をやめた項目は、まだ読んでいない。種類をオンに戻して読む回まで位置を残す
        || (!config.sync_settings
            && key_of(group).is_some_and(
                |key| matches!(kind(&key), Some(Kind::Setting(name)) if !is_key_setting(name)),
            ))
}

/// 同期の開始時点で決めた、まとまりごとの「初めての同期」。当て直しでも同じ記録を使う。
#[derive(Clone)]
struct Initial {
    no_record: bool,
    since: u64,
    paused: BTreeMap<String, u64>,
}

impl Initial {
    fn new(no_record: bool, state: &State) -> Self {
        Self {
            no_record,
            since: state.since,
            paused: state.paused.clone(),
        }
    }

    fn for_kind(&self, kind: SyncKind) -> bool {
        self.no_record || self.paused.get(kind.group()).copied().unwrap_or(self.since) == 0
    }

    fn for_key(&self, key: &ItemKey) -> bool {
        let Some(kind) = kind(key) else {
            return false;
        };
        self.for_kind(kind.sync_kind())
            || matches!(kind, Kind::Setting(name) if !is_key_setting(name))
                && self.paused.get(&key.name()).copied().unwrap_or(self.since) == 0
    }
}

/// テキストウィンドウの履歴の全体を置く項目（docs/sync.md「履歴の同期」）。
fn history_item() -> ItemKey {
    ItemKey::new(HISTORY, HISTORY_ID)
}

/// この版が読み書きする項目か。
fn handled(key: &ItemKey) -> bool {
    kind(key).is_some() || *key == history_item()
}

fn known_setting(name: &str) -> bool {
    known_syncable_setting(name) || is_key_setting(name)
}

/// 設定を、窓口に置く粒度の平文値へ変換する。同期しない項目はここに現れない。
pub fn config_items(config: &Config) -> BTreeMap<ItemKey, Value> {
    let mut items = BTreeMap::new();
    for name in SYNCABLE_SETTING_NAMES {
        let value = match *name {
            "language" => json(config.language),
            "theme" => json(config.theme),
            "text_window_always_on_top" => json(config.text_window_always_on_top),
            "hide_text_window_on_blur" => json(config.hide_text_window_on_blur),
            "show_text_window_buttons" => json(config.show_text_window_buttons),
            "text_history_size" => json(config.text_history_size),
            "trim_trailing_whitespace" => json(config.trim_trailing_whitespace),
            "punctuation_style" => json(config.punctuation_style),
            "alphabet_width" => json(config.char_widths.alphabet),
            "digit_width" => json(config.char_widths.digit),
            "space_width" => json(config.char_widths.space),
            "symbol_width" => json(config.char_widths.symbol),
            "katakana_width" => json(config.char_widths.katakana),
            "exclude_from_clipboard_history" => json(config.exclude_from_clipboard_history),
            "text_font_family" => json(config.text_font_family.clone()),
            "text_font_size" => json(config.text_font_size),
            "text_color_light" => json(config.text_color_light.clone()),
            "text_color_dark" => json(config.text_color_dark.clone()),
            "input_guidance" => json(config.input_guidance.clone()),
            "ai_service" => json(config.ai_service),
            "ai_models" => json(config.ai_models.clone()),
            "ai_base_url" => json(config.ai_base_url.clone()),
            _ => unreachable!("all syncable setting names have a value"),
        };
        items.insert(setting_item(name), value);
    }
    items.insert(hotkey_item(), json(config.hotkey.clone()));
    items.insert(text_window_keys_item(), draft_keys_value(config));
    put_rows(&mut items, 'r', "replacements", &config.replacements);
    if let Some(snippets) = &config.snippets {
        put_rows(&mut items, 'n', "snippets", snippets);
    }
    items
}

/// 同期する行と、その並びを書き出す。
fn put_rows<T: SyncRow>(
    items: &mut BTreeMap<ItemKey, Value>,
    prefix: char,
    name: &str,
    rows: &[T],
) {
    let synced = || rows.iter().filter(|row| row.sync());
    for row in synced() {
        set(items, row_id(prefix, row.id()), row_value(row));
    }
    let order: Vec<&str> = synced().map(|row| row.id()).collect();
    set(items, order_id(name), json(order));
}

/// 今のデバイスで同期を許可している項目だけ。`config_items` は oplog の比べ（`changed_items`）と受信時の比較にも使うため、全項目を返す。
fn sync_items(config: &Config) -> BTreeMap<ItemKey, Value> {
    config_items(config)
        .into_iter()
        .filter(|(key, _)| sync_enabled(config, key))
        .collect()
}

fn row_value<T: Serialize>(row: &T) -> Value {
    let mut value = serde_json::to_value(row).expect("row serializes");
    let object = value.as_object_mut().expect("row is an object");
    object.remove("id");
    object.remove("sync");
    value
}

fn parse<T: for<'a> Deserialize<'a>>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

fn apply_value(config: &mut Config, item: &ItemKey, value: &Value) -> bool {
    match kind(item) {
        Some(Kind::Setting(name)) if name == hotkey_name() => {
            let Some(hotkey) = parse::<String>(value) else {
                return false;
            };
            if crate::draft_keys::check_hotkey(
                &config.text_window_keys,
                &hotkey,
                Platform::current(),
            )
            .is_err()
            {
                return false;
            }
            config.hotkey = hotkey;
            true
        }
        Some(Kind::Setting(name)) if name == text_window_keys_name() => {
            apply_draft_keys(config, value)
        }
        Some(Kind::Setting(name)) => config::apply_setting(config, name, value),
        Some(Kind::Replacement(id)) => apply_row(&mut config.replacements, id, value),
        Some(Kind::Snippet(id)) => apply_snippet_row(config, id, value),
        Some(Kind::Order("replacements")) => apply_order(&mut config.replacements, value),
        // 入れられない並びのために、既定の定型文を書き出さない
        Some(Kind::Order("snippets")) => {
            order_ids(value).is_some() && apply_order(synced_snippets(config), value)
        }
        _ => false,
    }
}

/// 定型文の行。既定の定型文のままのデバイスでは、同期しない既定の定型文だけを設定に書き出す
/// （docs/sync.md「同期する単位」）。同期する行は、届いたものだけにする。
fn synced_snippets(config: &mut Config) -> &mut Vec<Snippet> {
    let language = config.language;
    config
        .snippets
        .get_or_insert_with(|| unsynced_defaults(language, None))
}

fn default_snippets_for(language: Language) -> Vec<Snippet> {
    actions::default_snippets(Lang::resolve(language, Lang::system()))
}

/// 設定に書き出す既定の定型文。同期しないものと、ほかのデバイスが同期から外した `detached` の id のもの。
fn unsynced_defaults(language: Language, detached: Option<&str>) -> Vec<Snippet> {
    let mut defaults = default_snippets_for(language);
    for snippet in &mut defaults {
        if detached == Some(snippet.id.as_str()) {
            snippet.sync = false;
        }
    }
    defaults.retain(|snippet| !snippet.sync);
    defaults
}

/// 既定で同期する既定の定型文か。
fn synced_default_snippet(id: &str) -> bool {
    actions::default_snippets(crate::i18n::Lang::En)
        .iter()
        .any(|snippet| snippet.id == id && snippet.sync)
}

fn apply_snippet_row(config: &mut Config, id: &str, value: &Value) -> bool {
    // 入れられない行のために、既定の定型文を書き出さない
    if parse::<Snippet>(value).is_none() {
        return false;
    }
    let rows = synced_snippets(config);
    let is_new = rows.iter().all(|row| row.id != id);
    if !apply_row(rows, id, value) {
        return false;
    }
    if is_new {
        seat_default_snippet(rows);
    }
    true
}

/// 末尾に足した行が既定の定型文なら、既定の並びで次にある同期しない既定の定型文の前へ動かす。
/// 同期しない行は直前の行の後ろに置く決まりなので、並びが届いたときに、既定の並びのとおりに付いて動く。
fn seat_default_snippet(rows: &mut Vec<Snippet>) {
    let defaults = actions::default_snippets(crate::i18n::Lang::En);
    let Some(added) = rows.last() else {
        return;
    };
    let follower = defaults
        .iter()
        .position(|default| default.id == added.id)
        .and_then(|position| defaults.get(position + 1))
        .and_then(|next| rows.iter().position(|row| row.id == next.id && !row.sync));
    if let Some(index) = follower {
        let row = rows.pop().expect("a row was just added");
        rows.insert(index, row);
    }
}

fn apply_draft_keys(config: &mut Config, value: &Value) -> bool {
    // 無い操作は、書いていないのと同じく既定のキーを使う
    let parsed = crate::draft_keys::parse(Some(value), Platform::current());
    if !parsed.repaired.is_empty() {
        return false;
    }
    let mut keys = parsed.keys;
    let resolved = crate::draft_keys::resolve_conflicts(
        &mut keys,
        &config.hotkey,
        Platform::current(),
        &parsed.written,
    );
    // 届いたキーを外して入れると、手元の値が届いた値と違うものになり、外した値を書き戻してしまう。
    // 画面から割り当てるときと同じく、重なるキーは断る
    if !resolved.removed.is_empty() {
        return false;
    }
    config.text_window_keys = keys;
    config.yielded_draft_keys = resolved.yielded;
    true
}

fn apply_row<T: SyncRow>(rows: &mut Vec<T>, id: &str, value: &Value) -> bool {
    let mut row: T = match parse(value) {
        Some(row) => row,
        None => return false,
    };
    row.set_id(id.to_string());
    row.set_sync(true);
    if let Some(old) = rows.iter_mut().find(|old| old.id() == id) {
        *old = row;
    } else {
        rows.push(row);
    }
    true
}

fn order_ids(value: &Value) -> Option<Vec<String>> {
    parse::<Vec<String>>(value).filter(|ids| ids.iter().all(|id| valid_item_id(id)))
}

fn apply_order<T: SyncRow>(rows: &mut Vec<T>, value: &Value) -> bool {
    let Some(order) = order_ids(value) else {
        return false;
    };
    let mut leading = Vec::new();
    let mut groups = BTreeMap::<String, (T, Vec<T>)>::new();
    let mut original = Vec::new();
    let mut previous = None;
    for row in std::mem::take(rows) {
        if row.sync() {
            let id = row.id().to_string();
            original.push(id.clone());
            groups.insert(id.clone(), (row, Vec::new()));
            previous = Some(id);
        } else if let Some(id) = &previous {
            groups
                .get_mut(id)
                .expect("the preceding row exists")
                .1
                .push(row);
        } else {
            leading.push(row);
        }
    }
    let mut reordered = leading;
    let mut add = |id: &str| {
        if let Some((row, mut following)) = groups.remove(id) {
            reordered.push(row);
            reordered.append(&mut following);
        }
    };
    let mut seen = BTreeSet::new();
    for id in &order {
        if seen.insert(id) {
            add(id);
        }
    }
    for id in original {
        add(&id);
    }
    *rows = reordered;
    true
}

fn remove_local(config: &mut Config, item: &ItemKey) -> bool {
    match kind(item) {
        Some(Kind::Replacement(id)) => remove_row(&mut config.replacements, id),
        Some(Kind::Snippet(id)) => config
            .snippets
            .as_mut()
            .is_some_and(|rows| remove_row(rows, id)),
        _ => false,
    }
}
fn detach_local(config: &mut Config, item: &ItemKey) -> bool {
    match kind(item) {
        Some(Kind::Replacement(id)) => detach_row(&mut config.replacements, id),
        Some(Kind::Snippet(id)) => match &mut config.snippets {
            Some(rows) => detach_row(rows, id),
            // 既定の定型文のままのデバイスでは、外された既定の定型文を同期しない行として書き出す。
            // 書き出さないと、並びが届いたときに、誰も消していないのに手元から消える
            None if synced_default_snippet(id) => {
                config.snippets = Some(unsynced_defaults(config.language, Some(id)));
                true
            }
            None => false,
        },
        _ => false,
    }
}
fn remove_row<T: SyncRow>(rows: &mut Vec<T>, id: &str) -> bool {
    let before = rows.len();
    rows.retain(|row| row.id() != id);
    before != rows.len()
}
fn detach_row<T: SyncRow>(rows: &mut [T], id: &str) -> bool {
    if let Some(row) = rows.iter_mut().find(|row| row.id() == id) {
        row.set_sync(false);
        true
    } else {
        false
    }
}

fn detached(config: &Config, item: &ItemKey) -> bool {
    match kind(item) {
        Some(Kind::Replacement(id)) => config
            .replacements
            .iter()
            .any(|row| row.id == id && !row.sync),
        Some(Kind::Snippet(id)) => match &config.snippets {
            Some(rows) => rows.iter().any(|row| row.id == id && !row.sync),
            // 既定の定型文のままでも、同期しない既定の定型文は手元の行
            None => actions::default_snippets(crate::i18n::Lang::En)
                .iter()
                .any(|row| row.id == id && !row.sync),
        },
        _ => false,
    }
}

fn synced_ids<T: SyncRow>(rows: &[T]) -> BTreeSet<&str> {
    rows.iter()
        .filter(|row| row.sync())
        .map(|row| row.id())
        .collect()
}

/// 届いた値を手元に入れたときに、記録に置く値。並びは、手元で同期する行として持っている id だけを残す
/// （docs/sync.md「同期する単位」）。ほかの id（同期しない行・手元に無い行）は手元の並び（`config_items`）に
/// 現れないので、残すと手元を変えたように見え、除いた並びを書き戻し続ける。
fn settled_value(config: &Config, key: &ItemKey, value: &Value) -> Value {
    let synced = match kind(key) {
        Some(Kind::Order("replacements")) => synced_ids(&config.replacements),
        Some(Kind::Order("snippets")) => synced_ids(config.snippets.as_deref().unwrap_or_default()),
        _ => return value.clone(),
    };
    let Some(ids) = order_ids(value) else {
        return value.clone();
    };
    json(
        ids.into_iter()
            .filter(|id| synced.contains(id.as_str()))
            .collect::<Vec<_>>(),
    )
}

/// 窓口に無い手元の行のうち、中身が窓口の行と同じものを落とす（残る窓口の行が、その `id` で手元の行になる）。
/// 窓口の行どうしは、別々のデバイスが意図して置いた2行でありうるので、1つにしない。
fn dedupe_initial_rows<T: SyncRow>(rows: &mut Vec<T>, on_server: &BTreeSet<String>) -> bool {
    let server_values: BTreeSet<String> = rows
        .iter()
        .filter(|row| on_server.contains(row.id()))
        .map(|row| row_value(row).to_string())
        .collect();
    let before = rows.len();
    rows.retain(|row| {
        !row.sync()
            || on_server.contains(row.id())
            || !server_values.contains(&row_value(row).to_string())
    });
    before != rows.len()
}

/// 初めて同期する種類だけ、同じ内容で別の id の行を 1 つにする。行ごとの id を作らず、種類の開始状態で決める。
fn dedupe_initial_config_rows(config: &mut Config, state: &State, initial: &Initial) -> bool {
    // 記録にある行（この回に窓口から入れた行と、前の回に自分が書いた行）が、窓口にある行
    let on_server = |prefix: &str| {
        let prefix = ItemKey::new(SETTINGS, prefix).name();
        state
            .items
            .keys()
            .filter_map(|name| name.strip_prefix(&prefix))
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
    };
    let mut changed = false;
    if initial.for_kind(SyncKind::Replacements) {
        changed |= dedupe_initial_rows(&mut config.replacements, &on_server("r_"));
    }
    if initial.for_kind(SyncKind::Snippets) {
        if let Some(snippets) = &mut config.snippets {
            changed |= dedupe_initial_rows(snippets, &on_server("n_"));
        }
    }
    changed
}

/// 控えと今の行で id だけが違う同じ内容の行は、今の id を控えの並びの位置へ置く。
/// 控えを戻すときにその行を消して足すと、次の同期でほかのデバイスからも消してしまう。
fn match_restore_rows<T: SyncRow>(backup_rows: &mut [T], current_rows: &[T]) {
    let backup_ids: BTreeSet<_> = backup_rows.iter().map(|row| row.id().to_string()).collect();
    let current_ids: BTreeSet<_> = current_rows.iter().map(|row| row.id()).collect();
    let mut matched_current_ids = BTreeSet::new();
    for backup in backup_rows
        .iter_mut()
        .filter(|row| row.sync() && !current_ids.contains(row.id()))
    {
        let matching_id = current_rows
            .iter()
            .find(|current| {
                current.sync()
                    && !backup_ids.contains(current.id())
                    && !matched_current_ids.contains(current.id())
                    && row_value(*current) == row_value(&*backup)
            })
            .map(|current| current.id().to_string());
        if let Some(id) = matching_id {
            matched_current_ids.insert(id.clone());
            backup.set_id(id);
        }
    }
}

#[derive(Debug, Clone)]
pub struct RemoteItem {
    pub key: ItemKey,
    pub seq: u64,
    pub deleted: bool,
    pub plain: Option<Plain>,
}

/// 窓口の1項目が伝えていること。
enum Incoming<'a> {
    Deleted,
    Detached,
    Value(&'a Value),
    /// 復号できない・知らない `v`（`decrypt` が平文を返さない）。
    Unreadable,
}

impl RemoteItem {
    fn incoming(&self) -> Incoming<'_> {
        if self.deleted {
            return Incoming::Deleted;
        }
        match &self.plain {
            Some(plain) if plain.detached => Incoming::Detached,
            Some(Plain {
                value: Some(value), ..
            }) => Incoming::Value(value),
            _ => Incoming::Unreadable,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Write {
    pub key: ItemKey,
    pub base_seq: Option<u64>,
    pub deleted: bool,
    pub plain: Option<Value>,
    pub detached: bool,
    /// 手元でその値にした時刻（oplog の時刻）。分からなければ 0
    pub at: u64,
}

impl Write {
    /// 窓口に置く平文。消す項目には無い。
    fn payload(&self) -> Option<Plain> {
        let plain = if self.deleted {
            return None;
        } else if self.detached {
            Plain::detached()
        } else {
            Plain::value(self.plain.clone()?)
        };
        Some(Plain {
            at: self.at,
            ..plain
        })
    }
}

#[derive(Debug, Clone)]
pub struct Reconcile {
    pub config: Config,
    pub state: State,
    pub writes: Vec<Write>,
    pub changed: bool,
    /// まだ窓口へ送っていない手元の変更（oplog）。窓口の値を入れた項目と、書けた項目は抜いていく
    pub pending: BTreeMap<String, u64>,
    /// 窓口の値を入れたので、oplog から外す項目と、そのとき見ていた oplog の時刻
    pub accepted: Vec<(String, u64)>,
}

/// 通信を含まない同期の決まり。読む結果を検査済みの `RemoteItem` として渡し、次の設定・記録・書く項目を返す。
/// 書く項目の記録は、窓口に書けてから `sync_once_with` が置く。
#[cfg(test)]
pub fn reconcile(
    local: &Config,
    old: Option<State>,
    outbox: &BTreeMap<String, u64>,
    remote: &[RemoteItem],
    key_id: &str,
    since: u64,
) -> Reconcile {
    let no_record = old.is_none();
    let state = old.unwrap_or_default();
    let initial = Initial::new(no_record, &state);
    reconcile_as(
        local,
        state,
        &initial,
        outbox.clone(),
        remote,
        key_id,
        since,
    )
}

/// まだ見ていない、この版が扱う項目か。
fn is_new(state: &State, remote: &RemoteItem) -> bool {
    let name = remote.key.name();
    kind(&remote.key).is_some() && state.seen_seq(&name).is_none_or(|seq| remote.seq > seq)
}

/// 1回の当て直しで、手元の設定・記録・oplog をまとめて動かす。
struct Receiving<'a> {
    config: &'a mut Config,
    state: &'a mut State,
    pending: &'a mut BTreeMap<String, u64>,
    accepted: &'a mut Vec<(String, u64)>,
}

impl Receiving<'_> {
    /// 窓口の値を手元に入れたので、その項目の oplog を外す。
    fn accept(&mut self, name: &str) {
        if let Some(at) = self.pending.remove(name) {
            self.accepted.push((name.to_string(), at));
        }
    }
}

/// 窓口の1項目を、決まりに照らして手元の設定と記録に入れる。手元の設定を変えたかを返す。
fn receive(
    target: &mut Receiving<'_>,
    local_items: &BTreeMap<ItemKey, Value>,
    initial: bool,
    remote: &RemoteItem,
) -> bool {
    if !is_new(target.state, remote) {
        return false;
    }
    let name = remote.key.name();
    let mut changed = false;
    // 同期から外した手元の行は、同じ id の項目が届いても、中身も `sync` も変えない（docs/sync.md「同期する単位」）。
    if detached(target.config, &remote.key) {
        match target.state.items.get_mut(&name) {
            // 外した印をまだ書いていない。ほかのデバイスの写しを切り離すため、届いた項目の上に印を書く
            Some(seen) if !matches!(remote.incoming(), Incoming::Detached) => {
                seen.seq = remote.seq;
            }
            // 届いた `seq` は置いておき、印を付け直したときの `base_seq` にする
            _ => target.state.retire(name, remote.seq),
        }
        return changed;
    }
    let previous = target.state.items.get(&name).cloned();
    // 記録がある項目（前の回に自分が書いた項目）は、初めての同期でも、いつもの決まりで比べる。
    // 窓口の値を無条件に入れると、書いた後に手元で変えた値を巻き戻す
    if initial && previous.is_none() {
        match remote.incoming() {
            Incoming::Value(value) => {
                if apply_value(target.config, &remote.key, value) {
                    changed = true;
                    let settled = settled_value(target.config, &remote.key, value);
                    target.state.settle(name.clone(), remote.seq, &settled);
                    target.accept(&name);
                } else {
                    target.state.ignored.insert(name, remote.seq);
                }
            }
            Incoming::Detached => {
                changed |= detach_local(target.config, &remote.key);
                target.state.retire(name.clone(), remote.seq);
                target.accept(&name);
            }
            Incoming::Deleted => {
                changed |= remove_local(target.config, &remote.key);
                target.state.retire(name.clone(), remote.seq);
                target.accept(&name);
            }
            Incoming::Unreadable => {
                target.state.ignored.insert(name, remote.seq);
            }
        }
        return changed;
    }
    // 並びは、同じ回に届いた行を入れる前の手元の並びで比べる。
    // 入れた後で比べると、届いた行の分だけ並びが変わって見える
    let order = is_order(&remote.key);
    let current = if order {
        local_items.get(&remote.key).cloned()
    } else {
        config_items(target.config).get(&remote.key).cloned()
    };
    // 手元で変えて、まだ送っていない時刻。並びは食い違いにせず混ぜるので見ない。
    // 変えてから記録の値に戻した項目は、手元では何も変えていないので、窓口の値を入れる
    let reverted = previous
        .as_ref()
        .is_some_and(|seen| current.as_ref().map(hash_plain) == Some(seen.hash));
    let local_change = target
        .pending
        .get(&name)
        .copied()
        .filter(|_| !order && !reverted);
    match remote.incoming() {
        Incoming::Deleted => {
            if current.is_none() {
                // 手元でも消したか、外している。記録が無ければ、もともと持っていない行
                if previous.is_some() {
                    target.state.retire(name.clone(), remote.seq);
                }
                target.accept(&name);
            } else if local_change.is_none() {
                changed |= remove_local(target.config, &remote.key);
                target.state.retire(name, remote.seq);
            } else {
                // 手元で変えた行は、ほかのデバイスで消されても残し、書き直す（docs/sync.md「食い違い」）
                target.state.retire(name, remote.seq);
            }
        }
        Incoming::Detached => {
            changed |= detach_local(target.config, &remote.key);
            target.state.retire(name.clone(), remote.seq);
            target.accept(&name);
        }
        Incoming::Unreadable => {
            target.state.ignored.insert(name, remote.seq);
        }
        Incoming::Value(value) => {
            let remote_at = remote.plain.as_ref().map_or(0, |plain| plain.at);
            if !is_known_value(target.config, &remote.key, value) {
                target.state.ignored.insert(name, remote.seq);
            } else if local_change.is_some_and(|at| at > remote_at)
                // 手元で消した行は、ほかのデバイスで変えられたら時刻によらず残す（docs/sync.md「食い違い」）
                && current.is_some()
                && current.as_ref() != Some(value)
            {
                // 手元の方が後に変えた。記録を窓口の今の項目に進めて、次に手元の値で上書きする
                target.state.settle(name, remote.seq, value);
            } else {
                // 並びは、届いた並びの後ろに手元にだけある行を続けて合わせる（docs/sync.md「食い違い」）。
                // 足した分は、記録と違う並びとして次に書く
                changed |= apply_value(target.config, &remote.key, value);
                let settled = settled_value(target.config, &remote.key, value);
                target.state.settle(name.clone(), remote.seq, &settled);
                target.accept(&name);
            }
        }
    }
    changed
}

/// 同じ回に届いたホットキーとキー操作を入れる。片方ずつ今の手元と照らすと、キーを入れ替えた組
/// （操作から外したキーをホットキーにする など）を、重なりとして読み捨ててしまう。
/// 組でも検査を通らなければ、両方を読み捨てて、手元はどちらも変えない
fn receive_key_pair(
    target: &mut Receiving<'_>,
    local_items: &BTreeMap<ItemKey, Value>,
    initial: bool,
    hotkey: &RemoteItem,
    keys: &RemoteItem,
) -> bool {
    let before = (
        target.config.clone(),
        target.state.clone(),
        target.pending.clone(),
        target.accepted.len(),
    );
    // キー操作は、これから替わるホットキーとは照らさずに入れ、ホットキーを入れた後で照らし直す
    let local_hotkey = std::mem::take(&mut target.config.hotkey);
    let mut changed = receive(target, local_items, initial, keys);
    target.config.hotkey = local_hotkey;
    changed |= receive(target, local_items, initial, hotkey);
    let ignored = [hotkey, keys]
        .iter()
        .any(|item| target.state.ignored.get(&item.key.name()) == Some(&item.seq));
    let keys_applied = target
        .state
        .items
        .get(&keys.key.name())
        .is_some_and(|seen| seen.seq == keys.seq)
        && target.pending.get(&keys.key.name()).is_none();
    let consistent = match keys.incoming() {
        Incoming::Value(value) if keys_applied => apply_value(target.config, &keys.key, value),
        _ => crate::draft_keys::check_hotkey(
            &target.config.text_window_keys,
            &target.config.hotkey,
            Platform::current(),
        )
        .is_ok(),
    };
    if ignored || !consistent {
        let (config, state, pending, accepted) = before;
        *target.config = config;
        *target.state = state;
        *target.pending = pending;
        target.accepted.truncate(accepted);
        for item in [hotkey, keys] {
            target.state.ignored.insert(item.key.name(), item.seq);
        }
        return false;
    }
    changed
}

/// `initial` は、この同期が「初めての同期」か。`conflict` を受けて当て直す間も、同じ決まりで合わせる。
/// `pending` は、まだ窓口へ送っていない手元の変更（oplog）。
fn reconcile_as(
    local: &Config,
    mut state: State,
    initial: &Initial,
    mut pending: BTreeMap<String, u64>,
    remote: &[RemoteItem],
    key_id: &str,
    since: u64,
) -> Reconcile {
    let mut config = local.clone();
    state.key_id = key_id.to_string();
    state.since = since;
    let mut accepted = Vec::new();
    let mut changed = false;
    let local_items = config_items(local);
    let mut sorted: Vec<RemoteItem> = remote
        .iter()
        .filter(|remote| sync_enabled(local, &remote.key))
        .cloned()
        .collect();
    // 言語を先に入れてから、None の定型文を既定から実体化する。並びは最後にしないと同じ回の行を並べ替えられない。
    // 外した印は行より先に入れる。行が先に既定の定型文を実体化すると、外された既定の定型文を残せない。
    sorted.sort_by_key(|item| {
        (
            match kind(&item.key) {
                Some(Kind::Setting(_)) => 0,
                Some(Kind::Order(_)) => 3,
                _ if matches!(item.incoming(), Incoming::Detached) => 1,
                _ => 2,
            },
            item.seq,
        )
    });
    // ホットキーとキー操作は互いに重なりを見るので、同じ回に両方が届いたら、組にして入れる
    let position = |key: ItemKey| {
        sorted.iter().position(|item| {
            item.key == key && is_new(&state, item) && matches!(item.incoming(), Incoming::Value(_))
        })
    };
    let pair = position(hotkey_item()).zip(position(text_window_keys_item()));
    {
        let mut target = Receiving {
            config: &mut config,
            state: &mut state,
            pending: &mut pending,
            accepted: &mut accepted,
        };
        for (index, remote) in sorted.iter().enumerate() {
            match pair {
                Some((hotkey, keys)) if index == hotkey.min(keys) => {
                    changed |= receive_key_pair(
                        &mut target,
                        &local_items,
                        initial.for_key(&sorted[hotkey].key),
                        &sorted[hotkey],
                        &sorted[keys],
                    );
                }
                Some((hotkey, keys)) if index == hotkey.max(keys) => {}
                _ => {
                    changed |= receive(
                        &mut target,
                        &local_items,
                        initial.for_key(&remote.key),
                        remote,
                    )
                }
            }
        }
    }
    changed |= dedupe_initial_config_rows(&mut config, &state, initial);
    let now = sync_items(&config);
    let hashes: BTreeMap<String, [u8; 32]> = now
        .iter()
        .map(|(key, value)| (key.name(), hash_plain(value)))
        .collect();
    // 手元の値が変わった（か、無くなった）項目は、もう一度書いてみる
    state
        .too_large
        .retain(|name, hash| hashes.get(name) == Some(hash));
    // 手元にも記録にも無い項目（窓口に一度も書かないまま消した行など）と、変えてから記録の値に戻した項目
    // （並べ替えて戻した並びも）は、書くものが無いので oplog から外す。書くと、新しい時刻で、ほかのデバイスが
    // 後から変えた値を上書きする
    let present = config_items(&config);
    let stale: Vec<String> = pending
        .keys()
        .filter(|name| match state.items.get(*name) {
            Some(seen) => hashes.get(*name) == Some(&seen.hash),
            None => {
                key_of(name).is_none_or(|key| kind(&key).is_none() || !present.contains_key(&key))
            }
        })
        .cloned()
        .collect();
    for name in stale {
        let at = pending.remove(&name).expect("the stale name is pending");
        accepted.push((name, at));
    }
    let held = |state: &State, name: &str| state.ignored.contains_key(name);
    let at = |name: &str| pending.get(name).copied().unwrap_or(0);
    let mut writes = Vec::new();
    // 既定で同期する既定の定型文を、一度も書かないまま同期から外した。窓口に項目が無いと、ほかのデバイスには
    // 並びから消えたことしか伝わらず、消した行と見分けられないので、外した印を書く。
    // 何回かに分けて書くときに、その行を抜いた並びだけが先に届かないよう、ほかの項目より前に積む
    if kinds(&config).snippets {
        for default in actions::default_snippets(crate::i18n::Lang::En) {
            let key = ItemKey::new(SETTINGS, row_id('n', &default.id));
            let name = key.name();
            if default.sync
                && detached(&config, &key)
                && !state.items.contains_key(&name)
                && !state.retired.contains_key(&name)
                && !held(&state, &name)
            {
                writes.push(Write {
                    at: at(&name),
                    key,
                    base_seq: None,
                    deleted: false,
                    plain: None,
                    detached: true,
                });
            }
        }
    }
    for (key, value) in &now {
        let name = key.name();
        if held(&state, &name) || state.too_large.contains_key(&name) {
            continue;
        }
        let seen = state.items.get(&name);
        // まだ書いていない項目と、手元で変えた項目を書く。並びは混ぜて揃えるので、揃えたときの値と比べる
        let write = match seen {
            None => true,
            Some(seen) if is_order(key) => seen.hash != hashes[&name],
            Some(_) => pending.contains_key(&name),
        };
        if write {
            writes.push(Write {
                at: at(&name),
                key: key.clone(),
                base_seq: seen
                    .map(|seen| seen.seq)
                    .or_else(|| state.retired.get(&name).copied()),
                deleted: false,
                plain: Some(value.clone()),
                detached: false,
            });
        }
    }
    // 手元で消した・同期から外した行
    for (name, seen) in &state.items {
        let Some(key) = key_of(name) else {
            continue;
        };
        if kind(&key).is_none()
            || !sync_enabled(&config, &key)
            || now.contains_key(&key)
            || held(&state, name)
            || !pending.contains_key(name)
        {
            continue;
        }
        let detached = detached(&config, &key);
        writes.push(Write {
            at: at(name),
            key,
            base_seq: Some(seen.seq),
            deleted: !detached,
            plain: None,
            detached,
        });
    }
    Reconcile {
        config,
        state,
        writes,
        changed,
        pending,
        accepted,
    }
}

fn is_known_value(config: &Config, key: &ItemKey, value: &Value) -> bool {
    let mut checked = config.clone();
    apply_value(&mut checked, key, value)
}

/// 同期の1項目の値。種類は設定の項目名（OS ごとの項目は、`_macos`・`_windows` を除いた名前）と、行の種類。
/// バックアップから戻す画面が、設定の画面と同じ言い方で出す。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SyncValue {
    Language(Language),
    Theme(Theme),
    TextWindowAlwaysOnTop(bool),
    HideTextWindowOnBlur(bool),
    ShowTextWindowButtons(bool),
    TextHistorySize(u16),
    TrimTrailingWhitespace(bool),
    PunctuationStyle(PunctuationStyle),
    AlphabetWidth(WidthStyle),
    DigitWidth(WidthStyle),
    SpaceWidth(WidthStyle),
    SymbolWidth(WidthStyle),
    KatakanaWidth(KatakanaWidth),
    ExcludeFromClipboardHistory(bool),
    TextFontSize(u16),
    TextColorLight(String),
    TextColorDark(String),
    InputGuidance(Option<String>),
    AiService(AiService),
    AiModels(BTreeMap<AiService, String>),
    AiBaseUrl(String),
    Hotkey(String),
    TextWindowKeys(DraftKeys),
    TextFontFamily(String),
    Replacement(Replacement),
    Snippet(Snippet),
    /// 行の並び。
    Order(String),
    /// 行を消した。
    Deleted,
}

/// バックアップから戻すと変わる1項目（docs/config.md「バックアップ」）。粒度は同期の項目と同じ。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BackupDifference {
    pub id: String,
    pub current: SyncValue,
    pub restored: SyncValue,
}

/// 戻す画面に並べるバックアップ。名前は UTC の作成日時で、画面は今との違いを選ぶ手がかりとして出す。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub name: String,
    pub changes: Vec<BackupDifference>,
}

/// バックアップへ戻した後の設定。デバイスごとに決める項目（ログイン時の起動・AI の了解・同期のスイッチと除外）は今のまま残す。
/// 戻した値は、手元で変えた値として同期でほかのデバイスにも届く
pub fn restore_backup(current: &Config, backup: &Config) -> Config {
    let mut restored = Config {
        autostart: current.autostart,
        ai_consent: current.ai_consent,
        ai_consent_base_url: current.ai_consent_base_url.clone(),
        sync_settings: current.sync_settings,
        sync_keys: current.sync_keys,
        sync_replacements: current.sync_replacements,
        sync_snippets: current.sync_snippets,
        sync_history: current.sync_history,
        sync_excluded_settings: current.sync_excluded_settings.clone(),
        ..backup.clone()
    };
    // 今が行を持っていて、バックアップが既定の定型文のままなら、既定の定型文を行として戻す。
    // 既定のままという表現に戻すと行の項目が無くなり、同期している行を消したものとしてほかのデバイスからも消す
    if restored.snippets.is_none() && current.snippets.is_some() {
        restored.snippets = Some(default_snippets_for(restored.language));
    }
    match_restore_rows(&mut restored.replacements, &current.replacements);
    if let (Some(restored), Some(current)) = (&mut restored.snippets, &current.snippets) {
        match_restore_rows(restored, current);
    }
    restored
}

/// 今の設定とバックアップへ戻した後の設定を、同期の項目と同じ粒度で比べる。同期しない行も比べる
pub fn backup_differences(current: &Config, restored: &Config) -> Vec<BackupDifference> {
    let comparable = |config: &Config| {
        let mut config = config.clone();
        for row in &mut config.replacements {
            row.sync = true;
        }
        for row in config.snippets.iter_mut().flatten() {
            row.sync = true;
        }
        config
    };
    let (current, restored) = (comparable(current), comparable(restored));
    let current_items = config_items(&current);
    let restored_items = config_items(&restored);
    current_items
        .keys()
        .chain(restored_items.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|key| {
            if current_items.get(key) == restored_items.get(key) {
                return None;
            }
            Some(BackupDifference {
                id: key.id.clone(),
                current: backup_value(&current, key)?,
                restored: backup_value(&restored, key)?,
            })
        })
        .collect()
}

fn backup_value(config: &Config, key: &ItemKey) -> Option<SyncValue> {
    match kind(key)? {
        Kind::Order(name) => Some(SyncValue::Order(name.to_string())),
        _ => sync_value(config, key),
    }
}

/// `key` の項目の、`config` での値。行が無ければ（消した）`Deleted`。
fn sync_value(config: &Config, key: &ItemKey) -> Option<SyncValue> {
    fn row<T: SyncRow>(rows: &[T], id: &str, wrap: fn(T) -> SyncValue) -> SyncValue {
        rows.iter()
            .find(|row| row.id() == id && row.sync())
            .cloned()
            .map_or(SyncValue::Deleted, wrap)
    }
    Some(match kind(key)? {
        Kind::Replacement(id) => row(&config.replacements, id, SyncValue::Replacement),
        Kind::Snippet(id) => row(
            config.snippets.as_deref().unwrap_or_default(),
            id,
            SyncValue::Snippet,
        ),
        Kind::Order(_) => return None,
        Kind::Setting(name) if name == hotkey_name() => SyncValue::Hotkey(config.hotkey.clone()),
        Kind::Setting(name) if name == text_window_keys_name() => {
            SyncValue::TextWindowKeys(config.text_window_keys.clone())
        }
        Kind::Setting(name) => match name {
            "language" => SyncValue::Language(config.language),
            "theme" => SyncValue::Theme(config.theme),
            "text_window_always_on_top" => {
                SyncValue::TextWindowAlwaysOnTop(config.text_window_always_on_top)
            }
            "hide_text_window_on_blur" => {
                SyncValue::HideTextWindowOnBlur(config.hide_text_window_on_blur)
            }
            "show_text_window_buttons" => {
                SyncValue::ShowTextWindowButtons(config.show_text_window_buttons)
            }
            "text_history_size" => SyncValue::TextHistorySize(config.text_history_size),
            "trim_trailing_whitespace" => {
                SyncValue::TrimTrailingWhitespace(config.trim_trailing_whitespace)
            }
            "punctuation_style" => SyncValue::PunctuationStyle(config.punctuation_style),
            "alphabet_width" => SyncValue::AlphabetWidth(config.char_widths.alphabet),
            "digit_width" => SyncValue::DigitWidth(config.char_widths.digit),
            "space_width" => SyncValue::SpaceWidth(config.char_widths.space),
            "symbol_width" => SyncValue::SymbolWidth(config.char_widths.symbol),
            "katakana_width" => SyncValue::KatakanaWidth(config.char_widths.katakana),
            "exclude_from_clipboard_history" => {
                SyncValue::ExcludeFromClipboardHistory(config.exclude_from_clipboard_history)
            }
            "text_font_size" => SyncValue::TextFontSize(config.text_font_size),
            "text_color_light" => SyncValue::TextColorLight(config.text_color_light.clone()),
            "text_color_dark" => SyncValue::TextColorDark(config.text_color_dark.clone()),
            "input_guidance" => SyncValue::InputGuidance(config.input_guidance.clone()),
            "ai_service" => SyncValue::AiService(config.ai_service),
            "ai_models" => SyncValue::AiModels(config.ai_models.clone()),
            "ai_base_url" => SyncValue::AiBaseUrl(config.ai_base_url.clone()),
            "text_font_family" => SyncValue::TextFontFamily(config.text_font_family.clone()),
            _ => return None,
        },
    })
}

#[derive(Debug)]
pub enum Error {
    SignedOut,
    KeyMismatch,
    Conflict(Vec<ConflictItem>),
    Limit(&'static str),
    Other(String),
}

#[derive(Debug, Clone)]
pub struct ReadResult {
    pub reset: bool,
    pub next: u64,
    pub items: Vec<RemoteItem>,
}

#[derive(Debug, Clone)]
pub struct WrittenItem {
    pub key: ItemKey,
    pub seq: u64,
}

/// 409 に含まれる今の項目。`seq: None` は、窓口にその項目が無いことを表す。
#[derive(Debug, Clone)]
pub struct ConflictItem {
    pub key: ItemKey,
    pub seq: Option<u64>,
    pub deleted: bool,
    pub plain: Option<Plain>,
}

/// 通信だけを差し替えられる境目。同期の決まりの試験は窓口や暗号に依らない。
pub trait SyncTransport {
    fn read<'a>(
        &'a mut self,
        since: u64,
    ) -> Pin<Box<dyn Future<Output = Result<ReadResult, Error>> + Send + 'a>>;
    fn write<'a>(
        &'a mut self,
        writes: &'a [Write],
    ) -> Pin<Box<dyn Future<Output = Result<Vec<WrittenItem>, Error>> + Send + 'a>>;
    /// 前に読んだ1項目を、もう一度読む。窓口の今の項目が `seq` のものでなければ None。
    fn read_item<'a>(
        &'a mut self,
        key: &'a ItemKey,
        seq: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<RemoteItem>, Error>> + Send + 'a>>;
}

#[derive(Debug, Clone)]
pub struct SyncResult {
    pub config: Config,
    pub state: State,
    pub changed: bool,
    pub reset: bool,
    /// 窓口の値を入れたので oplog から外す項目と、そのとき見ていた oplog の時刻。`config` を手元に入れるときだけ外す
    pub accepted: Vec<(String, u64)>,
    /// 窓口へ書けたので oplog から外す項目と、書いた値の oplog の時刻。`config` を捨てるときも外す
    pub sent: Vec<(String, u64)>,
    /// この回に窓口へ書けた項目だけの記録。`config` を手元に入れずに捨てるときも、`merge_written` で残す。
    /// 並びは、同期を始めたときの手元の並びを書いたときだけ入る。
    pub written: State,
    /// 窓口の履歴と混ぜて、`config` の履歴の件数に切り詰めた履歴。履歴を同期しなかった回は None。
    pub history: Option<History>,
}

/// 失敗した同期。途中まで窓口へ書けていれば、その項目の記録を `merge_written` で残す。
#[derive(Debug)]
pub struct Failure {
    pub error: Error,
    pub written: State,
    pub reset: bool,
    pub sent: Vec<(String, u64)>,
}

/// 1回の同期の外側。読み書きは `SyncTransport` に閉じる。
/// `outbox` は、まだ窓口へ送っていない手元の変更（oplog）。
pub async fn sync_once_with<T: SyncTransport>(
    transport: &mut T,
    config: &Config,
    state: Option<State>,
    outbox: &BTreeMap<String, u64>,
    key_id: &str,
    history: Option<&History>,
) -> Result<SyncResult, Box<Failure>> {
    let enabled = kinds(config);
    let read = match transport
        .read(state.as_ref().map_or(0, |state| state.read_since(config)))
        .await
    {
        Ok(read) => read,
        Err(error) => {
            return Err(Box::new(Failure {
                error,
                written: State::new(key_id),
                reset: false,
                sent: Vec::new(),
            }))
        }
    };
    // 窓口が写しで組み直すよう知らせたら、前の記録は使えない
    let state = state.filter(|_| !read.reset);
    let no_record = state.is_none();
    // 履歴の同期をオンに戻した回なら、オフの間に置いてあった位置
    let history_resumed_from = state
        .as_ref()
        .and_then(|state| state.paused.get(SyncKind::History.group()).copied())
        .filter(|_| enabled.history);
    let mut recorded = state.unwrap_or_default();
    recorded.pause(config);
    let initial = Initial::new(no_record, &recorded);
    let mut result = if enabled.any_settings() {
        reconcile_as(
            config,
            recorded,
            &initial,
            outbox.clone(),
            &read.items,
            key_id,
            read.next,
        )
    } else {
        recorded.key_id = key_id.to_string();
        recorded.since = read.next;
        Reconcile {
            config: config.clone(),
            state: recorded,
            writes: Vec::new(),
            changed: false,
            pending: outbox.clone(),
            accepted: Vec::new(),
        }
    };
    let mut changed = result.changed;
    let mut accepted = std::mem::take(&mut result.accepted);
    let mut written = State::new(key_id);
    let mut sent = Vec::new();
    let local_items = config_items(config);
    let mut retries = 0;
    loop {
        let conflicts = match write_all(
            transport,
            &mut result,
            &mut written,
            &mut sent,
            &local_items,
        )
        .await
        {
            Ok(None) => break,
            Ok(Some(_)) if retries == MAX_CONFLICT_RETRIES => {
                Err(Error::Other("sync conflicts did not settle".to_string()))
            }
            Ok(Some(conflicts)) => Ok(conflicts),
            Err(error) => Err(error),
        };
        let conflicts = match conflicts {
            Ok(conflicts) => conflicts,
            Err(error) => {
                return Err(Box::new(Failure {
                    error,
                    written,
                    reset: read.reset,
                    sent,
                }))
            }
        };
        retries += 1;
        let mut current = Vec::new();
        for conflict in conflicts {
            match conflict.seq {
                Some(seq) => current.push(RemoteItem {
                    key: conflict.key,
                    seq,
                    deleted: conflict.deleted,
                    plain: conflict.plain,
                }),
                // 窓口に無い。記録を外して、初めての項目として書き直す
                None => result.state.forget(&conflict.key.name()),
            }
        }
        result = reconcile_as(
            &result.config,
            result.state,
            &initial,
            result.pending,
            &current,
            key_id,
            read.next,
        );
        changed |= result.changed;
        accepted.append(&mut result.accepted);
    }
    // 同じ回に履歴の件数が届いたら、届いた後の件数で合わせる
    let synced_history = if enabled.history {
        sync_history(
            transport,
            &mut result.state,
            &mut written,
            &read.items,
            history,
            result.config.text_history_size as usize,
            history_resumed_from.is_some(),
        )
        .await
    } else {
        None
    };
    // オンに戻した回に履歴を揃えられなかったら、戻した印を残して、次の回も同じ扱いにする。
    // 外すと、次の回が、オフの間に置いた手元の消した時刻で混ぜる（docs/sync.md「混ぜ方」）
    let size = result.config.text_history_size as usize;
    let settled = synced_history.as_ref().or(history).is_some_and(|local| {
        result
            .state
            .items
            .get(&history_item().name())
            .is_some_and(|seen| seen.hash == history_hash(local, size))
    });
    if settled && enabled.history {
        result.state.paused.remove(SyncKind::History.group());
    }
    // 成功した回だけ、再び読んだ設定の種類と個別項目の位置を外す。履歴は揃った回だけ上で外す。
    result.state.paused.retain(|group, _| {
        group == SyncKind::History.group() || paused_group(&result.config, group)
    });
    let history = synced_history;
    Ok(SyncResult {
        // 同じ値を入れ直しただけなら、変わっていない。設定を保存し直して次の同期を呼ばないため
        changed: changed && result.config != *config,
        config: result.config,
        state: result.state,
        reset: read.reset,
        accepted,
        sent,
        written,
        history,
    })
}

/// 窓口に書く履歴。暗号文が1項目の上限を超えるときは、古い方から落として収める（docs/sync.md「混ぜ方」）。
/// 1件だけで上限を超える本文は、先に外す。外さないと、それより古い履歴を全部落としても収まらず、
/// 窓口の履歴を空にして書く
fn fit_history(history: History) -> History {
    let empty = History {
        entries: Vec::new(),
        cleared_at: history.cleared_at,
    };
    if encrypted_len(&Plain::value(json(&history))) <= MAX_ENCRYPTED_ITEM_BYTES {
        return history;
    }
    let envelope = encrypted_len(&Plain::value(json(&empty)));
    let mut len = envelope;
    let mut kept = Vec::new();
    for entry in history.entries.into_iter().rev() {
        let entry_len = serde_json::to_vec(&entry).map_or(usize::MAX, |bytes| bytes.len());
        if envelope.saturating_add(entry_len) > MAX_ENCRYPTED_ITEM_BYTES {
            continue;
        }
        // 2件目からは、区切りのカンマの分が増える
        let added = entry_len + usize::from(!kept.is_empty());
        if len + added > MAX_ENCRYPTED_ITEM_BYTES {
            break;
        }
        len += added;
        kept.push(entry);
    }
    kept.reverse();
    History {
        entries: kept,
        ..empty
    }
}

/// 履歴の項目について、窓口が今持っているもの。
enum RemoteHistory {
    /// 項目が無いか、消した記録。`seq` は書くときの `base_seq`
    Absent(Option<u64>),
    Value(u64, History),
    /// 復号できない・知らない `v`・形が合わない
    Unreadable(u64),
}

impl RemoteHistory {
    fn from_item(seq: u64, deleted: bool, plain: Option<&Plain>) -> Self {
        if deleted {
            return Self::Absent(Some(seq));
        }
        match plain {
            Some(Plain {
                value: Some(value),
                detached: false,
                ..
            }) => parse::<History>(value)
                // 今の形で書けない値は、新しい版が書いたものとして読み捨てる。混ぜて書き戻すと、その版の履歴を削る
                .filter(|history| {
                    history.entries.len() <= history_store::MAX_SYNCED_ENTRIES
                        && history.entries.iter().all(|entry| entry.at > 0)
                })
                .map_or(Self::Unreadable(seq), |history| Self::Value(seq, history)),
            _ => Self::Unreadable(seq),
        }
    }
}

/// 履歴の記録に置く SHA-256。窓口の値でなく、揃ったときの手元の履歴と件数のものにする（docs/sync.md「混ぜ方」）。
/// 件数の少ないデバイスの手元は窓口の値と違うので、窓口の値の SHA-256 では、手元を変えたかを見分けられない。
/// 件数を含めるのは、件数を増やしたときに、窓口にある古い履歴を入れるため
fn history_hash(history: &History, size: usize) -> [u8; 32] {
    hash_plain(&json!({ "history": history, "size": size }))
}

/// 履歴の項目を読み書きする（docs/sync.md「履歴の同期」）。設定の項目と違い、食い違いにせず混ぜる。
/// 手元に入れる履歴（`size` 件に切り詰めたもの）を返す。同期しなかった・できなかった回は None で、
/// 失敗しても設定の同期の結果は捨てない。`local` が None なら、手元の履歴を読めなかった。
/// `resumed` は、オフにしていた履歴の同期をオンに戻した回か。
async fn sync_history<T: SyncTransport>(
    transport: &mut T,
    state: &mut State,
    written: &mut State,
    read: &[RemoteItem],
    local: Option<&History>,
    size: usize,
    resumed: bool,
) -> Option<History> {
    let key = history_item();
    let name = key.name();
    let arrived = read
        .iter()
        .filter(|item| item.key == key && state.seen_seq(&name).is_none_or(|seq| item.seq > seq))
        .max_by_key(|item| item.seq);
    let record = state.items.get(&name).cloned();
    if let Some(item) = arrived {
        state.ignored.remove(&name);
        // 届いた値は、読む位置が進むので次の回には届かない。この回に揃えられなかったときに、次の回が
        // 読み直して混ぜるよう、どの履歴とも合わない SHA-256 で `seq` だけを置く。揃えば置き直す
        if record.is_some() {
            state.items.insert(
                name.clone(),
                Seen {
                    seq: item.seq,
                    hash: [0; 32],
                },
            );
        }
    }
    let local = local?;
    // このデバイスで初めて履歴を同期する回と、オフにしていた履歴の同期をオンに戻した回（`resumed`）は、
    // 手元の消した時刻を使わない（docs/sync.md「混ぜ方」）
    let first = record.is_none() || resumed;
    let mut remote = match arrived {
        Some(item) => RemoteHistory::from_item(item.seq, item.deleted, item.plain.as_ref()),
        // 読み捨てた値は、窓口の値が変わるまで書かない
        None if state.ignored.contains_key(&name) => return None,
        None => match &record {
            Some(seen) if seen.hash == history_hash(local, size) => return None,
            // 手元か件数を変えた。手元は件数に切り詰めてあって窓口の値の全部は持っていないので、窓口の値を
            // 読み直して混ぜる。手元だけで書くと、件数の少ないデバイスが、ほかのデバイスの履歴を削る
            Some(seen) => match transport.read_item(&key, seen.seq).await {
                Ok(Some(item)) => {
                    RemoteHistory::from_item(item.seq, item.deleted, item.plain.as_ref())
                }
                Ok(None) => RemoteHistory::Absent(None),
                Err(error) => {
                    log::warn!("couldn't read the synced history again: {error}");
                    return None;
                }
            },
            None => RemoteHistory::Absent(None),
        },
    };
    for _ in 0..=MAX_CONFLICT_RETRIES {
        let (base_seq, remote_history) = match remote {
            RemoteHistory::Unreadable(seq) => {
                state.ignored.insert(name, seq);
                return None;
            }
            RemoteHistory::Absent(base_seq) => (base_seq, None),
            RemoteHistory::Value(seq, history) => (Some(seq), Some(history)),
        };
        let theirs = remote_history.clone().unwrap_or_default();
        let merged = if first {
            let ours = History {
                entries: local.entries.clone(),
                cleared_at: 0,
            };
            history_store::merge(&ours, &theirs)
        } else {
            history_store::merge(local, &theirs)
        };
        let next = merged.clone().truncated(size);
        let outgoing = fit_history(merged);
        let seq = if remote_history.as_ref() == Some(&outgoing) {
            base_seq.expect("a history value read from the server has a seq")
        } else {
            let write = Write {
                key: key.clone(),
                base_seq,
                deleted: false,
                plain: Some(json(&outgoing)),
                detached: false,
                // 履歴は後勝ちにせず混ぜるので、時刻は使わない
                at: 0,
            };
            match transport.write(std::slice::from_ref(&write)).await {
                Ok(replies) => match replies.iter().find(|reply| reply.key == key) {
                    Some(reply) => reply.seq,
                    None => {
                        log::warn!("the sync server didn't acknowledge the history");
                        return None;
                    }
                },
                Err(Error::Conflict(conflicts)) => {
                    remote = match conflicts.iter().find(|conflict| conflict.key == key) {
                        Some(conflict) => match conflict.seq {
                            Some(seq) => RemoteHistory::from_item(
                                seq,
                                conflict.deleted,
                                conflict.plain.as_ref(),
                            ),
                            None => RemoteHistory::Absent(None),
                        },
                        // `conflicts` が空なら、同じ要求を送り直す（docs/account-server.md「同期」）
                        None => match remote_history {
                            Some(history) => RemoteHistory::Value(
                                base_seq.expect("a history value read from the server has a seq"),
                                history,
                            ),
                            None => RemoteHistory::Absent(base_seq),
                        },
                    };
                    continue;
                }
                Err(error) => {
                    log::warn!("couldn't write the synced history: {error}");
                    return None;
                }
            }
        };
        let seen = Seen {
            seq,
            hash: history_hash(&next, size),
        };
        // 設定の結果を手元に入れずに捨てる回も、履歴は手元に入れるので、記録に残す
        state.settle_seen(name.clone(), seen.clone());
        written.settle_seen(name, seen);
        return Some(next);
    }
    log::warn!("history sync conflicts did not settle");
    None
}

/// 書く項目を窓口へ送り、書けた分を記録に置き、oplog から外す項目（`sent`）に足す。
/// `conflict` が返ったら、そこで止めて今の項目を返す。`local_items` は、同期を始めたときの手元の値。
async fn write_all<T: SyncTransport>(
    transport: &mut T,
    result: &mut Reconcile,
    written: &mut State,
    sent: &mut Vec<(String, u64)>,
    local_items: &BTreeMap<ItemKey, Value>,
) -> Result<Option<Vec<ConflictItem>>, Error> {
    let mut writes = Vec::new();
    for write in std::mem::take(&mut result.writes) {
        match (write.payload(), &write.plain) {
            (Some(plain), Some(value)) if encrypted_len(&plain) > MAX_ENCRYPTED_ITEM_BYTES => {
                log::warn!("a sync item is too large to write");
                result
                    .state
                    .too_large
                    .insert(write.key.name(), hash_plain(value));
            }
            _ => writes.push(write),
        }
    }
    for batch in writes.chunks(WRITE_BATCH_SIZE) {
        let replies = match transport.write(batch).await {
            Ok(replies) => replies,
            Err(Error::Conflict(conflicts)) => return Ok(Some(conflicts)),
            Err(Error::Limit(limit)) => {
                // 1項目の上限は送る前に除いている。全体・要求の上限は、ほかの項目が減れば通るので、記録に置かず次のきっかけで試す
                log::warn!("sync write was too large: {limit}");
                continue;
            }
            Err(error) => return Err(error),
        };
        for reply in replies {
            let Some(write) = batch.iter().find(|write| write.key == reply.key) else {
                continue;
            };
            let name = reply.key.name();
            if let Some(at) = result.pending.remove(&name) {
                sent.push((name.clone(), at));
            }
            match &write.plain {
                Some(value) => {
                    result.state.settle(name.clone(), reply.seq, value);
                    // 届いた並びに手元の行を足した並びは、結果を捨てると手元に入らないので置かず、次の回に読み直して
                    // 合わせる。手元の並びをそのまま書いたものは置く。忘れると、次の回に自分の書き込みを
                    // 他人の変更と取り違える
                    let unapplied_order =
                        is_order(&write.key) && local_items.get(&write.key) != Some(value);
                    if !unapplied_order {
                        written.settle(name, reply.seq, value);
                    }
                }
                None => {
                    result.state.retire(name.clone(), reply.seq);
                    written.retire(name, reply.seq);
                }
            }
        }
    }
    Ok(None)
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => write!(f, "signed out"),
            Self::KeyMismatch => write!(f, "key mismatch"),
            Self::Conflict(_) => write!(f, "sync conflict"),
            Self::Limit(limit) => write!(f, "sync limit: {limit}"),
            Self::Other(detail) => f.write_str(detail),
        }
    }
}

/// 同期の結果を手元に入れずに捨てるとき・同期が途中で失敗したときの記録。前の記録に、窓口へ書けた項目
/// （`written`）の `seq` と SHA-256 だけを足す（docs/sync.md「1回の同期」）。読んだだけの項目と `since` は
/// 足さないので、次の回にもう一度読む。`reset` を受けた回と前の記録が無いときは、`since` が 0 の記録になり、
/// 次の回も初めての同期として合わせる。
pub fn merge_written(previous: Option<State>, written: &State, reset: bool, key_id: &str) -> State {
    let mut state = previous
        .filter(|state| !reset && state.key_id == key_id)
        .unwrap_or_else(|| State::new(key_id));
    for (name, seen) in &written.items {
        state.settle_seen(name.clone(), seen.clone());
    }
    for (name, seq) in &written.retired {
        state.retire(name.clone(), *seq);
    }
    state
}

/// 同期が手元に入れた項目を、このデバイスでは反映できなかった（OS がホットキーを登録できない など）ときに、
/// 読み捨てた項目として置き直す。記録は同期の前に戻すので、窓口の値が変わったら、もう一度入れてみる。
pub fn ignore_applied(state: &mut State, before: Option<&State>, key: &ItemKey) {
    let name = key.name();
    let Some(seq) = state.items.get(&name).map(|seen| seen.seq) else {
        return;
    };
    match before.and_then(|before| before.items.get(&name)) {
        Some(seen) => state.items.insert(name.clone(), seen.clone()),
        None => state.items.remove(&name),
    };
    state.ignored.insert(name, seq);
}

fn auth(token: &str) -> Result<reqwest::header::HeaderValue, Error> {
    account::bearer(token).map_err(Error::Other)
}

/// 窓口の項目の中身。消した項目は、data があっても読まない
fn remote_plain(
    key: &[u8; 32],
    key_id: &str,
    item_key: &ItemKey,
    deleted: bool,
    data: Option<&str>,
) -> Option<Plain> {
    data.filter(|_| !deleted)
        .and_then(|data| decrypt(key, key_id, item_key, data))
}

#[derive(Deserialize)]
struct GetItem {
    collection: String,
    id: String,
    seq: u64,
    deleted: bool,
    data: Option<String>,
}
#[derive(Deserialize)]
struct GetReply {
    key_id: Option<String>,
    reset: bool,
    items: Vec<GetItem>,
    more: bool,
    next: u64,
}

/// `since` からの項目を、`more` が false になるまで読む。1ページを取る所（`fetch`。引数は `since` と、
/// `rebuild=1` を付けるか）を差し替えられるようにして、ページ送りを通信なしで確かめる。
async fn read_pages<F, R>(
    mut fetch: F,
    key: &[u8; 32],
    key_id: &str,
    mut since: u64,
) -> Result<ReadResult, Error>
where
    F: FnMut(u64, bool) -> R,
    R: Future<Output = Result<GetReply, Error>>,
{
    // `since=0` から始めたときと `reset: true` を受けたときは、組み直しの途中（docs/account-server.md「同期」）
    let mut rebuilding = since == 0;
    let mut reset = false;
    let mut items = Vec::new();
    loop {
        let reply = fetch(since, rebuilding).await?;
        if reply.key_id.as_deref().is_some_and(|id| id != key_id) {
            return Err(Error::KeyMismatch);
        }
        if reply.reset {
            // ここからは窓口の写しの先頭から届く。それまでに読んだ分は重なるので捨てる
            items.clear();
            reset = true;
            rebuilding = true;
        }
        for item in reply.items {
            let item_key = ItemKey::new(&item.collection, item.id);
            if !handled(&item_key) {
                continue;
            }
            let plain = remote_plain(key, key_id, &item_key, item.deleted, item.data.as_deref());
            items.push(RemoteItem {
                key: item_key,
                seq: item.seq,
                deleted: item.deleted,
                plain,
            });
        }
        since = reply.next;
        if !reply.more {
            return Ok(ReadResult {
                reset,
                next: since,
                items,
            });
        }
    }
}

async fn get_page(
    client: &reqwest::Client,
    token: &str,
    since: u64,
    limit: usize,
    rebuild: bool,
) -> Result<GetReply, Error> {
    let mut url = reqwest::Url::parse(&format!("{}/v1/sync", account::ACCOUNT_URL))
        .map_err(|error| Error::Other(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("since", &since.to_string());
        query.append_pair("limit", &limit.to_string());
        if rebuild {
            query.append_pair("rebuild", "1");
        }
    }
    let response = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, auth(token)?)
        .send()
        .await
        .map_err(|error| Error::Other(error.to_string()))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::SignedOut);
    }
    if !response.status().is_success() {
        return Err(Error::Other(format!(
            "GET /v1/sync: HTTP {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|error| Error::Other(error.to_string()))
}

#[derive(Deserialize)]
struct PutItem {
    collection: String,
    id: String,
    seq: u64,
}
#[derive(Deserialize)]
struct PutReply {
    items: Vec<PutItem>,
}
#[derive(Deserialize)]
struct ConflictReply {
    conflicts: Vec<ConflictReplyItem>,
}
#[derive(Deserialize)]
struct ConflictReplyItem {
    collection: String,
    id: String,
    seq: Option<u64>,
    deleted: bool,
    data: Option<String>,
}

/// 窓口へ書く項目の JSON。通信と分けて、要求の形を確かめられるようにする
fn put_items(key: &[u8; 32], key_id: &str, writes: &[Write]) -> Result<Vec<Value>, Error> {
    let mut items = Vec::new();
    for write in writes {
        if !handled(&write.key) {
            return Err(Error::Other("invalid local sync item".to_string()));
        }
        let mut item = json!({ "collection": write.key.collection, "id": write.key.id, "base_seq": write.base_seq, "deleted": write.deleted });
        // 消す項目には data を付けない。窓口は data が文字列か、無いときだけ受け付ける
        if !write.deleted {
            let plain = write
                .payload()
                .ok_or_else(|| Error::Other("a sync write has no value".to_string()))?;
            item["data"] =
                Value::String(encrypt(key, key_id, &write.key, &plain).map_err(Error::Other)?);
        }
        items.push(item);
    }
    Ok(items)
}

/// 409 の `conflicts` を、読んだ項目と同じ検査（知らない項目を除く・復号）に通す。
fn conflict_items(key: &[u8; 32], key_id: &str, body: Value) -> Result<Vec<ConflictItem>, Error> {
    let reply: ConflictReply =
        serde_json::from_value(body).map_err(|error| Error::Other(error.to_string()))?;
    Ok(reply
        .conflicts
        .into_iter()
        .filter_map(|item| {
            let item_key = ItemKey::new(&item.collection, item.id);
            handled(&item_key).then_some(())?;
            let plain = remote_plain(key, key_id, &item_key, item.deleted, item.data.as_deref());
            Some(ConflictItem {
                key: item_key,
                seq: item.seq,
                deleted: item.deleted,
                plain,
            })
        })
        .collect())
}

async fn put(
    client: &reqwest::Client,
    token: &str,
    key: &[u8; 32],
    key_id: &str,
    writes: &[Write],
) -> Result<Vec<PutItem>, Error> {
    let items = put_items(key, key_id, writes)?;
    let response = client
        .put(format!("{}/v1/sync", account::ACCOUNT_URL))
        .header(reqwest::header::AUTHORIZATION, auth(token)?)
        .json(&json!({ "key_id": key_id, "items": items }))
        .send()
        .await
        .map_err(|error| Error::Other(error.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::SignedOut);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| Error::Other(error.to_string()))?;
    if status.is_success() {
        return serde_json::from_value::<PutReply>(body)
            .map(|reply| reply.items)
            .map_err(|error| Error::Other(error.to_string()));
    }
    match body.get("error").and_then(Value::as_str) {
        Some("key_mismatch") => Err(Error::KeyMismatch),
        Some("conflict") => Err(Error::Conflict(conflict_items(key, key_id, body)?)),
        Some("too_large") => Err(Error::Limit(
            match body.get("limit").and_then(Value::as_str) {
                Some("item") => "item",
                Some("total") => "total",
                Some("request") => "request",
                _ => "unknown",
            },
        )),
        _ => Err(Error::Other(format!("PUT /v1/sync: HTTP {}", status))),
    }
}

/// 窓口の同期の入口と、そこで使う鍵。
pub struct HttpTransport<'a> {
    pub client: &'a reqwest::Client,
    pub token: &'a str,
    pub key: &'a [u8; 32],
    pub key_id: &'a str,
}

impl SyncTransport for HttpTransport<'_> {
    fn read<'a>(
        &'a mut self,
        since: u64,
    ) -> Pin<Box<dyn Future<Output = Result<ReadResult, Error>> + Send + 'a>> {
        let (client, token) = (self.client, self.token);
        Box::pin(read_pages(
            move |since, rebuild| get_page(client, token, since, READ_LIMIT, rebuild),
            self.key,
            self.key_id,
            since,
        ))
    }

    fn write<'a>(
        &'a mut self,
        writes: &'a [Write],
    ) -> Pin<Box<dyn Future<Output = Result<Vec<WrittenItem>, Error>> + Send + 'a>> {
        Box::pin(async move {
            put(self.client, self.token, self.key, self.key_id, writes)
                .await
                .map(|items| {
                    items
                        .into_iter()
                        .map(|item| WrittenItem {
                            key: ItemKey::new(&item.collection, item.id),
                            seq: item.seq,
                        })
                        .collect()
                })
        })
    }

    fn read_item<'a>(
        &'a mut self,
        key: &'a ItemKey,
        seq: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<RemoteItem>, Error>> + Send + 'a>> {
        Box::pin(async move {
            // `seq` の1つ前から1項目だけ読む。その項目が書き換わっていなければ、先頭に返る
            let reply = get_page(self.client, self.token, seq.saturating_sub(1), 1, false).await?;
            Ok(item_at(reply, self.key, self.key_id, key, seq))
        })
    }
}

/// 1項目を読み直した応答から、`seq` のままの `key` の項目を取り出す。ほかの項目が返った
/// （書き換わった・窓口が写しの先頭から返した）ときは None。
fn item_at(
    reply: GetReply,
    key: &[u8; 32],
    key_id: &str,
    item_key: &ItemKey,
    seq: u64,
) -> Option<RemoteItem> {
    if reply.key_id.as_deref() != Some(key_id) {
        return None;
    }
    let item = reply.items.into_iter().next()?;
    if item.collection != item_key.collection || item.id != item_key.id || item.seq != seq {
        return None;
    }
    let plain = remote_plain(key, key_id, item_key, item.deleted, item.data.as_deref());
    Some(RemoteItem {
        key: item_key.clone(),
        seq,
        deleted: item.deleted,
        plain,
    })
}

/// 1回の通信を走らせ、保存する前の結果を返す。呼び出し元が設定と記録を同じ世代で保存する。
pub async fn sync_once(
    mut transport: HttpTransport<'_>,
    config: &Config,
    state: Option<State>,
    outbox: &BTreeMap<String, u64>,
    history: Option<&History>,
) -> Result<SyncResult, Box<Failure>> {
    let key_id = transport.key_id;
    sync_once_with(
        &mut transport,
        config,
        state.filter(|state| state.key_id == key_id),
        outbox,
        key_id,
        history,
    )
    .await
}

/// 手元で変えた同期の項目（oplog に積む名前）。保存の前と後の設定を、窓口に置く粒度で比べる。
/// 同期を止めている種類の項目も積む。後でオンにしたときに、止めていた間に変えたものとして送る
pub fn changed_items(before: &Config, after: &Config) -> Vec<String> {
    // 片方だけが既定の定型文のまま（None）なら、その側は既定の行を持つものとして比べる。初めて定型文を変えたときに、
    // 触っていない既定の行まで今の時刻で積むと、ほかのデバイスで先に直した既定の行を後勝ちで巻き戻す。
    // 既定の行は、変える前の言語のものにする（両方 None で言語だけ替えたときは、行を積まない）
    let both_default = before.snippets.is_none() && after.snippets.is_none();
    let items = |config: &Config| {
        if both_default || config.snippets.is_some() {
            return config_items(config);
        }
        config_items(&Config {
            snippets: Some(default_snippets_for(before.language)),
            ..config.clone()
        })
    };
    let (before, after) = (items(before), items(after));
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .map(ItemKey::name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_state_is_treated_as_missing() {
        assert!(parse_state("not json").is_none());
    }

    /// 記録に揃えた後に手元で変えた項目。実際には変えたときに oplog に積まれる。
    /// 時刻は、変えた時刻の分からない窓口の値（`at` が 0）より後にする
    fn pending_since(config: &Config, state: Option<&State>) -> BTreeMap<String, u64> {
        let Some(state) = state else {
            return BTreeMap::new();
        };
        let items = config_items(config);
        let mut pending: BTreeMap<String, u64> = items
            .iter()
            .filter(|(key, value)| {
                state
                    .items
                    .get(&key.name())
                    .is_some_and(|seen| seen.hash != hash_plain(value))
            })
            .map(|(key, _)| (key.name(), 1))
            .collect();
        for name in state.items.keys() {
            if key_of(name).is_some_and(|key| kind(&key).is_some() && !items.contains_key(&key)) {
                pending.insert(name.clone(), 1);
            }
        }
        pending
    }

    /// 記録の後に手元で変えた項目を oplog に積んだものとして合わせる
    fn reconcile(
        local: &Config,
        old: Option<State>,
        remote: &[RemoteItem],
        key_id: &str,
        since: u64,
    ) -> Reconcile {
        let outbox = pending_since(local, old.as_ref());
        super::reconcile(local, old, &outbox, remote, key_id, since)
    }

    fn remote(collection: &str, id: &str, seq: u64, value: Value) -> RemoteItem {
        RemoteItem {
            key: ItemKey::new(collection, id),
            seq,
            deleted: false,
            plain: Some(Plain::value(value)),
        }
    }

    fn recorded(config: &Config) -> State {
        State {
            key_id: "key".to_string(),
            since: 1,
            items: config_items(config)
                .into_iter()
                .map(|(key, value)| {
                    (
                        key.name(),
                        Seen {
                            seq: 1,
                            hash: hash_plain(&value),
                        },
                    )
                })
                .collect(),
            ..State::default()
        }
    }

    #[test]
    fn initial_sync_prefers_remote_settings() {
        let local = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let result = reconcile(
            &local,
            None,
            &[remote("settings", "s_theme", 3, json!("light"))],
            "key",
            3,
        );
        assert_eq!(result.config.theme, Theme::Light);
        assert!(!result
            .writes
            .iter()
            .any(|write| write.key == ItemKey::new("settings", "s_theme")));
    }

    #[test]
    fn a_record_with_zero_since_is_still_an_initial_sync_after_reading() {
        let local = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let mut state = recorded(&Config::default());
        state.since = 0;
        state.items.remove(&setting_item("theme").name());
        let result = reconcile(
            &local,
            Some(state),
            &[remote(SETTINGS, "s_theme", 4, json!("light"))],
            "key",
            9,
        );
        assert_eq!(result.config.theme, Theme::Light);
    }

    #[test]
    fn a_kind_started_later_is_initial_only_for_that_kind() {
        let local = Config {
            snippets: Some(vec![
                snippet('a', "same".to_string()),
                snippet('b', "same".to_string()),
            ]),
            replacements: vec![replacement('c', "same"), replacement('d', "same")],
            ..Config::default()
        };
        let mut state = State {
            key_id: "key".to_string(),
            since: 9,
            paused: BTreeMap::from([(SyncKind::Snippets.group().to_string(), 0)]),
            ..State::default()
        };
        let replacement_key = row_key('r', 'c');
        state.items.insert(
            replacement_key.name(),
            Seen {
                seq: 1,
                hash: hash_plain(&row_value(&local.replacements[0])),
            },
        );
        let snippet_key = row_key('n', 'a');
        let result = reconcile(
            &local,
            Some(state),
            &[remote(
                SETTINGS,
                &snippet_key.id,
                10,
                row_value(&local.snippets.as_ref().unwrap()[0]),
            )],
            "key",
            10,
        );
        assert_eq!(result.config.snippets.unwrap().len(), 1);
        assert_eq!(result.config.replacements.len(), 2);
    }

    #[test]
    fn paused_positions_are_not_replaced_and_resuming_reads_the_earliest_one() {
        let mut state = State {
            since: 7,
            ..State::default()
        };
        let settings_off = Config {
            sync_settings: false,
            ..Config::default()
        };
        assert!(state.pause(&settings_off));
        state.since = 9;
        assert!(!state.pause(&settings_off));
        assert_eq!(state.paused.get(SyncKind::Settings.group()), Some(&7));
        state.paused.insert(SyncKind::Keys.group().to_string(), 3);
        assert_eq!(state.read_since(&Config::default()), 3);
    }

    #[test]
    fn encryption_rejects_a_changed_key_id() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let data = encrypt(&key, "first", &item, &Plain::value(json!("dark"))).unwrap();
        assert!(decrypt(&key, "second", &item, &data).is_none());
    }

    #[test]
    fn encryption_rejects_a_changed_collection() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let data = encrypt(&key, "key", &item, &Plain::value(json!("dark"))).unwrap();
        assert!(decrypt(&key, "key", &ItemKey::new("history", "s_theme"), &data).is_none());
    }

    #[test]
    fn encryption_rejects_a_changed_id() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let data = encrypt(&key, "key", &item, &Plain::value(json!("dark"))).unwrap();
        assert!(decrypt(&key, "key", &ItemKey::new(SETTINGS, "s_language"), &data).is_none());
    }

    #[test]
    fn encryption_rejects_a_changed_ciphertext_byte() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let mut data = STANDARD
            .decode(encrypt(&key, "key", &item, &Plain::value(json!("dark"))).unwrap())
            .unwrap();
        *data.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, "key", &item, &STANDARD.encode(data)).is_none());
    }

    #[test]
    fn encryption_round_trips() {
        let key = [3; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let value = json!("dark");
        let data = encrypt(&key, "key", &item, &Plain::value(value.clone())).unwrap();
        assert_eq!(
            decrypt(&key, "key", &item, &data).unwrap().value,
            Some(value)
        );
    }

    #[test]
    fn encryption_uses_a_fresh_nonce() {
        let key = [3; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        assert_ne!(
            encrypt(&key, "key", &item, &Plain::value(json!("dark"))).unwrap(),
            encrypt(&key, "key", &item, &Plain::value(json!("dark"))).unwrap()
        );
    }

    #[test]
    fn detached_plaintext_round_trips() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, format!("r_{}", "a".repeat(32)));
        let data = encrypt(&key, "key", &item, &Plain::detached()).unwrap();
        assert!(decrypt(&key, "key", &item, &data).unwrap().detached);
    }

    #[test]
    fn every_outgoing_id_is_accepted_by_the_server() {
        let id = "a".repeat(32);
        let mut config = Config::default();
        config.replacements.push(Replacement {
            id: id.clone(),
            from: "from".into(),
            to: "to".into(),
            enabled: true,
            sync: true,
        });
        let mut snippets = actions::default_snippets(crate::i18n::Lang::En);
        snippets.push(Snippet {
            id,
            name: "name".into(),
            body: "body".into(),
            ..Snippet::default()
        });
        config.snippets = Some(snippets);
        for key in config_items(&config).into_keys() {
            assert_eq!(key.collection, SETTINGS, "{}", key.id);
            assert!(valid_wire_id(&key.id), "{}", key.id);
            assert!(kind(&key).is_some(), "{}", key.id);
        }
    }

    #[test]
    fn conversion_omits_local_only_settings() {
        let config = Config {
            autostart: false,
            sync_settings: false,
            sync_history: false,
            yielded_draft_keys: crate::draft_keys::DraftAction::ALL.to_vec(),
            ai_consent_base_url: "http://localhost:11434/v1".to_string(),
            ..Config::default()
        };
        let items = config_items(&config);
        for name in [
            "autostart",
            "ai_consent",
            "ai_consent_base_url",
            "sync_settings",
            "sync_history",
            "yielded_draft_keys",
        ] {
            assert!(
                !items.contains_key(&ItemKey::new(SETTINGS, setting_id(name))),
                "{name}"
            );
            let mut received = config.clone();
            assert!(
                !apply_value(
                    &mut received,
                    &ItemKey::new(SETTINGS, setting_id(name)),
                    &json!(true)
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn conversion_omits_unsynced_rows() {
        let mut config = Config::default();
        config.replacements.push(Replacement {
            id: "a".repeat(32),
            from: "a".into(),
            to: "b".into(),
            enabled: true,
            sync: false,
        });
        assert!(!config_items(&config)
            .keys()
            .any(|key| key.id.starts_with("r_")));
    }

    #[test]
    fn conversion_omits_default_snippets_not_written_to_config() {
        assert!(!config_items(&Config::default())
            .keys()
            .any(|key| key.id.starts_with("n_") || key.id == "o_snippets"));
    }

    #[test]
    fn conversion_only_accepts_this_platform_settings() {
        let mut config = Config::default();
        let other = if platform_suffix() == "macos" {
            "windows"
        } else {
            "macos"
        };
        assert!(!apply_value(
            &mut config,
            &ItemKey::new(SETTINGS, format!("s_hotkey_{other}")),
            &json!("other")
        ));
        assert_eq!(config.hotkey, config::DEFAULT_HOTKEY);
    }

    #[test]
    fn unchanged_local_value_uses_remote_value() {
        let local = Config::default();
        let result = reconcile(
            &local,
            Some(recorded(&local)),
            &[remote(SETTINGS, "s_theme", 2, json!("dark"))],
            "key",
            2,
        );
        assert_eq!(result.config.theme, Theme::Dark);
        assert!(result.writes.is_empty());
    }

    #[test]
    fn local_only_change_writes_with_the_recorded_sequence() {
        let base = Config::default();
        let mut local = base.clone();
        local.theme = Theme::Dark;
        let result = reconcile(&local, Some(recorded(&base)), &[], "key", 1);
        let write = result
            .writes
            .iter()
            .find(|write| write.key.id == "s_theme")
            .unwrap();
        assert_eq!(write.base_seq, Some(1));
    }

    #[test]
    fn first_item_writes_with_no_base_sequence() {
        let result = reconcile(&Config::default(), None, &[], "key", 0);
        assert_eq!(
            result
                .writes
                .iter()
                .find(|write| write.key.id == "s_theme")
                .unwrap()
                .base_seq,
            None
        );
    }

    #[test]
    fn equal_local_and_remote_changes_only_update_the_record() {
        let base = Config::default();
        let mut local = base.clone();
        local.theme = Theme::Dark;
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[remote(SETTINGS, "s_theme", 2, json!("dark"))],
            "key",
            2,
        );
        assert!(result.writes.is_empty());
        assert_eq!(result.state.items["settings\0s_theme"].seq, 2);
    }

    #[test]
    fn a_remote_deletion_removes_an_unchanged_row() {
        let mut config = Config::default();
        let id = "b".repeat(32);
        config.replacements.push(Replacement {
            id: id.clone(),
            from: "a".into(),
            to: "b".into(),
            enabled: true,
            sync: true,
        });
        let result = reconcile(
            &config,
            Some(recorded(&config)),
            &[RemoteItem {
                key: ItemKey::new(SETTINGS, row_id('r', &id)),
                seq: 2,
                deleted: true,
                plain: None,
            }],
            "key",
            2,
        );
        assert!(result.config.replacements.is_empty());
    }

    #[test]
    fn local_deletion_writes_deleted() {
        let mut base = Config::default();
        let id = "c".repeat(32);
        base.replacements.push(Replacement {
            id,
            from: "a".into(),
            to: "b".into(),
            enabled: true,
            sync: true,
        });
        let result = reconcile(&Config::default(), Some(recorded(&base)), &[], "key", 1);
        assert!(result.writes.iter().any(|write| write.deleted));
    }

    #[test]
    fn remote_detached_marks_the_local_row_unsynced() {
        let id = "e".repeat(32);
        let mut local = Config::default();
        local.replacements.push(Replacement {
            id: id.clone(),
            from: "a".into(),
            to: "b".into(),
            enabled: true,
            sync: true,
        });
        let result = reconcile(
            &local,
            Some(recorded(&local)),
            &[RemoteItem {
                key: ItemKey::new(SETTINGS, row_id('r', &id)),
                seq: 2,
                deleted: false,
                plain: Some(Plain::detached()),
            }],
            "key",
            2,
        );
        assert!(!result.config.replacements[0].sync);
        assert!(result.config.replacements[0].from == "a");
    }

    #[test]
    fn undecryptable_remote_item_is_not_written_back() {
        let local = Config::default();
        let item = RemoteItem {
            key: ItemKey::new(SETTINGS, "s_theme"),
            seq: 2,
            deleted: false,
            plain: None,
        };
        let result = reconcile(&local, Some(recorded(&local)), &[item], "key", 2);
        assert_eq!(result.config, local);
        assert!(result.state.ignored.contains_key("settings\0s_theme"));
        assert!(!result.writes.iter().any(|write| write.key.id == "s_theme"));
    }

    #[test]
    fn malformed_row_is_not_applied_or_written_back() {
        let local = Config::default();
        let id = "f".repeat(32);
        let result = reconcile(
            &local,
            Some(recorded(&local)),
            &[remote(SETTINGS, &row_id('r', &id), 2, json!("not a row"))],
            "key",
            2,
        );
        assert!(result.config.replacements.is_empty());
        assert!(result
            .state
            .ignored
            .contains_key(&ItemKey::new(SETTINGS, row_id('r', &id)).name()));
        assert!(!result
            .writes
            .iter()
            .any(|write| write.key.id == row_id('r', &id)));
    }

    #[test]
    fn invalid_remote_values_are_not_applied_or_written_back() {
        let local = Config::default();
        for value in [json!(101), json!("unknown")] {
            let key = if value.is_number() {
                "s_text_history_size"
            } else {
                "s_theme"
            };
            let result = reconcile(
                &local,
                Some(recorded(&local)),
                &[remote(SETTINGS, key, 2, value)],
                "key",
                2,
            );
            assert!(
                result
                    .state
                    .ignored
                    .contains_key(&format!("settings\0{key}")),
                "{key}"
            );
            assert!(
                !result.writes.iter().any(|write| write.key.id == key),
                "{key}"
            );
        }
    }

    #[test]
    fn foreign_and_unknown_wire_items_are_not_tracked_or_rewritten() {
        let local = Config::default();
        let items = [
            remote("history", "s_theme", 2, json!("dark")),
            remote(SETTINGS, "x_future", 3, json!(true)),
            // 文字を揃える設定を、種類ごとでなく1項目に置いた形
            remote(
                SETTINGS,
                "s_char_widths",
                3,
                json!({ "alphabet": "full", "digit": "half", "space": "keep", "symbol": "keep", "katakana": "full" }),
            ),
        ];
        let mut state = recorded(&local);
        state.items.insert(
            "settings\0s_char_widths".to_string(),
            Seen {
                seq: 1,
                hash: hash_plain(&json!({})),
            },
        );
        let result = reconcile(&local, Some(state), &items, "key", 3);
        assert_eq!(result.config, local);
        assert!(result.state.ignored.is_empty());
        assert!(result.writes.is_empty());
    }

    fn widths(alphabet: WidthStyle, digit: WidthStyle, space: WidthStyle) -> Config {
        let mut config = Config::default();
        config.char_widths.alphabet = alphabet;
        config.char_widths.digit = digit;
        config.char_widths.space = space;
        config
    }

    fn written_ids(result: &Reconcile) -> Vec<&str> {
        result
            .writes
            .iter()
            .map(|write| write.key.id.as_str())
            .collect()
    }

    #[test]
    fn char_widths_are_read_and_written_one_kind_at_a_time() {
        let base = Config::default();
        let local = widths(WidthStyle::Full, WidthStyle::Keep, WidthStyle::Keep);
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[
                remote(SETTINGS, "s_digit_width", 2, json!("half")),
                remote(SETTINGS, "s_katakana_width", 3, json!("full")),
            ],
            "key",
            3,
        );
        let mut expected = widths(WidthStyle::Full, WidthStyle::Half, WidthStyle::Keep);
        expected.char_widths.katakana = KatakanaWidth::Full;
        assert_eq!(result.config, expected);
        assert_eq!(written_ids(&result), ["s_alphabet_width"]);
        assert_eq!(result.writes[0].plain, Some(json!("full")));
    }

    #[test]
    fn the_first_sync_takes_each_char_width_kind_that_the_server_has() {
        let local = widths(WidthStyle::Full, WidthStyle::Full, WidthStyle::Keep);
        let result = reconcile(
            &local,
            None,
            &[remote(SETTINGS, "s_digit_width", 1, json!("half"))],
            "key",
            1,
        );
        assert_eq!(
            result.config,
            widths(WidthStyle::Full, WidthStyle::Half, WidthStyle::Keep)
        );
        let written = written_ids(&result);
        assert!(written.contains(&"s_alphabet_width"));
        assert!(!written.contains(&"s_digit_width"));
    }

    #[test]
    fn a_char_width_changed_on_both_devices_is_decided_for_that_kind_alone() {
        let base = Config::default();
        let local = widths(WidthStyle::Full, WidthStyle::Full, WidthStyle::Keep);
        let items = [
            remote(SETTINGS, "s_alphabet_width", 2, json!("half")),
            remote(SETTINGS, "s_space_width", 3, json!("half")),
        ];
        let result = reconcile(&local, Some(recorded(&base)), &items, "key", 3);
        // 英字は手元の方が後に変えたので手元を残して書き、空白は手元で変えていないので届いた値を入れる
        assert_eq!(
            result.config,
            widths(WidthStyle::Full, WidthStyle::Full, WidthStyle::Half)
        );
        assert_eq!(written_ids(&result), ["s_alphabet_width", "s_digit_width"]);
    }

    #[test]
    fn an_excluded_char_width_kind_is_neither_read_nor_written() {
        let base = Config::default();
        let mut local = widths(WidthStyle::Full, WidthStyle::Full, WidthStyle::Keep);
        local.sync_excluded_settings = vec!["digit_width".to_string()];
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[
                remote(SETTINGS, "s_digit_width", 2, json!("half")),
                remote(SETTINGS, "s_space_width", 3, json!("half")),
            ],
            "key",
            3,
        );
        assert_eq!(result.config.char_widths.digit, WidthStyle::Full);
        assert_eq!(result.config.char_widths.space, WidthStyle::Half);
        assert_eq!(written_ids(&result), ["s_alphabet_width"]);
    }

    #[test]
    fn unknown_char_width_values_are_not_applied_or_written_back() {
        let local = Config::default();
        for (id, value) in [
            ("s_alphabet_width", json!("wide")),
            // カタカナは半角に揃えない
            ("s_katakana_width", json!("half")),
            ("s_digit_width", json!({ "digit": "half" })),
        ] {
            let result = reconcile(
                &local,
                Some(recorded(&local)),
                &[remote(SETTINGS, id, 2, value)],
                "key",
                2,
            );
            assert_eq!(result.config, local, "{id}");
            assert!(
                result
                    .state
                    .ignored
                    .contains_key(&format!("settings\0{id}")),
                "{id}"
            );
            assert!(result.writes.is_empty(), "{id}");
        }
    }

    #[test]
    fn conversion_round_trips_every_synced_value() {
        let id = "d".repeat(32);
        let mut config = Config {
            language: Language::En,
            theme: Theme::Dark,
            text_window_always_on_top: false,
            hide_text_window_on_blur: false,
            show_text_window_buttons: false,
            text_history_size: 42,
            trim_trailing_whitespace: false,
            punctuation_style: PunctuationStyle::Comma,
            char_widths: crate::text::CharWidths {
                alphabet: WidthStyle::Full,
                digit: WidthStyle::Half,
                space: WidthStyle::Full,
                symbol: WidthStyle::Half,
                katakana: KatakanaWidth::Full,
            },
            exclude_from_clipboard_history: false,
            hotkey: "Alt+KeyX".into(),
            text_font_family: "Test Sans".into(),
            text_font_size: 20,
            text_color_light: "#112233".into(),
            text_color_dark: "#aabbcc".into(),
            input_guidance: Some("guide".into()),
            ai_service: AiService::Gemini,
            ..Config::default()
        };
        config.ai_models.insert(AiService::Gemini, "model".into());
        *config.text_window_keys.get_mut(DraftAction::HistoryOlder) = "Alt+KeyP".into();
        config.text_window_keys.get_mut(DraftAction::Copy).clear();
        config.replacements.push(Replacement {
            id: id.clone(),
            from: "from".into(),
            to: "to".into(),
            enabled: false,
            sync: true,
        });
        let mut snippets = actions::default_snippets(crate::i18n::Lang::En);
        snippets.push(Snippet {
            id: id.clone(),
            name: "name".into(),
            body: "body".into(),
            output: crate::config::ActionOutput::Insert,
            encoding: crate::config::ActionEncoding::ShiftJis,
            enabled: false,
            sync: true,
        });
        config.snippets = Some(snippets);
        let items = config_items(&config);
        let mut restored = Config::default();
        for (key, value) in items.iter().filter(|(key, _)| !is_order(key)) {
            assert!(apply_value(&mut restored, key, value), "{}", key.id);
        }
        for (key, value) in items.iter().filter(|(key, _)| is_order(key)) {
            assert!(apply_value(&mut restored, key, value), "{}", key.id);
        }
        assert_eq!(config_items(&restored), items);
        assert_eq!(restored.text_window_keys, config.text_window_keys);
        assert_eq!(restored.input_guidance, config.input_guidance);
    }

    #[test]
    fn initial_sync_keeps_distinct_rows_from_both_devices() {
        let id = "e".repeat(32);
        let remote_id = "f".repeat(32);
        let mut local = Config::default();
        local.replacements.push(Replacement {
            id,
            from: "local".into(),
            to: "row".into(),
            enabled: true,
            sync: true,
        });
        let remote_row = json!({ "from": "remote", "to": "row", "enabled": true });
        let result = reconcile(
            &local,
            None,
            &[remote(SETTINGS, &row_id('r', &remote_id), 1, remote_row)],
            "key",
            1,
        );
        assert_eq!(result.config.replacements.len(), 2);
    }

    #[test]
    fn initial_sync_deduplicates_equal_rows_using_the_remote_id() {
        let local_id = "0".repeat(32);
        let remote_id = "1".repeat(32);
        let mut local = Config::default();
        local.replacements.push(Replacement {
            id: local_id,
            from: "same".into(),
            to: "row".into(),
            enabled: true,
            sync: true,
        });
        let result = reconcile(
            &local,
            None,
            &[remote(
                SETTINGS,
                &row_id('r', &remote_id),
                1,
                json!({ "from": "same", "to": "row", "enabled": true }),
            )],
            "key",
            1,
        );
        assert_eq!(result.config.replacements.len(), 1);
        assert_eq!(result.config.replacements[0].id, remote_id);
    }

    #[test]
    fn initial_sync_keeps_equal_rows_that_are_both_already_on_the_server() {
        let first = "a".repeat(32);
        let second = "b".repeat(32);
        let local = Config::default();
        let row = json!({ "from": "a", "to": "b", "enabled": true });
        let result = reconcile(
            &local,
            None,
            &[
                remote(SETTINGS, &row_id('r', &first), 1, row.clone()),
                remote(SETTINGS, &row_id('r', &second), 2, row),
            ],
            "key",
            2,
        );
        assert_eq!(result.config.replacements.len(), 2);
        assert!(!result.writes.iter().any(|write| write.deleted));
    }

    #[test]
    fn remote_order_keeps_local_only_rows_after_it() {
        let first = "2".repeat(32);
        let second = "3".repeat(32);
        let mut local = Config::default();
        for id in [&first, &second] {
            local.replacements.push(Replacement {
                id: id.to_string(),
                from: id.to_string(),
                to: "x".into(),
                enabled: true,
                sync: true,
            });
        }
        let result = reconcile(
            &local,
            None,
            &[remote(SETTINGS, "o_replacements", 2, json!([first]))],
            "key",
            2,
        );
        assert_eq!(
            result
                .config
                .replacements
                .iter()
                .map(|row| &row.id)
                .collect::<Vec<_>>(),
            vec![&first, &second]
        );
    }

    #[test]
    fn initial_order_places_server_rows_before_local_only_rows() {
        let local_id = "3".repeat(32);
        let remote_id = "4".repeat(32);
        let mut local = Config::default();
        local.replacements.push(Replacement {
            id: local_id.clone(),
            from: "local".into(),
            to: "row".into(),
            enabled: true,
            sync: true,
        });
        let result = reconcile(
            &local,
            None,
            &[
                remote(
                    SETTINGS,
                    &row_id('r', &remote_id),
                    1,
                    json!({ "from": "remote", "to": "row", "enabled": true }),
                ),
                remote(SETTINGS, "o_replacements", 2, json!([remote_id])),
            ],
            "key",
            2,
        );
        assert_eq!(
            result
                .config
                .replacements
                .iter()
                .map(|row| &row.id)
                .collect::<Vec<_>>(),
            vec![&remote_id, &local_id]
        );
    }

    #[test]
    fn order_keeps_unsynced_rows_attached_to_their_predecessor() {
        let first = "4".repeat(32);
        let middle = "5".repeat(32);
        let second = "6".repeat(32);
        let mut rows = vec![
            Replacement {
                id: first.clone(),
                from: "a".into(),
                to: "a".into(),
                enabled: true,
                sync: true,
            },
            Replacement {
                id: middle.clone(),
                from: "b".into(),
                to: "b".into(),
                enabled: true,
                sync: false,
            },
            Replacement {
                id: second.clone(),
                from: "c".into(),
                to: "c".into(),
                enabled: true,
                sync: true,
            },
        ];
        assert!(apply_order(&mut rows, &json!([second, first])));
        assert_eq!(
            rows.iter().map(|row| &row.id).collect::<Vec<_>>(),
            vec![&second, &first, &middle]
        );
    }

    #[test]
    fn order_keeps_a_leading_unsynced_row_in_front() {
        let first = "7".repeat(32);
        let second = "8".repeat(32);
        let mut rows = vec![
            Replacement {
                id: "9".repeat(32),
                from: "local".into(),
                to: "only".into(),
                enabled: true,
                sync: false,
            },
            Replacement {
                id: first.clone(),
                from: "a".into(),
                to: "a".into(),
                enabled: true,
                sync: true,
            },
            Replacement {
                id: second.clone(),
                from: "b".into(),
                to: "b".into(),
                enabled: true,
                sync: true,
            },
        ];
        assert!(apply_order(&mut rows, &json!([second, first])));
        assert!(!rows[0].sync);
    }

    #[test]
    fn order_ignores_missing_and_duplicate_ids_without_losing_rows() {
        let first = "a".repeat(32);
        let second = "b".repeat(32);
        let mut rows = vec![
            Replacement {
                id: first.clone(),
                from: "a".into(),
                to: "a".into(),
                enabled: true,
                sync: true,
            },
            Replacement {
                id: second.clone(),
                from: "b".into(),
                to: "b".into(),
                enabled: true,
                sync: true,
            },
        ];
        assert!(apply_order(
            &mut rows,
            &json!(["c".repeat(32), first, first])
        ));
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn state_round_trips_through_its_text() {
        let state = recorded(&Config::default());
        assert_eq!(parse_state(&state_text(&state)).unwrap().items, state.items);
    }

    #[test]
    fn a_null_value_survives_the_plaintext() {
        // 既定の input_guidance は null。値が無い平文として読み捨てると、既定に戻したことが伝わらない
        let key = [3; 32];
        let item = setting_item("input_guidance");
        let data = encrypt(&key, "key", &item, &Plain::value(Value::Null)).unwrap();
        assert_eq!(
            decrypt(&key, "key", &item, &data).unwrap().value,
            Some(Value::Null)
        );
    }

    #[test]
    fn text_window_keys_use_the_config_file_names_and_omit_yielded_keys() {
        let mut config = Config::default();
        *config.text_window_keys.get_mut(DraftAction::HistoryOlder) = "Alt+KeyP".into();
        config
            .text_window_keys
            .get_mut(DraftAction::ChangeFolder)
            .clear();
        config.yielded_draft_keys = vec![DraftAction::ChangeFolder];
        let value = config_items(&config)[&text_window_keys_item()].clone();
        assert_eq!(value["history_older"], json!("Alt+KeyP"));
        assert!(value.get("change_folder").is_none(), "{value}");

        let mut received = Config::default();
        assert!(apply_value(&mut received, &text_window_keys_item(), &value));
        assert_eq!(
            received.text_window_keys.get(DraftAction::HistoryOlder),
            "Alt+KeyP"
        );
        // 書いていない操作は、重なりが無ければ既定のキーを使う
        assert_eq!(
            received.text_window_keys.get(DraftAction::ChangeFolder),
            DraftKeys::default().get(DraftAction::ChangeFolder)
        );
    }

    #[test]
    fn text_window_keys_with_actions_this_version_does_not_have_are_taken() {
        // 知らない操作のキーは読み捨て、知っている操作のキーだけを入れる
        let value = json!({
            "copy": "Alt+KeyP",
            "send": "CommandOrControl+KeyJ",
            "send_targets": "CommandOrControl+KeyL",
            "insert_received": "CommandOrControl+KeyI",
            "discard_received": "",
        });
        let mut received = Config::default();
        assert!(apply_value(&mut received, &text_window_keys_item(), &value));
        assert_eq!(received.text_window_keys.get(DraftAction::Copy), "Alt+KeyP");
        // 知らない操作のキーは、どの操作のキーにもならない
        assert_eq!(
            received
                .text_window_keys
                .action_for("CommandOrControl+KeyL"),
            None
        );
        assert_eq!(
            received
                .text_window_keys
                .action_for("CommandOrControl+KeyJ"),
            None
        );
    }

    #[test]
    fn keys_that_fail_the_screen_checks_are_ignored_without_a_write() {
        let local = Config::default();
        let copy = local.text_window_keys.get(DraftAction::Copy).to_string();
        let cases = [
            // ホットキーが、テキストウィンドウのキーと重なる
            (hotkey_item(), json!(copy)),
            // 2つの操作に同じキー
            (
                text_window_keys_item(),
                json!({ "snippets": "Alt+KeyP", "settings": "Alt+KeyP" }),
            ),
            // ホットキーと同じキー
            (text_window_keys_item(), json!({ "copy": local.hotkey })),
            (text_window_keys_item(), json!({ "copy": 1 })),
        ];
        for (key, value) in cases {
            let result = reconcile(
                &local,
                Some(recorded(&local)),
                &[remote(SETTINGS, &key.id, 2, value.clone())],
                "key",
                2,
            );
            assert_eq!(result.config, local, "{value}");
            assert_eq!(result.state.ignored.get(&key.name()), Some(&2), "{value}");
            assert!(result.writes.is_empty(), "{value}");
        }
    }

    /// 窓口の、`at` の時刻に変えた値
    fn remote_at(id: &str, seq: u64, value: Value, at: u64) -> RemoteItem {
        RemoteItem {
            key: ItemKey::new(SETTINGS, id),
            seq,
            deleted: false,
            plain: Some(Plain {
                at,
                ..Plain::value(value)
            }),
        }
    }

    #[test]
    fn local_changes_are_named_by_item_including_rows_that_stop_syncing() {
        let before = Config {
            replacements: vec![replacement('a', "row")],
            ..Config::default()
        };
        let mut after = before.clone();
        after.theme = Theme::Dark;
        after.replacements[0].sync = false;
        assert_eq!(
            changed_items(&before, &after),
            [
                "settings\0o_replacements".to_string(),
                row_key('r', 'a').name(),
                setting_item("theme").name(),
            ]
        );
        assert!(changed_items(&before, &before).is_empty());
    }

    #[test]
    fn editing_one_default_snippet_names_only_that_row() {
        let before = Config::default();
        let mut snippets = default_snippets_for(before.language);
        let edited = snippets.iter().position(|snippet| snippet.sync).unwrap();
        snippets[edited].body.push('!');
        let key = ItemKey::new(SETTINGS, row_id('n', &snippets[edited].id));
        let after = Config {
            snippets: Some(snippets),
            ..before.clone()
        };
        assert_eq!(changed_items(&before, &after), [key.name()]);
        // 既定の定型文のまま言語だけを替えても、既定の行は積まない
        let switched = Config {
            language: Language::Ja,
            ..before.clone()
        };
        assert_eq!(
            changed_items(&before, &switched),
            [setting_item("language").name()]
        );
    }

    #[test]
    fn a_written_change_is_reported_with_the_time_it_was_queued() {
        let base = Config::default();
        let local = Config {
            theme: Theme::Dark,
            ..base.clone()
        };
        let name = setting_item("theme").name();
        let outbox = BTreeMap::from([(name.clone(), 7)]);
        let mut transport = FakeTransport::reading([read(1, [])]).after_seq(1);
        let result = tauri::async_runtime::block_on(sync_once_with(
            &mut transport,
            &local,
            Some(recorded(&base)),
            &outbox,
            "key",
            None,
        ))
        .unwrap();
        assert_eq!(result.sent, [(name, 7)]);
        assert!(result.accepted.is_empty());
        assert_eq!(transport.written("s_theme")[0].at, 7);
    }

    #[test]
    fn a_change_with_nothing_to_write_leaves_the_oplog() {
        let config = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let gone = row_key('r', 'a').name();
        let kept = setting_item("theme").name();
        let outbox = BTreeMap::from([(gone.clone(), 3), (kept.clone(), 4)]);
        let result = super::reconcile(
            &config,
            Some(recorded(&Config::default())),
            &outbox,
            &[],
            "key",
            1,
        );
        // 足して消した行は窓口に一度も書いていないので、送るものが無い。設定の項目は書く
        assert_eq!(result.accepted, [(gone, 3)]);
        assert_eq!(result.pending, BTreeMap::from([(kept, 4)]));
    }

    #[test]
    fn an_order_put_back_as_recorded_leaves_the_oplog() {
        let config = Config {
            replacements: vec![replacement('a', "a"), replacement('b', "b")],
            ..Config::default()
        };
        let order = ItemKey::new(SETTINGS, order_id("replacements")).name();
        let outbox = BTreeMap::from([(order.clone(), 3)]);
        let result = super::reconcile(&config, Some(recorded(&config)), &outbox, &[], "key", 1);
        assert_eq!(result.accepted, [(order, 3)]);
        assert!(result.writes.is_empty());
    }

    #[test]
    fn a_value_changed_and_put_back_here_takes_the_server_value() {
        let base = Config::default();
        let theme = setting_item("theme").name();
        let outbox = BTreeMap::from([(theme.clone(), 20)]);
        let result = super::reconcile(
            &base,
            Some(recorded(&base)),
            &outbox,
            &[remote_at("s_theme", 2, json!("dark"), 10)],
            "key",
            2,
        );
        assert_eq!(result.config.theme, Theme::Dark);
        assert_eq!(result.accepted, [(theme.clone(), 20)]);
        assert!(written_ids(&result).is_empty());
        // 届いた項目が無くても、戻した項目は書かずに oplog から外す
        let result = super::reconcile(&base, Some(recorded(&base)), &outbox, &[], "key", 2);
        assert_eq!(result.accepted, [(theme, 20)]);
        assert!(result.writes.is_empty());
    }

    #[test]
    fn a_value_changed_later_here_overwrites_the_server() {
        let base = Config::default();
        let local = Config {
            theme: Theme::Dark,
            ..base.clone()
        };
        let outbox = BTreeMap::from([(setting_item("theme").name(), 20)]);
        let result = super::reconcile(
            &local,
            Some(recorded(&base)),
            &outbox,
            &[remote_at("s_theme", 2, json!("light"), 10)],
            "key",
            2,
        );
        assert_eq!(result.config.theme, Theme::Dark);
        assert!(result.accepted.is_empty());
        let write = result
            .writes
            .iter()
            .find(|write| write.key.id == "s_theme")
            .unwrap();
        assert_eq!((write.base_seq, write.at), (Some(2), 20));
        assert_eq!(write.plain, Some(json!("dark")));
    }

    #[test]
    fn a_value_changed_later_there_or_at_the_same_time_is_taken() {
        let base = Config::default();
        let local = Config {
            theme: Theme::Dark,
            ..base.clone()
        };
        for at in [20, 30] {
            let outbox = BTreeMap::from([(setting_item("theme").name(), 20)]);
            let result = super::reconcile(
                &local,
                Some(recorded(&base)),
                &outbox,
                &[remote_at("s_theme", 2, json!("light"), at)],
                "key",
                2,
            );
            assert_eq!(result.config.theme, Theme::Light, "at {at}");
            assert_eq!(
                result.accepted,
                [(setting_item("theme").name(), 20)],
                "at {at}"
            );
            assert!(written_ids(&result).is_empty(), "at {at}");
        }
    }

    #[test]
    fn a_row_changed_here_and_deleted_there_is_kept_and_written_again() {
        let base = Config {
            replacements: vec![replacement('a', "row")],
            ..Config::default()
        };
        let local = Config {
            replacements: vec![replacement('a', "changed")],
            ..Config::default()
        };
        let key = row_key('r', 'a');
        let result = reconcile(&local, Some(recorded(&base)), &[deleted(&key, 4)], "key", 4);
        assert_eq!(result.config.replacements, local.replacements);
        let write = result.writes.iter().find(|write| write.key == key).unwrap();
        assert_eq!(write.base_seq, Some(4));
        assert!(!write.deleted);
    }

    #[test]
    fn a_row_deleted_here_and_changed_there_comes_back_even_if_deleted_later() {
        let base = Config {
            replacements: vec![replacement('a', "row")],
            ..Config::default()
        };
        let key = row_key('r', 'a');
        let changed = replacement('a', "changed");
        let outbox = BTreeMap::from([(key.name(), 20)]);
        let result = super::reconcile(
            &Config::default(),
            Some(recorded(&base)),
            &outbox,
            &[remote_at(&key.id, 4, row_value(&changed), 10)],
            "key",
            4,
        );
        assert_eq!(result.config.replacements, [changed]);
        assert_eq!(result.accepted, [(key.name(), 20)]);
        assert!(!result.writes.iter().any(|write| write.key == key));
    }

    #[test]
    fn an_item_at_or_below_the_recorded_seq_is_not_a_new_change() {
        // 古い暗号文の出し直し。手元を変えていなくても入れない
        let local = Config::default();
        let mut state = recorded(&local);
        state.items.get_mut("settings\0s_theme").unwrap().seq = 5;
        for seq in [4, 5] {
            let result = reconcile(
                &local,
                Some(state.clone()),
                &[remote(SETTINGS, "s_theme", seq, json!("dark"))],
                "key",
                5,
            );
            assert_eq!(result.config.theme, local.theme, "seq {seq}");
        }
    }

    fn replacement(id: char, from: &str) -> Replacement {
        Replacement {
            id: id.to_string().repeat(32),
            from: from.into(),
            to: "to".into(),
            enabled: true,
            sync: true,
        }
    }

    fn row_key(prefix: char, id: char) -> ItemKey {
        ItemKey::new(SETTINGS, row_id(prefix, &id.to_string().repeat(32)))
    }

    fn deleted(key: &ItemKey, seq: u64) -> RemoteItem {
        RemoteItem {
            key: key.clone(),
            seq,
            deleted: true,
            plain: None,
        }
    }

    fn detached_mark(key: &ItemKey, seq: u64) -> RemoteItem {
        RemoteItem {
            key: key.clone(),
            seq,
            deleted: false,
            plain: Some(Plain::detached()),
        }
    }

    #[test]
    fn initial_sync_removes_a_local_row_the_server_recorded_as_deleted() {
        let local = Config {
            replacements: vec![replacement('a', "gone"), replacement('b', "kept")],
            ..Config::default()
        };
        let key = row_key('r', 'a');
        let result = reconcile(&local, None, &[deleted(&key, 4)], "key", 4);
        assert_eq!(result.config.replacements, [replacement('b', "kept")]);
        assert_eq!(result.state.retired.get(&key.name()), Some(&4));
        assert!(!result.writes.iter().any(|write| write.key == key));
    }

    #[test]
    fn initial_sync_unsyncs_a_local_row_the_server_marked_as_detached() {
        let local = Config {
            replacements: vec![replacement('a', "local only")],
            ..Config::default()
        };
        let key = row_key('r', 'a');
        let result = reconcile(&local, None, &[detached_mark(&key, 4)], "key", 4);
        assert_eq!(result.config.replacements.len(), 1);
        assert!(!result.config.replacements[0].sync);
        assert!(!result.writes.iter().any(|write| write.key == key));
    }

    #[test]
    fn an_unknown_plaintext_version_is_unreadable() {
        let future = serde_json::to_vec(&json!({ "v": VERSION + 1, "value": "dark" })).unwrap();
        assert!(decode_plain(&future).is_none());
    }

    fn default_snippet(index: usize, lang: crate::i18n::Lang) -> Snippet {
        actions::default_snippets(lang).swap_remove(index)
    }

    /// 既定の定型文のままのデバイスが、初めての同期でない回と初めての同期で受け取る
    fn receive_snippets(items: &[RemoteItem]) -> [Reconcile; 2] {
        let local = Config::default();
        [Some(recorded(&local)), None].map(|state| reconcile(&local, state, items, "key", 9))
    }

    #[test]
    fn default_snippets_from_another_device_do_not_conflict_with_the_local_defaults() {
        let sort = default_snippet(1, crate::i18n::Lang::system());
        // 相手は、英訳を別の表示言語で持ち、並べ替えを同期する行にして、別の文字コードで書いている
        for lang in [crate::i18n::Lang::Ja, crate::i18n::Lang::En] {
            let translate = Snippet {
                enabled: false,
                ..default_snippet(0, lang)
            };
            let their_sort = Snippet {
                encoding: crate::config::ActionEncoding::ShiftJis,
                output: crate::config::ActionOutput::Insert,
                sync: true,
                ..sort.clone()
            };
            let items = [
                remote(
                    SETTINGS,
                    &row_id('n', &their_sort.id),
                    2,
                    row_value(&their_sort),
                ),
                remote(
                    SETTINGS,
                    &row_id('n', &translate.id),
                    3,
                    row_value(&translate),
                ),
                remote(
                    SETTINGS,
                    "o_snippets",
                    4,
                    json!([translate.id, their_sort.id]),
                ),
            ];
            for result in receive_snippets(&items) {
                assert_eq!(
                    result.config.snippets,
                    Some(vec![translate.clone(), sort.clone()]),
                    "{lang:?}"
                );
                // 並べ替えは手元で同期しない行。その id を抜いた並びを書き戻さない
                assert!(snippet_writes(&result).is_empty(), "{lang:?}");
            }
        }
    }

    fn snippet_writes(result: &Reconcile) -> Vec<&Write> {
        result
            .writes
            .iter()
            .filter(|write| write.key.id.starts_with("n_") || write.key.id == "o_snippets")
            .collect()
    }

    #[test]
    fn unsyncing_a_default_snippet_never_written_writes_the_mark_once() {
        let mut translate = default_snippet(0, crate::i18n::Lang::system());
        translate.sync = false;
        let key = ItemKey::new(SETTINGS, row_id('n', &translate.id));
        // 既定の定型文のままのデバイスで、最初の操作として英訳を同期から外した
        let local = Config {
            snippets: Some(vec![
                translate,
                default_snippet(1, crate::i18n::Lang::system()),
            ]),
            ..Config::default()
        };
        for (first_sync, state) in [(false, Some(recorded(&Config::default()))), (true, None)] {
            let since = state.as_ref().map_or(0, |state| state.since);
            let mut first = FakeTransport::reading([read(since, [])]).after_seq(since);
            let result = run(&mut first, &local, state).unwrap();
            let [mark] = &first.written(&key.id)[..] else {
                panic!("first sync: {first_sync}, the mark is written once");
            };
            assert!(mark.detached && !mark.deleted, "first sync: {first_sync}");
            assert_eq!(mark.base_seq, None, "first sync: {first_sync}");
            assert_eq!(result.config, local, "first sync: {first_sync}");

            let mut second = FakeTransport::reading([read(first.seq, first.stored.clone())])
                .after_seq(first.seq);
            let next = run(&mut second, &local, Some(result.state)).unwrap();
            assert!(second.writes.is_empty(), "first sync: {first_sync}");
            assert_eq!(next.config, local, "first sync: {first_sync}");
        }
    }

    /// 英訳（既定で同期する既定の定型文）を、同期しない行として持つデバイス
    fn translate_unsynced() -> (Config, ItemKey) {
        let translate = Snippet {
            sync: false,
            ..default_snippet(0, crate::i18n::Lang::system())
        };
        let key = ItemKey::new(SETTINGS, row_id('n', &translate.id));
        let local = Config {
            snippets: Some(vec![
                translate,
                default_snippet(1, crate::i18n::Lang::system()),
            ]),
            ..Config::default()
        };
        (local, key)
    }

    #[test]
    fn an_unsynced_default_snippet_already_on_the_server_gets_no_mark() {
        let (local, key) = translate_unsynced();
        let arrivals = [
            (
                "value",
                remote(
                    SETTINGS,
                    &key.id,
                    6,
                    row_value(&default_snippet(0, crate::i18n::Lang::En)),
                ),
            ),
            ("deleted", deleted(&key, 6)),
            ("mark", detached_mark(&key, 6)),
        ];
        for (first_sync, state) in [(false, Some(recorded(&local))), (true, None)] {
            for (arrival, item) in &arrivals {
                let case = format!("first sync: {first_sync}, {arrival}");
                let result = reconcile(&local, state.clone(), std::slice::from_ref(item), "key", 6);
                assert!(
                    !result.writes.iter().any(|write| write.key == key),
                    "{case}"
                );
                assert_eq!(result.config, local, "{case}");
                assert!(!result.changed, "{case}");

                let next = reconcile(&local, Some(result.state), &[], "key", 6);
                assert!(!next.writes.iter().any(|write| write.key == key), "{case}");
            }
        }
    }

    #[test]
    fn a_mark_refused_because_the_item_exists_is_not_written_again() {
        let (local, key) = translate_unsynced();
        // 読んだ後に、ほかのデバイスが英訳を書いた
        let theirs = ConflictItem {
            key: key.clone(),
            seq: Some(5),
            deleted: false,
            plain: Some(Plain::value(row_value(&default_snippet(
                0,
                crate::i18n::Lang::En,
            )))),
        };
        let mut first = FakeTransport::reading([read(1, [])])
            .failing([Error::Conflict(vec![theirs])])
            .after_seq(5);
        let result = run(&mut first, &local, Some(recorded(&Config::default()))).unwrap();
        let [refused] = &first.written(&key.id)[..] else {
            panic!("the mark is tried once");
        };
        assert!(refused.detached);
        assert!(!first.stored.iter().any(|item| item.key == key));
        assert_eq!(result.config, local);
        assert!(!result.changed);

        let mut second =
            FakeTransport::reading([read(first.seq, first.stored.clone())]).after_seq(first.seq);
        let next = run(&mut second, &local, Some(result.state)).unwrap();
        assert!(second.writes.is_empty());
        assert_eq!(next.config, local);
    }

    #[test]
    fn a_mark_is_written_no_later_than_the_order_without_its_row() {
        let (mut local, key) = translate_unsynced();
        // 並びより後に積まれる行で、1回の書き込みの上限を超える
        for index in 0..WRITE_BATCH_SIZE {
            local.replacements.push(Replacement {
                id: format!("{index:032x}"),
                from: index.to_string(),
                to: "to".into(),
                enabled: true,
                sync: true,
            });
        }
        let mut transport = FakeTransport::reading([read(1, [])]).after_seq(1);
        run(&mut transport, &local, Some(recorded(&Config::default()))).unwrap();
        assert!(transport.writes.len() > 1);
        let batch_of = |id: &str| {
            transport
                .writes
                .iter()
                .position(|batch| batch.iter().any(|write| write.key.id == id))
                .unwrap_or_else(|| panic!("{id} is written"))
        };
        assert!(batch_of(&key.id) <= batch_of("o_snippets"));
    }

    #[test]
    fn a_default_snippet_unsynced_on_another_device_stays_as_an_unsynced_row() {
        let sort = default_snippet(1, crate::i18n::Lang::system());
        let translate = Snippet {
            sync: false,
            ..default_snippet(0, crate::i18n::Lang::system())
        };
        let custom = Snippet {
            id: "a".repeat(32),
            name: "自作".into(),
            body: "echo".into(),
            ..Snippet::default()
        };
        let mark_key = ItemKey::new(SETTINGS, row_id('n', &translate.id));
        // どれが先に届いても同じ
        for (mark_seq, other_seq) in [(2, 3), (3, 2)] {
            let items = [
                detached_mark(&mark_key, mark_seq),
                remote(SETTINGS, "o_snippets", other_seq, json!([])),
            ];
            for result in receive_snippets(&items) {
                assert_eq!(
                    result.config.snippets,
                    Some(vec![translate.clone(), sort.clone()]),
                    "mark at {mark_seq}"
                );
                assert!(snippet_writes(&result).is_empty(), "mark at {mark_seq}");
            }
            let items = [
                detached_mark(&mark_key, mark_seq),
                remote(
                    SETTINGS,
                    &row_id('n', &custom.id),
                    other_seq,
                    row_value(&custom),
                ),
                remote(SETTINGS, "o_snippets", 4, json!([custom.id])),
            ];
            for result in receive_snippets(&items) {
                assert_eq!(
                    result.config.snippets,
                    Some(vec![translate.clone(), sort.clone(), custom.clone()]),
                    "mark at {mark_seq}"
                );
                assert!(snippet_writes(&result).is_empty(), "mark at {mark_seq}");
            }
        }
    }

    #[test]
    fn an_empty_order_without_a_mark_does_not_write_out_the_synced_default() {
        let sort = default_snippet(1, crate::i18n::Lang::system());
        for result in receive_snippets(&[remote(SETTINGS, "o_snippets", 2, json!([]))]) {
            assert_eq!(result.config.snippets, Some(vec![sort.clone()]));
            assert!(snippet_writes(&result).is_empty());
        }
    }

    #[test]
    fn a_default_snippet_deleted_on_another_device_does_not_come_back() {
        let sort = default_snippet(1, crate::i18n::Lang::system());
        let translate = default_snippet(0, crate::i18n::Lang::En);
        let custom = Snippet {
            id: "a".repeat(32),
            name: "自作".into(),
            body: "echo".into(),
            ..Snippet::default()
        };
        let items = [
            deleted(&ItemKey::new(SETTINGS, row_id('n', &translate.id)), 2),
            remote(SETTINGS, &row_id('n', &custom.id), 3, row_value(&custom)),
            remote(SETTINGS, "o_snippets", 4, json!([custom.id])),
        ];
        for result in receive_snippets(&items) {
            assert_eq!(
                result.config.snippets,
                Some(vec![sort.clone(), custom.clone()])
            );
            let written = |prefix: &str| {
                result
                    .writes
                    .iter()
                    .any(|write| write.key.id.starts_with(prefix))
            };
            assert!(!written("n_") && !written("o_snippets"));
        }
    }

    #[test]
    fn an_unusable_snippet_item_leaves_the_default_snippets_unwritten() {
        let items = [
            remote(
                SETTINGS,
                &row_id('n', &"a".repeat(32)),
                2,
                json!("not a row"),
            ),
            remote(SETTINGS, "o_snippets", 3, json!("not an order")),
        ];
        for result in receive_snippets(&items) {
            assert_eq!(result.config.snippets, None);
        }
    }

    #[test]
    fn a_swapped_hotkey_and_key_arriving_together_are_both_applied() {
        let local = Config::default();
        let copy = local.text_window_keys.get(DraftAction::Copy).to_string();
        // 相手は、コピーのキーを替えてから、空いたキーをホットキーにした
        let mut theirs = local.clone();
        *theirs.text_window_keys.get_mut(DraftAction::Copy) = "Alt+KeyP".into();
        theirs.hotkey = copy.clone();
        let their_items = config_items(&theirs);
        let item = |key: ItemKey, seq| remote(SETTINGS, &key.id, seq, their_items[&key].clone());
        // どちらが先に届いても同じ
        for (hotkey_seq, keys_seq) in [(2, 3), (3, 2)] {
            let result = reconcile(
                &local,
                Some(recorded(&local)),
                &[
                    item(hotkey_item(), hotkey_seq),
                    item(text_window_keys_item(), keys_seq),
                ],
                "key",
                3,
            );
            assert_eq!(result.config.hotkey, copy);
            assert_eq!(result.config.text_window_keys, theirs.text_window_keys);
            assert!(result.state.ignored.is_empty());
            assert!(result.writes.is_empty());
        }
    }

    #[test]
    fn a_hotkey_and_keys_that_overlap_each_other_are_both_ignored() {
        let local = Config::default();
        let items = [
            remote(SETTINGS, &hotkey_item().id, 2, json!("Alt+KeyP")),
            remote(
                SETTINGS,
                &text_window_keys_item().id,
                3,
                json!({ "copy": "Alt+KeyP" }),
            ),
        ];
        let result = reconcile(&local, Some(recorded(&local)), &items, "key", 3);
        assert_eq!(result.config, local);
        assert_eq!(result.state.ignored.get(&hotkey_item().name()), Some(&2));
        assert_eq!(
            result.state.ignored.get(&text_window_keys_item().name()),
            Some(&3)
        );
        assert!(result.writes.is_empty());
    }

    #[test]
    fn ignore_applied_restores_the_record_and_holds_the_item() {
        let local = Config::default();
        let before = recorded(&local);
        let mut result = reconcile(
            &local,
            Some(before.clone()),
            &[remote(SETTINGS, &hotkey_item().id, 6, json!("Alt+KeyP"))],
            "key",
            6,
        );
        assert_eq!(result.config.hotkey, "Alt+KeyP");
        // OS が登録できなかったので、手元は元のホットキーのまま
        ignore_applied(&mut result.state, Some(&before), &hotkey_item());
        let name = hotkey_item().name();
        assert_eq!(result.state.items[&name], before.items[&name]);
        let next = reconcile(&local, Some(result.state.clone()), &[], "key", 6);
        assert!(
            next.writes.is_empty(),
            "the local hotkey is not written back"
        );
        // 窓口の値が変わったら、もう一度入れてみる
        let later = reconcile(
            &local,
            Some(result.state),
            &[remote(SETTINGS, &hotkey_item().id, 7, json!("Alt+KeyO"))],
            "key",
            7,
        );
        assert_eq!(later.config.hotkey, "Alt+KeyO");
        assert!(later.state.ignored.is_empty());
    }

    /// 窓口の代わり。書けた項目には `seq` を順に振り、読み戻せるよう `stored` に置く
    #[derive(Default)]
    struct FakeTransport {
        reads: std::collections::VecDeque<ReadResult>,
        /// 書く要求ごとに、先頭から1つずつ返す失敗。尽きたら書ける
        write_errors: std::collections::VecDeque<Error>,
        /// 何回目（0 から）の書く要求から、通信の失敗にするか
        fail_from_write: Option<usize>,
        seq: u64,
        read_since: Vec<u64>,
        /// 1項目を読み直した `seq`
        item_reads: Vec<u64>,
        writes: Vec<Vec<Write>>,
        stored: Vec<RemoteItem>,
    }

    impl FakeTransport {
        fn reading(reads: impl IntoIterator<Item = ReadResult>) -> Self {
            Self {
                reads: reads.into_iter().collect(),
                ..Self::default()
            }
        }

        fn failing(mut self, errors: impl IntoIterator<Item = Error>) -> Self {
            self.write_errors = errors.into_iter().collect();
            self
        }

        fn after_seq(mut self, seq: u64) -> Self {
            self.seq = seq;
            self
        }

        fn written(&self, id: &str) -> Vec<&Write> {
            self.writes
                .iter()
                .flatten()
                .filter(|write| write.key.id == id)
                .collect()
        }
    }

    impl SyncTransport for FakeTransport {
        fn read<'a>(
            &'a mut self,
            since: u64,
        ) -> Pin<Box<dyn Future<Output = Result<ReadResult, Error>> + Send + 'a>> {
            self.read_since.push(since);
            let read = self.reads.pop_front().expect("an unexpected read");
            Box::pin(std::future::ready(Ok(read)))
        }

        fn write<'a>(
            &'a mut self,
            writes: &'a [Write],
        ) -> Pin<Box<dyn Future<Output = Result<Vec<WrittenItem>, Error>> + Send + 'a>> {
            self.writes.push(writes.to_vec());
            let failing = self
                .fail_from_write
                .is_some_and(|from| self.writes.len() > from);
            let error = self
                .write_errors
                .pop_front()
                .or_else(|| failing.then(|| Error::Other("offline".into())));
            let result = match error {
                Some(error) => Err(error),
                None => Ok(writes
                    .iter()
                    .map(|write| {
                        self.seq += 1;
                        self.stored.push(RemoteItem {
                            key: write.key.clone(),
                            seq: self.seq,
                            deleted: write.deleted,
                            plain: write.payload(),
                        });
                        WrittenItem {
                            key: write.key.clone(),
                            seq: self.seq,
                        }
                    })
                    .collect()),
            };
            Box::pin(std::future::ready(result))
        }

        fn read_item<'a>(
            &'a mut self,
            key: &'a ItemKey,
            seq: u64,
        ) -> Pin<Box<dyn Future<Output = Result<Option<RemoteItem>, Error>> + Send + 'a>> {
            self.item_reads.push(seq);
            let current = self.stored.iter().rev().find(|item| item.key == *key);
            Box::pin(std::future::ready(Ok(current
                .filter(|item| item.seq == seq)
                .cloned())))
        }
    }

    fn read(next: u64, items: impl IntoIterator<Item = RemoteItem>) -> ReadResult {
        ReadResult {
            reset: false,
            next,
            items: items.into_iter().collect(),
        }
    }

    fn run(
        transport: &mut FakeTransport,
        config: &Config,
        state: Option<State>,
    ) -> Result<SyncResult, Box<Failure>> {
        let outbox = pending_since(config, state.as_ref());
        tauri::async_runtime::block_on(sync_once_with(
            transport, config, state, &outbox, "key", None,
        ))
    }

    #[test]
    fn a_deleted_write_carries_no_data_and_others_carry_ciphertext() {
        let key = [7; 32];
        let write = |deleted: bool| Write {
            key: ItemKey::new("settings", "s_theme"),
            base_seq: Some(3),
            deleted,
            plain: (!deleted).then(|| json!("dark")),
            detached: false,
            at: 0,
        };
        let items = put_items(&key, "key", &[write(true), write(false)]).unwrap();
        // 窓口は、消す項目の data が null だと要求ごと断る
        assert!(items[0].get("data").is_none(), "{}", items[0]);
        assert_eq!(items[0]["deleted"], json!(true));
        assert!(items[1]["data"].is_string(), "{}", items[1]);
    }

    #[test]
    fn rows_and_their_order_arriving_together_are_not_a_conflict() {
        let snippet = |id: char, name: &str| crate::config::Snippet {
            id: id.to_string().repeat(32),
            name: name.to_string(),
            body: name.to_string(),
            ..Snippet::default()
        };
        let local = Config {
            snippets: Some(vec![snippet('c', "手元")]),
            ..Config::default()
        };
        let theirs = Config {
            snippets: Some(vec![
                snippet('e', "新2"),
                snippet('d', "新1"),
                snippet('c', "手元"),
            ]),
            ..Config::default()
        };
        let their_items = config_items(&theirs);
        let item = |id: String, seq| {
            let key = ItemKey::new("settings", id);
            remote("settings", &key.id, seq, their_items[&key].clone())
        };
        let result = reconcile(
            &local,
            Some(recorded(&local)),
            &[
                item("o_snippets".to_string(), 4),
                item(format!("n_{}", "d".repeat(32)), 2),
                item(format!("n_{}", "e".repeat(32)), 3),
            ],
            "key",
            4,
        );
        assert_eq!(
            result
                .config
                .snippets
                .iter()
                .flatten()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            ["新2", "新1", "手元"]
        );
        assert!(result.writes.is_empty(), "{:?}", result.writes);
    }

    #[test]
    fn receiving_the_value_already_held_is_not_a_change() {
        let config = Config::default();
        let key = ItemKey::new("settings", "s_theme");
        let held = config_items(&config)[&key].clone();
        let mut transport =
            FakeTransport::reading([read(5, [remote("settings", "s_theme", 5, held)])]);
        let result = run(&mut transport, &config, Some(recorded(&config))).unwrap();
        // 変わったと返すと、同じ中身の設定を保存し直して、次の同期を呼んでしまう
        assert!(!result.changed);
        assert!(transport.writes.is_empty());
    }

    #[test]
    fn rereading_our_own_write_is_not_a_conflict_with_a_newer_local_change() {
        let dark = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let mut first = FakeTransport::reading([read(0, [])]);
        let synced = run(&mut first, &dark, None).unwrap();
        let ours = first
            .stored
            .iter()
            .find(|item| item.key.id == "s_theme")
            .unwrap()
            .clone();

        // 書いた直後に手元を変える。次の回は、記録の since から自分の書き込みを読み戻す
        let light = Config {
            theme: Theme::Light,
            ..dark
        };
        let mut second =
            FakeTransport::reading([read(first.seq, [ours.clone()])]).after_seq(first.seq);
        let result = run(&mut second, &light, Some(synced.state)).unwrap();
        assert_eq!(result.config.theme, Theme::Light);
        let writes = second.written("s_theme");
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].base_seq, Some(ours.seq));
        assert_eq!(writes[0].plain, Some(json!("light")));
    }

    #[test]
    fn discarding_a_result_keeps_our_writes_and_reads_the_rest_again() {
        let base = Config::default();
        let dark = Config {
            theme: Theme::Dark,
            ..base.clone()
        };
        let theirs = remote(SETTINGS, "s_language", 5, json!("en"));
        let mut first = FakeTransport::reading([read(5, [theirs.clone()])]).after_seq(5);
        let before = recorded(&base);
        let discarded = run(&mut first, &dark, Some(before.clone())).unwrap();
        assert_eq!(discarded.config.language, Language::En);
        let [ours] = &first.stored[..] else {
            panic!("only the local change is written: {:?}", first.stored);
        };
        let ours = ours.clone();
        assert_eq!(ours.key.id, "s_theme");

        // 通信の間に手元を変えたので、読んだ値は入れていない
        let record = merge_written(Some(before.clone()), &discarded.written, false, "key");
        assert_eq!(record.since, before.since);
        let light = Config {
            theme: Theme::Light,
            ..base
        };
        let mut second = FakeTransport::reading([read(6, [theirs, ours.clone()])]).after_seq(6);
        let result = run(&mut second, &light, Some(record)).unwrap();
        assert_eq!(second.read_since, [before.since]);
        assert_eq!(
            result.config.language,
            Language::En,
            "their change arrives again"
        );
        assert_eq!(result.config.theme, Theme::Light);
        assert_eq!(second.written("s_theme")[0].base_seq, Some(ours.seq));
        assert!(second.written("s_language").is_empty());
    }

    #[test]
    fn discarding_the_first_sync_does_not_roll_back_a_newer_local_value() {
        let dark = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let mut first = FakeTransport::reading([read(0, [])]);
        let discarded = run(&mut first, &dark, None).unwrap();
        let record = merge_written(None, &discarded.written, false, "key");

        // 次の回も初めての同期。窓口の写しには、自分が書いた古い値と、ほかのデバイスの値がある
        let light = Config {
            theme: Theme::Light,
            ..dark
        };
        let mut copy = first.stored.clone();
        copy.retain(|item| item.key.id != "s_language");
        copy.push(remote(SETTINGS, "s_language", first.seq + 1, json!("en")));
        let mut second =
            FakeTransport::reading([read(first.seq + 1, copy)]).after_seq(first.seq + 1);
        let result = run(&mut second, &light, Some(record)).unwrap();
        assert_eq!(second.read_since, [0]);
        assert_eq!(result.config.theme, Theme::Light);
        assert_eq!(second.written("s_theme")[0].plain, Some(json!("light")));
        assert_eq!(result.config.language, Language::En, "the server wins");
    }

    #[test]
    fn discarding_a_result_leaves_the_written_order_to_be_read_again() {
        let named = |id: char, name: &str| Snippet {
            name: name.into(),
            ..snippet(id, name.into())
        };
        // 初めての同期。窓口には相手の行と並びがあり、手元には手元だけの行がある
        let local = Config {
            snippets: Some(vec![named('f', "手元")]),
            ..Config::default()
        };
        let theirs = Config {
            snippets: Some(vec![named('e', "相手2"), named('d', "相手1")]),
            ..Config::default()
        };
        let their_items = config_items(&theirs);
        let ids = [
            row_id('n', &"d".repeat(32)),
            row_id('n', &"e".repeat(32)),
            "o_snippets".to_string(),
        ];
        let arrivals: Vec<_> = ids
            .into_iter()
            .zip(2..)
            .map(|(id, seq)| {
                let key = ItemKey::new(SETTINGS, id);
                remote(SETTINGS, &key.id, seq, their_items[&key].clone())
            })
            .collect();
        let mut first = FakeTransport::reading([read(4, arrivals.clone())]).after_seq(4);
        let discarded = run(&mut first, &local, None).unwrap();
        // 書いた並びは、届いた並びの後ろに手元の行を足したもの
        assert_eq!(first.written("o_snippets").len(), 1);

        let record = merge_written(None, &discarded.written, false, "key");
        let mut copy: Vec<_> = arrivals
            .into_iter()
            .filter(|item| item.key.id != "o_snippets")
            .collect();
        copy.extend(first.stored.clone());
        let mut second = FakeTransport::reading([read(first.seq, copy)]).after_seq(first.seq);
        let result = run(&mut second, &local, Some(record)).unwrap();
        let names: Vec<_> = result
            .config
            .snippets
            .iter()
            .flatten()
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(names, ["相手2", "相手1", "手元"]);
        assert!(second.written("o_snippets").is_empty());
    }

    #[test]
    fn discarding_a_result_keeps_a_written_order_that_was_the_local_order() {
        let rows = |ids: [char; 3]| Config {
            snippets: Some(
                ids.into_iter()
                    .map(|id| snippet(id, id.to_string()))
                    .collect(),
            ),
            ..Config::default()
        };
        let before = recorded(&rows(['d', 'e', 'f']));
        // 手元の並びだけを変えて書き、通信の間に設定が変わったので結果を捨てる
        let mut first = FakeTransport::reading([read(1, [])]).after_seq(1);
        let discarded = run(&mut first, &rows(['e', 'd', 'f']), Some(before.clone())).unwrap();
        let [ours] = &first.stored[..] else {
            panic!("only the order is written: {:?}", first.stored);
        };
        let ours = ours.clone();
        assert_eq!(ours.key.id, "o_snippets");
        let record = merge_written(Some(before), &discarded.written, false, "key");

        // 並びをもう一度変える。自分が書いた並びを読み戻しても、食い違いにならない
        let again = rows(['f', 'e', 'd']);
        let mut second =
            FakeTransport::reading([read(first.seq, [ours.clone()])]).after_seq(first.seq);
        let result = run(&mut second, &again, Some(record)).unwrap();
        assert_eq!(result.config, again);
        let [write] = &second.written("o_snippets")[..] else {
            panic!("the new order is written once");
        };
        assert_eq!(write.base_seq, Some(ours.seq));
        assert_eq!(write.plain, Some(config_items(&again)[&ours.key].clone()));
    }

    #[test]
    fn a_reset_or_another_key_discards_the_previous_record_when_merging() {
        let config = Config::default();
        let before = recorded(&config);
        let mut transport = FakeTransport::reading([ReadResult {
            reset: true,
            ..read(9, [])
        }])
        .after_seq(9);
        let result = run(&mut transport, &config, Some(before.clone())).unwrap();
        let merged = merge_written(Some(before.clone()), &result.written, true, "key");
        assert_eq!(merged.since, 0);
        assert!(merged.items.values().all(|seen| seen.seq > 9));

        let other = merge_written(Some(before), &result.written, false, "other");
        assert_eq!(other.key_id, "other");
        assert_eq!(other.since, 0);
    }

    #[test]
    fn unsyncing_a_row_writes_the_mark_and_syncing_it_again_builds_on_the_mark() {
        let base = Config {
            replacements: vec![replacement('d', "row")],
            ..Config::default()
        };
        let key = row_key('r', 'd');
        let mut unsynced = base.clone();
        unsynced.replacements[0].sync = false;
        let mut first = FakeTransport::reading([read(1, [])]).after_seq(1);
        let result = run(&mut first, &unsynced, Some(recorded(&base))).unwrap();
        let mark = first.written(&key.id)[0].clone();
        assert!(mark.detached && !mark.deleted);
        assert_eq!(mark.base_seq, Some(1));
        assert!(!result.state.items.contains_key(&key.name()));
        assert_eq!(result.config.replacements, unsynced.replacements);
        let mark_seq = first
            .stored
            .iter()
            .find(|item| item.key == key)
            .unwrap()
            .seq;

        let mut second = FakeTransport::reading([read(mark_seq, [])]).after_seq(mark_seq);
        run(&mut second, &base, Some(result.state)).unwrap();
        let write = second.written(&key.id)[0];
        assert_eq!(write.base_seq, Some(mark_seq));
        assert_eq!(write.plain, Some(row_value(&base.replacements[0])));
    }

    #[test]
    fn a_conflict_reply_aligns_the_record_before_writing_again() {
        let base = Config::default();
        let local = Config {
            theme: Theme::Dark,
            trim_trailing_whitespace: !base.trim_trailing_whitespace,
            text_history_size: 7,
            ..base.clone()
        };
        let conflicts = vec![
            // 窓口には、同じ値がもう入っている
            ConflictItem {
                key: setting_item("theme"),
                seq: Some(4),
                deleted: false,
                plain: Some(Plain::value(json!("dark"))),
            },
            // 窓口に項目が無い
            ConflictItem {
                key: setting_item("text_history_size"),
                seq: None,
                deleted: true,
                plain: None,
            },
        ];
        let mut transport = FakeTransport::reading([read(1, [])])
            .failing([Error::Conflict(conflicts)])
            .after_seq(4);
        let result = run(&mut transport, &local, Some(recorded(&base))).unwrap();
        assert_eq!(
            transport.read_since.len(),
            1,
            "the conflicts stand in for a read"
        );
        let second = &transport.writes[1];
        assert!(!second.iter().any(|write| write.key.id == "s_theme"));
        let base_seq = |id: &str| {
            second
                .iter()
                .find(|write| write.key.id == id)
                .unwrap_or_else(|| panic!("{id} is written again"))
                .base_seq
        };
        assert_eq!(base_seq("s_text_history_size"), None);
        assert_eq!(base_seq("s_trim_trailing_whitespace"), Some(1));
        assert_eq!(result.state.items["settings\0s_theme"].seq, 4);
        assert!(!result.changed);
    }

    #[test]
    fn a_conflict_during_the_first_sync_takes_the_server_value() {
        let local = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let conflict = ConflictItem {
            key: setting_item("theme"),
            seq: Some(3),
            deleted: false,
            plain: Some(Plain::value(json!("light"))),
        };
        let mut transport = FakeTransport::reading([read(0, [])])
            .failing([Error::Conflict(vec![conflict])])
            .after_seq(3);
        let result = run(&mut transport, &local, None).unwrap();
        assert_eq!(result.config.theme, Theme::Light);
        assert!(result.changed);
        assert!(!transport.writes[1]
            .iter()
            .any(|write| write.key.id == "s_theme"));
    }

    #[test]
    fn conflicts_are_retried_three_times_and_then_left_for_the_next_sync() {
        let conflict = || Error::Conflict(Vec::new());
        let mut transport = FakeTransport::reading([read(0, [])]).failing([
            conflict(),
            conflict(),
            conflict(),
            conflict(),
        ]);
        let error = run(&mut transport, &Config::default(), None)
            .unwrap_err()
            .error;
        assert!(
            matches!(error, Error::Other(message) if message == "sync conflicts did not settle")
        );
        assert_eq!(transport.writes.len(), 1 + MAX_CONFLICT_RETRIES);

        // 空の conflicts は、同じ要求の送り直し
        let mut transport =
            FakeTransport::reading([read(0, [])]).failing([conflict(), conflict(), conflict()]);
        run(&mut transport, &Config::default(), None).unwrap();
        assert_eq!(transport.writes[3].len(), transport.writes[0].len());
    }

    #[test]
    fn a_reset_discards_the_old_record_and_rebuilds_from_the_copy() {
        let config = Config {
            replacements: vec![replacement('a', "row")],
            ..Config::default()
        };
        let mut old = recorded(&config);
        old.ignored.insert("settings\0s_language".into(), 1);
        old.retired.insert(row_key('r', 'b').name(), 1);
        let copy = remote(SETTINGS, "s_theme", 8, json!("dark"));
        let mut transport = FakeTransport::reading([ReadResult {
            reset: true,
            ..read(9, [copy])
        }])
        .after_seq(9);
        let result = run(&mut transport, &config, Some(old)).unwrap();
        assert!(result.reset);
        assert_eq!(transport.read_since, [1]);
        assert_eq!(
            result.config.theme,
            Theme::Dark,
            "the copy wins as in a first sync"
        );
        assert_eq!(result.state.since, 9);
        assert!(result.state.ignored.is_empty());
        assert!(result.state.retired.is_empty());
        assert_eq!(result.state.items["settings\0s_theme"].seq, 8);
        // 写しに無い手元の項目は、初めての項目として書く
        let row = transport.written(&row_key('r', 'a').id)[0];
        assert_eq!(row.base_seq, None);
        assert!(result.state.items[&row_key('r', 'a').name()].seq > 9);
    }

    #[test]
    fn key_mismatch_is_returned_to_the_caller() {
        let mut transport = FakeTransport::reading([read(1, [])]).failing([Error::KeyMismatch]);
        let error = run(&mut transport, &Config::default(), None)
            .unwrap_err()
            .error;
        assert!(matches!(error, Error::KeyMismatch));
    }

    fn snippet(id: char, body: String) -> Snippet {
        Snippet {
            id: id.to_string().repeat(32),
            name: "name".into(),
            body,
            ..Snippet::default()
        }
    }

    #[test]
    fn only_the_item_over_the_size_limit_is_left_unwritten() {
        let config = Config {
            snippets: Some(vec![
                snippet('a', "x".repeat(MAX_ENCRYPTED_ITEM_BYTES)),
                snippet('b', "small".into()),
            ]),
            ..Config::default()
        };
        let large = row_key('n', 'a');
        let mut first = FakeTransport::reading([read(1, [])]).after_seq(1);
        let result = run(&mut first, &config, Some(recorded(&Config::default()))).unwrap();
        assert!(first.written(&large.id).is_empty());
        assert_eq!(first.written(&row_key('n', 'b').id).len(), 1);
        assert_eq!(first.written("o_snippets").len(), 1);
        assert!(result.state.too_large.contains_key(&large.name()));

        // 値が同じ間は試さない
        let mut again = FakeTransport::reading([read(first.seq, [])]).after_seq(first.seq);
        let unchanged = run(&mut again, &config, Some(result.state)).unwrap();
        assert!(again.writes.is_empty());

        let mut shortened = config.clone();
        shortened.snippets.as_mut().unwrap()[0].body = "short".into();
        let mut third = FakeTransport::reading([read(first.seq, [])]).after_seq(first.seq);
        let result = run(&mut third, &shortened, Some(unchanged.state)).unwrap();
        assert_eq!(third.written(&large.id)[0].base_seq, None);
        assert!(result.state.too_large.is_empty());
    }

    #[test]
    fn an_item_just_under_the_size_limit_is_written() {
        let fits = |body_len: usize| {
            let row = snippet('a', "x".repeat(body_len));
            encrypted_len(&Plain::value(row_value(&row))) <= MAX_ENCRYPTED_ITEM_BYTES
        };
        let overhead = encrypted_len(&Plain::value(row_value(&snippet('a', String::new()))));
        assert!(fits(MAX_ENCRYPTED_ITEM_BYTES - overhead));
        assert!(!fits(MAX_ENCRYPTED_ITEM_BYTES - overhead + 1));
        // 測った大きさは、窓口が測る base64 を解いた暗号文の大きさと同じ
        let key = row_key('n', 'a');
        let plain = Plain::value(json!("x"));
        let data = encrypt(&[1; 32], "key", &key, &plain).unwrap();
        assert_eq!(STANDARD.decode(data).unwrap().len(), encrypted_len(&plain));
    }

    #[test]
    fn a_write_refused_for_the_total_size_is_tried_again_next_time() {
        let base = Config {
            replacements: vec![replacement('a', "row")],
            ..Config::default()
        };
        let local = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        let mut first = FakeTransport::reading([read(1, [])]).failing([Error::Limit("total")]);
        let result = run(&mut first, &local, Some(recorded(&base))).unwrap();
        assert!(result.state.too_large.is_empty());
        let mut second = FakeTransport::reading([read(1, [])]).after_seq(1);
        run(&mut second, &local, Some(result.state)).unwrap();
        assert_eq!(second.written("s_theme").len(), 1);
        // 書けなかった「消す」も、消えたことにせずにもう一度書く
        assert!(second.written(&row_key('r', 'a').id)[0].deleted);
    }

    fn page(reset: bool, more: bool, next: u64, items: &[(&ItemKey, u64)]) -> GetReply {
        GetReply {
            key_id: Some("key".into()),
            reset,
            more,
            next,
            items: items
                .iter()
                .map(|(key, seq)| GetItem {
                    collection: key.collection.clone(),
                    id: key.id.clone(),
                    seq: *seq,
                    deleted: false,
                    data: Some(encrypt(&[5; 32], "key", key, &Plain::value(json!(seq))).unwrap()),
                })
                .collect(),
        }
    }

    fn read_fake_pages(
        since: u64,
        pages: Vec<GetReply>,
    ) -> (Result<ReadResult, Error>, Vec<(u64, bool)>) {
        let mut pages = std::collections::VecDeque::from(pages);
        let mut calls = Vec::new();
        let result = tauri::async_runtime::block_on(read_pages(
            |since, rebuild| {
                calls.push((since, rebuild));
                std::future::ready(Ok(pages.pop_front().expect("an unexpected page")))
            },
            &[5; 32],
            "key",
            since,
        ));
        (result, calls)
    }

    #[test]
    fn every_page_reaches_the_rules_and_the_last_next_is_the_new_since() {
        let (theme, language) = (setting_item("theme"), setting_item("language"));
        let (result, calls) = read_fake_pages(
            3,
            vec![
                page(false, true, 4, &[(&theme, 4)]),
                page(false, false, 9, &[(&language, 6)]),
            ],
        );
        let result = result.unwrap();
        assert_eq!(calls, [(3, false), (4, false)]);
        assert!(!result.reset);
        assert_eq!(result.next, 9);
        let read: Vec<_> = result
            .items
            .iter()
            .map(|item| (item.key.id.as_str(), item.seq, item.plain.is_some()))
            .collect();
        assert_eq!(read, [("s_theme", 4, true), ("s_language", 6, true)]);
    }

    #[test]
    fn a_rebuild_keeps_asking_for_the_copy_on_later_pages() {
        let theme = setting_item("theme");
        // since=0 から始めたとき
        let (_, calls) = read_fake_pages(
            0,
            vec![
                page(false, true, 2, &[(&theme, 2)]),
                page(false, false, 5, &[]),
            ],
        );
        assert_eq!(calls, [(0, true), (2, true)]);
        // reset: true を受けたとき
        let (result, calls) = read_fake_pages(
            7,
            vec![
                page(true, true, 2, &[(&theme, 2)]),
                page(false, false, 5, &[]),
            ],
        );
        assert_eq!(calls, [(7, false), (2, true)]);
        let result = result.unwrap();
        assert!(result.reset);
        assert_eq!(result.items.len(), 1);
    }

    #[test]
    fn a_page_for_another_key_stops_the_read() {
        let mut other = page(false, false, 1, &[]);
        other.key_id = Some("other".into());
        let (result, _) = read_fake_pages(1, vec![other]);
        assert!(matches!(result, Err(Error::KeyMismatch)));
    }

    #[test]
    fn a_conflict_reply_is_read_like_fetched_items() {
        let key = [5; 32];
        let theme = setting_item("theme");
        let body = json!({
            "error": "conflict",
            "conflicts": [
                { "collection": "settings", "id": "s_theme", "seq": 4, "deleted": false,
                  "data": encrypt(&key, "key", &theme, &Plain::value(json!("dark"))).unwrap() },
                { "collection": "settings", "id": "s_language", "seq": null, "deleted": true, "data": null },
                { "collection": "history", "id": "h1", "seq": 2, "deleted": false, "data": "AAAA" },
            ],
        });
        let items = conflict_items(&key, "key", body).unwrap();
        assert_eq!(items.len(), 2, "items this app does not know are dropped");
        assert_eq!(items[0].seq, Some(4));
        assert_eq!(items[0].plain.as_ref().unwrap().value, Some(json!("dark")));
        assert_eq!(items[1].seq, None);
    }

    #[test]
    fn an_unsynced_local_row_is_left_alone_when_its_item_arrives() {
        let mut mine = replacement('a', "mine");
        mine.sync = false;
        let local = Config {
            replacements: vec![replacement('b', "first"), mine.clone()],
            ..Config::default()
        };
        let key = row_key('r', 'a');
        let theirs = row_value(&replacement('a', "theirs"));
        let arrivals = [
            remote(SETTINGS, &key.id, 6, theirs),
            deleted(&key, 6),
            detached_mark(&key, 6),
        ];
        let mut synced_only = local.clone();
        synced_only.replacements.pop();
        for (first_sync, state) in [(false, Some(recorded(&synced_only))), (true, None)] {
            for arrival in &arrivals {
                let result = reconcile(
                    &local,
                    state.clone(),
                    std::slice::from_ref(arrival),
                    "key",
                    6,
                );
                let case = format!("first sync: {first_sync}, deleted: {}", arrival.deleted);
                assert_eq!(result.config.replacements[1], mine, "{case}");
                assert!(
                    !result.writes.iter().any(|write| write.key == key),
                    "{case}"
                );

                // 印を付け直したら、届いた項目の seq の上に手元の値を書く
                let mut again = result.config.clone();
                again.replacements[1].sync = true;
                let next = reconcile(&again, Some(result.state), &[], "key", 6);
                let write = next.writes.iter().find(|write| write.key == key).unwrap();
                assert_eq!(write.base_seq, Some(6), "{case}");
                assert_eq!(write.plain, Some(row_value(&mine)), "{case}");
            }
        }
    }

    #[test]
    fn a_row_unsynced_before_its_mark_is_written_still_tells_the_other_devices() {
        let base = Config {
            replacements: vec![replacement('a', "mine")],
            ..Config::default()
        };
        let mut local = base.clone();
        local.replacements[0].sync = false;
        let key = row_key('r', 'a');
        let theirs = remote(SETTINGS, &key.id, 6, row_value(&replacement('a', "theirs")));
        for arrival in [theirs.clone(), deleted(&key, 6)] {
            let case = format!("deleted: {}", arrival.deleted);
            let result = reconcile(&local, Some(recorded(&base)), &[arrival], "key", 6);
            assert_eq!(result.config.replacements, local.replacements, "{case}");
            let write = result.writes.iter().find(|write| write.key == key).unwrap();
            assert!(write.detached && !write.deleted, "{case}");
            assert_eq!(write.base_seq, Some(6), "{case}");
        }
        // 相手も外していたら、書かずに既読にする
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[detached_mark(&key, 6)],
            "key",
            6,
        );
        assert!(!result.writes.iter().any(|write| write.key == key));

        // 印を書き終えた後に届いた値には、書かない
        let mut first = FakeTransport::reading([read(1, [])]).after_seq(1);
        let marked = run(&mut first, &local, Some(recorded(&base))).unwrap();
        assert!(first.written(&key.id)[0].detached);
        let later = RemoteItem {
            seq: first.seq + 1,
            ..theirs
        };
        let mut second =
            FakeTransport::reading([read(first.seq + 1, [later])]).after_seq(first.seq + 1);
        let result = run(&mut second, &local, Some(marked.state)).unwrap();
        assert!(second.written(&key.id).is_empty());
        assert_eq!(result.config.replacements, local.replacements);
    }

    #[test]
    fn an_order_naming_an_unsynced_row_keeps_it_after_its_predecessor() {
        let mut mine = replacement('b', "mine");
        mine.sync = false;
        let local = Config {
            replacements: vec![replacement('a', "a"), mine, replacement('c', "c")],
            ..Config::default()
        };
        let order = json!(["b".repeat(32), "c".repeat(32), "a".repeat(32)]);
        let result = reconcile(
            &local,
            Some(recorded(&local)),
            &[remote(SETTINGS, "o_replacements", 5, order)],
            "key",
            5,
        );
        let rows: Vec<_> = result
            .config
            .replacements
            .iter()
            .map(|row| (row.from.as_str(), row.sync))
            .collect();
        assert_eq!(rows, [("c", true), ("a", true), ("mine", false)]);
    }

    #[test]
    fn an_order_naming_an_unsynced_row_is_not_written_back() {
        let mut mine = snippet('b', "mine".into());
        mine.sync = false;
        let local = Config {
            snippets: Some(vec![
                snippet('a', "a".into()),
                mine,
                snippet('c', "c".into()),
            ]),
            ..Config::default()
        };
        // 相手は、手元で同期から外している行を同期している
        let order = json!(["c".repeat(32), "b".repeat(32), "a".repeat(32)]);
        let arrival = remote(SETTINGS, "o_snippets", 5, order);
        for (first_sync, state) in [(false, Some(recorded(&local))), (true, None)] {
            let result = reconcile(&local, state, std::slice::from_ref(&arrival), "key", 5);
            let ids: Vec<_> = result
                .config
                .snippets
                .iter()
                .flatten()
                .map(|row| &row.id[..1])
                .collect();
            assert_eq!(ids, ["c", "a", "b"], "first sync: {first_sync}");
            assert!(
                !result
                    .writes
                    .iter()
                    .any(|write| write.key.id == "o_snippets"),
                "first sync: {first_sync}"
            );
        }
    }

    #[test]
    fn an_order_naming_a_row_not_held_locally_is_not_written_back() {
        let local = Config {
            snippets: Some(vec![snippet('a', "a".into()), snippet('c', "c".into())]),
            ..Config::default()
        };
        // 相手の並びにある b は、手元では消したか、読み捨てた行
        let order = json!(["c".repeat(32), "b".repeat(32), "a".repeat(32)]);
        let arrival = remote(SETTINGS, "o_snippets", 5, order);
        for (first_sync, state) in [(false, Some(recorded(&local))), (true, None)] {
            let result = reconcile(&local, state, std::slice::from_ref(&arrival), "key", 5);
            let ids: Vec<_> = result
                .config
                .snippets
                .iter()
                .flatten()
                .map(|row| &row.id[..1])
                .collect();
            assert_eq!(ids, ["c", "a"], "first sync: {first_sync}");
            assert!(
                !result
                    .writes
                    .iter()
                    .any(|write| write.key.id == "o_snippets"),
                "first sync: {first_sync}"
            );
        }
    }

    #[test]
    fn a_batch_written_before_a_failure_stays_in_the_record() {
        let base = Config::default();
        let mut local = base.clone();
        local.snippets = Some(
            (0..WRITE_BATCH_SIZE)
                .map(|index| Snippet {
                    id: format!("{index:032x}"),
                    name: "name".into(),
                    body: "body".into(),
                    ..Snippet::default()
                })
                .collect(),
        );
        let before = recorded(&base);
        let mut first = FakeTransport::reading([read(1, [])]).after_seq(1);
        // 1回目のまとまりは書け、2回目のまとまりが落ちる
        first.fail_from_write = Some(1);
        let failure = run(&mut first, &local, Some(before.clone())).unwrap_err();
        assert_eq!(first.writes.len(), 2);
        assert_eq!(failure.written.items.len(), WRITE_BATCH_SIZE);

        let record = merge_written(Some(before), &failure.written, failure.reset, "key");
        let ours = first.stored[0].clone();
        let Some(Kind::Snippet(id)) = kind(&ours.key) else {
            panic!("the first batch holds snippets: {}", ours.key.id);
        };
        // 書けた行を、次の回までに手元で直す。自分の書き込みを読み戻しても、食い違いにならない
        let mut edited = local.clone();
        let rows = edited.snippets.as_mut().unwrap();
        let row = rows.iter_mut().find(|row| row.id == id).unwrap();
        row.body = "edited".into();
        let mut second =
            FakeTransport::reading([read(first.seq, first.stored.clone())]).after_seq(first.seq);
        let result = run(&mut second, &edited, Some(record)).unwrap();
        assert_eq!(second.written(&ours.key.id)[0].base_seq, Some(ours.seq));
        assert_eq!(result.config, edited);
    }
    fn history(entries: &[(&str, u64)], cleared_at: u64) -> History {
        History {
            entries: entries
                .iter()
                .map(|(text, at)| history_store::Entry {
                    text: text.to_string(),
                    at: *at,
                })
                .collect(),
            cleared_at,
        }
    }

    fn numbered(range: std::ops::Range<u64>) -> History {
        History {
            entries: range
                .map(|at| history_store::Entry {
                    text: format!("draft {at}"),
                    at,
                })
                .collect(),
            cleared_at: 0,
        }
    }

    fn remote_history(seq: u64, value: &History) -> RemoteItem {
        remote(HISTORY, HISTORY_ID, seq, json(value))
    }

    fn run_history(
        transport: &mut FakeTransport,
        state: Option<State>,
        local: &History,
        size: usize,
    ) -> SyncResult {
        let config = Config {
            text_history_size: size as u16,
            ..Config::default()
        };
        let state = state.or_else(|| Some(recorded(&config)));
        tauri::async_runtime::block_on(sync_once_with(
            transport,
            &config,
            state,
            &BTreeMap::new(),
            "key",
            Some(local),
        ))
        .unwrap()
    }

    /// 履歴の項目だけを持つ窓口と、そこへ順に同期するデバイス。
    #[derive(Default)]
    struct HistoryServer {
        seq: u64,
        item: Option<RemoteItem>,
    }

    struct HistoryDevice {
        state: Option<State>,
        local: History,
        size: usize,
    }

    impl HistoryDevice {
        fn new(local: History, size: usize) -> Self {
            Self {
                state: None,
                local,
                size,
            }
        }

        /// 1回同期し、混ぜた履歴を手元に入れる。窓口へ書いたかを返す
        fn sync(&mut self, server: &mut HistoryServer) -> bool {
            // 記録の無いデバイスは、`recorded` の読む位置（1）から読む
            let since = self.state.as_ref().map_or(1, |state| state.since);
            let arriving = server.item.iter().filter(|item| item.seq > since).cloned();
            let mut transport =
                FakeTransport::reading([read(server.seq, arriving)]).after_seq(server.seq);
            transport.stored.extend(server.item.clone());
            let result = run_history(&mut transport, self.state.take(), &self.local, self.size);
            server.seq = transport.seq;
            server.item = transport.stored.last().cloned();
            if let Some(next) = result.history {
                self.local = next;
            }
            self.state = Some(result.state);
            !transport.written(HISTORY_ID).is_empty()
        }
    }

    /// 前の版のファイルから読んだ履歴。`name` で本文を分け、時刻は `newest` からさかのぼる
    fn text_only_history(name: &str, count: usize, newest: u64) -> History {
        let entries: Vec<String> = (0..count).map(|index| format!("{name}{index}")).collect();
        let file = json!({ "version": 1, "entries": entries }).to_string();
        history_store::parse(&file, newest).unwrap().0
    }

    /// 全部のデバイスを順に同期するのを繰り返し、どのデバイスも書かなくなるまでの回数を返す
    fn settle(server: &mut HistoryServer, devices: &mut [HistoryDevice]) -> usize {
        for round in 1..=5 {
            let mut wrote = false;
            for device in devices.iter_mut() {
                wrote |= device.sync(server);
            }
            if !wrote {
                return round;
            }
        }
        panic!("the devices keep writing the history back to each other");
    }

    fn server_history(server: &HistoryServer) -> History {
        let plain = server.item.as_ref().and_then(|item| item.plain.as_ref());
        parse(plain.and_then(|plain| plain.value.as_ref()).unwrap()).unwrap()
    }

    #[test]
    fn three_devices_with_text_only_histories_settle() {
        let mut server = HistoryServer { seq: 1, item: None };
        // 2台はファイルの更新時刻が同じで、時刻が重なる
        let mut devices = [
            HistoryDevice::new(text_only_history("a", 50, 5000), 50),
            HistoryDevice::new(text_only_history("b", 50, 5000), 50),
            HistoryDevice::new(text_only_history("c", 50, 5020), 50),
        ];
        let rounds = settle(&mut server, &mut devices);
        assert!(rounds <= 3, "settled after {rounds} rounds");
        let synced = server_history(&server);
        assert_eq!(synced.entries.len(), 100);
        for device in &devices {
            assert_eq!(device.local, synced.clone().truncated(50));
        }
        // 落ち着いた後は、何度同期しても書かない
        assert_eq!(settle(&mut server, &mut devices), 1);
    }

    #[test]
    fn two_devices_holding_more_than_the_limit_together_settle() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut devices = [
            HistoryDevice::new(text_only_history("a", 60, 5000), 100),
            HistoryDevice::new(text_only_history("b", 60, 5000), 100),
        ];
        let rounds = settle(&mut server, &mut devices);
        assert!(rounds <= 3, "settled after {rounds} rounds");
        let synced = server_history(&server);
        assert_eq!(synced.entries.len(), 100);
        assert_eq!(devices[0].local, synced);
        assert_eq!(devices[1].local, synced);
    }

    #[test]
    fn a_device_syncing_history_for_the_first_time_does_not_spread_its_old_clear() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut synced = HistoryDevice::new(history(&[("a", 10), ("b", 30)], 0), 50);
        synced.sync(&mut server);
        // 同期に入る前に消したことがあるデバイス
        let mut joining = HistoryDevice::new(history(&[("c", 40)], 20), 50);
        joining.sync(&mut server);
        let mixed = history(&[("a", 10), ("b", 30), ("c", 40)], 0);
        assert_eq!(server_history(&server), mixed);
        assert_eq!(joining.local, mixed);
        synced.sync(&mut server);
        assert_eq!(synced.local, mixed);
    }

    #[test]
    fn a_device_syncing_history_for_the_first_time_takes_the_clear_of_the_server() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut synced = HistoryDevice::new(history(&[("x", 15)], 0), 50);
        synced.sync(&mut server);
        // 同期しているデバイスで消してから、1件覚えた
        synced.local = history(&[("b", 30)], 20);
        synced.sync(&mut server);
        let mut joining = HistoryDevice::new(history(&[("a", 10), ("c", 40)], 5), 50);
        joining.sync(&mut server);
        assert_eq!(joining.local, history(&[("b", 30), ("c", 40)], 20));
    }

    #[test]
    fn clearing_on_a_device_that_already_syncs_clears_the_other_devices() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut devices = [
            HistoryDevice::new(history(&[("a", 10)], 0), 50),
            HistoryDevice::new(history(&[("b", 20)], 0), 50),
        ];
        settle(&mut server, &mut devices);
        devices[0].local = history(&[("c", 40)], 30);
        settle(&mut server, &mut devices);
        assert_eq!(server_history(&server), history(&[("c", 40)], 30));
        assert_eq!(devices[1].local, history(&[("c", 40)], 30));
    }

    #[test]
    fn setting_the_size_to_zero_clears_the_server_and_keeps_nothing_locally() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut devices = [
            HistoryDevice::new(history(&[("a", 10)], 0), 50),
            HistoryDevice::new(history(&[("b", 20)], 0), 50),
        ];
        settle(&mut server, &mut devices);
        // 件数を 0 にして、消した時刻を置いた
        devices[0].size = 0;
        devices[0].local = history(&[], 30);
        assert!(devices[0].sync(&mut server));
        assert_eq!(server_history(&server), history(&[], 30));
        // 件数が 0 のデバイスも、ほかのデバイスが後で覚えた履歴を窓口から消さず、手元には入れない
        devices[1].sync(&mut server);
        devices[1].local = history(&[("c", 40)], 30);
        devices[1].sync(&mut server);
        assert!(!devices[0].sync(&mut server));
        assert_eq!(devices[0].local, history(&[], 30));
        assert_eq!(server_history(&server), history(&[("c", 40)], 30));
    }

    #[test]
    fn raising_the_size_brings_in_the_older_entries_on_the_server() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut devices = [
            HistoryDevice::new(numbered(1..31), 50),
            HistoryDevice::new(History::default(), 10),
        ];
        settle(&mut server, &mut devices);
        assert_eq!(devices[1].local, numbered(21..31));
        devices[1].size = 25;
        assert!(!devices[1].sync(&mut server), "nothing new to write");
        assert_eq!(devices[1].local, numbered(6..31));
    }

    #[test]
    fn the_history_is_cut_to_a_size_arriving_in_the_same_sync() {
        let local = numbered(1..6);
        let mut transport = FakeTransport::reading([read(
            4,
            [remote(SETTINGS, "s_text_history_size", 4, json!(2))],
        )])
        .after_seq(4);
        let result = run_history(&mut transport, None, &local, 50);
        assert_eq!(result.config.text_history_size, 2);
        assert_eq!(result.history, Some(numbered(4..6)));
        // 窓口に書く値は切り詰めない
        assert_eq!(written_history(&transport), [(None, local)]);
    }

    #[test]
    fn an_arrived_history_that_could_not_be_mixed_is_read_again_next_time() {
        let mut server = HistoryServer { seq: 1, item: None };
        let mut device = HistoryDevice::new(history(&[("a", 10), ("c", 30)], 0), 50);
        device.sync(&mut server);
        let theirs = history(&[("b", 20)], 0);
        let mut transport = FakeTransport::reading([read(5, [remote_history(5, &theirs)])])
            .failing([Error::Other("offline".into())])
            .after_seq(5);
        let failed = run_history(&mut transport, device.state.take(), &device.local, 50);
        assert_eq!(failed.history, None);
        assert_eq!(failed.state.since, 5);

        // 読む位置は進んでいて、届いた値は次の回には届かない
        let mut transport = FakeTransport::reading([read(5, [])]).after_seq(5);
        transport.stored.push(remote_history(5, &theirs));
        let result = run_history(&mut transport, Some(failed.state), &device.local, 50);
        assert_eq!(transport.item_reads, [5]);
        let mixed = history(&[("a", 10), ("b", 20), ("c", 30)], 0);
        assert_eq!(written_history(&transport), [(Some(5), mixed.clone())]);
        assert_eq!(result.history, Some(mixed));
    }

    fn written_history(transport: &FakeTransport) -> Vec<(Option<u64>, History)> {
        transport
            .written(HISTORY_ID)
            .into_iter()
            .map(|write| {
                assert_eq!(write.key.collection, HISTORY);
                (
                    write.base_seq,
                    parse(
                        write
                            .plain
                            .as_ref()
                            .expect("the history is written as a value"),
                    )
                    .expect("the written history has the wire shape"),
                )
            })
            .collect()
    }

    #[test]
    fn the_history_item_is_read_and_written_on_the_wire() {
        let key = history_item();
        assert!(valid_wire_id(&key.id));
        let write = Write {
            key: key.clone(),
            base_seq: None,
            deleted: false,
            plain: Some(json(history(&[("draft", 5)], 3))),
            detached: false,
            at: 0,
        };
        let items = put_items(&[5; 32], "key", &[write]).unwrap();
        assert_eq!(items[0]["collection"], "history");
        assert_eq!(items[0]["id"], "h");
        let plain = decrypt(&[5; 32], "key", &key, items[0]["data"].as_str().unwrap()).unwrap();
        assert_eq!(
            plain.value,
            Some(json!({ "entries": [{ "text": "draft", "at": 5 }], "cleared_at": 3 }))
        );
        let result = read_fake_pages(0, vec![page(false, false, 4, &[(&key, 4)])])
            .0
            .unwrap();
        assert_eq!(result.items.len(), 1);
    }

    #[test]
    fn a_first_history_sync_writes_the_local_history() {
        let local = history(&[("a", 10), ("b", 20)], 0);
        let mut transport = FakeTransport::reading([read(1, [])]).after_seq(1);
        let result = run_history(&mut transport, None, &local, 50);
        assert_eq!(written_history(&transport), [(None, local.clone())]);
        assert_eq!(result.history, Some(local));
        let name = history_item().name();
        assert_eq!(result.state.items[&name].seq, 2);
        assert_eq!(result.written.items[&name], result.state.items[&name]);
    }

    #[test]
    fn an_unchanged_history_is_neither_read_again_nor_written() {
        let local = history(&[("a", 10)], 0);
        let mut transport = FakeTransport::reading([read(1, []), read(2, [])]).after_seq(1);
        let first = run_history(&mut transport, None, &local, 50);
        let second = run_history(&mut transport, Some(first.state), &local, 50);
        assert_eq!(second.history, None);
        assert_eq!(transport.written(HISTORY_ID).len(), 1);
        assert!(transport.item_reads.is_empty());
    }

    #[test]
    fn an_arriving_history_is_mixed_into_the_local_one_and_written_back() {
        let local = history(&[("a", 10), ("c", 30)], 0);
        let theirs = history(&[("b", 20)], 0);
        let mut transport =
            FakeTransport::reading([read(4, [remote_history(4, &theirs)])]).after_seq(4);
        let result = run_history(&mut transport, None, &local, 50);
        let mixed = history(&[("a", 10), ("b", 20), ("c", 30)], 0);
        assert_eq!(written_history(&transport), [(Some(4), mixed.clone())]);
        assert_eq!(result.history, Some(mixed));
    }

    #[test]
    fn an_arriving_history_that_holds_everything_is_not_written_back() {
        let local = history(&[("a", 10)], 0);
        let theirs = history(&[("a", 10), ("b", 20), ("c", 30)], 0);
        let mut transport = FakeTransport::reading([read(4, [remote_history(4, &theirs)])]);
        // このデバイスの件数に切り詰めるのは、手元に入れる分だけ
        let result = run_history(&mut transport, None, &local, 2);
        assert!(transport.writes.is_empty());
        assert_eq!(result.history, Some(history(&[("b", 20), ("c", 30)], 0)));
        assert_eq!(result.state.items[&history_item().name()].seq, 4);
    }

    #[test]
    fn a_clear_on_another_device_drops_the_older_local_entries() {
        let local = history(&[("a", 10), ("c", 30)], 0);
        let theirs = history(&[], 20);
        let mut transport =
            FakeTransport::reading([read(4, [remote_history(4, &theirs)])]).after_seq(4);
        let result = run_history(&mut transport, None, &local, 50);
        let mixed = history(&[("c", 30)], 20);
        assert_eq!(written_history(&transport), [(Some(4), mixed.clone())]);
        assert_eq!(result.history, Some(mixed));
    }

    #[test]
    fn a_device_keeping_fewer_entries_does_not_trim_the_server_history() {
        let theirs = numbered(1..101);
        let mut transport = FakeTransport::reading([read(4, [remote_history(4, &theirs)])]);
        transport.stored.push(remote_history(4, &theirs));
        let first = run_history(&mut transport, None, &History::default(), 3);
        let held = first.history.expect("the arrived history is applied");
        assert_eq!(held, numbered(98..101));

        // 手元で1件覚えた。窓口の値は届かないので、読み直して混ぜる
        let mut local = held.clone();
        local.entries.remove(0);
        local.entries.push(history_store::Entry {
            text: "new".into(),
            at: 500,
        });
        transport.reads.push_back(read(4, []));
        transport.seq = 4;
        let second = run_history(&mut transport, Some(first.state), &local, 3);
        assert_eq!(transport.item_reads, [4]);
        let written = written_history(&transport);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0].0, Some(4));
        // 100 件のうち、いちばん古い1件だけが新しい1件に押し出される
        assert_eq!(written[0].1.entries.len(), 100);
        assert_eq!(written[0].1.entries[0].at, 2);
        assert_eq!(written[0].1.entries[99].text, "new");
        assert_eq!(second.history, Some(local));
    }

    #[test]
    fn a_history_changed_on_the_server_since_the_record_is_taken_from_the_conflict() {
        let local = history(&[("a", 10)], 0);
        let mut transport = FakeTransport::reading([read(1, []), read(2, [])]).after_seq(1);
        let first = run_history(&mut transport, None, &local, 50);
        // 読み直しても、記録の `seq` の項目はもう無い
        transport.stored.clear();
        let theirs = history(&[("a", 10), ("b", 20)], 0);
        transport
            .write_errors
            .push_back(Error::Conflict(vec![ConflictItem {
                key: history_item(),
                seq: Some(7),
                deleted: false,
                plain: Some(Plain::value(json(&theirs))),
            }]));
        transport.seq = 7;
        let changed = history(&[("a", 10), ("c", 30)], 0);
        let second = run_history(&mut transport, Some(first.state), &changed, 50);
        let mixed = history(&[("a", 10), ("b", 20), ("c", 30)], 0);
        let written = written_history(&transport);
        assert_eq!(written[1], (None, changed));
        assert_eq!(written[2], (Some(7), mixed.clone()));
        assert_eq!(second.history, Some(mixed));
        assert_eq!(second.state.items[&history_item().name()].seq, 8);
    }

    #[test]
    fn history_conflicts_are_retried_and_then_left_for_the_next_sync() {
        let local = history(&[("a", 10)], 0);
        let conflict = |seq: u64| {
            Error::Conflict(vec![ConflictItem {
                key: history_item(),
                seq: Some(seq),
                deleted: false,
                plain: Some(Plain::value(json(history(&[("b", seq)], 0)))),
            }])
        };
        let mut transport = FakeTransport::reading([read(1, [])])
            .failing((2..=5).map(conflict).collect::<Vec<_>>());
        let result = run_history(&mut transport, None, &local, 50);
        assert_eq!(
            transport.written(HISTORY_ID).len(),
            MAX_CONFLICT_RETRIES + 1
        );
        assert_eq!(result.history, None);
        let name = history_item().name();
        assert!(!result.state.items.contains_key(&name));
    }

    #[test]
    fn an_unreadable_local_history_is_not_synced() {
        let config = Config::default();
        let theirs = history(&[("a", 10)], 0);
        let mut transport = FakeTransport::reading([read(4, [remote_history(4, &theirs)])]);
        let result = run(&mut transport, &config, Some(recorded(&config))).unwrap();
        assert_eq!(result.history, None);
        assert!(transport.writes.is_empty());
    }

    #[test]
    fn an_unreadable_history_is_ignored_until_the_server_value_changes() {
        let local = history(&[("a", 10)], 0);
        let unreadable = [
            remote(HISTORY, HISTORY_ID, 4, json!({ "entries": "future" })),
            // 今の版が書かない値: 時刻の無い履歴と、上限を超える件数
            remote_history(4, &history(&[("z", 0)], 0)),
            remote_history(
                4,
                &numbered(1..history_store::MAX_SYNCED_ENTRIES as u64 + 2),
            ),
            RemoteItem {
                key: history_item(),
                seq: 4,
                deleted: false,
                plain: None,
            },
        ];
        for item in unreadable {
            let mut transport = FakeTransport::reading([read(4, [item]), read(4, [])]);
            let first = run_history(&mut transport, None, &local, 50);
            let name = history_item().name();
            assert_eq!(first.history, None);
            assert_eq!(first.state.ignored.get(&name), Some(&4));
            let changed = history(&[("a", 10), ("b", 20)], 0);
            let second = run_history(&mut transport, Some(first.state), &changed, 50);
            assert_eq!(second.history, None);
            assert!(transport.writes.is_empty());

            let theirs = history(&[("c", 30)], 0);
            transport
                .reads
                .push_back(read(6, [remote_history(6, &theirs)]));
            transport.seq = 6;
            let third = run_history(&mut transport, Some(second.state), &changed, 50);
            assert_eq!(
                third.history,
                Some(history(&[("a", 10), ("b", 20), ("c", 30)], 0))
            );
            assert!(third.state.ignored.is_empty());
        }
    }

    fn sized(at: u64, kib: usize) -> history_store::Entry {
        history_store::Entry {
            text: format!("{at}{}", "x".repeat(kib * 1024)),
            at,
        }
    }

    #[test]
    fn a_history_over_the_size_limit_is_written_without_its_oldest_entries() {
        let local = History {
            entries: (1..=3).map(|at| sized(at, 100)).collect(),
            cleared_at: 0,
        };
        let fitted = fit_history(local.clone());
        assert_eq!(fitted.entries, local.entries[1..]);
        assert!(encrypted_len(&Plain::value(json(&fitted))) <= MAX_ENCRYPTED_ITEM_BYTES);
        assert_eq!(fit_history(fitted.clone()), fitted);

        let mut transport = FakeTransport::reading([read(1, [])]).after_seq(1);
        let result = run_history(&mut transport, None, &local, 50);
        assert_eq!(written_history(&transport), [(None, fitted)]);
        // 手元の履歴は削らない
        assert_eq!(result.history, Some(local));
    }

    #[test]
    fn a_text_too_large_on_its_own_is_left_out_without_emptying_the_history() {
        // いちばん新しい1件だけで上限を超える
        let local = History {
            entries: vec![sized(1, 1), sized(2, 1), sized(3, 300)],
            cleared_at: 7,
        };
        let fitted = fit_history(local.clone());
        assert_eq!(fitted.entries, local.entries[..2]);
        assert_eq!(fitted.cleared_at, 7);
        // 途中にあっても、その1件だけを外し、残りは古い方から落とす
        let mixed = History {
            entries: vec![sized(1, 100), sized(2, 100), sized(3, 300), sized(4, 100)],
            cleared_at: 0,
        };
        let fitted = fit_history(mixed.clone());
        assert_eq!(
            fitted.entries,
            [mixed.entries[1].clone(), mixed.entries[3].clone()]
        );
        assert!(encrypted_len(&Plain::value(json(&fitted))) <= MAX_ENCRYPTED_ITEM_BYTES);

        // 窓口に置けない本文が手元にあっても、同期のたびに書き直さない
        let mut server = HistoryServer { seq: 1, item: None };
        let mut device = HistoryDevice::new(local.clone(), 50);
        // このデバイスは、消した時刻を使わない初めての同期
        device.local.cleared_at = 0;
        assert!(device.sync(&mut server));
        assert_eq!(server_history(&server).entries, local.entries[..2]);
        assert_eq!(device.local.entries, local.entries);
        assert!(!device.sync(&mut server));
    }

    #[test]
    fn the_size_limit_is_measured_to_the_byte() {
        let exact = |text_len: usize| History {
            entries: vec![
                sized(1, 1),
                history_store::Entry {
                    text: "x".repeat(text_len),
                    at: 2,
                },
            ],
            cleared_at: 0,
        };
        // 2件でちょうど上限になる長さを探し、1バイト超えたら古い方を落とす
        let base = encrypted_len(&Plain::value(json(exact(0))));
        let room = MAX_ENCRYPTED_ITEM_BYTES - base;
        assert_eq!(fit_history(exact(room)).entries.len(), 2);
        let over = fit_history(exact(room + 1));
        assert_eq!(over.entries.len(), 1);
        assert_eq!(over.entries[0].at, 2);
    }

    #[test]
    fn a_failed_history_write_keeps_the_settings_result() {
        let local = history(&[("a", 10)], 0);
        let mut transport =
            FakeTransport::reading([read(1, [])]).failing([Error::Other("offline".into())]);
        let result = run_history(&mut transport, None, &local, 50);
        assert_eq!(result.history, None);
        assert!(!result.state.items.contains_key(&history_item().name()));
        assert_eq!(result.state.since, 1);
    }

    #[test]
    fn rereading_one_item_only_accepts_the_item_at_the_recorded_seq() {
        let key = history_item();
        let other = setting_item("theme");
        let read_at = |items: &[(&ItemKey, u64)]| {
            item_at(page(false, false, 9, items), &[5; 32], "key", &key, 4)
        };
        assert_eq!(read_at(&[(&key, 4)]).map(|item| item.seq), Some(4));
        assert!(read_at(&[(&key, 6)]).is_none(), "the item was rewritten");
        assert!(read_at(&[(&other, 4)]).is_none());
        assert!(read_at(&[]).is_none());
    }

    fn id_of(id: char) -> String {
        id.to_string().repeat(32)
    }

    fn order_of(ids: &str) -> Value {
        json(ids.chars().map(id_of).collect::<Vec<_>>())
    }

    fn with_replacements(ids: &str) -> Config {
        Config {
            replacements: ids
                .chars()
                .map(|id| replacement(id, &id.to_string()))
                .collect(),
            ..Config::default()
        }
    }

    fn replacement_ids(config: &Config) -> String {
        config.replacements.iter().map(|row| &row.id[..1]).collect()
    }

    fn order_writes(result: &Reconcile) -> Vec<(Option<u64>, Value)> {
        result
            .writes
            .iter()
            .filter(|write| write.key.id == "o_replacements")
            .map(|write| (write.base_seq, write.plain.clone().unwrap()))
            .collect()
    }

    #[test]
    fn two_devices_each_adding_a_row_merge_the_order_without_a_conflict() {
        let base = with_replacements("ab");
        let local = with_replacements("abc");
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[
                remote(
                    SETTINGS,
                    &row_key('r', 'd').id,
                    2,
                    row_value(&replacement('d', "d")),
                ),
                remote(SETTINGS, "o_replacements", 3, order_of("abd")),
            ],
            "key",
            3,
        );
        assert_eq!(replacement_ids(&result.config), "abdc");
        assert_eq!(order_writes(&result), [(Some(3), order_of("abdc"))]);
    }

    #[test]
    fn a_reorder_here_and_a_row_added_there_take_the_arrived_order() {
        let base = with_replacements("ab");
        let local = with_replacements("ba");
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[
                remote(
                    SETTINGS,
                    &row_key('r', 'c').id,
                    2,
                    row_value(&replacement('c', "c")),
                ),
                remote(SETTINGS, "o_replacements", 3, order_of("abc")),
            ],
            "key",
            3,
        );
        assert_eq!(replacement_ids(&result.config), "abc");
        assert!(order_writes(&result).is_empty());
    }

    #[test]
    fn a_row_added_here_and_a_reorder_there_keep_the_added_row_after_the_arrived_order() {
        let base = with_replacements("ab");
        let local = with_replacements("abc");
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[remote(SETTINGS, "o_replacements", 2, order_of("ba"))],
            "key",
            2,
        );
        assert_eq!(replacement_ids(&result.config), "bac");
        assert_eq!(order_writes(&result), [(Some(2), order_of("bac"))]);
    }

    #[test]
    fn both_devices_reordering_take_the_arrived_order() {
        let base = with_replacements("abc");
        let local = with_replacements("cab");
        let result = reconcile(
            &local,
            Some(recorded(&base)),
            &[remote(SETTINGS, "o_replacements", 2, order_of("bac"))],
            "key",
            2,
        );
        assert_eq!(replacement_ids(&result.config), "bac");
        assert!(order_writes(&result).is_empty());
    }

    fn run_sync(
        transport: &mut FakeTransport,
        config: &Config,
        state: Option<State>,
        history: Option<&History>,
    ) -> SyncResult {
        let outbox = pending_since(config, state.as_ref());
        tauri::async_runtime::block_on(sync_once_with(
            transport, config, state, &outbox, "key", history,
        ))
        .unwrap()
    }

    #[test]
    fn settings_turned_off_are_neither_read_nor_written_and_resume_where_they_stopped() {
        let base = Config::default();
        let local = Config {
            theme: Theme::Dark,
            sync_settings: false,
            ..base.clone()
        };
        let arriving = || remote(SETTINGS, "s_language", 5, json!("en"));
        let drafts = history(&[("a", 10)], 0);
        let mut transport = FakeTransport::reading([read(5, [arriving()])]).after_seq(5);
        let off = run_sync(&mut transport, &local, Some(recorded(&base)), Some(&drafts));
        assert_eq!(off.config, local);
        assert!(!off.changed);
        assert!(transport.written("s_theme").is_empty());
        assert_eq!(transport.written(HISTORY_ID).len(), 1);
        assert_eq!(off.state.since, 5);
        assert_eq!(off.state.paused.get("settings"), Some(&1));

        let mut transport = FakeTransport::reading([read(6, [arriving()])]).after_seq(6);
        let resumed = Config {
            theme: Theme::Dark,
            ..base
        };
        let on = run_sync(&mut transport, &resumed, Some(off.state), Some(&drafts));
        assert_eq!(transport.read_since, [1]);
        assert_eq!(on.config.language, Language::En);
        assert_eq!(transport.written("s_theme").len(), 1);
        assert_eq!(on.state.paused.get("settings"), None);
        assert_eq!(on.state.since, 6);
    }

    #[test]
    fn history_turned_off_is_neither_read_nor_written_and_resumes_where_it_stopped() {
        let config = Config::default();
        let off_config = Config {
            sync_history: false,
            ..config.clone()
        };
        let drafts = history(&[("a", 10)], 0);
        let theirs = history(&[("b", 20)], 0);
        let mut transport =
            FakeTransport::reading([read(5, [remote_history(5, &theirs)])]).after_seq(5);
        let off = run_sync(
            &mut transport,
            &off_config,
            Some(recorded(&config)),
            Some(&drafts),
        );
        assert_eq!(off.history, None);
        assert!(transport.written(HISTORY_ID).is_empty());
        assert!(!off.state.items.contains_key(&history_item().name()));
        assert_eq!(off.state.paused.get("history"), Some(&1));

        let mut transport =
            FakeTransport::reading([read(5, [remote_history(5, &theirs)])]).after_seq(5);
        let on = run_sync(&mut transport, &config, Some(off.state), Some(&drafts));
        assert_eq!(transport.read_since, [1]);
        assert_eq!(on.history, Some(history(&[("a", 10), ("b", 20)], 0)));
        assert_eq!(on.state.paused.get("history"), None);
    }

    #[test]
    fn settings_turned_on_for_the_first_time_follow_the_first_sync_rules() {
        let local = Config {
            theme: Theme::Dark,
            sync_settings: false,
            ..Config::default()
        };
        let mut transport = FakeTransport::reading([read(9, [])]).after_seq(9);
        let off = run_sync(&mut transport, &local, None, None);
        assert_eq!(off.state.paused.get("settings"), Some(&0));
        assert_eq!(off.state.since, 9);

        let mut transport =
            FakeTransport::reading([read(9, [remote(SETTINGS, "s_theme", 4, json!("light"))])])
                .after_seq(9);
        let on = run_sync(&mut transport, &Config::default(), Some(off.state), None);
        assert_eq!(transport.read_since, [0]);
        assert_eq!(on.config.theme, Theme::Light);
    }

    #[test]
    fn disabled_kinds_and_excluded_settings_neither_read_nor_write_their_items() {
        let mut config = Config {
            theme: Theme::Dark,
            ..Config::default()
        };
        config.sync_excluded_settings = vec!["theme".to_string()];
        config.sync_replacements = false;
        config.sync_snippets = false;
        config.sync_keys = false;
        let replacement = replacement('a', "remote");
        let items = [
            remote(SETTINGS, "s_theme", 2, json!("light")),
            remote(SETTINGS, &row_key('r', 'a').id, 3, row_value(&replacement)),
            remote(SETTINGS, &hotkey_item().id, 4, json!("Alt+KeyT")),
        ];
        let result = reconcile(
            &config,
            Some(recorded(&Config::default())),
            &items,
            "key",
            4,
        );
        assert_eq!(result.config.theme, Theme::Dark);
        assert!(result.config.replacements.is_empty());
        assert_eq!(result.config.hotkey, config.hotkey);
        assert!(result
            .writes
            .iter()
            .all(|write| !items.iter().any(|item| item.key == write.key)));
    }

    #[test]
    fn disabled_row_kinds_leave_missing_recorded_rows_on_the_server() {
        let cases = [
            (
                SyncKind::Replacements,
                row_key('r', 'b'),
                row_value(&replacement('b', "remote")),
            ),
            (
                SyncKind::Snippets,
                row_key('n', 'c'),
                row_value(&snippet('c', "remote".to_string())),
            ),
        ];
        for (kind, key, value) in cases {
            let mut off = Config::default();
            match kind {
                SyncKind::Replacements => off.sync_replacements = false,
                SyncKind::Snippets => off.sync_snippets = false,
                _ => unreachable!(),
            }
            let mut old = State::new("key");
            old.items.insert(
                key.name(),
                Seen {
                    seq: 1,
                    hash: hash_plain(&value),
                },
            );
            let stopped = reconcile(&off, Some(old.clone()), &[], "key", 2);
            assert!(
                stopped.writes.iter().all(|write| write.key != key),
                "{kind:?}"
            );
            if kind == SyncKind::Snippets {
                assert!(
                    stopped
                        .writes
                        .iter()
                        .all(|write| !write.key.id.starts_with("n_")),
                    "default snippet marks stay unwritten while snippets are off"
                );
            }

            let active = reconcile(&Config::default(), Some(old), &[], "key", 2);
            assert!(
                active
                    .writes
                    .iter()
                    .any(|write| write.key == key && (write.deleted || write.detached)),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn disabled_keys_are_not_applied_and_apply_again_when_enabled() {
        let remote = remote(SETTINGS, &hotkey_item().id, 2, json!("Alt+KeyT"));
        let stopped = Config {
            sync_keys: false,
            ..Config::default()
        };
        let off = reconcile(
            &stopped,
            Some(recorded(&Config::default())),
            std::slice::from_ref(&remote),
            "key",
            2,
        );
        assert_eq!(off.config.hotkey, stopped.hotkey);
        assert!(off.writes.iter().all(|write| write.key != remote.key));

        let on = reconcile(
            &Config::default(),
            Some(recorded(&Config::default())),
            &[remote],
            "key",
            2,
        );
        assert_eq!(on.config.hotkey, "Alt+KeyT");
    }

    #[test]
    fn an_excluded_setting_resumes_from_its_own_position() {
        let base = Config::default();
        let mut stopped = base.clone();
        stopped.sync_excluded_settings = vec!["theme".to_string()];
        let mut transport = FakeTransport::reading([read(5, [])]).after_seq(5);
        let off = run_sync(&mut transport, &stopped, Some(recorded(&base)), None);
        let theme_name = ItemKey::new(SETTINGS, setting_id("theme")).name();
        assert_eq!(off.state.paused.get(&theme_name), Some(&1));

        let theirs = remote(SETTINGS, "s_theme", 5, json!("dark"));
        let resumed = base.clone();
        let mut transport = FakeTransport::reading([read(6, [theirs])]).after_seq(6);
        let on = run_sync(&mut transport, &resumed, Some(off.state), None);
        assert_eq!(transport.read_since, [1]);
        assert_eq!(on.config.theme, Theme::Dark);
        assert_eq!(on.state.paused.get(&theme_name), None);
    }

    #[test]
    fn an_excluded_setting_keeps_its_position_while_settings_are_off() {
        let base = Config::default();
        let mut stopped = base.clone();
        stopped.sync_settings = false;
        stopped.sync_excluded_settings = vec!["theme".to_string()];
        let mut transport = FakeTransport::reading([read(5, [])]).after_seq(5);
        let off = run_sync(&mut transport, &stopped, Some(recorded(&base)), None);
        let theme = setting_item("theme").name();
        assert_eq!(off.state.paused.get("settings"), Some(&1));
        assert_eq!(off.state.paused.get(&theme), Some(&1));

        let mut settings_on = stopped.clone();
        settings_on.sync_settings = true;
        let arriving = remote(SETTINGS, "s_theme", 5, json!("dark"));
        let mut transport = FakeTransport::reading([read(6, [arriving.clone()])]).after_seq(6);
        let still_excluded = run_sync(&mut transport, &settings_on, Some(off.state), None);
        assert_eq!(still_excluded.state.paused.get("settings"), None);
        assert_eq!(still_excluded.state.paused.get(&theme), Some(&1));

        let mut transport = FakeTransport::reading([read(7, [arriving])]).after_seq(7);
        let resumed = run_sync(&mut transport, &base, Some(still_excluded.state), None);
        assert_eq!(transport.read_since, [1]);
        assert_eq!(resumed.config.theme, Theme::Dark);
        assert_eq!(resumed.state.paused.get(&theme), None);
    }

    #[test]
    fn a_setting_returned_while_settings_are_off_keeps_its_position_until_it_is_read() {
        let base = Config::default();
        let mut excluded = base.clone();
        excluded.sync_excluded_settings = vec!["theme".to_string()];
        let mut transport = FakeTransport::reading([read(5, [])]).after_seq(5);
        let off = run_sync(&mut transport, &excluded, Some(recorded(&base)), None);
        let theme = setting_item("theme").name();
        assert_eq!(off.state.paused.get(&theme), Some(&1));

        // 設定をオフにしてから除外をやめる。この回は設定を読まないので、項目の位置は残る
        let mut settings_off = base.clone();
        settings_off.sync_settings = false;
        let arriving = remote(SETTINGS, "s_theme", 5, json!("dark"));
        let mut transport = FakeTransport::reading([read(8, [])]).after_seq(8);
        let returned = run_sync(&mut transport, &settings_off, Some(off.state), None);
        assert_eq!(returned.state.paused.get(&theme), Some(&1));
        assert_eq!(returned.state.paused.get("settings"), Some(&5));

        let mut transport = FakeTransport::reading([read(9, [arriving])]).after_seq(9);
        let resumed = run_sync(&mut transport, &base, Some(returned.state), None);
        assert_eq!(transport.read_since, [1]);
        assert_eq!(resumed.config.theme, Theme::Dark);
        assert_eq!(resumed.state.paused.get(&theme), None);
    }

    #[test]
    fn a_setting_excluded_while_settings_are_off_is_read_from_where_settings_stopped() {
        let base = Config::default();
        let mut settings_off = base.clone();
        settings_off.sync_settings = false;
        let mut transport = FakeTransport::reading([read(8, [])]).after_seq(8);
        let off = run_sync(&mut transport, &settings_off, Some(recorded(&base)), None);
        assert_eq!(off.state.paused.get("settings"), Some(&1));

        // 設定を止めた後、`since` が進んでから項目を外す。項目も、設定を止めたときから読んでいない
        let mut excluded = settings_off.clone();
        excluded.sync_excluded_settings = vec!["theme".to_string()];
        let mut state = off.state;
        assert!(state.pause(&excluded));
        let theme = setting_item("theme").name();
        assert_eq!(state.paused.get(&theme), Some(&1));

        // 別の種類を止めた位置は、設定を止めた位置に引きずられない
        let mut snippets_off = excluded.clone();
        snippets_off.sync_snippets = false;
        assert!(state.pause(&snippets_off));
        assert_eq!(state.paused.get("snippets"), Some(&8));
    }

    #[test]
    fn returning_an_excluded_setting_keeps_a_value_changed_later_here() {
        let base = Config::default();
        let mut stopped = base.clone();
        stopped.sync_excluded_settings = vec!["theme".to_string()];
        let mut transport = FakeTransport::reading([read(4, [])]).after_seq(4);
        let off = run_sync(&mut transport, &stopped, Some(recorded(&base)), None);
        let local = Config {
            theme: Theme::Dark,
            ..base.clone()
        };
        let mut transport =
            FakeTransport::reading([read(5, [remote(SETTINGS, "s_theme", 5, json!("light"))])])
                .after_seq(5);
        let resumed = run_sync(&mut transport, &local, Some(off.state), None);
        assert_eq!(resumed.config.theme, Theme::Dark);
        assert_eq!(transport.written("s_theme")[0].base_seq, Some(5));
    }

    /// 設定の項目1つと、片方で消した行2つが食い違っている状態。
    /// 返すのは、手元の設定・記録・窓口の今の項目
    #[test]
    fn a_history_cleared_while_its_sync_was_off_does_not_clear_the_other_devices() {
        let config = Config::default();
        let shared = history(&[("a", 10)], 0);
        let mut transport = FakeTransport::reading([read(1, [])]).after_seq(1);
        let synced = run_sync(
            &mut transport,
            &config,
            Some(recorded(&config)),
            Some(&shared),
        );
        let on_server = transport.stored.clone();
        let mut transport = FakeTransport::reading([read(2, [])]).after_seq(2);
        let off_config = Config {
            sync_history: false,
            ..config.clone()
        };
        let off = run_sync(
            &mut transport,
            &off_config,
            Some(synced.state),
            Some(&shared),
        );
        // オフの間に、このデバイスの履歴を消した
        let cleared = history(&[], 100);
        let mut transport = FakeTransport::reading([read(2, [])]).after_seq(2);
        transport.stored = on_server;
        let on = run_sync(&mut transport, &config, Some(off.state), Some(&cleared));
        assert!(transport.written(HISTORY_ID).is_empty());
        assert_eq!(on.history, Some(shared));
        assert_eq!(on.state.paused.get("history"), None);
    }

    /// 履歴を1回同期した記録と、そのとき窓口に置いた項目。
    fn history_synced_once(shared: &History) -> (State, Vec<RemoteItem>) {
        let config = Config::default();
        let mut transport = FakeTransport::reading([read(1, [])]).after_seq(1);
        let synced = run_sync(
            &mut transport,
            &config,
            Some(recorded(&config)),
            Some(shared),
        );
        (synced.state, transport.stored)
    }

    fn resume_history(
        state: State,
        on_server: &[RemoteItem],
        local: &History,
    ) -> (SyncResult, FakeTransport) {
        let mut transport = FakeTransport::reading([read(2, [])]).after_seq(2);
        transport.stored = on_server.to_vec();
        let result = run_sync(&mut transport, &Config::default(), Some(state), Some(local));
        (result, transport)
    }

    #[test]
    fn a_history_cleared_while_both_kinds_were_off_does_not_clear_the_other_devices() {
        let shared = history(&[("a", 10)], 0);
        let (mut state, on_server) = history_synced_once(&shared);
        // 両方オフの間は通信しないので、印はスイッチを切り替えたときに置く
        let both_off = Config {
            sync_settings: false,
            sync_history: false,
            ..Config::default()
        };
        assert!(state.pause(&both_off));
        assert!(!state.pause(&both_off));
        let (on, transport) = resume_history(state, &on_server, &history(&[], 100));
        assert!(transport.written(HISTORY_ID).is_empty());
        assert_eq!(on.history, Some(shared));
        assert_eq!(on.state.paused.get("history"), None);
    }

    #[test]
    fn a_history_cleared_after_turning_it_off_offline_does_not_clear_the_other_devices() {
        let shared = history(&[("a", 10)], 0);
        let (mut state, on_server) = history_synced_once(&shared);
        state.pause(&Config {
            sync_history: false,
            ..Config::default()
        });
        // オフにした回は窓口につながらず、途中まで書けた分だけを記録に足す
        let state = merge_written(Some(state), &State::new("key"), false, "key");
        assert!(state.paused.contains_key("history"));
        let (on, transport) = resume_history(state, &on_server, &history(&[], 100));
        assert!(transport.written(HISTORY_ID).is_empty());
        assert_eq!(on.history, Some(shared));
    }

    #[test]
    fn a_history_that_could_not_be_mixed_when_turned_back_on_is_resumed_again_next_time() {
        let shared = history(&[("a", 10)], 0);
        let (mut state, on_server) = history_synced_once(&shared);
        state.pause(&Config {
            sync_history: false,
            ..Config::default()
        });
        let paused_at = state.paused.get("history").copied();
        // オフの間に消してから、1件覚えた
        let local = history(&[("b", 200)], 100);
        let mut transport =
            FakeTransport::reading([read(2, [])]).failing([Error::Other("offline".into())]);
        transport.stored = on_server.clone();
        let failed = run_sync(
            &mut transport,
            &Config::default(),
            Some(state),
            Some(&local),
        );
        assert_eq!(failed.history, None);
        assert_eq!(failed.state.paused.get("history").copied(), paused_at);

        let (on, transport) = resume_history(failed.state, &on_server, &local);
        assert_eq!(on.history, Some(history(&[("a", 10), ("b", 200)], 0)));
        assert_eq!(transport.written(HISTORY_ID).len(), 1);
        assert_eq!(on.state.paused.get("history"), None);
    }
}
