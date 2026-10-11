//! 下書きの履歴を app_local_data_dir/history.json に保存する処理と、ほかのデバイスの履歴との混ぜ方。

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};

use crate::{atomic_file, config};

pub const FILE_NAME: &str = "history.json";
/// 本文だけを置いていた版。時刻は 0 として読む（docs/sync.md「履歴の同期」）。
const TEXT_ONLY_VERSION: u8 = 1;
const VERSION: u8 = 2;
/// 窓口に置く履歴の件数の上限（docs/sync.md「履歴の同期」）。
pub const MAX_SYNCED_ENTRIES: usize = 100;

/// 履歴の1件。項目名は、窓口に置く値と同じにする（docs/sync.md「履歴の同期」）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub text: String,
    /// 覚えた時刻。UNIX のミリ秒
    pub at: u64,
}

/// 履歴の全体。窓口に置く値と同じ形（docs/sync.md「履歴の同期」）。`entries` は古い順。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub entries: Vec<Entry>,
    /// 履歴を消した時刻。消していなければ 0
    pub cleared_at: u64,
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
        if self.entries.len() > max_entries {
            self.entries.drain(..self.entries.len() - max_entries);
        }
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
            .max(entries.last().map_or(0, |entry| entry.at.saturating_add(1)));
        for text in texts.into_iter().skip(kept) {
            entries.push(Entry { text, at });
            at = at.saturating_add(1);
        }
        Self {
            entries,
            cleared_at: self.cleared_at,
        }
    }

    /// 履歴を消した後の形。消した時刻は、今ある履歴のどれよりも前にならないようにする
    /// （時計が戻っていると、消した履歴がほかのデバイスから戻るため）。
    pub fn cleared(&self, now: u64) -> Self {
        let newest = self.entries.iter().map(|entry| entry.at).max().unwrap_or(0);
        Self {
            entries: Vec::new(),
            cleared_at: now.max(self.cleared_at).max(newest),
        }
    }
}

/// 手元の履歴と窓口の履歴を混ぜる（docs/sync.md「混ぜ方」）。件数は `MAX_SYNCED_ENTRIES` までで、
/// デバイスの件数には切り詰めない。
pub fn merge(local: &History, remote: &History) -> History {
    let cleared_at = local.cleared_at.max(remote.cleared_at);
    let mut newest: HashMap<&str, u64> = HashMap::new();
    for entry in remote.entries.iter().chain(&local.entries) {
        let at = newest.entry(&entry.text).or_insert(entry.at);
        *at = (*at).max(entry.at);
    }
    let mut taken = HashSet::new();
    // 窓口の履歴を先に並べる。時刻が同じ履歴（時刻の無い版から読んだ履歴は、どれも 0）の順を窓口の順に揃え、
    // デバイスごとに違う順で書き戻し合わないようにする
    let mut entries: Vec<Entry> = remote
        .entries
        .iter()
        .chain(&local.entries)
        // 消した時刻が 0 なら、消していない。時刻が 0 の履歴も落とさない
        .filter(|entry| cleared_at == 0 || entry.at > cleared_at)
        .filter(|entry| {
            newest[entry.text.as_str()] == entry.at && taken.insert(entry.text.as_str())
        })
        .cloned()
        .collect();
    entries.sort_by_key(|entry| entry.at);
    History {
        entries,
        cleared_at,
    }
    .truncated(MAX_SYNCED_ENTRIES)
}

/// 同期で混ぜた履歴（`next`）を手元に入れる形にする。`snapshot` は同期を始めたときの手元の履歴で、`current` は今の
/// 手元の履歴。通信の間に手元の履歴が変わっていたら、古い手元で混ぜた結果で上書きせず、今の手元ともう一度混ぜる。
pub fn applied_from_sync(
    current: &History,
    snapshot: &History,
    next: &History,
    max_entries: usize,
) -> History {
    if current == snapshot {
        next.clone()
    } else {
        merge(current, next)
    }
    .truncated(max_entries)
}

/// 同期が履歴ファイルを入れ替えた後、画面が読み直す前に、画面から届いた一覧を保存する形にする。`seen` は、
/// 入れ替える前から画面が持っている履歴で、一覧はこれを元にしている。`seen` と照らして時刻を付けてから、
/// 今のファイルと混ぜる。保存する履歴と、画面が今持つ履歴を返す。
pub fn saved_over_sync(
    file: &History,
    mut seen: History,
    texts: Vec<String>,
    max_entries: usize,
    now: u64,
) -> (History, History) {
    // 新しく覚えた本文は、届いた履歴と、届いた消した時刻より後にする。ほかのデバイスの時計が進んでいても、
    // 今覚えた本文が、消したはずの履歴として落ちたり、届いた履歴より古い方へ入ったりしないため
    seen.cleared_at = seen.cleared_at.max(file.cleared_at);
    let newest = file.entries.last().map_or(0, |entry| entry.at);
    let seen = seen.restamped(texts, now.max(newest.saturating_add(1)));
    (merge(&seen, file).truncated(max_entries), seen)
}

#[derive(Deserialize)]
struct Versioned {
    version: u8,
}

#[derive(Deserialize)]
struct TextOnlyFormat {
    entries: Vec<String>,
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

/// JSON の本文を読む。
pub fn parse(text: &str) -> Result<History, ReadProblem> {
    match read_json::<Versioned>(text)?.version {
        TEXT_ONLY_VERSION => Ok(History {
            entries: read_json::<TextOnlyFormat>(text)?
                .entries
                .into_iter()
                .map(|text| Entry { text, at: 0 })
                .collect(),
            cleared_at: 0,
        }),
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

pub fn truncate(mut entries: Vec<String>, max_entries: usize) -> Vec<String> {
    if entries.len() > max_entries {
        entries.drain(..entries.len() - max_entries);
    }
    entries
}

/// ファイルがなければ空を返す。ほかの読み込み失敗は理由の種類だけを
/// 返す。
pub fn load(path: &Path) -> Result<History, LoadError> {
    match fs::read_to_string(path) {
        Ok(text) => parse(&text).map_err(LoadError::Invalid),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(History::default()),
        Err(error) => Err(LoadError::Io(error.kind())),
    }
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

/// 一時ファイルへ書いてから差し替える。unix では履歴本文を所有者だけが
/// 読めるようにする。履歴も消した時刻も無ければ、空のファイルを作らず、無い状態にする。
pub fn save(path: &Path, history: &History) -> io::Result<()> {
    if *history == History::default() {
        return remove(path);
    }
    atomic_file::write_private(path, format(history).as_bytes())
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 読めなかった履歴を同じフォルダーの `history.broken-YYYYMMDD-HHMMSS.json` へ写してから消す。
/// 空で始めると次のコピーで上書きするので、先に写す。元を残すと、コピーせずに起動し直すたびに
/// 同じ中身の写しが増える。写した先を返す。元がなければ何もせず None
pub fn set_aside(path: &Path, now: SystemTime) -> io::Result<Option<PathBuf>> {
    let Some(backup) = config::back_up(path, now)? else {
        return Ok(None);
    };
    remove(path)?;
    Ok(Some(backup))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::{
        fs,
        time::{Duration, UNIX_EPOCH},
    };

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("mawok-history-test-{}-{name}", std::process::id()))
    }

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
            r#"{"version":2,"entries":[{"text":"draft","at":5}],"cleared_at":3}"#
        );
    }

    #[test]
    fn reads_the_text_only_version_with_time_zero() {
        assert_eq!(
            parse(r#"{"version": 1, "entries": ["old", "new"]}"#),
            Ok(history(&[("old", 0), ("new", 0)], 0))
        );
    }

    #[test]
    fn rejects_broken_json_and_unknown_versions() {
        assert_eq!(parse("{"), Err(ReadProblem::InvalidJson));
        assert_eq!(
            parse(r#"{"version": 3, "entries": []}"#),
            Err(ReadProblem::UnknownVersion)
        );
    }

    #[test]
    fn rejects_wrong_shape() {
        assert_eq!(
            parse(r#"{"version": 1, "entries": [1]}"#),
            Err(ReadProblem::InvalidShape)
        );
        assert_eq!(
            parse(r#"{"version": 2, "entries": ["draft"], "cleared_at": 0}"#),
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
        let path = temp_path("missing");
        let _ = fs::remove_file(&path);
        assert_eq!(load(&path), Ok(History::default()));
    }

    #[test]
    fn saves_atomically_and_with_private_permissions() {
        let path = temp_path("save");
        let _ = fs::remove_file(&path);
        let saved = history(&[("draft", 1)], 0);
        save(&path, &saved).unwrap();
        assert_eq!(load(&path), Ok(saved));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn an_empty_history_leaves_no_file_unless_it_was_cleared() {
        let path = temp_path("empty");
        save(&path, &history(&[("draft", 1)], 0)).unwrap();
        save(&path, &History::default()).unwrap();
        assert!(!path.exists());
        // 消した時刻は、履歴が無くても置いておく
        save(&path, &history(&[], 9)).unwrap();
        assert_eq!(load(&path), Ok(history(&[], 9)));
        let _ = fs::remove_file(&path);
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
        // 窓口の側で消した。消した時刻ちょうどの履歴も落とす
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
    fn merging_keeps_the_newest_hundred() {
        let side = |offset: u64| History {
            entries: (0..80)
                .map(|index| Entry {
                    text: format!("{offset}-{index}"),
                    at: index * 2 + offset,
                })
                .collect(),
            cleared_at: 0,
        };
        let merged = merge(&side(1), &side(2));
        assert_eq!(merged.entries.len(), MAX_SYNCED_ENTRIES);
        // 160 件のうち、古い 60 件を落とす
        assert_eq!(merged.entries[0].at, 61);
        assert_eq!(merged.entries[99].at, 160);
        assert!(merged
            .entries
            .windows(2)
            .all(|pair| pair[0].at < pair[1].at));
    }

    #[test]
    fn merging_keeps_entries_without_a_time_unless_a_device_cleared() {
        let text_only = history(&[("b", 0), ("a", 0)], 0);
        // 時刻の無い版から読んだ履歴は、消していなければ残し、手元の順を保つ
        assert_eq!(merge(&text_only, &History::default()), text_only);
        assert_eq!(
            merge(&text_only, &history(&[("c", 10)], 0)),
            history(&[("b", 0), ("a", 0), ("c", 10)], 0)
        );
        assert_eq!(
            merge(&text_only, &history(&[("c", 10)], 5)),
            history(&[("c", 10)], 5)
        );
    }

    #[test]
    fn merging_orders_entries_of_the_same_time_as_the_server_does() {
        let local = history(&[("x", 0), ("a", 0)], 0);
        let remote = history(&[("b", 0), ("a", 0)], 0);
        let merged = merge(&local, &remote);
        assert_eq!(merged, history(&[("b", 0), ("a", 0), ("x", 0)], 0));
        // 窓口に書いた後は、どのデバイスで混ぜても同じ順になり、書き戻し合わない
        assert_eq!(merge(&remote, &merged), merged);
        assert_eq!(merge(&merged, &merged), merged);
    }

    #[test]
    fn a_synced_history_replaces_the_local_one_cut_to_the_device_size() {
        let snapshot = history(&[("a", 10)], 0);
        let next = history(&[("a", 10), ("b", 20), ("c", 30)], 0);
        assert_eq!(applied_from_sync(&snapshot, &snapshot, &next, 50), next);
        // 通信の間に件数を減らした
        assert_eq!(
            applied_from_sync(&snapshot, &snapshot, &next, 2),
            history(&[("b", 20), ("c", 30)], 0)
        );
    }

    #[test]
    fn a_synced_history_is_mixed_again_with_a_history_changed_meanwhile() {
        let snapshot = history(&[("a", 10)], 0);
        let next = history(&[("a", 10), ("b", 20)], 0);
        // 通信の間に覚えた
        assert_eq!(
            applied_from_sync(&history(&[("a", 10), ("c", 30)], 0), &snapshot, &next, 50),
            history(&[("a", 10), ("b", 20), ("c", 30)], 0)
        );
        // 通信の間に消した。届いた履歴で戻さない
        assert_eq!(
            applied_from_sync(&history(&[], 40), &snapshot, &next, 50),
            history(&[], 40)
        );
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_keeps_the_synced_entries() {
        let seen = history(&[("a", 10), ("c", 30)], 0);
        let file = history(&[("a", 10), ("b", 20), ("c", 30), ("d", 40)], 0);
        let (next, held) = saved_over_sync(&file, seen, texts(&["a", "c", "e"]), 50, 500);
        assert_eq!(
            next,
            history(&[("a", 10), ("b", 20), ("c", 30), ("d", 40), ("e", 500)], 0)
        );
        // 画面が持つのは、届いた履歴を除いた一覧のまま
        assert_eq!(held, history(&[("a", 10), ("c", 30), ("e", 500)], 0));
        // 続けて保存しても、同じ本文に新しい時刻を付け直さない
        let (again, _) = saved_over_sync(&next, held, texts(&["a", "c", "e"]), 50, 900);
        assert_eq!(again, next);
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_stays_after_what_arrived() {
        // ほかのデバイスの時計が進んでいて、届いた履歴と消した時刻が、このデバイスの今より後
        let seen = history(&[("a", 10)], 0);
        let file = history(&[("b", 800)], 700);
        let (next, _) = saved_over_sync(&file, seen, texts(&["a", "c"]), 50, 500);
        assert_eq!(next, history(&[("b", 800), ("c", 801)], 700));
    }

    #[test]
    fn a_save_from_a_screen_that_has_not_reread_is_cut_to_the_device_size() {
        let seen = history(&[("a", 10)], 0);
        let file = history(&[("a", 10), ("b", 20)], 0);
        let (next, _) = saved_over_sync(&file, seen, texts(&["a", "c"]), 2, 500);
        assert_eq!(next, history(&[("b", 20), ("c", 500)], 0));
    }

    #[test]
    fn sets_aside_unreadable_history() {
        let dir = temp_path("set-aside");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let now = UNIX_EPOCH + Duration::from_secs(1_789_281_005);
        assert_eq!(set_aside(&path, now).unwrap(), None);

        fs::write(&path, r#"{"version": 3, "entries": ["draft"]}"#).unwrap();
        let backup = set_aside(&path, now).unwrap().unwrap();
        assert_eq!(backup, dir.join("history.broken-20260913-063005.json"));
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
        let _ = fs::remove_dir_all(&dir);
    }
}
