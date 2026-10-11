//! Pro の設定同期。窓口から来る値は、復号できても設定ファイルと同じ検査を通してから使う。

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    future::Future,
    io,
    path::Path,
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
    account, account_key, actions,
    ai::AiService,
    atomic_file,
    config::{self, Action, Config, Language, Snippet, Theme},
    draft_keys::{DraftAction, Platform},
    history_store::{self, History},
    text::{CharWidths, PunctuationStyle, Replacement},
};

pub const STATE_FILE_NAME: &str = "sync-state.json";
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
        }
    }

    fn detached() -> Self {
        Self {
            v: VERSION,
            value: None,
            detached: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    pub seq: u64,
    pub hash: [u8; 32],
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    pub key_id: String,
    pub since: u64,
    #[serde(default)]
    pub items: BTreeMap<String, Seen>,
    #[serde(default)]
    pub conflicts: BTreeSet<String>,
    /// 大きすぎて書けなかった項目と、そのときの平文の SHA-256。手元の値が変わるまで書かない。
    #[serde(default)]
    pub too_large: BTreeMap<String, [u8; 32]>,
    /// 窓口で消えた・同期から外れた項目の `seq`。同じ id をもう一度書くときの `base_seq` に使う。
    #[serde(default)]
    pub retired: BTreeMap<String, u64>,
    /// 読み捨てた項目と、その `seq`。新しい版が書いた項目を壊さないよう、窓口の値が変わるまで書かない。
    #[serde(default)]
    pub ignored: BTreeMap<String, u64>,
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

    /// 窓口で消えた・同期から外れた。
    fn retire(&mut self, name: String, seq: u64) {
        self.items.remove(&name);
        self.ignored.remove(&name);
        self.retired.insert(name, seq);
    }

    /// まだ窓口の写しを読み終えたことが無い。記録が無いデバイスと同じく、初めての同期として合わせる。
    fn awaits_first_read(&self) -> bool {
        self.since == 0
    }
}

pub fn load(path: &Path) -> Option<State> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub fn save(path: &Path, state: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    atomic_file::write(path, &bytes).map_err(|error| error.to_string())
}

pub fn clear(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn derived_key(key: &[u8; 32]) -> [u8; 32] {
    account_key::derive(key, KEY_INFO)
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

/// このデバイスの OS のホットキーの項目。
pub fn hotkey_item() -> ItemKey {
    setting_item(&format!("hotkey_{}", platform_suffix()))
}

/// このデバイスの OS の、テキストウィンドウのキーの項目。
pub fn text_window_keys_item() -> ItemKey {
    setting_item(&format!("text_window_keys_{}", platform_suffix()))
}

pub fn setting_item(name: &str) -> ItemKey {
    ItemKey::new(SETTINGS, setting_id(name))
}

/// 設定ファイルと同じ項目名で書く。黙って外した操作は、設定ファイルと同じく書かない
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
    Action(&'a str),
    Order(&'a str),
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
        return valid_id(id).then_some(Kind::Replacement(id));
    }
    if let Some(id) = key.id.strip_prefix("n_") {
        return valid_id(id).then_some(Kind::Snippet(id));
    }
    if let Some(id) = key.id.strip_prefix("a_") {
        return valid_id(id).then_some(Kind::Action(id));
    }
    match key.id.as_str() {
        "o_replacements" => Some(Kind::Order("replacements")),
        "o_snippets" => Some(Kind::Order("snippets")),
        "o_actions" => Some(Kind::Order("actions")),
        _ => None,
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
    matches!(
        name,
        "language"
            | "theme"
            | "text_window_always_on_top"
            | "hide_text_window_on_blur"
            | "show_text_window_buttons"
            | "text_history_size"
            | "trim_trailing_whitespace"
            | "punctuation_style"
            | "char_widths"
            | "exclude_from_clipboard_history"
            | "text_font_size"
            | "text_color_light"
            | "text_color_dark"
            | "input_guidance"
            | "ai_service"
            | "ai_models"
    ) || ["hotkey", "text_window_keys", "text_font_family"]
        .into_iter()
        .any(|platform_name| name == format!("{platform_name}_{}", platform_suffix()))
}

/// 設定を、窓口に置く粒度の平文値へ変換する。同期しない項目はここに現れない。
pub fn config_items(config: &Config) -> BTreeMap<ItemKey, Value> {
    let mut items = BTreeMap::new();
    for (id, value) in [
        ("language", json(config.language)),
        ("theme", json(config.theme)),
        (
            "text_window_always_on_top",
            json(config.text_window_always_on_top),
        ),
        (
            "hide_text_window_on_blur",
            json(config.hide_text_window_on_blur),
        ),
        (
            "show_text_window_buttons",
            json(config.show_text_window_buttons),
        ),
        ("text_history_size", json(config.text_history_size)),
        (
            "trim_trailing_whitespace",
            json(config.trim_trailing_whitespace),
        ),
        ("punctuation_style", json(config.punctuation_style)),
        ("char_widths", json(config.char_widths)),
        (
            "exclude_from_clipboard_history",
            json(config.exclude_from_clipboard_history),
        ),
        ("text_font_size", json(config.text_font_size)),
        ("text_color_light", json(config.text_color_light.clone())),
        ("text_color_dark", json(config.text_color_dark.clone())),
        ("input_guidance", json(config.input_guidance.clone())),
        ("ai_service", json(config.ai_service)),
        ("ai_models", json(config.ai_models.clone())),
    ] {
        set(&mut items, setting_id(id), value);
    }
    let suffix = platform_suffix();
    set(
        &mut items,
        setting_id(&format!("hotkey_{suffix}")),
        json(config.hotkey.clone()),
    );
    set(
        &mut items,
        setting_id(&format!("text_window_keys_{suffix}")),
        draft_keys_value(config),
    );
    set(
        &mut items,
        setting_id(&format!("text_font_family_{suffix}")),
        json(config.text_font_family.clone()),
    );
    for row in &config.replacements {
        if row.sync {
            set(&mut items, row_id('r', &row.id), row_value(row));
        }
    }
    for row in &config.snippets {
        if row.sync {
            set(&mut items, row_id('n', &row.id), row_value(row));
        }
    }
    if let Some(actions) = &config.actions {
        for row in actions {
            if row.sync {
                set(&mut items, row_id('a', &row.id), row_value(row));
            }
        }
    }
    for (name, order) in [
        (
            "replacements",
            config
                .replacements
                .iter()
                .filter(|row| row.sync)
                .map(|row| row.id.clone())
                .collect::<Vec<_>>(),
        ),
        (
            "snippets",
            config
                .snippets
                .iter()
                .filter(|row| row.sync)
                .map(|row| row.id.clone())
                .collect::<Vec<_>>(),
        ),
    ] {
        set(&mut items, order_id(name), json(order));
    }
    if let Some(actions) = &config.actions {
        set(
            &mut items,
            order_id("actions"),
            json(
                actions
                    .iter()
                    .filter(|row| row.sync)
                    .map(|row| row.id.clone())
                    .collect::<Vec<_>>(),
            ),
        );
    }
    items
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

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn apply_value(config: &mut Config, item: &ItemKey, value: &Value) -> bool {
    match kind(item) {
        Some(Kind::Setting("language")) => set_if(&mut config.language, parse::<Language>(value)),
        Some(Kind::Setting("theme")) => set_if(&mut config.theme, parse::<Theme>(value)),
        Some(Kind::Setting("text_window_always_on_top")) => {
            set_if(&mut config.text_window_always_on_top, parse(value))
        }
        Some(Kind::Setting("hide_text_window_on_blur")) => {
            set_if(&mut config.hide_text_window_on_blur, parse(value))
        }
        Some(Kind::Setting("show_text_window_buttons")) => {
            set_if(&mut config.show_text_window_buttons, parse(value))
        }
        Some(Kind::Setting("text_history_size")) => set_if(
            &mut config.text_history_size,
            parse::<u16>(value).filter(|size| *size <= config::MAX_DRAFT_HISTORY_SIZE),
        ),
        Some(Kind::Setting("trim_trailing_whitespace")) => {
            set_if(&mut config.trim_trailing_whitespace, parse(value))
        }
        Some(Kind::Setting("punctuation_style")) => set_if(
            &mut config.punctuation_style,
            parse::<PunctuationStyle>(value),
        ),
        Some(Kind::Setting("char_widths")) => {
            set_if(&mut config.char_widths, parse::<CharWidths>(value))
        }
        Some(Kind::Setting("exclude_from_clipboard_history")) => {
            set_if(&mut config.exclude_from_clipboard_history, parse(value))
        }
        Some(Kind::Setting("text_font_size")) => set_if(
            &mut config.text_font_size,
            parse::<u16>(value).filter(|size| {
                (config::MIN_DRAFT_FONT_SIZE..=config::MAX_DRAFT_FONT_SIZE).contains(size)
            }),
        ),
        Some(Kind::Setting("text_color_light")) => value
            .as_str()
            .and_then(config::normalize_text_color)
            .map(|v| config.text_color_light = v)
            .is_some(),
        Some(Kind::Setting("text_color_dark")) => value
            .as_str()
            .and_then(config::normalize_text_color)
            .map(|v| config.text_color_dark = v)
            .is_some(),
        Some(Kind::Setting("input_guidance")) => {
            set_if(&mut config.input_guidance, parse::<Option<String>>(value))
        }
        Some(Kind::Setting("ai_service")) => set_if(&mut config.ai_service, parse(value)),
        Some(Kind::Setting("ai_models")) => set_if(
            &mut config.ai_models,
            // 空のモデルは、設定ファイルでも画面でも「既定のモデル」として項目ごと外す
            parse::<BTreeMap<AiService, String>>(value).filter(|models| {
                models
                    .values()
                    .all(|model| !model.is_empty() && model.trim() == model)
            }),
        ),
        Some(Kind::Setting(name)) if name == format!("hotkey_{}", platform_suffix()) => {
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
        Some(Kind::Setting(name)) if name == format!("text_window_keys_{}", platform_suffix()) => {
            apply_draft_keys(config, value)
        }
        Some(Kind::Setting(name)) if name == format!("text_font_family_{}", platform_suffix()) => {
            set_if(&mut config.text_font_family, parse(value))
        }
        Some(Kind::Replacement(id)) => apply_row(&mut config.replacements, id, value),
        Some(Kind::Snippet(id)) => apply_row(&mut config.snippets, id, value),
        Some(Kind::Action(id)) => apply_action_row(config, id, value),
        Some(Kind::Order("replacements")) => apply_order(&mut config.replacements, value),
        Some(Kind::Order("snippets")) => apply_order(&mut config.snippets, value),
        // 入れられない並びのために、既定のアクションを書き出さない
        Some(Kind::Order("actions")) => {
            order_ids(value).is_some() && apply_order(synced_actions(config), value)
        }
        _ => false,
    }
}

/// アクションの行。既定のアクションのままのデバイスでは、同期しない既定のアクションだけを設定に書き出す
/// （docs/sync.md「同期する単位」）。同期する行は、届いたものだけにする。
fn synced_actions(config: &mut Config) -> &mut Vec<Action> {
    let language = config.language;
    config
        .actions
        .get_or_insert_with(|| unsynced_defaults(language, None))
}

/// 設定に書き出す既定のアクション。同期しないものと、ほかのデバイスが同期から外した `detached` の id のもの。
fn unsynced_defaults(language: Language, detached: Option<&str>) -> Vec<Action> {
    let lang = match language {
        Language::Ja => crate::i18n::Lang::Ja,
        Language::En => crate::i18n::Lang::En,
        Language::System => crate::i18n::Lang::system(),
    };
    let mut defaults = actions::default_actions(lang);
    for action in &mut defaults {
        if detached == Some(action.id.as_str()) {
            action.sync = false;
        }
    }
    defaults.retain(|action| !action.sync);
    defaults
}

/// 既定で同期する既定のアクションか。
fn synced_default_action(id: &str) -> bool {
    actions::default_actions(crate::i18n::Lang::En)
        .iter()
        .any(|action| action.id == id && action.sync)
}

fn apply_action_row(config: &mut Config, id: &str, value: &Value) -> bool {
    // 入れられない行のために、既定のアクションを書き出さない
    if parse::<Action>(value).is_none() {
        return false;
    }
    let rows = synced_actions(config);
    let is_new = rows.iter().all(|row| row.id != id);
    if !apply_row(rows, id, value) {
        return false;
    }
    if is_new {
        seat_default_action(rows);
    }
    true
}

/// 末尾に足した行が既定のアクションなら、既定の並びで次にある同期しない既定のアクションの前へ動かす。
/// 同期しない行は直前の行の後ろに置く決まりなので、並びが届いたときに、既定の並びのとおりに付いて動く。
fn seat_default_action(rows: &mut Vec<Action>) {
    let defaults = actions::default_actions(crate::i18n::Lang::En);
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

fn set_if<T>(target: &mut T, value: Option<T>) -> bool {
    if let Some(value) = value {
        *target = value;
        true
    } else {
        false
    }
}

fn apply_draft_keys(config: &mut Config, value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let mut table = toml_edit::InlineTable::new();
    for action in DraftAction::ALL {
        match object.get(action.name()) {
            // 無い操作は、設定ファイルに書いていないのと同じく既定のキーを使う
            None => {}
            Some(Value::String(key)) => {
                table.insert(action.name(), toml_edit::Value::from(key.as_str()));
            }
            Some(_) => return false,
        }
    }
    let item = toml_edit::Item::Value(toml_edit::Value::InlineTable(table));
    let parsed = crate::draft_keys::parse(Some(&item), Platform::current());
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

trait SyncRow: Serialize + for<'a> Deserialize<'a> + Clone {
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
impl SyncRow for Action {
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
    parse::<Vec<String>>(value).filter(|ids| ids.iter().all(|id| valid_id(id)))
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
        Some(Kind::Snippet(id)) => remove_row(&mut config.snippets, id),
        Some(Kind::Action(id)) => config
            .actions
            .as_mut()
            .is_some_and(|rows| remove_row(rows, id)),
        _ => false,
    }
}
fn detach_local(config: &mut Config, item: &ItemKey) -> bool {
    match kind(item) {
        Some(Kind::Replacement(id)) => detach_row(&mut config.replacements, id),
        Some(Kind::Snippet(id)) => detach_row(&mut config.snippets, id),
        Some(Kind::Action(id)) => match &mut config.actions {
            Some(rows) => detach_row(rows, id),
            // 既定のアクションのままのデバイスでは、外された既定のアクションを同期しない行として書き出す。
            // 書き出さないと、並びが届いたときに、誰も消していないのに手元から消える
            None if synced_default_action(id) => {
                config.actions = Some(unsynced_defaults(config.language, Some(id)));
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
        Some(Kind::Snippet(id)) => config.snippets.iter().any(|row| row.id == id && !row.sync),
        Some(Kind::Action(id)) => match &config.actions {
            Some(rows) => rows.iter().any(|row| row.id == id && !row.sync),
            // 既定のアクションのままでも、同期しない既定のアクションは手元の行
            None => actions::default_actions(crate::i18n::Lang::En)
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
        Some(Kind::Order("snippets")) => synced_ids(&config.snippets),
        Some(Kind::Order("actions")) => synced_ids(config.actions.as_deref().unwrap_or_default()),
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
}

impl Write {
    /// 窓口に置く平文。消す項目には無い。
    fn payload(&self) -> Option<Plain> {
        if self.deleted {
            None
        } else if self.detached {
            Some(Plain::detached())
        } else {
            self.plain.clone().map(Plain::value)
        }
    }
}

#[derive(Debug, Clone)]
pub struct Reconcile {
    pub config: Config,
    pub state: State,
    pub writes: Vec<Write>,
    pub changed: bool,
}

/// 通信を含まない同期の決まり。読む結果を検査済みの `RemoteItem` として渡し、次の設定・記録・書く項目を返す。
/// 書く項目の記録は、窓口に書けてから `sync_once_with` が置く。
pub fn reconcile(
    local: &Config,
    old: Option<State>,
    remote: &[RemoteItem],
    key_id: &str,
    since: u64,
) -> Reconcile {
    let initial = old.as_ref().is_none_or(State::awaits_first_read);
    reconcile_as(
        local,
        old.unwrap_or_default(),
        initial,
        remote,
        key_id,
        since,
    )
}

/// まだ見ていない、この版が扱う項目か。
fn is_new(state: &State, remote: &RemoteItem) -> bool {
    let name = remote.key.name();
    kind(&remote.key).is_some()
        && !state.conflicts.contains(&name)
        && state.seen_seq(&name).is_none_or(|seq| remote.seq > seq)
}

/// 窓口の1項目を、決まりに照らして手元の設定と記録に入れる。手元の設定を変えたかを返す。
fn receive(
    config: &mut Config,
    state: &mut State,
    local_items: &BTreeMap<ItemKey, Value>,
    initial: bool,
    remote: &RemoteItem,
) -> bool {
    if !is_new(state, remote) {
        return false;
    }
    let name = remote.key.name();
    let mut changed = false;
    // 同期から外した手元の行は、同じ id の項目が届いても、中身も `sync` も変えない（docs/sync.md「同期する単位」）。
    if detached(config, &remote.key) {
        match state.items.get_mut(&name) {
            // 外した印をまだ書いていない。ほかのデバイスの写しを切り離すため、届いた項目の上に印を書く
            Some(seen) if !matches!(remote.incoming(), Incoming::Detached) => {
                seen.seq = remote.seq;
            }
            // 届いた `seq` は置いておき、印を付け直したときの `base_seq` にする
            _ => state.retire(name, remote.seq),
        }
        return changed;
    }
    let previous = state.items.get(&name).cloned();
    // 記録がある項目（前の回に自分が書いた項目）は、初めての同期でも、いつもの決まりで比べる。
    // 窓口の値を無条件に入れると、書いた後に手元で変えた値を巻き戻す
    if initial && previous.is_none() {
        match remote.incoming() {
            Incoming::Value(value) => {
                if apply_value(config, &remote.key, value) {
                    changed = true;
                    let settled = settled_value(config, &remote.key, value);
                    state.settle(name, remote.seq, &settled);
                } else {
                    state.ignored.insert(name, remote.seq);
                }
            }
            Incoming::Detached => {
                changed |= detach_local(config, &remote.key);
                state.retire(name, remote.seq);
            }
            Incoming::Deleted => {
                changed |= remove_local(config, &remote.key);
                state.retire(name, remote.seq);
            }
            Incoming::Unreadable => {
                state.ignored.insert(name, remote.seq);
            }
        }
        return changed;
    }
    // 並びは、同じ回に届いた行を入れる前の手元の並びで比べる。
    // 入れた後で比べると、届いた行の分だけ並びが変わって見え、手元を変えていないのに食い違いになる
    let current = if matches!(kind(&remote.key), Some(Kind::Order(_))) {
        local_items.get(&remote.key).cloned()
    } else {
        config_items(config).get(&remote.key).cloned()
    };
    let local_unchanged = match (&previous, &current) {
        (Some(seen), Some(value)) => seen.hash == hash_plain(value),
        (None, None) => true,
        _ => false,
    };
    match remote.incoming() {
        Incoming::Deleted => {
            if current.is_none() {
                // 手元でも消したか、外している。記録が無ければ、もともと持っていない行
                if previous.is_some() {
                    state.retire(name, remote.seq);
                }
            } else if local_unchanged {
                changed |= remove_local(config, &remote.key);
                state.retire(name, remote.seq);
            } else {
                state.conflicts.insert(name);
            }
        }
        Incoming::Detached => {
            changed |= detach_local(config, &remote.key);
            state.retire(name, remote.seq);
        }
        Incoming::Unreadable => {
            state.ignored.insert(name, remote.seq);
        }
        Incoming::Value(value) => {
            if !is_known_value(config, &remote.key, value) {
                state.ignored.insert(name, remote.seq);
            } else if local_unchanged {
                changed |= apply_value(config, &remote.key, value);
                let settled = settled_value(config, &remote.key, value);
                state.settle(name, remote.seq, &settled);
            } else if current.as_ref() == Some(value) {
                state.settle(name, remote.seq, value);
            } else {
                state.ignored.remove(&name);
                state.conflicts.insert(name);
            }
        }
    }
    changed
}

/// 同じ回に届いたホットキーとキー操作を入れる。片方ずつ今の手元と照らすと、キーを入れ替えた組
/// （操作から外したキーをホットキーにする など）を、重なりとして読み捨ててしまう。
/// 組でも検査を通らなければ、両方を読み捨てて、手元はどちらも変えない
fn receive_key_pair(
    config: &mut Config,
    state: &mut State,
    local_items: &BTreeMap<ItemKey, Value>,
    initial: bool,
    hotkey: &RemoteItem,
    keys: &RemoteItem,
) -> bool {
    let before = (config.clone(), state.clone());
    // キー操作は、これから替わるホットキーとは照らさずに入れ、ホットキーを入れた後で照らし直す
    let local_hotkey = std::mem::take(&mut config.hotkey);
    let mut changed = receive(config, state, local_items, initial, keys);
    config.hotkey = local_hotkey;
    changed |= receive(config, state, local_items, initial, hotkey);
    let ignored = [hotkey, keys]
        .iter()
        .any(|item| state.ignored.get(&item.key.name()) == Some(&item.seq));
    let keys_settled = state
        .items
        .get(&keys.key.name())
        .is_some_and(|seen| seen.seq == keys.seq);
    let consistent = match keys.incoming() {
        Incoming::Value(value) if keys_settled => apply_value(config, &keys.key, value),
        _ => crate::draft_keys::check_hotkey(
            &config.text_window_keys,
            &config.hotkey,
            Platform::current(),
        )
        .is_ok(),
    };
    if ignored || !consistent {
        (*config, *state) = before;
        for item in [hotkey, keys] {
            state.ignored.insert(item.key.name(), item.seq);
        }
        return false;
    }
    changed
}

/// `initial` は、この同期が「初めての同期」か。`conflict` を受けて当て直す間も、同じ決まりで合わせる。
fn reconcile_as(
    local: &Config,
    mut state: State,
    initial: bool,
    remote: &[RemoteItem],
    key_id: &str,
    since: u64,
) -> Reconcile {
    let mut config = local.clone();
    state.key_id = key_id.to_string();
    state.since = since;
    let mut changed = false;
    let local_items = config_items(local);
    let mut sorted = remote.to_vec();
    // 言語を先に入れてから、None のアクションを既定から実体化する。並びは最後にしないと同じ回の行を並べ替えられない。
    // 外した印は行より先に入れる。行が先に既定のアクションを実体化すると、外された既定のアクションを残せない。
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
    for (index, remote) in sorted.iter().enumerate() {
        match pair {
            Some((hotkey, keys)) if index == hotkey.min(keys) => {
                changed |= receive_key_pair(
                    &mut config,
                    &mut state,
                    &local_items,
                    initial,
                    &sorted[hotkey],
                    &sorted[keys],
                );
            }
            Some((hotkey, keys)) if index == hotkey.max(keys) => {}
            _ => changed |= receive(&mut config, &mut state, &local_items, initial, remote),
        }
    }
    if initial {
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
        changed |= dedupe_initial_rows(&mut config.replacements, &on_server("r_"));
        changed |= dedupe_initial_rows(&mut config.snippets, &on_server("n_"));
        if let Some(actions) = &mut config.actions {
            changed |= dedupe_initial_rows(actions, &on_server("a_"));
        }
    }
    let now = config_items(&config);
    let hashes: BTreeMap<String, [u8; 32]> = now
        .iter()
        .map(|(key, value)| (key.name(), hash_plain(value)))
        .collect();
    // 手元の値が変わった（か、無くなった）項目は、もう一度書いてみる
    state
        .too_large
        .retain(|name, hash| hashes.get(name) == Some(hash));
    let held = |state: &State, name: &str| {
        state.conflicts.contains(name) || state.ignored.contains_key(name)
    };
    let mut writes = Vec::new();
    // 既定で同期する既定のアクションを、一度も書かないまま同期から外した。窓口に項目が無いと、ほかのデバイスには
    // 並びから消えたことしか伝わらず、消した行と見分けられないので、外した印を書く。
    // 何回かに分けて書くときに、その行を抜いた並びだけが先に届かないよう、ほかの項目より前に積む
    for default in actions::default_actions(crate::i18n::Lang::En) {
        let key = ItemKey::new(SETTINGS, row_id('a', &default.id));
        let name = key.name();
        if default.sync
            && detached(&config, &key)
            && !state.items.contains_key(&name)
            && !state.retired.contains_key(&name)
            && !held(&state, &name)
        {
            writes.push(Write {
                key,
                base_seq: None,
                deleted: false,
                plain: None,
                detached: true,
            });
        }
    }
    for (key, value) in &now {
        let name = key.name();
        if held(&state, &name) || state.too_large.contains_key(&name) {
            continue;
        }
        let seen = state.items.get(&name);
        if seen.is_none_or(|seen| seen.hash != hashes[&name]) {
            writes.push(Write {
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
    for (name, seen) in &state.items {
        let Some((collection, id)) = name.split_once('\0') else {
            continue;
        };
        let key = ItemKey::new(collection, id);
        if kind(&key).is_none() || now.contains_key(&key) || held(&state, name) {
            continue;
        }
        let detached = detached(&config, &key);
        writes.push(Write {
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
    }
}

fn is_known_value(config: &Config, key: &ItemKey, value: &Value) -> bool {
    let mut checked = config.clone();
    apply_value(&mut checked, key, value)
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
}

/// 1回の同期の外側。読み書きは `SyncTransport` に閉じる。
pub async fn sync_once_with<T: SyncTransport>(
    transport: &mut T,
    config: &Config,
    state: Option<State>,
    key_id: &str,
    history: Option<&History>,
) -> Result<SyncResult, Box<Failure>> {
    let read = match transport
        .read(state.as_ref().map_or(0, |state| state.since))
        .await
    {
        Ok(read) => read,
        Err(error) => {
            return Err(Box::new(Failure {
                error,
                written: State::new(key_id),
                reset: false,
            }))
        }
    };
    // 窓口が写しで組み直すよう知らせたら、前の記録は使えない
    let state = state.filter(|_| !read.reset);
    let initial = state.as_ref().is_none_or(State::awaits_first_read);
    let mut result = reconcile(config, state, &read.items, key_id, read.next);
    let mut changed = result.changed;
    let mut written = State::new(key_id);
    let local_items = config_items(config);
    let mut retries = 0;
    loop {
        let conflicts = match write_all(transport, &mut result, &mut written, &local_items).await {
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
                None => {
                    let name = conflict.key.name();
                    result.state.items.remove(&name);
                    result.state.retired.remove(&name);
                }
            }
        }
        result = reconcile_as(
            &result.config,
            result.state,
            initial,
            &current,
            key_id,
            read.next,
        );
        changed |= result.changed;
    }
    // 同じ回に履歴の件数が届いたら、届いた後の件数で合わせる
    let history = sync_history(
        transport,
        &mut result.state,
        &mut written,
        &read.items,
        history,
        result.config.text_history_size as usize,
    )
    .await;
    Ok(SyncResult {
        // 同じ値を入れ直しただけなら、変わっていない。設定ファイルを書き直して次の同期を呼ばないため
        changed: changed && result.config != *config,
        config: result.config,
        state: result.state,
        reset: read.reset,
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
async fn sync_history<T: SyncTransport>(
    transport: &mut T,
    state: &mut State,
    written: &mut State,
    read: &[RemoteItem],
    local: Option<&History>,
    size: usize,
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
    // このデバイスで初めて履歴を同期する回は、手元の消した時刻を使わない（docs/sync.md「混ぜ方」）
    let first = record.is_none();
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

/// 書く項目を窓口へ送り、書けた分を記録に置く。`conflict` が返ったら、そこで止めて今の項目を返す。
/// `local_items` は、同期を始めたときの手元の値。
async fn write_all<T: SyncTransport>(
    transport: &mut T,
    result: &mut Reconcile,
    written: &mut State,
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
            match &write.plain {
                Some(value) => {
                    result.state.settle(name.clone(), reply.seq, value);
                    // 届いた並びに手元の行を足した並びは、結果を捨てると手元に入らないので置かず、次の回に読み直して
                    // 合わせる。手元の並びをそのまま書いたものは置く。忘れると、次の回に自分の書き込みを
                    // 他人の変更と取り違える
                    let unapplied_order = matches!(kind(&write.key), Some(Kind::Order(_)))
                        && local_items.get(&write.key) != Some(value);
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
    let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| Error::Other("invalid account token".to_string()))?;
    value.set_sensitive(true);
    Ok(value)
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
            let plain = item
                .data
                .as_deref()
                .filter(|_| !item.deleted)
                .and_then(|data| decrypt(key, key_id, &item_key, data));
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
            let plain = item
                .data
                .as_deref()
                .filter(|_| !item.deleted)
                .and_then(|data| decrypt(key, key_id, &item_key, data));
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

struct HttpTransport<'a> {
    client: &'a reqwest::Client,
    token: &'a str,
    key: &'a [u8; 32],
    key_id: &'a str,
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
    let plain = item
        .data
        .as_deref()
        .filter(|_| !item.deleted)
        .and_then(|data| decrypt(key, key_id, item_key, data));
    Some(RemoteItem {
        key: item_key.clone(),
        seq,
        deleted: item.deleted,
        plain,
    })
}

/// 1回の通信を走らせ、保存する前の結果を返す。呼び出し元が設定と記録を同じ世代で保存する。
pub async fn sync_once(
    client: &reqwest::Client,
    token: &str,
    key: &[u8; 32],
    key_id: &str,
    config: &Config,
    state: Option<State>,
    history: Option<&History>,
) -> Result<SyncResult, Box<Failure>> {
    let mut transport = HttpTransport {
        client,
        token,
        key,
        key_id,
    };
    sync_once_with(
        &mut transport,
        config,
        state.filter(|state| state.key_id == key_id),
        key_id,
        history,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft_keys::DraftKeys;

    #[test]
    fn corrupt_state_is_treated_as_missing() {
        let path = std::env::temp_dir().join(format!("mawok-sync-corrupt-{}", std::process::id()));
        fs::write(&path, b"not json").unwrap();
        assert!(load(&path).is_none());
        let _ = fs::remove_file(path);
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
        config.snippets.push(Snippet {
            id: id.clone(),
            name: "name".into(),
            body: "body".into(),
            sync: true,
        });
        let mut actions = actions::default_actions(crate::i18n::Lang::En);
        actions.push(Action {
            id,
            name: "name".into(),
            command: "command".into(),
            ..Action::default()
        });
        config.actions = Some(actions);
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
            sync_enabled: false,
            yielded_draft_keys: crate::draft_keys::DraftAction::ALL.to_vec(),
            ..Config::default()
        };
        let items = config_items(&config);
        for name in [
            "autostart",
            "devices",
            "ai_consent",
            "sync_enabled",
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
    fn conversion_omits_default_actions_not_written_to_config() {
        assert!(!config_items(&Config::default())
            .keys()
            .any(|key| key.id.starts_with("a_") || key.id == "o_actions"));
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
        ];
        let result = reconcile(&local, Some(recorded(&local)), &items, "key", 3);
        assert_eq!(result.config, local);
        assert!(result.state.ignored.is_empty());
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
            char_widths: CharWidths {
                alphabet: crate::text::WidthStyle::Full,
                digit: crate::text::WidthStyle::Half,
                space: crate::text::WidthStyle::Full,
                symbol: crate::text::WidthStyle::Half,
                katakana: crate::text::KatakanaWidth::Full,
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
        config.snippets.push(Snippet {
            id: id.clone(),
            name: "name".into(),
            body: "body".into(),
            sync: true,
        });
        let mut actions = actions::default_actions(crate::i18n::Lang::En);
        actions.push(Action {
            id: id.clone(),
            name: "action".into(),
            command: "command".into(),
            output: crate::config::ActionOutput::Insert,
            encoding: crate::config::ActionEncoding::ShiftJis,
            enabled: false,
            sync: true,
        });
        config.actions = Some(actions);
        let items = config_items(&config);
        let mut restored = Config::default();
        for (key, value) in items
            .iter()
            .filter(|(key, _)| !matches!(kind(key), Some(Kind::Order(_))))
        {
            assert!(apply_value(&mut restored, key, value), "{}", key.id);
        }
        for (key, value) in items
            .iter()
            .filter(|(key, _)| matches!(kind(key), Some(Kind::Order(_))))
        {
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
    fn state_round_trips_and_clear_removes_it() {
        let path = std::env::temp_dir().join(format!("mawok-sync-state-{}", std::process::id()));
        let state = recorded(&Config::default());
        save(&path, &state).unwrap();
        assert_eq!(load(&path).unwrap().items, state.items);
        clear(&path).unwrap();
        assert!(load(&path).is_none());
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
            .get_mut(DraftAction::SendTargets)
            .clear();
        config.yielded_draft_keys = vec![DraftAction::SendTargets];
        let value = config_items(&config)[&text_window_keys_item()].clone();
        assert_eq!(value["history_older"], json!("Alt+KeyP"));
        assert!(value.get("send_targets").is_none(), "{value}");

        let mut received = Config::default();
        assert!(apply_value(&mut received, &text_window_keys_item(), &value));
        assert_eq!(
            received.text_window_keys.get(DraftAction::HistoryOlder),
            "Alt+KeyP"
        );
        // 書いていない操作は、重なりが無ければ既定のキーを使う
        assert_eq!(
            received.text_window_keys.get(DraftAction::SendTargets),
            DraftKeys::default().get(DraftAction::SendTargets)
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
                json!({ "snippets": "Alt+KeyP", "actions": "Alt+KeyP" }),
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

    #[test]
    fn conflict_stops_the_item_until_it_is_resolved() {
        let base = Config::default();
        let mut local = base.clone();
        local.theme = Theme::Dark;
        let first = reconcile(
            &local,
            Some(recorded(&base)),
            &[remote(SETTINGS, "s_theme", 2, json!("light"))],
            "key",
            2,
        );
        assert_eq!(first.config.theme, Theme::Dark);
        assert!(first.state.conflicts.contains("settings\0s_theme"));
        assert!(first.writes.is_empty());
        let next = reconcile(
            &first.config,
            Some(first.state),
            &[remote(SETTINGS, "s_theme", 3, json!("system"))],
            "key",
            3,
        );
        assert_eq!(next.config.theme, Theme::Dark);
        assert!(next.writes.is_empty());
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
            assert!(result.state.conflicts.is_empty(), "seq {seq}");
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

    fn default_action(index: usize, lang: crate::i18n::Lang) -> Action {
        actions::default_actions(lang).swap_remove(index)
    }

    /// 既定のアクションのままのデバイスが、初めての同期でない回と初めての同期で受け取る
    fn receive_actions(items: &[RemoteItem]) -> [Reconcile; 2] {
        let local = Config::default();
        [Some(recorded(&local)), None].map(|state| reconcile(&local, state, items, "key", 9))
    }

    #[test]
    fn default_actions_from_another_device_do_not_conflict_with_the_local_defaults() {
        let sort = default_action(1, crate::i18n::Lang::system());
        // 相手は、英訳を別の表示言語で持ち、並べ替えを同期する行にして、別の文字コードで書いている
        for lang in [crate::i18n::Lang::Ja, crate::i18n::Lang::En] {
            let translate = Action {
                enabled: false,
                ..default_action(0, lang)
            };
            let their_sort = Action {
                encoding: crate::config::ActionEncoding::ShiftJis,
                output: crate::config::ActionOutput::Insert,
                sync: true,
                ..sort.clone()
            };
            let items = [
                remote(
                    SETTINGS,
                    &row_id('a', &their_sort.id),
                    2,
                    row_value(&their_sort),
                ),
                remote(
                    SETTINGS,
                    &row_id('a', &translate.id),
                    3,
                    row_value(&translate),
                ),
                remote(
                    SETTINGS,
                    "o_actions",
                    4,
                    json!([translate.id, their_sort.id]),
                ),
            ];
            for result in receive_actions(&items) {
                assert!(result.state.conflicts.is_empty(), "{lang:?}");
                assert_eq!(
                    result.config.actions,
                    Some(vec![translate.clone(), sort.clone()]),
                    "{lang:?}"
                );
                // 並べ替えは手元で同期しない行。その id を抜いた並びを書き戻さない
                assert!(action_writes(&result).is_empty(), "{lang:?}");
            }
        }
    }

    fn action_writes(result: &Reconcile) -> Vec<&Write> {
        result
            .writes
            .iter()
            .filter(|write| write.key.id.starts_with("a_") || write.key.id == "o_actions")
            .collect()
    }

    #[test]
    fn unsyncing_a_default_action_never_written_writes_the_mark_once() {
        let mut translate = default_action(0, crate::i18n::Lang::system());
        translate.sync = false;
        let key = ItemKey::new(SETTINGS, row_id('a', &translate.id));
        // 既定のアクションのままのデバイスで、最初の操作として英訳を同期から外した
        let local = Config {
            actions: Some(vec![
                translate,
                default_action(1, crate::i18n::Lang::system()),
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

    /// 英訳（既定で同期する既定のアクション）を、同期しない行として持つデバイス
    fn translate_unsynced() -> (Config, ItemKey) {
        let translate = Action {
            sync: false,
            ..default_action(0, crate::i18n::Lang::system())
        };
        let key = ItemKey::new(SETTINGS, row_id('a', &translate.id));
        let local = Config {
            actions: Some(vec![
                translate,
                default_action(1, crate::i18n::Lang::system()),
            ]),
            ..Config::default()
        };
        (local, key)
    }

    #[test]
    fn an_unsynced_default_action_already_on_the_server_gets_no_mark() {
        let (local, key) = translate_unsynced();
        let arrivals = [
            (
                "value",
                remote(
                    SETTINGS,
                    &key.id,
                    6,
                    row_value(&default_action(0, crate::i18n::Lang::En)),
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
            plain: Some(Plain::value(row_value(&default_action(
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
        assert!(batch_of(&key.id) <= batch_of("o_actions"));
    }

    #[test]
    fn a_default_action_unsynced_on_another_device_stays_as_an_unsynced_row() {
        let sort = default_action(1, crate::i18n::Lang::system());
        let translate = Action {
            sync: false,
            ..default_action(0, crate::i18n::Lang::system())
        };
        let custom = Action {
            id: "a".repeat(32),
            name: "自作".into(),
            command: "echo".into(),
            ..Action::default()
        };
        let mark_key = ItemKey::new(SETTINGS, row_id('a', &translate.id));
        // どれが先に届いても同じ
        for (mark_seq, other_seq) in [(2, 3), (3, 2)] {
            let items = [
                detached_mark(&mark_key, mark_seq),
                remote(SETTINGS, "o_actions", other_seq, json!([])),
            ];
            for result in receive_actions(&items) {
                assert_eq!(
                    result.config.actions,
                    Some(vec![translate.clone(), sort.clone()]),
                    "mark at {mark_seq}"
                );
                assert!(action_writes(&result).is_empty(), "mark at {mark_seq}");
            }
            let items = [
                detached_mark(&mark_key, mark_seq),
                remote(
                    SETTINGS,
                    &row_id('a', &custom.id),
                    other_seq,
                    row_value(&custom),
                ),
                remote(SETTINGS, "o_actions", 4, json!([custom.id])),
            ];
            for result in receive_actions(&items) {
                assert_eq!(
                    result.config.actions,
                    Some(vec![translate.clone(), sort.clone(), custom.clone()]),
                    "mark at {mark_seq}"
                );
                assert!(action_writes(&result).is_empty(), "mark at {mark_seq}");
            }
        }
    }

    #[test]
    fn an_empty_order_without_a_mark_does_not_write_out_the_synced_default() {
        let sort = default_action(1, crate::i18n::Lang::system());
        for result in receive_actions(&[remote(SETTINGS, "o_actions", 2, json!([]))]) {
            assert_eq!(result.config.actions, Some(vec![sort.clone()]));
            assert!(action_writes(&result).is_empty());
        }
    }

    #[test]
    fn a_default_action_deleted_on_another_device_does_not_come_back() {
        let sort = default_action(1, crate::i18n::Lang::system());
        let translate = default_action(0, crate::i18n::Lang::En);
        let custom = Action {
            id: "a".repeat(32),
            name: "自作".into(),
            command: "echo".into(),
            ..Action::default()
        };
        let items = [
            deleted(&ItemKey::new(SETTINGS, row_id('a', &translate.id)), 2),
            remote(SETTINGS, &row_id('a', &custom.id), 3, row_value(&custom)),
            remote(SETTINGS, "o_actions", 4, json!([custom.id])),
        ];
        for result in receive_actions(&items) {
            assert_eq!(
                result.config.actions,
                Some(vec![sort.clone(), custom.clone()])
            );
            let written = |prefix: &str| {
                result
                    .writes
                    .iter()
                    .any(|write| write.key.id.starts_with(prefix))
            };
            assert!(!written("a_") && !written("o_actions"));
        }
    }

    #[test]
    fn an_unusable_action_item_leaves_the_default_actions_unwritten() {
        let items = [
            remote(
                SETTINGS,
                &row_id('a', &"a".repeat(32)),
                2,
                json!("not a row"),
            ),
            remote(SETTINGS, "o_actions", 3, json!("not an order")),
        ];
        for result in receive_actions(&items) {
            assert_eq!(result.config.actions, None);
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
        tauri::async_runtime::block_on(sync_once_with(transport, config, state, "key", None))
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
            sync: true,
        };
        let local = Config {
            snippets: vec![snippet('c', "手元")],
            ..Config::default()
        };
        let theirs = Config {
            snippets: vec![
                snippet('e', "新2"),
                snippet('d', "新1"),
                snippet('c', "手元"),
            ],
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
        assert!(
            result.state.conflicts.is_empty(),
            "{:?}",
            result.state.conflicts
        );
        assert_eq!(
            result
                .config
                .snippets
                .iter()
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
        // 変わったと返すと、同じ中身の設定ファイルを書き直して、次の同期を呼んでしまう
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
        assert!(result.state.conflicts.is_empty());
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
        assert!(result.state.conflicts.is_empty());
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
        assert!(result.state.conflicts.is_empty());
    }

    #[test]
    fn discarding_a_result_leaves_the_written_order_to_be_read_again() {
        let named = |id: char, name: &str| Snippet {
            name: name.into(),
            ..snippet(id, name.into())
        };
        // 初めての同期。窓口には相手の行と並びがあり、手元には手元だけの行がある
        let local = Config {
            snippets: vec![named('f', "手元")],
            ..Config::default()
        };
        let theirs = Config {
            snippets: vec![named('e', "相手2"), named('d', "相手1")],
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
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(names, ["相手2", "相手1", "手元"]);
        assert!(second.written("o_snippets").is_empty());
        assert!(result.state.conflicts.is_empty());
    }

    #[test]
    fn discarding_a_result_keeps_a_written_order_that_was_the_local_order() {
        let rows = |ids: [char; 3]| Config {
            snippets: ids
                .into_iter()
                .map(|id| snippet(id, id.to_string()))
                .collect(),
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
        assert!(result.state.conflicts.is_empty());
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
        assert!(result.state.conflicts.is_empty());
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
        assert!(result.state.conflicts.is_empty());
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
        old.conflicts.insert("settings\0s_theme".into());
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
        assert!(result.state.conflicts.is_empty());
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
            sync: true,
        }
    }

    #[test]
    fn only_the_item_over_the_size_limit_is_left_unwritten() {
        let config = Config {
            snippets: vec![
                snippet('a', "x".repeat(MAX_ENCRYPTED_ITEM_BYTES)),
                snippet('b', "small".into()),
            ],
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
        shortened.snippets[0].body = "short".into();
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
                assert!(result.state.conflicts.is_empty(), "{case}");
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
                assert!(next.state.conflicts.is_empty(), "{case}");
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
            assert!(result.state.conflicts.is_empty(), "{case}");
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
            snippets: vec![snippet('a', "a".into()), mine, snippet('c', "c".into())],
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
            snippets: vec![snippet('a', "a".into()), snippet('c', "c".into())],
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
        for index in 0..WRITE_BATCH_SIZE {
            local.snippets.push(Snippet {
                id: format!("{index:032x}"),
                name: "name".into(),
                body: "body".into(),
                sync: true,
            });
        }
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
        let row = edited.snippets.iter_mut().find(|row| row.id == id).unwrap();
        row.body = "edited".into();
        let mut second =
            FakeTransport::reading([read(first.seq, first.stored.clone())]).after_seq(first.seq);
        let result = run(&mut second, &edited, Some(record)).unwrap();
        assert!(result.state.conflicts.is_empty());
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
        assert!(
            !result.state.conflicts.contains(&name),
            "history never stops as a conflict"
        );
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
}
