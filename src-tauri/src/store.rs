//! 設定の置き場（SQLite）。設定・同期の oplog・同期の記録を1つのファイルに置き、同じトランザクションで書く（docs/config.md）

use std::{collections::BTreeMap, path::Path};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const FILE_NAME: &str = "settings.db";
/// 表の形の版。形を変えたら上げ、`open` で前の版の形から移す
const SCHEMA_VERSION: i64 = 1;
const SYNC_STATE: &str = "sync_state";

pub struct Store {
    connection: Connection,
}

/// 置き場を開けなかった理由
#[derive(Debug)]
pub struct OpenError {
    /// ファイルが SQLite のものでないか、壊れている。作り直すしかない。ほかの失敗（ロック・権限・入出力）は、
    /// 時間をおけば開けることがあるので、ファイルに手を付けない
    pub broken: bool,
    pub message: String,
}

impl From<rusqlite::Error> for OpenError {
    fn from(error: rusqlite::Error) -> Self {
        Self {
            broken: matches!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt)
            ),
            message: error.to_string(),
        }
    }
}

/// 1回のトランザクションで書くもの。書かないものは既定のまま（None・空）にする
#[derive(Default)]
pub struct Commit<'a> {
    /// 設定の項目の全体（既定と違う値だけ）。置き換える
    pub entries: Option<&'a BTreeMap<String, Value>>,
    /// 手元で変えた同期の項目と、変えた時刻（UNIX のミリ秒）。oplog に積む
    pub changed: Vec<(String, u64)>,
    /// 窓口と揃った同期の項目と、揃えたときに見ていた oplog の時刻。それより後にまた変えていなければ、oplog から外す
    pub settled: Vec<(String, u64)>,
    /// 同期の記録（JSON）。`Some(None)` で消す
    pub sync_state: Option<Option<&'a str>>,
}

impl Store {
    /// 開く。無ければ作る。設定の項目を読み通せるかまで確かめる
    pub fn open(path: &Path) -> Result<Self, OpenError> {
        let store = Self::init(Connection::open(path)?)?;
        store
            .connection
            .prepare("SELECT name, value FROM settings")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .try_for_each(|row| row.map(|_| ()))?;
        Ok(store)
    }

    /// 置き場を作れないときと、テストで使う。中身はアプリを終えると消える
    pub fn in_memory() -> Self {
        Self::init(Connection::open_in_memory().expect("an in-memory database opens"))
            .expect("an in-memory database initializes")
    }

    fn init(connection: Connection) -> rusqlite::Result<Self> {
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version == 0 {
            connection
                .execute_batch(
                    "BEGIN;
                     CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
                     CREATE TABLE IF NOT EXISTS sync_outbox (name TEXT PRIMARY KEY, changed_at INTEGER NOT NULL) WITHOUT ROWID;
                     CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
                     PRAGMA user_version = 1;
                     COMMIT;",
                )?;
        } else if version > SCHEMA_VERSION {
            // 新しい版が足した表や列は、この版では読まずに残す。項目の値の読み方は、知らない項目を読み飛ばすので変わらない
            log::info!("settings database version {version} is newer than {SCHEMA_VERSION}");
        }
        Ok(Self { connection })
    }

    /// 設定の項目。JSON として読めない値は読み飛ばし、ログにだけ出す
    pub fn entries(&self) -> Result<BTreeMap<String, Value>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT name, value FROM settings")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut entries = BTreeMap::new();
        for row in rows {
            let (name, value) = row.map_err(|error| error.to_string())?;
            match serde_json::from_str(&value) {
                Ok(value) => {
                    entries.insert(name, value);
                }
                Err(error) => log::warn!("ignored an unreadable setting {name}: {error}"),
            }
        }
        Ok(entries)
    }

    /// まだ窓口へ送っていない、手元で変えた同期の項目と、最後に変えた時刻
    pub fn outbox(&self) -> Result<BTreeMap<String, u64>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT name, changed_at FROM sync_outbox")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            row.map(|(name, at)| (name, u64::try_from(at).unwrap_or_default()))
                .map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn sync_state(&self) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT value FROM meta WHERE name = ?1",
                [SYNC_STATE],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn commit(&mut self, commit: &Commit<'_>) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let error = |error: rusqlite::Error| error.to_string();
        if let Some(entries) = commit.entries {
            transaction
                .execute("DELETE FROM settings", [])
                .map_err(error)?;
            for (name, value) in entries {
                transaction
                    .execute(
                        "INSERT INTO settings (name, value) VALUES (?1, ?2)",
                        params![name, value.to_string()],
                    )
                    .map_err(error)?;
            }
        }
        for (name, at) in &commit.changed {
            transaction
                .execute(
                    "INSERT INTO sync_outbox (name, changed_at) VALUES (?1, ?2)
                     ON CONFLICT (name) DO UPDATE SET changed_at = max(changed_at, excluded.changed_at)",
                    params![name, to_sql(*at)],
                )
                .map_err(error)?;
        }
        for (name, at) in &commit.settled {
            transaction
                .execute(
                    "DELETE FROM sync_outbox WHERE name = ?1 AND changed_at <= ?2",
                    params![name, to_sql(*at)],
                )
                .map_err(error)?;
        }
        match commit.sync_state {
            Some(Some(state)) => {
                transaction
                    .execute(
                        "INSERT INTO meta (name, value) VALUES (?1, ?2)
                         ON CONFLICT (name) DO UPDATE SET value = excluded.value",
                        params![SYNC_STATE, state],
                    )
                    .map_err(error)?;
            }
            Some(None) => {
                transaction
                    .execute("DELETE FROM meta WHERE name = ?1", [SYNC_STATE])
                    .map_err(error)?;
            }
            None => {}
        }
        transaction.commit().map_err(error)
    }
}

/// 置き場を作り直す前に、SQLite がファイルの横に置く書きかけの記録を消す。残すと、新しいファイルの書きかけとして
/// 当て直され、作り直したファイルを壊す
pub fn remove_side_files(path: &Path) -> std::io::Result<()> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut side = path.as_os_str().to_owned();
        side.push(suffix);
        match std::fs::remove_file(side) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

fn to_sql(at: u64) -> i64 {
    i64::try_from(at).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entries(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn replaces_the_entries_and_keeps_them_across_opening() {
        let dir = crate::test_support::TempDir::new("store-entries");
        let path = dir.join(FILE_NAME);
        let mut store = Store::open(&path).unwrap();
        let first = entries(&[("theme", json!("dark")), ("language", json!("ja"))]);
        store
            .commit(&Commit {
                entries: Some(&first),
                ..Commit::default()
            })
            .unwrap();
        let second = entries(&[("theme", json!("light"))]);
        store
            .commit(&Commit {
                entries: Some(&second),
                ..Commit::default()
            })
            .unwrap();
        drop(store);
        assert_eq!(Store::open(&path).unwrap().entries().unwrap(), second);
    }

    #[test]
    fn keeps_the_latest_change_and_settles_only_what_was_seen() {
        let mut store = Store::in_memory();
        let changed = |name: &str, at| Commit {
            changed: vec![(name.to_string(), at)],
            ..Commit::default()
        };
        store.commit(&changed("s_theme", 20)).unwrap();
        // 時計が戻っても、後で変えた記録を前の時刻で上書きしない
        store.commit(&changed("s_theme", 10)).unwrap();
        store.commit(&changed("s_language", 5)).unwrap();
        assert_eq!(
            store.outbox().unwrap(),
            BTreeMap::from([("s_language".to_string(), 5), ("s_theme".to_string(), 20)])
        );
        // 送った後にまた変えた項目は、送った時刻で外さない
        store
            .commit(&Commit {
                settled: vec![("s_theme".to_string(), 19), ("s_language".to_string(), 5)],
                ..Commit::default()
            })
            .unwrap();
        assert_eq!(
            store.outbox().unwrap(),
            BTreeMap::from([("s_theme".to_string(), 20)])
        );
    }

    #[test]
    fn stores_and_clears_the_sync_state() {
        let mut store = Store::in_memory();
        assert_eq!(store.sync_state().unwrap(), None);
        store
            .commit(&Commit {
                sync_state: Some(Some("{\"since\":3}")),
                ..Commit::default()
            })
            .unwrap();
        assert_eq!(
            store.sync_state().unwrap().as_deref(),
            Some("{\"since\":3}")
        );
        store
            .commit(&Commit {
                sync_state: Some(None),
                ..Commit::default()
            })
            .unwrap();
        assert_eq!(store.sync_state().unwrap(), None);
    }

    #[test]
    fn refuses_a_file_that_is_not_a_database() {
        let dir = crate::test_support::TempDir::new("store-broken");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "not a database").unwrap();
        assert!(Store::open(&path).is_err_and(|error| error.broken));
    }
}
