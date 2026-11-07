//! 設定のファイル（docs/config.md「ファイル」）。設定・定型文・置き換え辞書を、置き場の TOML のファイルに読み書きする。
//! 画面から書くときは、手で書いたコメント・並び・知らない項目を残し、変えた項目だけを書き換える

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::{Map, Number, Value};
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table};

use crate::{atomic_file, config::key};

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

/// 項目を置き場のファイルに書く。`managed` は、このアプリが書く項目名（ほかの名前は、新しい版が書いた項目や
/// 手で書いたものとして残す）。中身が変わらないファイルは書かない。ほかのデバイスで同期しているときに、
/// 変えていないファイルまで書き換えて衝突のもとにしないため。
/// 読めないファイルは書き換えない（手で書きかけのものを、画面からの変更で消さないため）。そのときは
/// `SETTINGS_FILE_UNREADABLE` の符号を返す（読めるファイルの分は書く）
pub fn write(
    dir: &Path,
    os: &str,
    managed: &[&str],
    entries: &BTreeMap<String, Value>,
) -> Result<(), String> {
    let mut unreadable = Vec::new();
    for name in FILE_NAMES {
        let path = dir.join(name);
        let before = match fs::read_to_string(target(&path)) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("{name}: {error}")),
        };
        let mut document = match before.as_deref().map(str::parse::<DocumentMut>) {
            Some(Ok(document)) => document,
            Some(Err(_)) => {
                unreadable.push(name);
                continue;
            }
            None => DocumentMut::new(),
        };
        match name {
            SETTINGS => update_settings(&mut document, os, managed, entries),
            _ => {
                let (item_name, _) = ROW_FILES
                    .into_iter()
                    .find(|(_, file)| *file == name)
                    .expect("a row file");
                set_or_remove(document.as_table_mut(), item_name, entries.get(item_name));
            }
        }
        let after = document.to_string();
        if before.as_deref() == Some(after.as_str())
            || (before.is_none() && after.trim().is_empty())
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

/// 先のファイルが無い symlink の、先のパス（dotfiles でそのファイルの無いブランチに切り替えた間など）。
/// 置き場が無いときと同じく扱う（docs/config.md「置き場」）。既定の値で読み直したり、symlink を普通のファイルに置き換えて
/// 書いたりしないため
pub fn dangling_link_target(dir: &Path) -> Option<PathBuf> {
    FILE_NAMES.iter().find_map(|name| {
        let path = dir.join(name);
        let is_link = fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink());
        if !is_link || path.exists() {
            return None;
        }
        Some(dir.join(fs::read_link(&path).ok()?))
    })
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
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn is_row_item(name: &str) -> bool {
    ROW_FILES.iter().any(|(item_name, _)| *item_name == name)
}

fn update_settings(
    document: &mut DocumentMut,
    os: &str,
    managed: &[&str],
    entries: &BTreeMap<String, Value>,
) {
    let table = document.as_table_mut();
    for &name in managed {
        if is_row_item(name) {
            continue;
        }
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
            let before = existing.and_then(to_json);
            set_or_remove(&mut per_os, os, entries.get(name));
            // この OS の値が変わらなければ、書き方（1行の表・コメント・位置）を残すため触らない
            if before == Some(table_to_json(per_os.iter())) {
                continue;
            }
            if per_os.is_empty() {
                table.remove(name);
            } else if inline {
                // 元の1行の表をその場で書き換える。入れ替えると、行末のコメントと空白（値の装飾）が消えるため
                let value = entries.get(name).and_then(to_value);
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
            set_or_remove(table, name, entries.get(name));
        }
    }
}

/// 値を入れる。同じ値が書いてあれば、書き方（コメント・引用符の種類など）を残すため触らない。値が無ければ消す
fn set_or_remove(table: &mut Table, name: &str, value: Option<&Value>) {
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
        if !rows.is_empty() && rows.iter().all(Value::is_object) {
            update_rows(name, tables, rows);
            return;
        }
    }
    if let Some(item) = to_item(value) {
        table.insert(name, item);
    }
}

/// 行の並びを書き換える。中身が同じ行は、元の表（前に付けたコメント・書き方・知らない項目）をそのまま使い、
/// 位置が変わっても書き直さない。同じ位置で中身の変わった行は、元の表の値だけを書き換えて、コメントと知らない項目を残す。
/// 比べるときは、書いていない項目を既定の値で埋める（`enabled` を省いた手書きの行を、毎回書き直さないため）
fn update_rows(item_name: &str, tables: &mut ArrayOfTables, rows: &[Value]) {
    let existing: Vec<Table> = tables.iter().cloned().collect();
    let normalized: Vec<Option<Value>> = existing
        .iter()
        .map(|table| crate::config::normalized_row(item_name, &table_to_json(table.iter())))
        .collect();
    let mut used = vec![false; existing.len()];
    let mut next = ArrayOfTables::new();
    for (index, row) in rows.iter().enumerate() {
        let Some(object) = row.as_object() else {
            continue;
        };
        let wanted = crate::config::normalized_row(item_name, row);
        let same = (0..existing.len())
            .find(|&at| !used[at] && wanted.is_some() && normalized[at] == wanted);
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
                let mut table = existing[index].clone();
                for (name, value) in object {
                    set_or_remove(&mut table, name, Some(value));
                }
                table
            }
            None => to_table(object),
        };
        next.push(table);
    }
    // 表は、並びでなく文書の中の位置で書き出されるので、新しい並びの順に位置を振り直す
    let base = existing
        .iter()
        .filter_map(Table::position)
        .min()
        .unwrap_or(0);
    for (index, table) in next.iter_mut().enumerate() {
        table.set_position(Some(base + index as isize));
    }
    *tables = next;
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

    // Windows は symlink を張るのに権限が要るので、Unix だけで確かめる
    #[cfg(unix)]
    #[test]
    fn finds_a_link_whose_target_is_missing() {
        let dir = TempDir::new("settings-files-dangling");
        fs::write(dir.join("mawok.toml"), "").unwrap();
        std::os::unix::fs::symlink("mawok.toml", dir.join(SETTINGS)).unwrap();
        assert_eq!(dangling_link_target(dir.path()), None);
        fs::remove_file(dir.join("mawok.toml")).unwrap();
        assert_eq!(
            dangling_link_target(dir.path()),
            Some(dir.join("mawok.toml"))
        );
    }
    use serde_json::json;

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
        write(dir.path(), "macos", MANAGED, &written).unwrap();
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
        write(dir.path(), "macos", MANAGED, &next).unwrap();
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
        write(dir.path(), "macos", MANAGED, &entries(&[])).unwrap();
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
        write(dir.path(), "macos", MANAGED, &next).unwrap();
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
        write(dir.path(), "macos", MANAGED, &same).unwrap();
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
        write(dir.path(), "macos", MANAGED, &moved).unwrap();
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
        write(dir.path(), "macos", MANAGED, &hotkey).unwrap();
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
        assert!(write(dir.path(), "macos", MANAGED, &next).is_err());
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
}
