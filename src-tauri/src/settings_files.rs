//! 設定のファイル（docs/config.md「ファイル」）。設定・定型文・置き換え辞書を、置き場の TOML のファイルに読み書きする。
//! 画面から書くときは、手で書いたコメント・並び・知らない項目を残し、変えた項目だけを書き換える

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::{Map, Number, Value};
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table};

use crate::{
    atomic_file,
    config::key,
    folder_access::{self, Reach},
};

pub const SETTINGS: &str = "settings.toml";
pub const SNIPPETS: &str = "snippets.toml";
pub const REPLACEMENTS: &str = "replacements.toml";
/// 置き場に置くファイル。見張るときも、この名前のファイルの変化だけを拾う
pub const FILE_NAMES: [&str; 3] = [SETTINGS, SNIPPETS, REPLACEMENTS];

/// 行の並びを1つのファイルに置く項目と、そのファイル
const ROW_FILES: [(&str, &str); 2] = [(key::SNIPPETS, SNIPPETS), (key::REPLACEMENTS, REPLACEMENTS)];

/// OS ごとに欄を分ける項目（docs/config.md「ファイル」）。キーの名前が OS で違い、クラウドストレージには
/// マシンごとに書き分ける仕組みが無いため
const PER_OS: [&str; 2] = [key::HOTKEY, key::TEXT_WINDOW_KEYS];

/// 読んだ結果
#[derive(Debug, Default)]
pub struct Read {
    /// 項目名と値。設定の型への入れ方は config::from_entries
    pub entries: BTreeMap<String, Value>,
    /// 読めなかったファイルの名前と理由。読めないファイルの項目は entries に入らない
    pub unreadable: Vec<(&'static str, String)>,
}

/// 置き場のファイルを読む。無いファイルは、書いていない（既定のまま）として扱う
pub fn read(dir: &Path, os: &str) -> Read {
    let mut read = Read::default();
    for name in FILE_NAMES {
        let document = match load(&dir.join(name)) {
            Ok(Some(document)) => document,
            Ok(None) => continue,
            Err(error) => {
                read.unreadable.push((name, error));
                continue;
            }
        };
        match name {
            SETTINGS => {
                for (item_name, item) in document.iter() {
                    let Some(value) = to_json(item) else {
                        continue;
                    };
                    if PER_OS.contains(&item_name) {
                        if let Some(value) = value.get(os) {
                            read.entries.insert(item_name.to_string(), value.clone());
                        }
                    } else if !is_row_item(item_name) {
                        read.entries.insert(item_name.to_string(), value);
                    }
                }
            }
            _ => {
                let (item_name, _) = ROW_FILES
                    .into_iter()
                    .find(|(_, file)| *file == name)
                    .expect("a row file");
                if let Some(value) = document.get(item_name).and_then(to_json) {
                    read.entries.insert(item_name.to_string(), value);
                }
            }
        }
    }
    read
}

/// 項目を書くファイルの名前
pub fn file_of(item_name: &str) -> &'static str {
    ROW_FILES
        .into_iter()
        .find(|(name, _)| *name == item_name)
        .map_or(SETTINGS, |(_, file)| file)
}

/// 置き場に、設定のどれかのファイルがあるか。置き場を替えるときに、そちらの設定を使うかを聞くのに使う
pub fn exists_in(dir: &Path) -> bool {
    FILE_NAMES.iter().any(|name| dir.join(name).exists())
}

/// どの項目を書くか
#[derive(Debug, Clone, Copy)]
pub enum Scope<'a> {
    /// `before`（今の設定を書いたときの項目）から変えた項目だけを書く。画面から 1 つ変えたときに、ほかの項目を
    /// メモリの内容で書き直さないため。ほかのデバイスから届いて、まだ読み込んでいない変更や、読めずに読み飛ばした値
    /// （新しい版が書いた選択肢・キー・行など）を、変えていない項目まで巻き添えで消さない。表（キー操作）の中の項目と
    /// 行の並びの中の行も、`before` に無かったもの（読めなかったもの）には触らない
    Changed(&'a BTreeMap<String, Value>),
    /// `managed` の項目を全部書く（バックアップから戻す・置き場を替えて今の設定を書く）。
    /// `set_aside_unreadable` なら、読めないファイルを `<名前>.broken-….toml` に写してから書き直す
    All { set_aside_unreadable: bool },
}

/// 項目を置き場のファイルに書く。`managed` は、このアプリが書く項目名（ほかの名前は、新しい版が書いた項目や
/// 手で書いたものとして残す）。書く項目の無いファイルは読みもしない。中身が変わらないファイルは書かない。
/// ほかのデバイスで同期しているときに、変えていないファイルまで書き換えて衝突のもとにしないため。
/// 書く項目のあるファイルが読めなければ書き換えない（手で書きかけのものを、画面からの変更で消さないため）。そのときは
/// `SETTINGS_FILE_UNREADABLE` の符号を返す（読めるファイルの分は書く）
pub fn write(
    dir: &Path,
    os: &str,
    managed: &[&str],
    scope: Scope<'_>,
    entries: &BTreeMap<String, Value>,
) -> Result<(), String> {
    let names: Vec<&str> = match scope {
        Scope::Changed(before) => managed
            .iter()
            .copied()
            .filter(|name| before.get(*name) != entries.get(*name))
            .collect(),
        Scope::All { .. } => managed.to_vec(),
    };
    let before = match scope {
        Scope::Changed(before) => Some(before),
        Scope::All { .. } => None,
    };
    let mut unreadable = Vec::new();
    for name in FILE_NAMES {
        let in_file: Vec<&str> = names
            .iter()
            .copied()
            .filter(|item| file_of(item) == name)
            .collect();
        if in_file.is_empty() {
            continue;
        }
        let path = dir.join(name);
        let before_text = match fs::read_to_string(target(&path)) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("{name}: {error}")),
        };
        let mut document = match before_text.as_deref().map(str::parse::<DocumentMut>) {
            Some(Ok(document)) => document,
            Some(Err(_)) => match scope {
                Scope::All {
                    set_aside_unreadable: true,
                } => {
                    match atomic_file::back_up(&target(&path), std::time::SystemTime::now()) {
                        Ok(copy) => log::warn!(
                            "set aside the unreadable settings file {name} to {}",
                            copy.map(|copy| copy.display().to_string())
                                .unwrap_or_default()
                        ),
                        Err(error) => return Err(format!("{name}: {error}")),
                    }
                    DocumentMut::new()
                }
                _ => {
                    unreadable.push(name);
                    continue;
                }
            },
            None => DocumentMut::new(),
        };
        match name {
            SETTINGS => update_settings(&mut document, os, &in_file, before, entries),
            _ => {
                for item_name in in_file {
                    set_or_remove(
                        document.as_table_mut(),
                        item_name,
                        before.map(|before| before.get(item_name)),
                        entries.get(item_name),
                    );
                }
            }
        }
        let after = document.to_string();
        if before_text.as_deref() == Some(after.as_str())
            || (before_text.is_none() && after.trim().is_empty())
        {
            continue;
        }
        atomic_file::write(&target(&path), after.as_bytes())
            .map_err(|error| format!("{name}: {error}"))?;
    }
    if unreadable.is_empty() {
        Ok(())
    } else {
        log::warn!(
            "didn't write the unreadable settings files: {}",
            unreadable.join(", ")
        );
        Err(crate::error_codes::SETTINGS_FILE_UNREADABLE.to_string())
    }
}

/// 置き場のうち、読めないもの（docs/config.md「置き場」）。現れる・許可されるまで、置き場に何も書かない
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unreachable {
    /// 無い。パスは、設定画面に出す無いもの。symlink なら、`..` を畳んだその先
    Missing(PathBuf),
    /// macOS のサンドボックスが読ませない。パスは、読む許可が要る symlink の先（docs/config.md「macOS のサンドボックス」）
    Denied(PathBuf),
}

/// 先を読めない、設定のファイルか履歴のフォルダーの symlink。先が無い（dotfiles でそのファイルの無いブランチに
/// 切り替えた間など）ものは、置き場が無いときと同じく扱う（docs/config.md「置き場」）。既定の値で読み直したり、
/// symlink を普通のファイルに置き換えて書いたりしないため。サンドボックスが読ませないものも、許可されるまで同じく扱う
pub fn unreachable_link(dir: &Path) -> Option<Unreachable> {
    for name in FILE_NAMES {
        let path = dir.join(name);
        if !is_link(&path) {
            continue;
        }
        match folder_access::file_reach(&path) {
            Reach::Readable => {}
            Reach::Missing => {
                let target = folder_access::link_target(&path).unwrap_or(path);
                return Some(Unreachable::Missing(target));
            }
            Reach::Denied => return folder_access::link_target(&path).map(Unreachable::Denied),
        }
    }
    // 履歴のフォルダーは、先が無ければ見張りを始めるときに作るので、断られたときだけ見る
    let history = dir.join(crate::history_store::DIR_NAME);
    if is_link(&history) && folder_access::dir_reach(&history) == Reach::Denied {
        return folder_access::link_target(&history).map(Unreachable::Denied);
    }
    None
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// 書く先。symlink なら、その先のファイルに書く。stow などで張った dotfiles の symlink を、
/// 一時ファイルからの差し替えで普通のファイルに置き換えて壊さないため
fn target(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn load(path: &Path) -> Result<Option<DocumentMut>, String> {
    match fs::read_to_string(path) {
        Ok(text) => text
            .parse::<DocumentMut>()
            .map(Some)
            .map_err(|error| parse_error(&text, &error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// 読めない理由。ログに出すので、行と桁と理由だけにする。toml_edit の文はその行の中身を引き、
/// 定型文や置き換え辞書の本文がログに残るため（マニュアルの「ログにテキストの中身は残していません」）
fn parse_error(text: &str, error: &toml_edit::TomlError) -> String {
    let Some(start) = error.span().map(|span| span.start.min(text.len())) else {
        return error.message().to_string();
    };
    let before = text.get(..start).unwrap_or(text);
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    format!("line {line}, column {column}: {}", error.message())
}

fn is_row_item(name: &str) -> bool {
    ROW_FILES.iter().any(|(item_name, _)| *item_name == name)
}

/// `before` は Scope::Changed の前の項目（None なら全部書く）
fn update_settings(
    document: &mut DocumentMut,
    os: &str,
    names: &[&str],
    before: Option<&BTreeMap<String, Value>>,
    entries: &BTreeMap<String, Value>,
) {
    let table = document.as_table_mut();
    for &name in names {
        if is_row_item(name) {
            continue;
        }
        let previous = before.map(|before| before.get(name));
        if PER_OS.contains(&name) {
            let existing = table.get(name);
            let inline = matches!(
                existing,
                Some(Item::Value(toml_edit::Value::InlineTable(_)))
            );
            let mut per_os = match existing {
                Some(Item::Table(per_os)) => per_os.clone(),
                // 1行の表（`hotkey = { macos = "…" }`）で書いてあっても、ほかの OS の値を残す
                Some(Item::Value(toml_edit::Value::InlineTable(per_os))) => {
                    per_os.clone().into_table()
                }
                // OS の欄でない形で書いてあれば、読むときも読み飛ばしているので、書くときに今の形に直す
                _ => Table::new(),
            };
            let before_json = existing.and_then(to_json);
            set_or_remove(&mut per_os, os, previous, entries.get(name));
            // この OS の値が変わらなければ、書き方（1行の表・コメント・位置）を残すため触らない
            if before_json == Some(table_to_json(per_os.iter())) {
                continue;
            }
            if per_os.is_empty() {
                table.remove(name);
            } else if inline {
                // 元の1行の表をその場で書き換える。入れ替えると、行末のコメントと空白（値の装飾）が消えるため
                let value = per_os.get(os).and_then(to_json).and_then(|v| to_value(&v));
                if let Some(Item::Value(toml_edit::Value::InlineTable(existing))) =
                    table.get_mut(name)
                {
                    let added_or_removed = match value {
                        Some(value) => existing.insert(os, value).is_none(),
                        None => existing.remove(os).is_some(),
                    };
                    // 欄が増減すると、前の最後の値の後ろの空白が `,` の前に残るので、中の空白だけを整える
                    if added_or_removed {
                        existing.fmt();
                    }
                }
            } else {
                table.insert(name, Item::Table(per_os));
            }
        } else {
            set_or_remove(table, name, previous, entries.get(name));
        }
    }
}

/// 値を入れる。同じ値が書いてあれば、書き方（コメント・引用符の種類など）を残すため触らない。値が無ければ消す。
/// `previous` は Scope::Changed のときの前の値（`Some(None)` は前も無かった）。そのときは、表の中の項目は前にあって
/// 今は無いものだけを消し、行の並びは読めなかった行を残す。前に無かったもの（読めずに読み飛ばしたもの）に触らないため
fn set_or_remove(
    table: &mut Table,
    name: &str,
    previous: Option<Option<&Value>>,
    value: Option<&Value>,
) {
    let changed_only = previous.is_some();
    let previous = previous.flatten();
    // 変えた分だけ書くときは、無くなった表や並びも、空の表・並びとして中身を比べて書く。丸ごと消すと、
    // 読めずに読み飛ばした中身まで消すため
    let empty_object = Value::Object(Map::new());
    let empty_array = Value::Array(Vec::new());
    let value = match (value, table.get(name)) {
        (None, Some(Item::Table(_) | Item::Value(toml_edit::Value::InlineTable(_))))
            if changed_only =>
        {
            Some(&empty_object)
        }
        (None, Some(Item::ArrayOfTables(_))) if changed_only => Some(&empty_array),
        (value, _) => value,
    };
    let Some(value) = value else {
        table.remove(name);
        return;
    };
    if table.get(name).and_then(to_json).as_ref() == Some(value) {
        return;
    }
    // 行の並び（`[[snippets]]` など）は、変わった行だけを書き換える。1行を直しただけで、ほかの行に手で書いた
    // コメントや書き方を消さないため
    if let (Some(Item::ArrayOfTables(tables)), Value::Array(rows)) = (table.get_mut(name), value) {
        if rows.iter().all(Value::is_object) && (changed_only || !rows.is_empty()) {
            update_rows(name, tables, rows, changed_only);
            if tables.is_empty() {
                table.remove(name);
            }
            return;
        }
    }
    // 表（`[text_window_keys.macos]` など）は、項目ごとに入れ替える。表ごと入れ替えると、変えていない項目のコメントまで消える
    if let (Some(Item::Table(existing)), Value::Object(object)) = (table.get_mut(name), value) {
        let previous_object = previous.and_then(Value::as_object);
        let gone: Vec<String> = existing
            .iter()
            .map(|(key, _)| key.to_string())
            .filter(|key| !object.contains_key(key))
            .filter(|key| !changed_only || previous_object.is_some_and(|p| p.contains_key(key)))
            .collect();
        for key in gone {
            existing.remove(&key);
        }
        for (key, value) in object {
            if previous_object.and_then(|p| p.get(key)) == Some(value) {
                continue;
            }
            set_or_remove(existing, key, None, Some(value));
        }
        if existing.is_empty() {
            table.remove(name);
        }
        return;
    }
    // 1行の表（`macos = { copy = "…" }`）も、同じく項目ごとに入れ替える。入れ替えると、知らない項目が消えるため
    if let (Some(Item::Value(toml_edit::Value::InlineTable(existing))), Value::Object(object)) =
        (table.get_mut(name), value)
    {
        let previous_object = previous.and_then(Value::as_object);
        let gone: Vec<String> = existing
            .iter()
            .map(|(key, _)| key.to_string())
            .filter(|key| !object.contains_key(key))
            .filter(|key| !changed_only || previous_object.is_some_and(|p| p.contains_key(key)))
            .collect();
        for key in &gone {
            existing.remove(key);
        }
        let mut added = false;
        for (key, value) in object {
            if previous_object.and_then(|p| p.get(key)) == Some(value)
                || existing.get(key).and_then(value_to_json).as_ref() == Some(value)
            {
                continue;
            }
            if let Some(new) = to_value(value) {
                added |= existing.insert(key, new).is_none();
            }
        }
        if existing.is_empty() {
            table.remove(name);
        } else if added || !gone.is_empty() {
            existing.fmt();
        }
        return;
    }
    if value == &empty_object || value == &empty_array {
        return;
    }
    let Some(item) = to_item(value) else {
        return;
    };
    // 値だけを入れ替える。`insert` は、キーの上の行のコメントと行末のコメント（キーと値の装飾）を消すため
    if let (Some(Item::Value(old)), Item::Value(mut new)) = (table.get_mut(name), item.clone()) {
        *new.decor_mut() = old.decor().clone();
        *old = new;
        return;
    }
    table.insert(name, item);
}

/// 行の並びを書き換える。中身が同じ行は、元の表（前に付けたコメント・書き方・知らない項目）をそのまま使い、
/// 位置が変わっても書き直さない。同じ位置で中身の変わった行は、元の表の値だけを書き換えて、コメントと知らない項目を残す。
/// 比べるときは、書いていない項目を既定の値で埋める（`enabled` を省いた手書きの行を、毎回書き直さないため）。
/// `keep_unreadable` なら、行として読めない行（新しい版が足した型の行・書き間違えた行）を残す。置くのは、元で次にあった
/// 読めた行の前（その行が無くなっていれば末尾）。位置は読めた行の中で数える（画面の並びには、読めない行が入っていないため）
fn update_rows(item_name: &str, tables: &mut ArrayOfTables, rows: &[Value], keep_unreadable: bool) {
    let all: Vec<Table> = tables.iter().cloned().collect();
    let all_normalized: Vec<Option<Value>> = all
        .iter()
        .map(|table| crate::config::normalized_row(item_name, &table_to_json(table.iter())))
        .collect();
    // 読めない行と、元でその次にあった読めた行（existing の中の位置）
    let (existing, normalized, unreadable) = if keep_unreadable {
        let mut existing = Vec::new();
        let mut normalized = Vec::new();
        let mut waiting = Vec::new();
        let mut unreadable: Vec<(Option<usize>, Table)> = Vec::new();
        for (table, row) in all.iter().zip(&all_normalized) {
            if row.is_some() {
                for table in waiting.drain(..) {
                    unreadable.push((Some(existing.len()), table));
                }
                existing.push(table.clone());
                normalized.push(row.clone());
            } else {
                waiting.push(table.clone());
            }
        }
        unreadable.extend(waiting.into_iter().map(|table| (None, table)));
        (existing, normalized, unreadable)
    } else {
        (all.clone(), all_normalized, Vec::new())
    };
    let mut used = vec![false; existing.len()];
    let mut next: Vec<Table> = Vec::new();
    // next の各行が、existing のどの行から来たか
    let mut sources: Vec<Option<usize>> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(object) = row.as_object() else {
            continue;
        };
        let wanted = crate::config::normalized_row(item_name, row);
        let same = (0..existing.len())
            .find(|&at| !used[at] && wanted.is_some() && normalized[at] == wanted);
        let mut source = same;
        let table = match same {
            Some(at) => {
                used[at] = true;
                existing[at].clone()
            }
            // 同じ位置の行がほかの行と合っていなければ、その行を直したとみる
            None if index < existing.len()
                && !used[index]
                && !rows.iter().any(|other| {
                    crate::config::normalized_row(item_name, other) == normalized[index]
                }) =>
            {
                used[index] = true;
                source = Some(index);
                let mut table = existing[index].clone();
                for (name, value) in object {
                    set_or_remove(&mut table, name, None, Some(value));
                }
                table
            }
            None => to_table(object),
        };
        next.push(table);
        sources.push(source);
    }
    for (follower, table) in unreadable {
        let at = follower
            .and_then(|follower| sources.iter().position(|source| *source == Some(follower)))
            .unwrap_or(next.len());
        next.insert(at, table);
        sources.insert(at, None);
    }
    // 表は、並びでなく文書の中の位置で書き出されるので、新しい並びの順に位置を振り直す
    let base = all.iter().filter_map(Table::position).min().unwrap_or(0);
    let mut written = ArrayOfTables::new();
    for (index, mut table) in next.into_iter().enumerate() {
        table.set_position(Some(base + index as isize));
        written.push(table);
    }
    *tables = written;
}

fn to_json(item: &Item) -> Option<Value> {
    match item {
        Item::None => None,
        Item::Value(value) => value_to_json(value),
        Item::Table(table) => Some(table_to_json(table.iter())),
        Item::ArrayOfTables(tables) => Some(Value::Array(
            tables
                .iter()
                .map(|table| table_to_json(table.iter()))
                .collect(),
        )),
    }
}

fn table_to_json<'a>(items: impl Iterator<Item = (&'a str, &'a Item)>) -> Value {
    Value::Object(
        items
            .filter_map(|(name, item)| to_json(item).map(|value| (name.to_string(), value)))
            .collect(),
    )
}

fn value_to_json(value: &toml_edit::Value) -> Option<Value> {
    use toml_edit::Value as V;
    Some(match value {
        V::String(text) => Value::String(text.value().clone()),
        V::Integer(number) => Value::Number(Number::from(*number.value())),
        V::Float(number) => Value::Number(Number::from_f64(*number.value())?),
        V::Boolean(flag) => Value::Bool(*flag.value()),
        // 日時を書く設定は無い。文字列として読み、設定の型に入れるときに断る
        V::Datetime(time) => Value::String(time.value().to_string()),
        V::Array(array) => Value::Array(array.iter().filter_map(value_to_json).collect()),
        V::InlineTable(table) => Value::Object(
            table
                .iter()
                .filter_map(|(name, value)| value_to_json(value).map(|v| (name.to_string(), v)))
                .collect::<Map<_, _>>(),
        ),
    })
}

/// JSON の値を TOML に。表の並び（定型文など）は `[[…]]` の表の並びに、表は `[…]` の表にする。
/// 手で読み書きしやすい形にするため。null は TOML に無いので書かない（設定に null の値は無い）
fn to_item(value: &Value) -> Option<Item> {
    match value {
        Value::Array(rows) if !rows.is_empty() && rows.iter().all(Value::is_object) => {
            let mut tables = ArrayOfTables::new();
            for row in rows {
                tables.push(to_table(row.as_object()?));
            }
            Some(Item::ArrayOfTables(tables))
        }
        Value::Object(object) => Some(Item::Table(to_table(object))),
        _ => to_value(value).map(Item::Value),
    }
}

fn to_table(object: &Map<String, Value>) -> Table {
    let mut table = Table::new();
    for (name, value) in object {
        if let Some(item) = to_item(value) {
            table.insert(name, item);
        }
    }
    table
}

fn to_value(value: &Value) -> Option<toml_edit::Value> {
    Some(match value {
        Value::Null => return None,
        Value::Bool(flag) => (*flag).into(),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => integer.into(),
            None => number.as_f64()?.into(),
        },
        Value::String(text) => text.as_str().into(),
        Value::Array(items) => toml_edit::Value::Array(items.iter().filter_map(to_value).collect()),
        Value::Object(object) => toml_edit::Value::InlineTable(
            object
                .iter()
                .filter_map(|(name, value)| to_value(value).map(|v| (name.as_str(), v)))
                .collect(),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use serde_json::json;

    // Windows は symlink を張るのに権限が要るので、Unix だけで確かめる
    #[cfg(unix)]
    #[test]
    fn finds_a_link_whose_target_is_missing() {
        let dir = TempDir::new("settings-files-dangling");
        fs::write(dir.join("mawok.toml"), "").unwrap();
        std::os::unix::fs::symlink("mawok.toml", dir.join(SETTINGS)).unwrap();
        assert_eq!(unreachable_link(dir.path()), None);
        fs::remove_file(dir.join("mawok.toml")).unwrap();
        assert_eq!(
            unreachable_link(dir.path()),
            Some(Unreachable::Missing(dir.join("mawok.toml")))
        );
    }

    /// stow が張るような相対の symlink は、`..` を畳んだ先を無いものとして返す。画面にそのまま出すため
    #[cfg(unix)]
    #[test]
    fn names_the_normalized_target_of_a_relative_link() {
        let dir = TempDir::new("settings-files-relative-dangling");
        let settings_dir = dir.join("config/mawok");
        fs::create_dir_all(&settings_dir).unwrap();
        std::os::unix::fs::symlink(
            "../../dotfiles/mawok/settings.toml",
            settings_dir.join(SETTINGS),
        )
        .unwrap();
        assert_eq!(
            unreachable_link(&settings_dir),
            Some(Unreachable::Missing(
                dir.join("dotfiles/mawok/settings.toml")
            ))
        );
    }

    const ALL: Scope<'static> = Scope::All {
        set_aside_unreadable: false,
    };

    const MANAGED: &[&str] = &[
        key::HOTKEY,
        key::TEXT_WINDOW_KEYS,
        key::THEME,
        key::TEXT_FONT_SIZE,
        key::SNIPPETS,
        key::REPLACEMENTS,
    ];

    fn entries(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn round_trips_settings_rows_and_the_keys_of_this_os() {
        let dir = TempDir::new("settings-files-round-trip");
        let written = entries(&[
            ("hotkey", json!("CommandOrControl+Shift+KeyM")),
            (
                "text_window_keys",
                json!({ "copy": "CommandOrControl+KeyJ" }),
            ),
            ("theme", json!("dark")),
            ("text_font_size", json!(20)),
            (
                "snippets",
                json!([{ "name": "挨拶", "body": "お世話に\nなっております。", "enabled": true }]),
            ),
        ]);
        write(dir.path(), "macos", MANAGED, ALL, &written).unwrap();
        let read = read(dir.path(), "macos");
        assert!(read.unreadable.is_empty());
        assert_eq!(read.entries, written);
        // 定型文は別のファイルに、表の並びで書く。置き換え辞書は空なので作らない
        let snippets = fs::read_to_string(dir.path().join(SNIPPETS)).unwrap();
        assert!(snippets.contains("[[snippets]]"), "{snippets}");
        assert!(!dir.path().join(REPLACEMENTS).exists());
        // ほかの OS では、その OS の欄が無いので既定のまま
        let other = super::read(dir.path(), "windows");
        assert!(!other.entries.contains_key("hotkey"));
        assert!(!other.entries.contains_key("text_window_keys"));
    }

    #[test]
    fn keeps_comments_unknown_items_and_the_other_os_when_writing() {
        let dir = TempDir::new("settings-files-keeps");
        let text = "# 自分で書いたメモ\ntheme = \"dark\" # 夜に使う\nfrom_a_newer_version = true\n\n[hotkey]\nwindows = \"Control+Shift+Space\"\n";
        fs::write(dir.path().join(SETTINGS), text).unwrap();
        let next = entries(&[
            ("theme", json!("dark")),
            ("text_font_size", json!(20)),
            ("hotkey", json!("CommandOrControl+Shift+KeyM")),
        ]);
        write(dir.path(), "macos", MANAGED, ALL, &next).unwrap();
        let after = fs::read_to_string(dir.path().join(SETTINGS)).unwrap();
        assert!(after.contains("# 自分で書いたメモ"), "{after}");
        assert!(after.contains("theme = \"dark\" # 夜に使う"), "{after}");
        assert!(after.contains("from_a_newer_version = true"), "{after}");
        assert!(
            after.contains("windows = \"Control+Shift+Space\""),
            "{after}"
        );
        assert!(
            after.contains("macos = \"CommandOrControl+Shift+KeyM\""),
            "{after}"
        );
        // 既定に戻した項目は消す
        write(dir.path(), "macos", MANAGED, ALL, &entries(&[])).unwrap();
        let reset = fs::read_to_string(dir.path().join(SETTINGS)).unwrap();
        assert!(!reset.contains("theme"), "{reset}");
        assert!(!reset.contains("macos"), "{reset}");
        assert!(
            reset.contains("windows = \"Control+Shift+Space\""),
            "{reset}"
        );
    }

    #[test]
    fn keeps_the_other_os_of_an_inline_table_and_the_comments_of_untouched_rows() {
        let dir = TempDir::new("settings-files-inline");
        fs::write(
            dir.join(SETTINGS),
            "hotkey = { macos = \"Alt+Space\", windows = \"Control+Space\" }\n",
        )
        .unwrap();
        fs::write(
            dir.join(SNIPPETS),
            "# 挨拶\n[[snippets]]\nname = 'a'\nbody = 'b'\nenabled = true\n\n[[snippets]]\nname = 'c'\nbody = 'd'\nenabled = true\n",
        )
        .unwrap();
        let next = entries(&[
            ("hotkey", json!("Alt+KeyM")),
            (
                "snippets",
                json!([
                    { "name": "a", "body": "b", "enabled": true },
                    { "name": "c", "body": "d", "enabled": false }
                ]),
            ),
        ]);
        write(dir.path(), "macos", MANAGED, ALL, &next).unwrap();
        let settings = fs::read_to_string(dir.join(SETTINGS)).unwrap();
        assert!(
            settings.contains("windows = \"Control+Space\""),
            "{settings}"
        );
        assert!(settings.contains("macos = \"Alt+KeyM\""), "{settings}");
        let snippets = fs::read_to_string(dir.join(SNIPPETS)).unwrap();
        assert!(
            snippets.contains("# 挨拶\n[[snippets]]\nname = 'a'"),
            "{snippets}"
        );
        assert_eq!(read(dir.path(), "macos").entries, next);
    }

    #[test]
    fn keeps_the_comments_of_unchanged_keys_in_a_table() {
        let dir = TempDir::new("settings-files-changed-table");
        let before = "# よく使う\n[text_window_keys.macos]\ncopy = \"Mod+Enter\" # 手で決めた\npaste = \"Mod+KeyV\"\n";
        fs::write(dir.join(SETTINGS), before).unwrap();
        let next = entries(&[(
            "text_window_keys",
            json!({ "copy": "Mod+Enter", "paste": "Mod+KeyB" }),
        )]);
        write(dir.path(), "macos", MANAGED, ALL, &next).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(SETTINGS)).unwrap(),
            before.replace("Mod+KeyV", "Mod+KeyB")
        );
    }

    #[test]
    fn keeps_the_comments_of_a_changed_value() {
        let dir = TempDir::new("settings-files-changed-value");
        fs::write(
            dir.join(SETTINGS),
            "# 大きめにする\ntext_font_size = 20 # 会社の画面\n",
        )
        .unwrap();
        let next = entries(&[("text_font_size", json!(24))]);
        write(dir.path(), "macos", MANAGED, ALL, &next).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(SETTINGS)).unwrap(),
            "# 大きめにする\ntext_font_size = 24 # 会社の画面\n"
        );
    }

    #[test]
    fn keeps_rows_moved_or_written_without_defaults_and_an_untouched_inline_table() {
        let dir = TempDir::new("settings-files-rows");
        let settings = "hotkey = { windows = \"Control+Space\" } # 会社の PC\ntheme = \"dark\"\n";
        fs::write(dir.join(SETTINGS), settings).unwrap();
        let snippets = "# 挨拶\n[[snippets]]\nname = 'a'\nbody = 'b'\n\n# 署名\n[[snippets]]\nname = 'c'\nbody = 'd'\n";
        fs::write(dir.join(SNIPPETS), snippets).unwrap();
        // 読んだままの設定を書いても、どのファイルも書き換えない（`enabled` を省いた行も、既定の値で埋めて比べる）
        let read_back = read(dir.path(), "macos").entries;
        let mut same = read_back.clone();
        same.insert(
            "snippets".to_string(),
            json!([
                { "name": "a", "body": "b", "enabled": true },
                { "name": "c", "body": "d", "enabled": true }
            ]),
        );
        write(dir.path(), "macos", MANAGED, ALL, &same).unwrap();
        assert_eq!(fs::read_to_string(dir.join(SETTINGS)).unwrap(), settings);
        assert_eq!(fs::read_to_string(dir.join(SNIPPETS)).unwrap(), snippets);
        // 並べ替えても、行に付けたコメントは行と一緒に動く
        let mut moved = same.clone();
        moved.insert(
            "snippets".to_string(),
            json!([
                { "name": "c", "body": "d", "enabled": true },
                { "name": "a", "body": "b", "enabled": true }
            ]),
        );
        write(dir.path(), "macos", MANAGED, ALL, &moved).unwrap();
        let after = fs::read_to_string(dir.join(SNIPPETS)).unwrap();
        let (signature, greeting) = (after.find("# 署名").unwrap(), after.find("# 挨拶").unwrap());
        assert!(signature < greeting, "{after}");
        assert!(
            after.find("name = 'c'").unwrap() < after.find("name = 'a'").unwrap(),
            "{after}"
        );
        // この OS の値を変えても、1行の表の行末のコメントは残る
        let mut hotkey = moved.clone();
        hotkey.insert("hotkey".to_string(), json!("Alt+KeyM"));
        write(dir.path(), "macos", MANAGED, ALL, &hotkey).unwrap();
        let written = fs::read_to_string(dir.join(SETTINGS)).unwrap();
        assert!(
            written.starts_with(
                "hotkey = { windows = \"Control+Space\", macos = \"Alt+KeyM\" } # 会社の PC\n"
            ),
            "{written}"
        );
    }

    #[test]
    fn does_not_rewrite_unchanged_or_unreadable_files() {
        let dir = TempDir::new("settings-files-unreadable");
        let broken = "theme = \n";
        fs::write(dir.path().join(SETTINGS), broken).unwrap();
        let read = read(dir.path(), "macos");
        assert_eq!(read.unreadable.len(), 1);
        assert_eq!(read.unreadable[0].0, SETTINGS);
        let next = entries(&[
            ("theme", json!("dark")),
            (
                "snippets",
                json!([{ "name": "a", "body": "b", "enabled": true }]),
            ),
        ]);
        assert!(write(dir.path(), "macos", MANAGED, ALL, &next).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join(SETTINGS)).unwrap(),
            broken
        );
        // 読めるファイルは書く
        assert!(dir.path().join(SNIPPETS).exists());
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink() {
        let dir = TempDir::new("settings-files-symlink");
        let dotfiles = dir.path().join("dotfiles");
        let config = dir.path().join("config");
        fs::create_dir_all(&dotfiles).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::write(dotfiles.join(SETTINGS), "").unwrap();
        std::os::unix::fs::symlink(dotfiles.join(SETTINGS), config.join(SETTINGS)).unwrap();
        write(
            &config,
            "macos",
            MANAGED,
            ALL,
            &entries(&[("theme", json!("dark"))]),
        )
        .unwrap();
        assert!(fs::symlink_metadata(config.join(SETTINGS))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::read_to_string(dotfiles.join(SETTINGS))
            .unwrap()
            .contains("theme = \"dark\""));
    }

    /// 画面から 1 つ変えたときは、その項目だけを書く。ほかのデバイスから届いてまだ読み込んでいない変更と、
    /// 読めずに読み飛ばした値・キー・行を、メモリの内容で消さない
    #[test]
    fn writes_only_the_changed_items_and_keeps_what_was_not_read() {
        let dir = TempDir::new("settings-files-changed-only");
        // 読んだ後に、ほかのデバイスが theme を変え、新しい版が足した値・キー・行がある
        fs::write(
            dir.join(SETTINGS),
            "theme = \"light\"\npunctuation_style = \"from_a_newer_version\"\n\n[text_window_keys.macos]\ncopy = \"Mod+KeyJ\"\nnew_action = \"Mod+KeyN\"\n",
        )
        .unwrap();
        fs::write(
            dir.join(SNIPPETS),
            "[[snippets]]\nname = 'a'\nbody = 'b'\n\n[[snippets]]\nname = 'from_a_newer_version'\nbody = 1\n\n[[snippets]]\nname = 'c'\nbody = 'd'\n",
        )
        .unwrap();
        let before = entries(&[
            ("theme", json!("dark")),
            ("text_window_keys", json!({ "copy": "Mod+KeyJ" })),
            (
                "snippets",
                json!([
                    { "name": "a", "body": "b", "enabled": true },
                    { "name": "c", "body": "d", "enabled": true }
                ]),
            ),
        ]);
        // 文字の大きさだけを変える
        let mut next = before.clone();
        next.insert("text_font_size".to_string(), json!(20));
        write(dir.path(), "macos", MANAGED, Scope::Changed(&before), &next).unwrap();
        let settings = fs::read_to_string(dir.join(SETTINGS)).unwrap();
        assert!(settings.contains("theme = \"light\""), "{settings}");
        assert!(settings.contains("from_a_newer_version"), "{settings}");
        assert!(settings.contains("new_action"), "{settings}");
        assert!(settings.contains("text_font_size = 20"), "{settings}");

        // キー操作を既定に戻しても、知らない操作は残す
        let mut keys = next.clone();
        keys.remove("text_window_keys");
        write(dir.path(), "macos", MANAGED, Scope::Changed(&next), &keys).unwrap();
        let settings = fs::read_to_string(dir.join(SETTINGS)).unwrap();
        assert!(!settings.contains("copy ="), "{settings}");
        assert!(settings.contains("new_action = \"Mod+KeyN\""), "{settings}");

        // 行を並べ替え・1 行消しても、読めない行は元の位置に残す
        let mut rows = keys.clone();
        rows.insert(
            "snippets".to_string(),
            json!([{ "name": "c", "body": "d", "enabled": true }]),
        );
        write(dir.path(), "macos", MANAGED, Scope::Changed(&keys), &rows).unwrap();
        let snippets = fs::read_to_string(dir.join(SNIPPETS)).unwrap();
        assert!(!snippets.contains("name = 'a'"), "{snippets}");
        assert!(
            snippets.find("from_a_newer_version").unwrap() < snippets.find("name = 'c'").unwrap(),
            "{snippets}"
        );
        // 全部消しても、読めない行は残す
        let mut none = rows.clone();
        none.remove("snippets");
        write(dir.path(), "macos", MANAGED, Scope::Changed(&rows), &none).unwrap();
        let snippets = fs::read_to_string(dir.join(SNIPPETS)).unwrap();
        assert!(snippets.contains("from_a_newer_version"), "{snippets}");
        assert!(!snippets.contains("name = 'c'"), "{snippets}");
    }

    /// 読めないファイルがあっても、変えた項目がほかのファイルにあれば書けたとして返す
    #[test]
    fn fails_only_when_a_changed_item_is_in_an_unreadable_file() {
        let dir = TempDir::new("settings-files-unreadable-other");
        fs::write(dir.join(SNIPPETS), "[[snippets]\n").unwrap();
        let before = entries(&[]);
        let theme = entries(&[("theme", json!("dark"))]);
        write(
            dir.path(),
            "macos",
            MANAGED,
            Scope::Changed(&before),
            &theme,
        )
        .unwrap();
        assert!(fs::read_to_string(dir.join(SETTINGS))
            .unwrap()
            .contains("theme"));
        let mut snippets = theme.clone();
        snippets.insert(
            "snippets".to_string(),
            json!([{ "name": "a", "body": "b", "enabled": true }]),
        );
        assert!(write(
            dir.path(),
            "macos",
            MANAGED,
            Scope::Changed(&theme),
            &snippets
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(dir.join(SNIPPETS)).unwrap(),
            "[[snippets]\n"
        );
    }

    /// バックアップから戻すときは、読めないファイルを写して除けてから書き直す
    #[test]
    fn sets_aside_unreadable_files_when_restoring() {
        let dir = TempDir::new("settings-files-restore");
        fs::write(dir.join(SNIPPETS), "[[snippets]\n").unwrap();
        let restored = entries(&[(
            "snippets",
            json!([{ "name": "a", "body": "b", "enabled": true }]),
        )]);
        write(
            dir.path(),
            "macos",
            MANAGED,
            Scope::All {
                set_aside_unreadable: true,
            },
            &restored,
        )
        .unwrap();
        assert_eq!(read(dir.path(), "macos").entries, restored);
        let set_aside = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("snippets.broken-")
            });
        assert!(set_aside);
    }

    #[test]
    fn names_only_the_line_and_column_of_an_unreadable_file() {
        let dir = TempDir::new("settings-files-parse-error");
        fs::write(
            dir.join(SNIPPETS),
            "[[snippets]]\nname = 'a'\nbody = 'secret text\n",
        )
        .unwrap();
        let read = read(dir.path(), "macos");
        let (_, error) = &read.unreadable[0];
        assert!(error.starts_with("line 3, column "), "{error}");
        assert!(!error.contains("secret"), "{error}");
    }

    /// 1行の表で書いたキー操作も、知らない操作を残す
    #[test]
    fn keeps_unknown_keys_of_an_inline_table_when_writing_changes() {
        let dir = TempDir::new("settings-files-inline-keys");
        fs::write(
            dir.join(SETTINGS),
            "[text_window_keys]\nmacos = { copy = \"Mod+KeyJ\", new_action = \"Mod+KeyN\" }\n",
        )
        .unwrap();
        let before = entries(&[("text_window_keys", json!({ "copy": "Mod+KeyJ" }))]);
        let next = entries(&[("text_window_keys", json!({ "copy": "Mod+KeyK" }))]);
        write(dir.path(), "macos", MANAGED, Scope::Changed(&before), &next).unwrap();
        let settings = fs::read_to_string(dir.join(SETTINGS)).unwrap();
        assert!(settings.contains("copy = \"Mod+KeyK\""), "{settings}");
        assert!(settings.contains("new_action = \"Mod+KeyN\""), "{settings}");
        write(
            dir.path(),
            "macos",
            MANAGED,
            Scope::Changed(&next),
            &entries(&[]),
        )
        .unwrap();
        let settings = fs::read_to_string(dir.join(SETTINGS)).unwrap();
        assert!(!settings.contains("copy"), "{settings}");
        assert!(settings.contains("new_action = \"Mod+KeyN\""), "{settings}");
    }
}
