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
    account, account_key, atomic_file,
    config::{self, Action, Config, Language, Snippet, Theme},
    draft_keys::Platform,
    text::{CharWidths, PunctuationStyle, Replacement},
};

pub const STATE_FILE_NAME: &str = "sync-state.json";
const KEY_INFO: &[u8] = b"mawok sync v1";
const VERSION: u64 = 1;
const SETTINGS: &str = "settings";

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    detached: bool,
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
    /// 413 で拒まれた項目。値をログに出さず、次の変更まで再送しない。
    #[serde(default)]
    pub too_large: BTreeSet<String>,
    /// 復号できない・この版で読めない窓口の項目。古い版が書き戻さないよう、その版が変わるまで送らない。
    #[serde(default)]
    pub ignored: BTreeMap<String, u64>,
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
    plain: &Value,
) -> Result<String, String> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new((&derived_key(key)).into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &encode_plain(&Plain {
                    v: VERSION,
                    value: Some(plain.clone()),
                    detached: false,
                })?,
                aad: &associated_data(key_id, item),
            },
        )
        .map_err(|_| "couldn't encrypt a sync item".to_string())?;
    let mut data = nonce.to_vec();
    data.extend(ciphertext);
    Ok(STANDARD.encode(data))
}

fn encrypt_detached(key: &[u8; 32], key_id: &str, item: &ItemKey) -> Result<String, String> {
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new((&derived_key(key)).into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &encode_plain(&Plain {
                    v: VERSION,
                    value: None,
                    detached: true,
                })?,
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
    Sha256::digest(
        encode_plain(&Plain {
            v: VERSION,
            value: Some(value.clone()),
            detached: false,
        })
        .expect("sync values serialize"),
    )
    .into()
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
        json(config.text_window_keys.clone()),
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
        (
            "actions",
            config
                .actions
                .as_ref()
                .map(|rows| {
                    rows.iter()
                        .filter(|row| row.sync)
                        .map(|row| row.id.clone())
                        .collect()
                })
                .unwrap_or_default(),
        ),
    ] {
        set(&mut items, order_id(name), json(order));
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
        Some(Kind::Setting("text_history_size")) => value
            .as_f64()
            .filter(|number| {
                *number >= 0.0
                    && *number <= config::MAX_DRAFT_HISTORY_SIZE as f64
                    && number.is_finite()
            })
            .map(|number| {
                config.text_history_size = number.round() as u16;
            })
            .is_some(),
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
        Some(Kind::Setting("text_font_size")) => value
            .as_f64()
            .filter(|number| {
                number.is_finite()
                    && *number >= config::MIN_DRAFT_FONT_SIZE as f64
                    && *number <= config::MAX_DRAFT_FONT_SIZE as f64
            })
            .map(|number| {
                config.text_font_size = number.round() as u16;
            })
            .is_some(),
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
        Some(Kind::Setting("ai_models")) => set_if(&mut config.ai_models, parse(value)),
        Some(Kind::Setting(name)) if name == format!("hotkey_{}", platform_suffix()) => {
            set_if(&mut config.hotkey, parse(value))
        }
        Some(Kind::Setting(name)) if name == format!("text_window_keys_{}", platform_suffix()) => {
            apply_draft_keys(config, value)
        }
        Some(Kind::Setting(name)) if name == format!("text_font_family_{}", platform_suffix()) => {
            set_if(&mut config.text_font_family, parse(value))
        }
        Some(Kind::Replacement(id)) => apply_row(&mut config.replacements, id, value),
        Some(Kind::Snippet(id)) => apply_row(&mut config.snippets, id, value),
        Some(Kind::Action(id)) => {
            let rows = config.actions.get_or_insert_default();
            apply_row(rows, id, value)
        }
        Some(Kind::Order("replacements")) => apply_order(&mut config.replacements, value),
        Some(Kind::Order("snippets")) => apply_order(&mut config.snippets, value),
        Some(Kind::Order("actions")) => config
            .actions
            .as_mut()
            .is_some_and(|rows| apply_order(rows, value)),
        _ => false,
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
    for action in crate::draft_keys::DraftAction::ALL {
        let Some(key) = object.get(action.name()).and_then(Value::as_str) else {
            continue;
        };
        table.insert(action.name(), toml_edit::Value::from(key));
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

fn apply_order<T: SyncRow>(rows: &mut Vec<T>, value: &Value) -> bool {
    let Some(order) = parse::<Vec<String>>(value).filter(|ids| ids.iter().all(|id| valid_id(id)))
    else {
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
        Some(Kind::Action(id)) => config
            .actions
            .as_mut()
            .is_some_and(|rows| detach_row(rows, id)),
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
        Some(Kind::Action(id)) => config
            .actions
            .as_ref()
            .is_some_and(|rows| rows.iter().any(|row| row.id == id && !row.sync)),
        _ => false,
    }
}

fn dedupe_initial_rows<T: SyncRow>(rows: &mut Vec<T>, remote_ids: &BTreeSet<String>) {
    let remote_values: BTreeSet<String> = rows
        .iter()
        .filter(|row| remote_ids.contains(row.id()))
        .map(|row| row_value(row).to_string())
        .collect();
    let mut kept_remote_values = BTreeSet::new();
    rows.retain(|row| {
        if !row.sync() || !remote_values.contains(&row_value(row).to_string()) {
            return true;
        }
        remote_ids.contains(row.id()) && kept_remote_values.insert(row_value(row).to_string())
    });
}

#[derive(Debug, Clone)]
pub struct RemoteItem {
    pub key: ItemKey,
    pub seq: u64,
    pub deleted: bool,
    pub plain: Option<Plain>,
}
#[derive(Debug, Clone)]
pub struct Write {
    pub key: ItemKey,
    pub base_seq: Option<u64>,
    pub deleted: bool,
    pub plain: Option<Value>,
    pub detached: bool,
    previous: Option<Seen>,
}
#[derive(Debug, Clone)]
pub struct Reconcile {
    pub config: Config,
    pub state: State,
    pub writes: Vec<Write>,
    pub changed: bool,
}

/// 通信を含まない同期の決まり。読む結果を検査済みの `RemoteItem` として渡し、次の設定・記録・書く項目を返す。
pub fn reconcile(
    local: &Config,
    old: Option<State>,
    remote: &[RemoteItem],
    key_id: &str,
    since: u64,
) -> Reconcile {
    let initial = old.is_none();
    let mut config = local.clone();
    let mut state = old.unwrap_or_default();
    state.key_id = key_id.to_string();
    state.since = since;
    let mut writes = Vec::new();
    let mut changed = false;
    let mut sorted = remote.to_vec();
    sorted.sort_by_key(|item| (matches!(kind(&item.key), Some(Kind::Order(_))), item.seq));
    for remote in &sorted {
        if kind(&remote.key).is_none() {
            continue;
        }
        let name = remote.key.name();
        if state.conflicts.contains(&name) {
            continue;
        }
        let current = config_items(&config).get(&remote.key).cloned();
        let previous = state.items.get(&name).cloned();
        if initial {
            match (&remote.plain, remote.deleted) {
                (Some(plain), false) if plain.v == VERSION && !plain.detached => {
                    if let Some(value) = &plain.value {
                        if apply_value(&mut config, &remote.key, value) {
                            changed = true;
                            state.items.insert(
                                name.clone(),
                                Seen {
                                    seq: remote.seq,
                                    hash: hash_plain(value),
                                },
                            );
                            state.ignored.remove(&name);
                        } else {
                            state.ignored.insert(name, remote.seq);
                        }
                    }
                }
                (Some(plain), false) if plain.v == VERSION && plain.detached => {
                    changed |= detach_local(&mut config, &remote.key);
                }
                (_, true) => {}
                _ => {
                    state.ignored.insert(name, remote.seq);
                }
            }
            continue;
        }
        if remote.deleted {
            match (previous, current) {
                (Some(seen), Some(value)) if seen.hash == hash_plain(&value) => {
                    changed |= remove_local(&mut config, &remote.key);
                    state.items.remove(&name);
                }
                (Some(_), None) => {
                    state.items.remove(&name);
                }
                (Some(_), Some(_)) => {
                    state.conflicts.insert(name);
                }
                _ => {}
            }
            continue;
        }
        let Some(plain) = &remote.plain else {
            state.ignored.insert(name, remote.seq);
            continue;
        };
        if plain.v != VERSION {
            state.ignored.insert(name, remote.seq);
            continue;
        }
        if plain.detached {
            changed |= detach_local(&mut config, &remote.key);
            state.items.remove(&name);
            continue;
        }
        let Some(value) = &plain.value else {
            continue;
        };
        if !is_known_value(&config, &remote.key, value) {
            state.ignored.insert(name, remote.seq);
            continue;
        }
        state.ignored.remove(&name);
        match (previous, current) {
            (Some(seen), Some(local_value)) if seen.hash == hash_plain(&local_value) => {
                changed |= apply_value(&mut config, &remote.key, value);
                state.items.insert(
                    name,
                    Seen {
                        seq: remote.seq,
                        hash: hash_plain(value),
                    },
                );
            }
            (Some(_), Some(local_value)) if local_value == *value => {
                state.items.insert(
                    name,
                    Seen {
                        seq: remote.seq,
                        hash: hash_plain(value),
                    },
                );
            }
            (Some(_), Some(_)) => {
                state.conflicts.insert(name);
            }
            (None, None) => {
                changed |= apply_value(&mut config, &remote.key, value);
                state.items.insert(
                    name,
                    Seen {
                        seq: remote.seq,
                        hash: hash_plain(value),
                    },
                );
            }
            (None, Some(local_value)) if local_value == *value => {
                state.items.insert(
                    name,
                    Seen {
                        seq: remote.seq,
                        hash: hash_plain(value),
                    },
                );
            }
            (None, Some(_)) => {
                state.conflicts.insert(name);
            }
            (Some(_), None) => {
                state.conflicts.insert(name);
            }
        }
    }
    if initial {
        let remote_ids = |row_kind: char| {
            sorted
                .iter()
                .filter(|item| {
                    matches!(
                        (row_kind, kind(&item.key)),
                        ('r', Some(Kind::Replacement(_)))
                            | ('n', Some(Kind::Snippet(_)))
                            | ('a', Some(Kind::Action(_)))
                    ) && !item.deleted
                        && item.plain.as_ref().is_some_and(|plain| !plain.detached)
                })
                .map(|item| item.key.id[2..].to_string())
                .collect::<BTreeSet<_>>()
        };
        dedupe_initial_rows(&mut config.replacements, &remote_ids('r'));
        dedupe_initial_rows(&mut config.snippets, &remote_ids('n'));
        if let Some(actions) = &mut config.actions {
            dedupe_initial_rows(actions, &remote_ids('a'));
        }
    }
    let now = config_items(&config);
    for (key, value) in &now {
        let name = key.name();
        if state.conflicts.contains(&name)
            || state.too_large.contains(&name)
            || state.ignored.contains_key(&name)
        {
            continue;
        }
        if state
            .items
            .get(&name)
            .is_none_or(|seen| seen.hash != hash_plain(value))
        {
            writes.push(Write {
                key: key.clone(),
                base_seq: state.items.get(&name).map(|seen| seen.seq),
                deleted: false,
                plain: Some(value.clone()),
                detached: false,
                previous: None,
            });
        }
    }
    for (name, seen) in state.items.clone() {
        let Some((collection, id)) = name.split_once('\0') else {
            continue;
        };
        let key = ItemKey::new(collection, id);
        if kind(&key).is_none() {
            continue;
        }
        if !now.contains_key(&key)
            && !state.conflicts.contains(&name)
            && !state.ignored.contains_key(&name)
        {
            let detached = detached(&config, &key);
            writes.push(Write {
                key,
                base_seq: Some(seen.seq),
                deleted: !detached,
                plain: None,
                detached,
                previous: Some(seen),
            });
            state.items.remove(&name);
        }
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
}

#[derive(Debug, Clone)]
pub struct SyncResult {
    pub config: Config,
    pub state: State,
    pub changed: bool,
    pub reset: bool,
}

/// 1回の同期の外側。読み書きは `SyncTransport` に閉じ、競合時だけ最大3回読み直す。
pub async fn sync_once_with<T: SyncTransport>(
    transport: &mut T,
    config: &Config,
    mut state: Option<State>,
    key_id: &str,
) -> Result<SyncResult, Error> {
    let mut reset_seen = false;
    for _ in 0..3 {
        let read = transport
            .read(state.as_ref().map_or(0, |state| state.since))
            .await?;
        if read.reset {
            state = None;
            reset_seen = true;
        }
        let mut result = reconcile(config, state.clone(), &read.items, key_id, read.next);
        let mut conflict = false;
        for batch in result.writes.chunks(100) {
            match transport.write(batch).await {
                Ok(written) => {
                    for reply in written {
                        let name = reply.key.name();
                        if let Some(write) = batch.iter().find(|write| write.key == reply.key) {
                            if let Some(value) = &write.plain {
                                result.state.items.insert(
                                    name,
                                    Seen {
                                        seq: reply.seq,
                                        hash: hash_plain(value),
                                    },
                                );
                            } else {
                                result.state.items.remove(&name);
                            }
                        }
                    }
                }
                Err(Error::Other(detail)) if detail == "conflict" => {
                    conflict = true;
                    break;
                }
                Err(Error::Limit(limit)) => {
                    for write in batch {
                        result.state.too_large.insert(write.key.name());
                        if let Some(seen) = &write.previous {
                            result.state.items.insert(write.key.name(), seen.clone());
                        }
                    }
                    log::warn!("sync write was too large: {limit}");
                }
                Err(error) => return Err(error),
            }
        }
        if conflict {
            continue;
        }
        return Ok(SyncResult {
            config: result.config,
            state: result.state,
            changed: result.changed,
            reset: reset_seen,
        });
    }
    Err(Error::Other("sync conflicts did not settle".to_string()))
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => write!(f, "signed out"),
            Self::KeyMismatch => write!(f, "key mismatch"),
            Self::Limit(limit) => write!(f, "sync limit: {limit}"),
            Self::Other(detail) => f.write_str(detail),
        }
    }
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

async fn read_all(
    client: &reqwest::Client,
    token: &str,
    key: &[u8; 32],
    expected_key_id: &str,
    mut since: u64,
) -> Result<(String, bool, u64, Vec<RemoteItem>), Error> {
    let mut rebuilding = since == 0;
    let mut reset = false;
    let mut all = Vec::new();
    loop {
        let mut url = reqwest::Url::parse(&format!("{}/v1/sync", account::ACCOUNT_URL))
            .map_err(|error| Error::Other(error.to_string()))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("since", &since.to_string());
            query.append_pair("limit", "500");
            if rebuilding {
                query.append_pair("rebuild", "1");
            }
        }
        let request = client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, auth(token)?);
        let response = request
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
        let reply: GetReply = response
            .json()
            .await
            .map_err(|error| Error::Other(error.to_string()))?;
        let key_id = reply.key_id.unwrap_or_default();
        if !key_id.is_empty() && key_id != expected_key_id {
            return Err(Error::KeyMismatch);
        }
        reset |= reply.reset;
        rebuilding |= reply.reset;
        for item in reply.items {
            let key_item = ItemKey::new(&item.collection, item.id);
            if kind(&key_item).is_none() {
                continue;
            }
            let plain = if item.deleted {
                None
            } else {
                item.data
                    .as_deref()
                    .and_then(|data| decrypt(key, expected_key_id, &key_item, data))
            };
            all.push(RemoteItem {
                key: key_item,
                seq: item.seq,
                deleted: item.deleted,
                plain,
            });
        }
        since = reply.next;
        if !reply.more {
            return Ok((
                if key_id.is_empty() {
                    expected_key_id.to_string()
                } else {
                    key_id
                },
                reset,
                since,
                all,
            ));
        }
    }
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

async fn put(
    client: &reqwest::Client,
    token: &str,
    key: &[u8; 32],
    key_id: &str,
    writes: &[Write],
) -> Result<Vec<PutItem>, Error> {
    let mut items = Vec::new();
    for write in writes {
        if kind(&write.key).is_none() {
            return Err(Error::Other("invalid local sync item".to_string()));
        }
        let data = if write.deleted {
            None
        } else if write.detached {
            Some(encrypt_detached(key, key_id, &write.key).map_err(Error::Other)?)
        } else {
            Some(
                encrypt(
                    key,
                    key_id,
                    &write.key,
                    write.plain.as_ref().expect("non-deleted write has a value"),
                )
                .map_err(Error::Other)?,
            )
        };
        items.push(json!({ "collection": write.key.collection, "id": write.key.id, "base_seq": write.base_seq, "deleted": write.deleted, "data": data }));
    }
    let response = client
        .put(format!("{}/v1/sync", account::ACCOUNT_URL))
        .header(reqwest::header::AUTHORIZATION, auth(token)?)
        .json(&json!({ "key_id": key_id, "items": items }))
        .send()
        .await
        .map_err(|error| Error::Other(error.to_string()))?;
    let status = response.status();
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
        Some("conflict") => Err(Error::Other("conflict".to_string())),
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
        Box::pin(async move {
            let (_, reset, next, items) =
                read_all(self.client, self.token, self.key, self.key_id, since).await?;
            Ok(ReadResult { reset, next, items })
        })
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
}

/// 1回の通信を走らせ、保存する前の結果を返す。呼び出し元が設定と記録を同じ世代で保存する。
pub async fn sync_once(
    client: &reqwest::Client,
    token: &str,
    key: &[u8; 32],
    key_id: &str,
    config: &Config,
    state: Option<State>,
) -> Result<SyncResult, Error> {
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
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypts_with_a_fresh_nonce_and_binds_the_item() {
        let key = [7; 32];
        let item = ItemKey::new("settings", "s_theme");
        let value = json!("dark");
        let first = encrypt(&key, "key", &item, &value).unwrap();
        let second = encrypt(&key, "key", &item, &value).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            decrypt(&key, "key", &item, &first).unwrap().value,
            Some(value)
        );
        assert!(decrypt(&key, "other", &item, &first).is_none());
        assert!(decrypt(&key, "key", &ItemKey::new("settings", "s_language"), &first).is_none());
        assert!(decrypt(&key, "key", &ItemKey::new("history", "s_theme"), &first).is_none());
    }

    #[test]
    fn only_syncs_the_specified_values() {
        let config = Config::default();
        let items = config_items(&config);
        assert!(items.contains_key(&ItemKey::new("settings", "s_theme")));
        assert!(!items.contains_key(&ItemKey::new("settings", "s_sync_enabled")));
        assert!(!items.keys().any(|key| key.id.starts_with("a_")));
        assert!(items.contains_key(&ItemKey::new(
            "settings",
            format!("s_hotkey_{}", platform_suffix())
        )));
    }

    #[test]
    fn corrupt_state_is_treated_as_missing() {
        let path = std::env::temp_dir().join(format!("mawok-sync-state-{}", std::process::id()));
        fs::write(&path, b"not json").unwrap();
        assert!(load(&path).is_none());
        let _ = fs::remove_file(path);
    }

    fn remote(collection: &str, id: &str, seq: u64, value: Value) -> RemoteItem {
        RemoteItem {
            key: ItemKey::new(collection, id),
            seq,
            deleted: false,
            plain: Some(Plain {
                v: VERSION,
                value: Some(value),
                detached: false,
            }),
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
    fn applies_a_remote_change_when_local_value_is_unchanged() {
        let local = Config::default();
        let result = reconcile(
            &local,
            Some(recorded(&local)),
            &[remote("settings", "s_theme", 2, json!("dark"))],
            "key",
            2,
        );
        assert_eq!(result.config.theme, Theme::Dark);
        assert!(result.writes.is_empty());
    }

    #[test]
    fn writes_a_local_change_and_stops_on_a_conflict() {
        let base = Config::default();
        let mut local = base.clone();
        local.theme = Theme::Dark;
        let local_only = reconcile(&local, Some(recorded(&base)), &[], "key", 1);
        assert!(local_only
            .writes
            .iter()
            .any(|write| write.key == ItemKey::new("settings", "s_theme")));
        let conflict = reconcile(
            &local,
            Some(recorded(&base)),
            &[remote("settings", "s_theme", 2, json!("light"))],
            "key",
            2,
        );
        assert_eq!(conflict.config.theme, Theme::Dark);
        assert!(conflict.state.conflicts.contains("settings\0s_theme"));
        assert!(!conflict
            .writes
            .iter()
            .any(|write| write.key == ItemKey::new("settings", "s_theme")));
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
    fn initial_sync_writes_settings_missing_from_the_server() {
        let result = reconcile(&Config::default(), None, &[], "key", 0);
        assert!(result
            .writes
            .iter()
            .any(|write| write.key == ItemKey::new(SETTINGS, "s_language")));
    }

    #[test]
    fn removes_and_detaches_rows_without_overwriting_them() {
        let mut local = Config::default();
        let id = "a".repeat(32);
        local.replacements.push(Replacement {
            id: id.clone(),
            from: "a".into(),
            to: "b".into(),
            enabled: true,
            sync: true,
        });
        let mut deleted = RemoteItem {
            key: ItemKey::new("settings", row_id('r', &id)),
            seq: 2,
            deleted: true,
            plain: None,
        };
        let result = reconcile(&local, Some(recorded(&local)), &[deleted.clone()], "key", 2);
        assert!(result.config.replacements.is_empty());
        deleted.deleted = false;
        deleted.plain = Some(Plain {
            v: VERSION,
            value: None,
            detached: true,
        });
        let detached = reconcile(&local, Some(recorded(&local)), &[deleted], "key", 2);
        assert!(!detached.config.replacements[0].sync);
        let local_detached = detached.config.clone();
        let write = reconcile(&local_detached, Some(recorded(&local)), &[], "key", 1);
        assert!(
            write
                .writes
                .iter()
                .any(|write| write.detached
                    && write.key == ItemKey::new("settings", row_id('r', &id)))
        );
    }

    #[test]
    fn ignores_bad_or_unknown_remote_values_without_writing_them_back() {
        let local = Config::default();
        let bad = remote("settings", "s_theme", 2, json!("future-theme"));
        let unknown = remote("future", "value", 3, json!(true));
        let result = reconcile(&local, Some(recorded(&local)), &[bad, unknown], "key", 3);
        assert!(result.state.ignored.contains_key("settings\0s_theme"));
        assert!(!result.state.ignored.contains_key("future\0value"));
        assert!(!result
            .writes
            .iter()
            .any(|write| write.key == ItemKey::new("settings", "s_theme")));
    }

    #[test]
    fn encryption_rejects_a_changed_key_id() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let data = encrypt(&key, "first", &item, &json!("dark")).unwrap();
        assert!(decrypt(&key, "second", &item, &data).is_none());
    }

    #[test]
    fn encryption_rejects_a_changed_collection() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let data = encrypt(&key, "key", &item, &json!("dark")).unwrap();
        assert!(decrypt(&key, "key", &ItemKey::new("history", "s_theme"), &data).is_none());
    }

    #[test]
    fn encryption_rejects_a_changed_id() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let data = encrypt(&key, "key", &item, &json!("dark")).unwrap();
        assert!(decrypt(&key, "key", &ItemKey::new(SETTINGS, "s_language"), &data).is_none());
    }

    #[test]
    fn encryption_rejects_a_changed_ciphertext_byte() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let mut data = STANDARD
            .decode(encrypt(&key, "key", &item, &json!("dark")).unwrap())
            .unwrap();
        *data.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, "key", &item, &STANDARD.encode(data)).is_none());
    }

    #[test]
    fn encryption_round_trips() {
        let key = [3; 32];
        let item = ItemKey::new(SETTINGS, "s_theme");
        let value = json!("dark");
        let data = encrypt(&key, "key", &item, &value).unwrap();
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
            encrypt(&key, "key", &item, &json!("dark")).unwrap(),
            encrypt(&key, "key", &item, &json!("dark")).unwrap()
        );
    }

    #[test]
    fn detached_plaintext_round_trips() {
        let key = [1; 32];
        let item = ItemKey::new(SETTINGS, format!("r_{}", "a".repeat(32)));
        let data = encrypt_detached(&key, "key", &item).unwrap();
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
        config.actions = Some(vec![Action {
            id,
            name: "name".into(),
            command: "command".into(),
            ..Action::default()
        }]);
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
            .any(|key| key.id.starts_with("a_")));
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
    fn conflict_stays_stopped_on_the_next_sync() {
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
        let next = reconcile(
            &first.config,
            Some(first.state),
            &[remote(SETTINGS, "s_theme", 3, json!("system"))],
            "key",
            3,
        );
        assert_eq!(next.config.theme, Theme::Dark);
        assert!(!next.writes.iter().any(|write| write.key.id == "s_theme"));
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
    fn local_sync_false_writes_detached_and_removes_the_record() {
        let id = "d".repeat(32);
        let mut base = Config::default();
        base.replacements.push(Replacement {
            id: id.clone(),
            from: "a".into(),
            to: "b".into(),
            enabled: true,
            sync: true,
        });
        let mut local = base.clone();
        local.replacements[0].sync = false;
        let result = reconcile(&local, Some(recorded(&base)), &[], "key", 1);
        assert!(result
            .writes
            .iter()
            .any(|write| write.detached && write.key.id == row_id('r', &id)));
        assert!(!result
            .state
            .items
            .contains_key(&ItemKey::new(SETTINGS, row_id('r', &id)).name()));
        assert!(!result.config.replacements.is_empty());
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
                plain: Some(Plain {
                    v: VERSION,
                    value: None,
                    detached: true,
                }),
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
            hotkey: "Alt+X".into(),
            text_font_family: "Test Sans".into(),
            text_font_size: 20,
            text_color_light: "#112233".into(),
            text_color_dark: "#aabbcc".into(),
            input_guidance: Some("guide".into()),
            ai_service: crate::ai::AiService::Gemini,
            ..Config::default()
        };
        config
            .ai_models
            .insert(crate::ai::AiService::Gemini, "model".into());
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
        config.actions = Some(vec![Action {
            id: id.clone(),
            name: "action".into(),
            command: "command".into(),
            output: crate::config::ActionOutput::Insert,
            encoding: crate::config::ActionEncoding::ShiftJis,
            enabled: false,
            sync: true,
        }]);
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
    }

    #[test]
    fn unknown_version_is_ignored_without_a_write() {
        let local = Config::default();
        let item = RemoteItem {
            key: ItemKey::new(SETTINGS, "s_theme"),
            seq: 2,
            deleted: false,
            plain: Some(Plain {
                v: VERSION + 1,
                value: Some(json!("dark")),
                detached: false,
            }),
        };
        let result = reconcile(&local, Some(recorded(&local)), &[item], "key", 2);
        assert_eq!(result.config, local);
        assert!(result.state.ignored.contains_key("settings\0s_theme"));
        assert!(!result.writes.iter().any(|write| write.key.id == "s_theme"));
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

    struct FakeTransport {
        reads: Vec<ReadResult>,
        write_errors: Vec<Option<Error>>,
        read_since: Vec<u64>,
        writes: Vec<Vec<Write>>,
    }

    impl SyncTransport for FakeTransport {
        fn read<'a>(
            &'a mut self,
            since: u64,
        ) -> Pin<Box<dyn Future<Output = Result<ReadResult, Error>> + Send + 'a>> {
            self.read_since.push(since);
            Box::pin(std::future::ready(Ok(self.reads.remove(0))))
        }

        fn write<'a>(
            &'a mut self,
            writes: &'a [Write],
        ) -> Pin<Box<dyn Future<Output = Result<Vec<WrittenItem>, Error>> + Send + 'a>> {
            self.writes.push(writes.to_vec());
            let result = match self.write_errors.remove(0) {
                Some(error) => Err(error),
                None => Ok(writes
                    .iter()
                    .map(|write| WrittenItem {
                        key: write.key.clone(),
                        seq: 2,
                    })
                    .collect()),
            };
            Box::pin(std::future::ready(result))
        }
    }

    fn empty_read(reset: bool, next: u64) -> ReadResult {
        ReadResult {
            reset,
            next,
            items: Vec::new(),
        }
    }

    #[test]
    fn sync_once_retries_conflicts_at_most_three_times() {
        let mut transport = FakeTransport {
            reads: vec![
                empty_read(false, 1),
                empty_read(false, 2),
                empty_read(false, 3),
            ],
            write_errors: vec![
                Some(Error::Other("conflict".to_string())),
                Some(Error::Other("conflict".to_string())),
                Some(Error::Other("conflict".to_string())),
            ],
            read_since: Vec::new(),
            writes: Vec::new(),
        };
        let error = tauri::async_runtime::block_on(sync_once_with(
            &mut transport,
            &Config::default(),
            None,
            "key",
        ))
        .unwrap_err();
        assert!(
            matches!(error, Error::Other(message) if message == "sync conflicts did not settle")
        );
        assert_eq!(transport.read_since, vec![0, 0, 0]);
    }

    #[test]
    fn sync_once_reset_discards_the_old_record_and_rebuilds() {
        let state = recorded(&Config::default());
        let mut transport = FakeTransport {
            reads: vec![empty_read(true, 9)],
            write_errors: vec![None],
            read_since: Vec::new(),
            writes: Vec::new(),
        };
        let result = tauri::async_runtime::block_on(sync_once_with(
            &mut transport,
            &Config::default(),
            Some(state),
            "key",
        ))
        .unwrap();
        assert!(result.reset);
        assert_eq!(transport.read_since, vec![1]);
        assert!(transport.writes[0]
            .iter()
            .any(|write| write.base_seq.is_none()));
    }

    #[test]
    fn sync_once_returns_key_mismatch() {
        let mut transport = FakeTransport {
            reads: vec![empty_read(false, 1)],
            write_errors: vec![Some(Error::KeyMismatch)],
            read_since: Vec::new(),
            writes: Vec::new(),
        };
        let error = tauri::async_runtime::block_on(sync_once_with(
            &mut transport,
            &Config::default(),
            None,
            "key",
        ))
        .unwrap_err();
        assert!(matches!(error, Error::KeyMismatch));
    }
}
