//! 設定のバックアップ（docs/config.md「バックアップ」）。置き場の項目（既定と違う値だけ）を、時刻を名前にした JSON に書く

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::atomic_file;

pub const DIR_NAME: &str = "backups";
/// 毎日の自動のバックアップの間隔
pub const DAILY: Duration = Duration::from_secs(24 * 60 * 60);
/// VS Code の設定同期の控えと同じく、30 日より古いものは消す。ただし最近の 10 件は、続けて書いた直後でも戻れるよう残す
const RETENTION_DAYS: u64 = 30;
const MIN_COUNT: usize = 10;
/// 戻す画面に並べる数。残す決まりで溜まる数より少し多い程度にして、選ぶ手間を増やさない
pub const LIST_LIMIT: usize = 20;
const VERSION: u64 = 1;

#[derive(Serialize, Deserialize)]
struct File {
    v: u64,
    settings: BTreeMap<String, Value>,
}

/// 書く。いちばん新しいバックアップと同じ中身なら重ねずに None。書いたら古いものを片付ける
pub fn write(
    dir: &Path,
    entries: &BTreeMap<String, Value>,
    now: SystemTime,
) -> io::Result<Option<String>> {
    if let Some(latest) = names(dir)?.first() {
        if read(dir, latest).ok().as_ref() == Some(entries) {
            return Ok(None);
        }
    }
    let file = File {
        v: VERSION,
        settings: entries.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
    // 名前は秒までなので、同じ秒に書いたもの（戻す直前のバックアップと、すぐ続けて戻したときのもの など）を
    // 上書きしないよう、空いている次の秒の名前にする
    let mut stamp = now;
    let name = loop {
        let name = name_at(stamp);
        if !dir.join(&name).exists() {
            break name;
        }
        stamp += Duration::from_secs(1);
    };
    // 設定にはキー操作や定型文の本文が入るので、unix では所有者だけが読めるようにする
    atomic_file::write_private(&dir.join(&name), &bytes)?;
    // 書けたバックアップを、片付けられなかったことで失敗に見せない
    if let Err(error) = clean(dir, now) {
        log::warn!("couldn't remove old settings backups: {error}");
    }
    Ok(Some(name))
}

/// 毎日の自動のバックアップを書く頃か。いちばん新しいものから1日たっていれば（無ければ）書く
pub fn due(dir: &Path, now: SystemTime) -> io::Result<bool> {
    Ok(match names(dir)?.first() {
        Some(latest) => time_of(latest)
            .is_none_or(|at| now.duration_since(at).is_ok_and(|elapsed| elapsed >= DAILY)),
        None => true,
    })
}

/// 新しい順の名前
pub fn names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names: Vec<String> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| valid_name(name))
            .collect(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    names.sort_by(|a, b| b.cmp(a));
    Ok(names)
}

pub fn read(dir: &Path, name: &str) -> io::Result<BTreeMap<String, Value>> {
    if !valid_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid backup name",
        ));
    }
    let file: File = serde_json::from_slice(&fs::read(dir.join(name))?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if file.v != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown backup version {}", file.v),
        ));
    }
    Ok(file.settings)
}

/// 形が正しい名前（UTC の `YYYYMMDDTHHMMSSZ.json`）だけを受ける。パスの区切りを通さない
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 21
        && bytes[8] == b'T'
        && bytes[15] == b'Z'
        && &bytes[16..] == b".json"
        && bytes[..8]
            .iter()
            .chain(bytes[9..15].iter())
            .all(u8::is_ascii_digit)
}

fn name_at(time: SystemTime) -> String {
    let stamp = atomic_file::utc_stamp(time);
    let (date, time) = stamp.split_at(8);
    format!("{date}T{}Z.json", &time[1..])
}

fn time_of(name: &str) -> Option<SystemTime> {
    let digits = |range: std::ops::Range<usize>| name.get(range)?.parse::<u64>().ok();
    let (year, month, day) = (digits(0..4)?, digits(4..6)?, digits(6..8)?);
    let (hour, minute, second) = (digits(9..11)?, digits(11..13)?, digits(13..15)?);
    // Howard Hinnant の days_from_civil（atomic_file::utc_stamp の逆）
    let year = year as i64 - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_from_march = (month as i64 + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = u64::try_from(days).ok()? * 86_400 + hour * 3600 + minute * 60 + second;
    Some(UNIX_EPOCH + Duration::from_secs(seconds))
}

/// 30 日より古いものを消す。新しい方から 10 件は残す
fn clean(dir: &Path, now: SystemTime) -> io::Result<()> {
    let cutoff = name_at(
        now.checked_sub(Duration::from_secs(RETENTION_DAYS * 86_400))
            .unwrap_or(UNIX_EPOCH),
    );
    for (index, name) in names(dir)?.into_iter().enumerate() {
        if index >= MIN_COUNT && name < cutoff {
            fs::remove_file(dir.join(name))?;
        }
    }
    Ok(())
}

/// バックアップを置くフォルダー。設定の置き場と同じフォルダーの下
pub fn dir_in(config_dir: &Path) -> PathBuf {
    config_dir.join(DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use serde_json::json;

    const DAY: u64 = 86_400;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn entries(theme: &str) -> BTreeMap<String, Value> {
        BTreeMap::from([("theme".to_string(), json!(theme))])
    }

    #[test]
    fn names_by_utc_time_and_reads_back() {
        let dir = TempDir::new("backup-names");
        // 2026-10-17 12:34:56 UTC
        let now = at(1_792_240_496);
        let name = write(&dir.join(DIR_NAME), &entries("dark"), now)
            .unwrap()
            .unwrap();
        assert_eq!(name, "20261017T123456Z.json");
        assert_eq!(time_of(&name), Some(now));
        assert_eq!(read(&dir.join(DIR_NAME), &name).unwrap(), entries("dark"));
    }

    #[test]
    fn skips_the_same_contents_as_the_latest() {
        let dir = TempDir::new("backup-same");
        let backups = dir.join(DIR_NAME);
        assert!(write(&backups, &entries("dark"), at(DAY))
            .unwrap()
            .is_some());
        assert!(write(&backups, &entries("dark"), at(2 * DAY))
            .unwrap()
            .is_none());
        assert!(write(&backups, &entries("light"), at(3 * DAY))
            .unwrap()
            .is_some());
        assert_eq!(names(&backups).unwrap().len(), 2);
    }

    #[test]
    fn does_not_overwrite_a_backup_written_in_the_same_second() {
        let dir = TempDir::new("backup-same-second");
        let backups = dir.join(DIR_NAME);
        let first = write(&backups, &entries("dark"), at(DAY)).unwrap().unwrap();
        let second = write(&backups, &entries("light"), at(DAY))
            .unwrap()
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(read(&backups, &first).unwrap(), entries("dark"));
        // 後に書いた方が、いちばん新しいものとして並ぶ
        assert_eq!(names(&backups).unwrap().first(), Some(&second));
    }

    #[test]
    fn is_due_a_day_after_the_latest() {
        let dir = TempDir::new("backup-due");
        let backups = dir.join(DIR_NAME);
        assert!(due(&backups, at(DAY)).unwrap());
        write(&backups, &entries("dark"), at(DAY)).unwrap();
        assert!(!due(&backups, at(2 * DAY - 1)).unwrap());
        assert!(due(&backups, at(2 * DAY)).unwrap());
    }

    #[test]
    fn keeps_thirty_days_but_at_least_the_latest_ten() {
        let dir = TempDir::new("backup-clean");
        let backups = dir.join(DIR_NAME);
        for day in 1..=12 {
            write(&backups, &entries(&day.to_string()), at(day * DAY)).unwrap();
        }
        // 12 件とも 30 日以内なので残る
        assert_eq!(names(&backups).unwrap().len(), 12);
        // 40 日目に書くと、30 日より古い 1〜9 日目のうち、新しい方から 10 件に入らない 1〜3 日目が消える
        write(&backups, &entries("40"), at(40 * DAY)).unwrap();
        let kept = names(&backups).unwrap();
        assert_eq!(kept.len(), 10);
        assert_eq!(kept.last().unwrap(), &name_at(at(4 * DAY)));
    }

    #[test]
    fn refuses_names_that_are_not_backups() {
        assert!(valid_name("20261017T123456Z.json"));
        for name in [
            "../20261017T123456Z.json",
            "20261017T123456Z.toml",
            "2026101xT123456Z.json",
            "settings.db",
        ] {
            assert!(!valid_name(name), "{name}");
        }
    }
}
