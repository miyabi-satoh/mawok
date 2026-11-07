//! 設定の置き場を見張る（docs/config.md「ほかで変わったとき」）。ほかのデバイスの同期やエディターで設定のファイルか
//! 履歴のファイルが変わったら、落ち着くのを待ってから知らせる

use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};

use crate::{history_store, settings_files};

/// 変わってから知らせるまで待つ長さ。エディターの保存やクラウドストレージの書き込みは、一時ファイル・消す・差し替えの
/// 何回かの変化になるので、まとめて1回にする。待つ間は前の設定のままなので、長すぎない値にする
const SETTLE: Duration = Duration::from_millis(500);

/// 何が変わったか
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Changed {
    pub settings: bool,
    pub history: bool,
}

/// 見張りを止めるには手放す
pub struct Watch {
    _watcher: RecommendedWatcher,
}

/// `dir` の設定のファイルと、`history_dir` の履歴のファイルを見張る。履歴のフォルダーが無ければ作ってから見張る
pub fn start(
    dir: &Path,
    history_dir: &Path,
    on_change: impl Fn(Changed) + Send + 'static,
) -> notify::Result<Watch> {
    std::fs::create_dir_all(history_dir)?;
    let (sender, receiver) = mpsc::channel::<Changed>();
    // 知らせのパスは、OS によって実体のパスで届く（macOS の /var は /private/var）ので、比べる側も実体のパスにする
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let history = real(history_dir);
    let history_watched = history.clone();
    // symlink にした設定のファイル（stow など）は、先のファイルを直すと先のフォルダーにだけ知らせが来るので、そこも見張る。
    // 先のファイルは名前が違うこと（`ln -s ~/dotfiles/mawok.toml settings.toml`）があるので、先のパスでも選ぶ
    let settings_dir = real(dir);
    let mut targets = Vec::new();
    let mut watched = vec![settings_dir.clone()];
    for name in settings_files::FILE_NAMES {
        let Ok(target) = std::fs::canonicalize(dir.join(name)) else {
            continue;
        };
        if let Some(parent) = target.parent().map(Path::to_path_buf) {
            if !watched.contains(&parent) {
                watched.push(parent);
            }
        }
        targets.push(target);
    }
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        let changed = classify(&settings_dir, &targets, &history, &event.paths);
        if changed != Changed::default() {
            let _ = sender.send(changed);
        }
    })?;
    // まだ無いファイルは見張れないので、フォルダーを見張って名前で選ぶ
    // 比べるのと同じ実体のパスで見張る。Windows と Linux は、見張ったパスに名前を付けたパスで知らせるため
    for settings_dir in &watched {
        watcher.watch(settings_dir, RecursiveMode::NonRecursive)?;
    }
    watcher.watch(&history_watched, RecursiveMode::NonRecursive)?;
    thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut changed = first;
            while let Ok(next) = receiver.recv_timeout(SETTLE) {
                changed.settings |= next.settings;
                changed.history |= next.history;
            }
            on_change(changed);
        }
    });
    Ok(Watch { _watcher: watcher })
}

fn classify(
    settings_dir: &Path,
    targets: &[PathBuf],
    history_dir: &Path,
    paths: &[PathBuf],
) -> Changed {
    let mut changed = Changed::default();
    for path in paths {
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            continue;
        };
        let name = name.to_string_lossy();
        if parent == history_dir && history_store::is_device_file(path) {
            changed.history = true;
        } else if (parent == settings_dir && settings_files::FILE_NAMES.contains(&name.as_ref()))
            || targets.contains(path)
        {
            changed.settings = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_only_the_settings_files_and_history_files() {
        let dir = PathBuf::from("/sync/Mawok");
        let targets = [PathBuf::from("/dotfiles/mawok/snippets-mac.toml")];
        let history = dir.join("history");
        let changed = |path: &str| classify(&dir, &targets, &history, &[PathBuf::from(path)]);
        assert!(changed("/sync/Mawok/settings.toml").settings);
        // symlink の先は、名前が違っても選び、先のフォルダーのほかのファイルは選ばない
        assert!(changed("/dotfiles/mawok/snippets-mac.toml").settings);
        assert_eq!(changed("/dotfiles/mawok/settings.toml"), Changed::default());
        assert!(changed("/sync/Mawok/history/a1b2.json").history);
        assert_eq!(changed("/sync/Mawok/settings.toml.tmp"), Changed::default());
        assert_eq!(changed("/sync/Mawok/notes.txt"), Changed::default());
        assert_eq!(
            changed("/sync/Mawok/history/a1b2.json.tmp"),
            Changed::default()
        );
        assert_eq!(
            changed("/sync/Mawok/history/a1b2.broken-20261107-000000.json"),
            Changed::default()
        );
    }
}
