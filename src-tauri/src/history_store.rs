//! テキストウィンドウの履歴を、設定の置き場の `history/<デバイス>.json` に保存する処理と、ほかのデバイスの履歴との混ぜ方
//! （docs/config.md「履歴」）。各デバイスは自分のファイルだけを書き、読むときにすべてのファイルを混ぜる

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};

use crate::atomic_file;

/// 設定の置き場の中で、履歴のファイルを置くフォルダー
pub const DIR_NAME: &str = "history";
const VERSION: u8 = 1;
/// 混ぜた履歴の件数の上限。どのデバイスの件数の設定も、これより多くはできない
pub const MAX_MERGED_ENTRIES: usize = crate::config::MAX_DRAFT_HISTORY_SIZE as usize;

/// 履歴の1件（docs/config.md「履歴」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub text: String,
    /// 覚えた時刻。UNIX のミリ秒
    pub at: u64,
}

/// 履歴の全体。1つのデバイスのファイルの中身で、`entries` は古い順
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub entries: Vec<Entry>,
    /// 履歴を消した時刻。消していなければ 0
    pub cleared_at: u64,
    /// 1件ずつ消した本文と、消した時刻。その時刻までに覚えた同じ本文を、どのデバイスの分も見せない。
    /// 消した時刻を残さないと、ほかのデバイスのファイルから同じ本文が戻るため
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<Entry>,
}

impl History {
    pub fn texts(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.text.clone())
            .collect()
    }

    /// 新しい方から `max_entries` 件を残す。
    pub fn truncated(mut self, max_entries: usize) -> Self {
        self.entries = truncate(self.entries, max_entries);
        self
    }

    /// 画面が持つ一覧（古い順の本文）に、時刻を付ける。画面は本文しか持たないので、前に保存した履歴と照らす。
    /// 画面の一覧は、古い方から忘れ、新しい方へ足すことでしか変わらない。前の履歴の末尾と、一覧の先頭が重なる
    /// いちばん長い所を引き続きある本文とみて前の時刻を保ち、その後ろを新しく覚えた本文として今の時刻を付ける。
    /// 本文が同じかどうかだけで照らすと、前にも覚えた本文をもう一度覚えたときに、古い時刻が付く。
    pub fn restamped(&self, texts: Vec<String>, now: u64) -> Self {
        let kept = (0..=self.entries.len().min(texts.len()))
            .rev()
            .find(|&kept| {
                self.entries[self.entries.len() - kept..]
                    .iter()
                    .zip(&texts)
                    .all(|(entry, text)| entry.text == *text)
            })
            .unwrap_or(0);
        let mut entries = self.entries[self.entries.len() - kept..].to_vec();
        // 新しく覚えた本文は、消した時刻より後で、引き続きある本文より後にする。時計が戻っていても、
        // 消したはずの履歴として落ちたり、並びが入れ替わったりしないため。同じ回に覚えた本文も、1 ずつずらして順を保つ
        let mut at = now
            .max(self.cleared_at.saturating_add(1))
            .max(entries.last().map_or(0, |entry| entry.at.saturating_add(1)))
            .max(
                self.deleted
                    .iter()
                    .map(|deleted| deleted.at.saturating_add(1))
                    .max()
                    .unwrap_or(0),
            );
        for text in texts.into_iter().skip(kept) {
            entries.push(Entry { text, at });
            at = at.saturating_add(1);
        }
        Self {
            entries,
            cleared_at: self.cleared_at,
            deleted: self.deleted.clone(),
        }
    }

    /// 1件を消した後の形。同じ本文はすべて消し、消した時刻を残す。消した時刻は、消す本文を覚えた時刻より前にしない
    /// （時計が戻っていると、消した本文がほかのデバイスから戻るため）
    pub fn without(&self, text: &str, now: u64) -> Self {
        let newest = self
            .entries
            .iter()
            .filter(|entry| entry.text == text)
            .map(|entry| entry.at)
            .max()
            .unwrap_or(0);
        let mut deleted = self.deleted.clone();
        deleted.push(Entry {
            text: text.to_string(),
            at: now.max(newest),
        });
        Self {
            entries: self
                .entries
                .iter()
                .filter(|entry| entry.text != text)
                .cloned()
                .collect(),
            cleared_at: self.cleared_at,
            deleted: merge_deleted(&deleted, &[], self.cleared_at),
        }
    }

    /// 履歴を消した後の形。消した時刻は、今ある履歴のどれよりも前にならないようにする
    /// （時計が戻っていると、消した履歴がほかのデバイスから戻るため）。
    pub fn cleared(&self, now: u64) -> Self {
        let newest = self.entries.iter().map(|entry| entry.at).max().unwrap_or(0);
        // 1件ずつ消した記録は、消した時刻より前のものしか無いので要らない
        Self {
            entries: Vec::new(),
            cleared_at: now.max(self.cleared_at).max(newest),
            deleted: Vec::new(),
        }
    }
}

/// 2つのデバイスの履歴を混ぜる（docs/config.md「履歴」）。件数は `MAX_MERGED_ENTRIES` までで、
/// デバイスの件数には切り詰めない。結果は、どちらを先に渡したかに依らない。依ると、同じ時刻の履歴の順や
/// 切り詰めで落とす履歴がデバイスごとに違う
pub fn merge(local: &History, remote: &History) -> History {
    let cleared_at = local.cleared_at.max(remote.cleared_at);
    let deleted = merge_deleted(&local.deleted, &remote.deleted, cleared_at);
    let deleted_at: HashMap<&str, u64> = deleted
        .iter()
        .map(|entry| (entry.text.as_str(), entry.at))
        .collect();
    let mut newest: HashMap<&str, u64> = HashMap::new();
    for entry in local.entries.iter().chain(&remote.entries) {
        let at = newest.entry(&entry.text).or_insert(entry.at);
        *at = (*at).max(entry.at);
    }
    let mut entries: Vec<Entry> = newest
        .into_iter()
        .filter(|(text, at)| {
            *at > cleared_at && deleted_at.get(text).is_none_or(|deleted| at > deleted)
        })
        .map(|(text, at)| Entry {
            text: text.to_string(),
            at,
        })
        .collect();
    entries.sort_by(|a, b| (a.at, &a.text).cmp(&(b.at, &b.text)));
    History {
        entries,
        cleared_at,
        deleted,
    }
    .truncated(MAX_MERGED_ENTRIES)
}

/// 1件ずつ消した記録を合わせる。同じ本文は消した時刻の新しい方を残し、履歴を消した時刻までのものは落とす
/// （それより前に覚えた本文は、履歴を消した時刻で見せなくなっている）。並びは本文の順で、渡す順に依らない
fn merge_deleted(local: &[Entry], remote: &[Entry], cleared_at: u64) -> Vec<Entry> {
    let mut newest: HashMap<&str, u64> = HashMap::new();
    for entry in local.iter().chain(remote) {
        let at = newest.entry(&entry.text).or_insert(entry.at);
        *at = (*at).max(entry.at);
    }
    let mut deleted: Vec<Entry> = newest
        .into_iter()
        .filter(|(_, at)| *at > cleared_at)
        .map(|(text, at)| Entry {
            text: text.to_string(),
            at,
        })
        .collect();
    deleted.sort_by(|a, b| a.text.cmp(&b.text));
    deleted
}

/// 画面が持つ履歴の写し。ほかのデバイスの履歴を混ぜてファイルを入れ替えてから、画面が読み直すまでの間だけ、ファイルと違う。
/// その間に画面から届く保存は、入れ替える前の一覧を元にしている。今のファイルと照らして時刻を付けると、
/// ほかのデバイスの履歴を混ぜた一覧を、画面の古い一覧で上書きするので、この写しと照らす。
#[derive(Debug, Default)]
pub struct ScreenCopy {
    /// 画面がまだ読み直していない入れ替えがあるときの、画面が持つ履歴
    stale: Option<History>,
}

impl ScreenCopy {
    pub const fn new() -> Self {
        Self { stale: None }
    }

    /// 画面が今のファイルと同じ履歴を持った（読み込んだ・消した）。
    pub fn caught_up(&mut self) {
        self.stale = None;
    }

    /// ファイルが、画面の持つ履歴と違うものになった（ほかのデバイスの履歴を混ぜて入れ替えた・置き場が無い間に空の一覧を渡した・
    /// 置き場を替えた）。`before` は画面が持つ履歴。先の入れ替えを画面がまだ読み直していなければ、画面が持つのはそのときの履歴のまま
    pub fn replaced_by_other_devices(&mut self, before: History) {
        self.stale.get_or_insert(before);
    }

    /// 画面から届いた一覧（古い順の本文）を、保存する履歴にする。`file` は今のファイル。
    pub fn saved(
        &mut self,
        file: &History,
        texts: Vec<String>,
        max_entries: usize,
        now: u64,
    ) -> History {
        let Some(mut seen) = self.stale.take() else {
            return file.restamped(texts, now);
        };
        // 消した時刻は今のファイルに合わせる。画面が持つ履歴の消した時刻は、混ぜて替える前のもの。
        // 新しく覚えた本文は、届いた履歴と消した時刻より後にする。ほかのデバイスの時計が進んでいても、
        // 今覚えた本文が、消したはずの履歴として落ちたり、届いた履歴より古い方へ入ったりしないため
        seen.cleared_at = file.cleared_at;
        // 1件ずつ消した記録も今のファイルに合わせる。新しく覚えた本文を、ほかのデバイスで消した時刻より後にするため
        seen.deleted = file.deleted.clone();
        let newest = file.entries.last().map_or(0, |entry| entry.at);
        let seen = seen.restamped(texts, now.max(newest.saturating_add(1)));
        let next = merge(&seen, file).truncated(max_entries);
        self.stale = Some(seen);
        next
    }
}

#[derive(Deserialize)]
struct Versioned {
    version: u8,
}

#[derive(Serialize, Deserialize)]
struct FileFormat {
    version: u8,
    #[serde(flatten)]
    history: History,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadProblem {
    InvalidJson,
    UnknownVersion,
    InvalidShape,
}

impl std::fmt::Display for ReadProblem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidJson => "invalid JSON",
            Self::UnknownVersion => "unknown version",
            Self::InvalidShape => "invalid data shape",
        })
    }
}

fn read_json<'a, T: Deserialize<'a>>(text: &'a str) -> Result<T, ReadProblem> {
    serde_json::from_str(text).map_err(|error| {
        if error.is_data() {
            ReadProblem::InvalidShape
        } else {
            ReadProblem::InvalidJson
        }
    })
}

/// JSON の本文を読む
pub fn parse(text: &str) -> Result<History, ReadProblem> {
    match read_json::<Versioned>(text)?.version {
        VERSION => Ok(read_json::<FileFormat>(text)?.history),
        _ => Err(ReadProblem::UnknownVersion),
    }
}

/// 履歴を保存用の JSON にする。
pub fn format(history: &History) -> String {
    serde_json::to_string(&FileFormat {
        version: VERSION,
        history: history.clone(),
    })
    .expect("history entries are serializable")
}

/// 古い順の一覧から、新しい方の `max_entries` 件を残す
pub fn truncate<T>(mut entries: Vec<T>, max_entries: usize) -> Vec<T> {
    if entries.len() > max_entries {
        entries.drain(..entries.len() - max_entries);
    }
    entries
}

/// ファイルがなければ空を返す。ほかの読み込み失敗は理由の種類だけを返す
pub fn load(path: &Path) -> Result<History, LoadError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(History::default()),
        // 文字コードが壊れたファイルも、書き方の壊れたファイルと同じく、写して退けられるようにする
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            return Err(LoadError::Invalid(ReadProblem::InvalidJson))
        }
        Err(error) => return Err(LoadError::Io(error.kind())),
    };
    parse(&text).map_err(LoadError::Invalid)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadError {
    Invalid(ReadProblem),
    Io(io::ErrorKind),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(problem) => problem.fmt(formatter),
            Self::Io(kind) => write!(formatter, "I/O error ({kind:?})"),
        }
    }
}

/// このデバイスのファイル（`own`）と、同じフォルダーのほかのデバイスのファイルを混ぜた履歴。
/// このデバイスのファイルが読めなければ、その理由を返す（呼ぶ側が写して退ける）。ほかのデバイスのファイルは、
/// 読めなければログに出して飛ばす。書きかけを読んだだけのことがあり、ほかのデバイスのファイルには手を付けないため
pub fn load_merged(own: &Path) -> Result<History, LoadError> {
    let mut merged = load(own)?;
    let Some(dir) = own.parent() else {
        return Ok(merged);
    };
    let others = match fs::read_dir(dir) {
        Ok(others) => others,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(merged),
        Err(error) => {
            log::warn!("couldn't list the draft history of the other devices: {error}");
            return Ok(merged);
        }
    };
    for other in others.flatten() {
        let path = other.path();
        if path == own || !is_device_file(&path) {
            continue;
        }
        match load_other(&path) {
            Ok(history) => merged = merge(&merged, &history),
            Err(error) => log::info!(
                "skipped the draft history {}: {error}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ),
        }
    }
    Ok(merged)
}

/// デバイスの履歴のファイルか。読めなかった履歴の写し（`<名前>.broken-….json`。set_aside）は、混ぜずに残す
pub fn is_device_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "json")
        && path
            .file_stem()
            .is_some_and(|stem| !stem.to_string_lossy().contains(".broken-"))
}

/// ほかのデバイスのファイルを読む
fn load_other(path: &Path) -> Result<History, LoadError> {
    let text = fs::read_to_string(path).map_err(|error| LoadError::Io(error.kind()))?;
    parse(&text).map_err(LoadError::Invalid)
}

/// 一時ファイルへ書いてから差し替える。unix では履歴本文を所有者だけが
/// 読めるようにする。履歴も消した時刻も無ければ、空のファイルを作らず、無い状態にする。
pub fn save(path: &Path, history: &History) -> io::Result<()> {
    if *history == History::default() {
        return atomic_file::remove(path);
    }
    atomic_file::write_private(path, format(history).as_bytes())
}

/// 読めなかった履歴を同じフォルダーの `<名前>.broken-YYYYMMDD-HHMMSS.json` へ写してから消す。
/// 空で始めると次のコピーで上書きするので、先に写す。元を残すと、コピーせずに起動し直すたびに
/// 同じ中身の写しが増える。写した先を返す。元がなければ何もせず None
pub fn set_aside(path: &Path, now: SystemTime) -> io::Result<Option<PathBuf>> {
    let Some(backup) = atomic_file::back_up(path, now)? else {
        return Ok(None);
    };
    atomic_file::remove(path)?;
    Ok(Some(backup))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::{
        fs,
        time::{Duration, UNIX_EPOCH},
    };

    fn history(entries: &[(&str, u64)], cleared_at: u64) -> History {
        History {
            entries: entries
                .iter()
                .map(|(text, at)| Entry {
                    text: text.to_string(),
                    at: *at,
                })
                .collect(),
            cleared_at,
            deleted: Vec::new(),
        }
    }

    fn texts(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|text| text.to_string()).collect()
    }

    #[test]
    fn round_trips() {
        let saved = history(&[("old", 1), ("new", 2)], 0);
        assert_eq!(parse(&format(&saved)), Ok(saved));
    }

    #[test]
    fn writes_the_times_next_to_the_texts() {
        assert_eq!(
            format(&history(&[("draft", 5)], 3)),
            r#"{"version":1,"entries":[{"text":"draft","at":5}],"cleared_at":3}"#
        );
    }

    #[test]
    fn mixes_the_files_of_the_other_devices_without_writing_them() {
        let dir = TempDir::new("history-merged");
        let own = dir.join("own.json");
        save(&own, &history(&[("a", 10), ("b", 30)], 0)).unwrap();
        let other = dir.join("other.json");
        let other_text = r#"{"version": 1, "entries": [{"text": "c", "at": 20}, {"text": "b", "at": 40}], "cleared_at": 5}"#;
        fs::write(&other, other_text).unwrap();
        // 書きかけなどで読めないファイルは飛ばす
        fs::write(dir.join("broken.json"), "{").unwrap();
        fs::write(dir.join("notes.txt"), "not a history").unwrap();
        let merged = load_merged(&own).unwrap();
        assert_eq!(merged, history(&[("a", 10), ("c", 20), ("b", 40)], 5));
        assert_eq!(fs::read_to_string(&other).unwrap(), other_text);
        // ほかのデバイスで消した時刻より前の履歴は、どのデバイスの分も落とす
        fs::write(&other, r#"{"version": 1, "entries": [], "cleared_at": 25}"#).unwrap();
        assert_eq!(load_merged(&own).unwrap(), history(&[("b", 30)], 25));
    }

    #[test]
    fn rejects_broken_json_and_unknown_versions() {
        assert_eq!(parse("{"), Err(ReadProblem::InvalidJson));
        assert_eq!(
            parse(r#"{"version": 2, "entries": [], "cleared_at": 0}"#),
            Err(ReadProblem::UnknownVersion)
        );
    }

    #[test]
    fn treats_a_file_with_broken_encoding_as_invalid() {
        let dir = TempDir::new("history-broken-encoding");
        let path = dir.join("a1b2c3d4.json");
        fs::write(&path, [0xff, 0xfe, b'{']).unwrap();
        assert_eq!(
            load(&path),
            Err(LoadError::Invalid(ReadProblem::InvalidJson))
        );
    }

    #[test]
    fn rejects_wrong_shape() {
        assert_eq!(
            parse(r#"{"version": 1, "entries": [1], "cleared_at": 0}"#),
            Err(ReadProblem::InvalidShape)
        );
        assert_eq!(
            parse(r#"{"version": 1, "entries": ["draft"], "cleared_at": 0}"#),
            Err(ReadProblem::InvalidShape)
        );
    }

    #[test]
    fn truncating_keeps_the_newest_entries_and_zero_keeps_none() {
        let saved = history(&[("1", 1), ("2", 2), ("3", 3)], 7);
        assert_eq!(
            saved.clone().truncated(2),
            history(&[("2", 2), ("3", 3)], 7)
        );
        assert_eq!(saved.truncated(0), history(&[], 7));
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = TempDir::new("history-missing");
        let path = dir.join("a1b2c3d4.json");
        assert_eq!(load(&path), Ok(History::default()));
    }

    #[test]
    fn saves_atomically_and_with_private_permissions() {
        let dir = TempDir::new("history-save");
        let path = dir.join("a1b2c3d4.json");
        let saved = history(&[("draft", 1)], 0);
        save(&path, &saved).unwrap();
        assert_eq!(load(&path), Ok(saved));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn an_empty_history_leaves_no_file_unless_it_was_cleared() {
        let dir = TempDir::new("history-empty");
        let path = dir.join("a1b2c3d4.json");
        save(&path, &history(&[("draft", 1)], 0)).unwrap();
        save(&path, &History::default()).unwrap();
        assert!(!path.exists());
        // 消した時刻は、履歴が無くても置いておく
        save(&path, &history(&[], 9)).unwrap();
        assert_eq!(load(&path), Ok(history(&[], 9)));
    }

    #[test]
    fn restamping_keeps_the_times_of_entries_still_held() {
        let saved = history(&[("a", 10), ("b", 20)], 0);
        assert_eq!(saved.restamped(texts(&["a", "b"]), 500), saved);
    }

    #[test]
    fn restamping_gives_the_current_time_to_added_entries() {
        let saved = history(&[("a", 10), ("b", 20)], 0);
        assert_eq!(
            saved.restamped(texts(&["a", "b", "c"]), 500),
            history(&[("a", 10), ("b", 20), ("c", 500)], 0)
        );
        assert_eq!(
            History::default().restamped(texts(&["a"]), 500),
            history(&[("a", 500)], 0)
        );
    }

    #[test]
    fn restamping_follows_entries_forgotten_from_the_old_end() {
        let saved = history(&[("a", 10), ("b", 20), ("c", 30)], 0);
        // 件数を減らした
        assert_eq!(
            saved.restamped(texts(&["b", "c"]), 500),
            history(&[("b", 20), ("c", 30)], 0)
        );
        // 件数がいっぱいで、覚えた分だけ古い方を忘れた
        assert_eq!(
            saved.restamped(texts(&["b", "c", "d"]), 500),
            history(&[("b", 20), ("c", 30), ("d", 500)], 0)
        );
    }

    #[test]
    fn restamping_treats_a_text_recorded_again_as_new() {
        let saved = history(&[("a", 10), ("b", 20)], 0);
        assert_eq!(
            saved.restamped(texts(&["a", "b", "a"]), 500),
            history(&[("a", 10), ("b", 20), ("a", 500)], 0)
        );
        // 古い方の同じ本文を忘れたのと同じ回に、もう一度覚えた
        assert_eq!(
            saved.restamped(texts(&["b", "a"]), 500),
            history(&[("b", 20), ("a", 500)], 0)
        );
    }

    #[test]
    fn restamping_keeps_the_newer_time_of_a_text_held_twice() {
        let saved = history(&[("a", 10), ("b", 20), ("a", 30)], 0);
        assert_eq!(
            saved.restamped(texts(&["b", "a", "c"]), 500),
            history(&[("b", 20), ("a", 30), ("c", 500)], 0)
        );
    }

    #[test]
    fn restamping_replaces_everything_when_nothing_overlaps() {
        let saved = history(&[("a", 10), ("b", 20)], 0);
        assert_eq!(
            saved.restamped(texts(&["c", "d"]), 500),
            history(&[("c", 500), ("d", 501)], 0)
        );
        assert_eq!(saved.restamped(Vec::new(), 500), history(&[], 0));
    }

    #[test]
    fn restamping_stays_after_held_entries_and_the_clear_when_the_clock_went_back() {
        assert_eq!(
            history(&[("a", 900)], 0).restamped(texts(&["a", "b", "c"]), 500),
            history(&[("a", 900), ("b", 901), ("c", 902)], 0)
        );
        assert_eq!(
            history(&[], 900).restamped(texts(&["a"]), 500),
            history(&[("a", 901)], 900)
        );
    }

    #[test]
    fn clearing_records_when_and_never_before_the_entries_it_clears() {
        assert_eq!(history(&[("a", 10)], 5).cleared(500), history(&[], 500));
        assert_eq!(history(&[("a", 900)], 5).cleared(500), history(&[], 900));
        assert_eq!(history(&[], 900).cleared(500), history(&[], 900));
    }

    #[test]
    fn deleting_drops_every_entry_of_the_text_and_records_when() {
        let deleted = history(&[("a", 1), ("b", 2), ("a", 3)], 0).without("a", 10);
        assert_eq!(deleted.texts(), texts(&["b"]));
        assert_eq!(
            deleted.deleted,
            [Entry {
                text: "a".to_string(),
                at: 10
            }]
        );
        // 時計が戻っていても、消した本文を覚えた時刻より前にはしない
        assert_eq!(history(&[("a", 50)], 0).without("a", 10).deleted[0].at, 50);
    }

    #[test]
    fn merging_does_not_bring_back_a_deleted_entry_from_another_device() {
        let local = history(&[("b", 2)], 0).without("a", 10);
        let remote = history(&[("a", 1), ("b", 2), ("c", 3)], 0);
        let merged = merge(&local, &remote);
        assert_eq!(merged.texts(), texts(&["b", "c"]));
        // 消した記録も混ぜた結果に残り、さらにほかのデバイスへ渡る
        assert_eq!(merged.deleted, local.deleted);
        assert_eq!(merge(&remote, &local), merged);
    }

    #[test]
    fn a_text_recorded_again_after_deleting_comes_back() {
        let deleted = history(&[("a", 1)], 0).without("a", 10);
        // 時計が戻っていても、消した時刻より後に覚えたことにする
        let again = deleted.restamped(texts(&["a"]), 5);
        assert_eq!(again.entries[0].at, 11);
        assert_eq!(
            merge(&again, &history(&[("a", 1)], 0)).texts(),
            texts(&["a"])
        );
    }

    #[test]
    fn clearing_or_a_later_clear_forgets_the_deleted_records() {
        let deleted = history(&[("a", 1), ("b", 2)], 0).without("a", 10);
        assert!(deleted.cleared(20).deleted.is_empty());
        assert!(merge(&deleted, &history(&[], 30)).deleted.is_empty());
    }

    #[test]
    fn merging_interleaves_both_sides_by_time() {
        assert_eq!(
            merge(
                &history(&[("a", 10), ("c", 30)], 0),
                &history(&[("b", 20), ("d", 40)], 0)
            ),
            history(&[("a", 10), ("b", 20), ("c", 30), ("d", 40)], 0)
        );
    }

    #[test]
    fn merging_takes_the_later_clear_and_drops_entries_up_to_it() {
        // ほかのデバイスで消した。消した時刻ちょうどの履歴も落とす
        assert_eq!(
            merge(
                &history(&[("a", 10), ("b", 20), ("c", 30)], 5),
                &history(&[("d", 15), ("e", 25)], 20)
            ),
            history(&[("e", 25), ("c", 30)], 20)
        );
        // 手元の側で消した
        assert_eq!(
            merge(
                &history(&[("c", 30)], 20),
                &history(&[("a", 10), ("b", 21)], 0)
            ),
            history(&[("b", 21), ("c", 30)], 20)
        );
    }

    #[test]
    fn merging_keeps_one_of_the_same_text_with_the_later_time() {
        assert_eq!(
            merge(
                &history(&[("a", 10), ("b", 20)], 0),
                &history(&[("b", 5), ("a", 30)], 0)
            ),
            history(&[("b", 20), ("a", 30)], 0)
        );
        // 手元に同じ本文が2回あっても、新しい方の1つにする
        assert_eq!(
            merge(
                &history(&[("a", 10), ("b", 20), ("a", 30)], 0),
                &History::default()
            ),
            history(&[("b", 20), ("a", 30)], 0)
        );
        assert_eq!(
            merge(&history(&[("a", 10)], 0), &history(&[("a", 10)], 0)),
            history(&[("a", 10)], 0)
        );
    }

    #[test]
    fn merging_keeps_the_newest_up_to_the_limit() {
        // 2つを合わせると上限を超える件数にする
        let count = MAX_MERGED_ENTRIES * 4 / 5;
        let side = |offset: u64| History {
            entries: (0..count as u64)
                .map(|index| Entry {
                    text: format!("{offset}-{index}"),
                    at: index * 2 + offset,
                })
                .collect(),
            cleared_at: 0,
            deleted: Vec::new(),
        };
        let merged = merge(&side(1), &side(2));
        assert_eq!(merged.entries.len(), MAX_MERGED_ENTRIES);
        // 時刻は 1 から 2 * count まで並ぶので、古い方から上限を超えた分を落とす
        let total = (count * 2) as u64;
        assert_eq!(merged.entries[0].at, total - MAX_MERGED_ENTRIES as u64 + 1);
        assert_eq!(merged.entries.last().unwrap().at, total);
        assert!(merged
            .entries
            .windows(2)
            .all(|pair| pair[0].at < pair[1].at));
    }

    #[test]
    fn merging_does_not_depend_on_which_side_is_local() {
        // 同じ時刻の履歴は本文の順に並べ、切り詰めで落とす履歴も、どちらを手元にしても同じ
        let count = MAX_MERGED_ENTRIES as u64 * 3 / 5;
        let side = |name: &str| History {
            entries: (1..=count)
                .map(|at| Entry {
                    text: format!("{name}{at:06}"),
                    at,
                })
                .collect(),
            cleared_at: 0,
            deleted: Vec::new(),
        };
        let merged = merge(&side("a"), &side("b"));
        assert_eq!(merged, merge(&side("b"), &side("a")));
        assert_eq!(merged.entries.len(), MAX_MERGED_ENTRIES);
        // 時刻、同じ時刻なら本文の順に並べたうちの、新しい方の上限の件数を残す
        let mut all: Vec<Entry> = side("a")
            .entries
            .into_iter()
            .chain(side("b").entries)
            .collect();
        all.sort_by(|a, b| (a.at, &a.text).cmp(&(b.at, &b.text)));
        assert_eq!(merged.entries, all[all.len() - MAX_MERGED_ENTRIES..]);
        // 混ぜた結果は、どのデバイスの手元と混ぜ直しても変わらない
        assert_eq!(merge(&side("a").truncated(50), &merged), merged);
        assert_eq!(merge(&merged, &merged), merged);
    }

    #[test]
    fn merging_drops_entries_without_a_time() {
        // このアプリは時刻を 1 以上で書くので、時刻が 0 の履歴は手で書いたファイルにしか無い
        assert_eq!(
            merge(&history(&[("a", 10)], 0), &history(&[("b", 0)], 0)),
            history(&[("a", 10)], 0)
        );
    }

    fn stale_screen(seen: History) -> ScreenCopy {
        let mut screen = ScreenCopy::new();
        screen.replaced_by_other_devices(seen);
        screen
    }

    #[test]
    fn a_save_from_a_screen_holding_the_file_is_stamped_against_the_file() {
        let file = history(&[("a", 10), ("b", 20)], 0);
        let mut screen = ScreenCopy::new();
        assert_eq!(
            screen.saved(&file, texts(&["a", "b", "c"]), 50, 500),
            history(&[("a", 10), ("b", 20), ("c", 500)], 0)
        );
        // 読み直した後・消した後は、今のファイルと照らす
        let mut screen = stale_screen(history(&[("a", 10)], 0));
        screen.caught_up();
        assert_eq!(
            screen.saved(&file, texts(&["b", "c"]), 50, 500),
            history(&[("b", 20), ("c", 500)], 0)
        );
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_keeps_the_merged_entries() {
        let mut screen = stale_screen(history(&[("a", 10), ("c", 30)], 0));
        let file = history(&[("a", 10), ("b", 20), ("c", 30), ("d", 40)], 0);
        let next = screen.saved(&file, texts(&["a", "c", "e"]), 50, 500);
        assert_eq!(
            next,
            history(&[("a", 10), ("b", 20), ("c", 30), ("d", 40), ("e", 500)], 0)
        );
        // 画面が持つのは、届いた履歴を除いた一覧のまま。続けて保存しても、同じ本文に新しい時刻を付け直さない
        assert_eq!(screen.saved(&next, texts(&["a", "c", "e"]), 50, 900), next);
        // 次の入れ替えがあっても、画面が持つ履歴は先のまま
        screen.replaced_by_other_devices(next.clone());
        assert_eq!(screen.saved(&next, texts(&["a", "c", "e"]), 50, 900), next);
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_stays_after_a_deletion_that_arrived() {
        // ほかのデバイスが、このデバイスの今より後の時刻で "c" を消した。画面は読み直す前にまた "c" をコピーした
        let mut screen = stale_screen(history(&[("a", 10)], 0));
        let file = history(&[("a", 10), ("c", 20)], 0).without("c", 700);
        let next = screen.saved(&file, texts(&["a", "c"]), 50, 500);
        assert_eq!(next.texts(), texts(&["a", "c"]));
        assert_eq!(next.entries[1].at, 701);
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_stays_after_what_arrived() {
        // ほかのデバイスの時計が進んでいて、届いた履歴と消した時刻が、このデバイスの今より後
        let mut screen = stale_screen(history(&[("a", 10)], 0));
        let file = history(&[("b", 800)], 700);
        assert_eq!(
            screen.saved(&file, texts(&["a", "c"]), 50, 500),
            history(&[("b", 800), ("c", 801)], 700)
        );
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_is_cut_to_the_device_size() {
        let mut screen = stale_screen(history(&[("a", 10)], 0));
        let file = history(&[("a", 10), ("b", 20)], 0);
        assert_eq!(
            screen.saved(&file, texts(&["a", "c"]), 2, 500),
            history(&[("b", 20), ("c", 500)], 0)
        );
    }

    #[test]
    fn sets_aside_unreadable_history() {
        let dir = TempDir::new("history-set-aside");
        let path = dir.join("a1b2c3d4.json");
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        assert_eq!(set_aside(&path, now).unwrap(), None);

        fs::write(&path, r#"{"version": 3, "entries": ["draft"]}"#).unwrap();
        let backup = set_aside(&path, now).unwrap().unwrap();
        assert_eq!(backup, dir.join("a1b2c3d4.broken-20260913-063005.json"));
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            r#"{"version": 3, "entries": ["draft"]}"#
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!path.exists());
    }
}
