//! Mac 版の更新（docs/platform.md「Mac 版の更新」）。確かめるのも入れ替えるのも Rust 側で行い、設定の画面には状態だけを渡す

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime},
};

use log::{error, info, warn};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{
    atomic_file, events,
    update_status::{UpdateStatus, UpdateView},
    AppState,
};

/// 起動してから初めて確かめるまで。起動の最中に通信を足さないため
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// 常駐している間に確かめ直す間隔
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// 確かめ直す時が来たかを見る間隔。待つ時計はスリープの間は進まないので、24 時間を寝て待たず、前に確かめた時刻と壁時計で比べる
const POLL_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// 確かめる問い合わせを諦めるまで。返事が来ないまま「確かめています」が続き、次の確認も始められなくなるのを防ぐ
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// 通知した版を覚えておくファイル（app_local_data_dir）。同じ版を、起動し直すたびに知らせないため
const NOTIFIED_FILE_NAME: &str = "update-notified.txt";

#[derive(Default)]
pub struct UpdateState {
    inner: Mutex<Inner>,
    /// 下書きウィンドウに書きかけの文があるか。下書きウィンドウが、空かどうかが変わったときに知らせる
    draft_has_text: AtomicBool,
}

#[derive(Default)]
struct Inner {
    status: UpdateStatus,
    /// 見つけた新しい版。「更新して再起動」で入れる
    update: Option<Update>,
    /// 最後に確かめ始めた時刻（壁時計）
    last_checked: Option<SystemTime>,
}

impl UpdateState {
    fn view(&self) -> UpdateView {
        UpdateView {
            status: self.inner.lock().unwrap().status.clone(),
            draft_has_text: self.draft_has_text.load(Ordering::Relaxed),
        }
    }
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit(events::UPDATE_CHANGED, app.state::<UpdateState>().view());
}

/// 起動して少ししてから確かめ、常駐している間は1日ごとに確かめ直す。
/// 開発版では確かめない（開発中の版に対して、出していない版の情報を見に行かないため）。設定の画面から手で確かめることはできる
pub fn start_periodic_checks(app: &AppHandle) {
    if cfg!(debug_assertions) {
        info!("automatic update checks are off in development builds");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let last_checked = app
                .state::<UpdateState>()
                .inner
                .lock()
                .unwrap()
                .last_checked;
            if is_due(last_checked, SystemTime::now()) {
                check(&app, false).await;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

/// 前に確かめてから1日たったか。時計が戻されて前の時刻が先になっていたら、確かめ直す
fn is_due(last_checked: Option<SystemTime>, now: SystemTime) -> bool {
    last_checked.is_none_or(|last| {
        now.duration_since(last)
            .map_or(true, |elapsed| elapsed >= CHECK_INTERVAL)
    })
}

/// 新しい版を確かめる。manual は設定の画面から確かめたとき。画面で見ているので、見つかっても通知しない
async fn check(app: &AppHandle, manual: bool) {
    let state = app.state::<UpdateState>();
    let previous = {
        let mut inner = state.inner.lock().unwrap();
        if matches!(
            inner.status,
            UpdateStatus::Checking | UpdateStatus::Installing { .. }
        ) {
            return;
        }
        std::mem::replace(&mut inner.status, UpdateStatus::Checking)
    };
    emit_changed(app);
    let result = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let found = {
        let mut inner = state.inner.lock().unwrap();
        if result.is_ok() {
            inner.last_checked = Some(SystemTime::now());
        }
        let (status, update) = match result {
            Ok(Some(update)) => {
                info!(
                    "update {} is available (current {})",
                    update.version, update.current_version
                );
                (
                    UpdateStatus::Available {
                        version: update.version.clone(),
                    },
                    Some(update),
                )
            }
            Ok(None) => {
                info!("no update is available");
                (UpdateStatus::UpToDate, None)
            }
            Err(error) => {
                warn!("couldn't check for updates: {error}");
                let update = inner.update.take();
                (
                    status_after_failed_check(previous, update.is_some()),
                    update,
                )
            }
        };
        inner.status = status;
        inner.update = update;
        inner.update.as_ref().map(|update| update.version.clone())
    };
    emit_changed(app);
    if let Some(version) = found {
        notify_once(app, &version, manual);
    }
}

/// 新しい版を、その版につき1回だけ OS の通知で知らせる。設定の画面で見つけた版は、知らせたものとして覚えるだけにする
fn notify_once(app: &AppHandle, version: &str, manual: bool) {
    let path = notified_path(app);
    let notified = path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok());
    if !should_notify(notified.as_deref(), version) {
        return;
    }
    if let Some(path) = &path {
        if let Err(error) = atomic_file::write(path, version.as_bytes()) {
            warn!("couldn't remember the notified update: {error}");
        }
    }
    if manual {
        return;
    }
    let message = app.state::<AppState>().lang().update_available(version);
    crate::show_notification(app, message);
}

/// 確かめられなかったときの状態。前に見つけた版があれば、その状態（入れられる・入れられなかった）を残す。
/// つながらない間に確かめ直しが当たっても、入れる手段を消さないため。確かめた時刻も記録しないので、次の見回りで確かめ直す
fn status_after_failed_check(previous: UpdateStatus, has_update: bool) -> UpdateStatus {
    if has_update {
        previous
    } else {
        UpdateStatus::CheckFailed
    }
}

fn should_notify(notified: Option<&str>, version: &str) -> bool {
    notified.map(str::trim) != Some(version)
}

fn notified_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .inspect_err(|error| warn!("couldn't find the data folder: {error}"))
        .ok()
        .map(|dir| dir.join(NOTIFIED_FILE_NAME))
}

/// 見つけた新しい版をダウンロードして入れ替え、アプリを再起動する。失敗したら、状態を「入れられなかった」にする
async fn install(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let (update, version) = {
        let mut inner = state.inner.lock().unwrap();
        let version = match &inner.status {
            UpdateStatus::Available { version } | UpdateStatus::InstallFailed { version } => {
                version.clone()
            }
            _ => return,
        };
        let Some(update) = inner.update.clone() else {
            return;
        };
        inner.status = UpdateStatus::Installing {
            version: version.clone(),
        };
        (update, version)
    };
    emit_changed(app);
    info!("installing update {version}");
    match download_and_install(update).await {
        Ok(()) => {
            info!("installed update {version}; restarting");
            // 再起動で立ち上がる次のプロセスが、終わりかけのこのプロセスを2つ目の起動と取り違えて終わらないよう、先に放す
            crate::release_single_instance_lock(app);
            app.request_restart();
        }
        Err(error) => {
            error!("couldn't install update {version}: {error}");
            state.inner.lock().unwrap().status = UpdateStatus::InstallFailed { version };
            emit_changed(app);
        }
    }
}

async fn download_and_install(update: Update) -> Result<(), String> {
    // 開発版は .app の中から動いていないので、入れ替える先を取り違える（実行ファイルのあるフォルダーごと置き換える）
    if cfg!(debug_assertions) {
        return Err("updates aren't installed in development builds".into());
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    // 入れ替えはファイルの移動で、管理者の許可を求めることもあるので、非同期の処理の糸を塞がない
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// 設定の画面が、開いたときに今の状態を読む。その後の変わり目は update-changed で届く
#[tauri::command]
pub fn update_status(state: tauri::State<'_, UpdateState>) -> UpdateView {
    state.view()
}

/// 設定の画面から、今すぐ確かめる。結果は update-changed で届く
#[tauri::command]
pub async fn check_for_update(app: AppHandle) {
    check(&app, true).await;
}

/// 「更新して再起動」。うまくいけば戻らずに再起動し、失敗は update-changed で届く
#[tauri::command]
pub async fn install_update(app: AppHandle) {
    install(&app).await;
}

/// 下書きウィンドウが、書きかけがあるかが変わったときに知らせる。中身は受け取らない
#[tauri::command]
pub fn set_draft_has_text(app: AppHandle, has_text: bool) {
    let changed = app
        .state::<UpdateState>()
        .draft_has_text
        .swap(has_text, Ordering::Relaxed)
        != has_text;
    if changed {
        emit_changed(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_again_a_day_after_the_last_check() {
        let now = SystemTime::now();
        assert!(is_due(None, now));
        assert!(!is_due(Some(now - Duration::from_secs(60 * 60)), now));
        assert!(is_due(Some(now - CHECK_INTERVAL), now));
        // 時計が戻されて、前に確かめた時刻が先になった
        assert!(is_due(Some(now + Duration::from_secs(60)), now));
    }

    #[test]
    fn keeps_the_found_update_when_a_check_fails() {
        let available = UpdateStatus::Available {
            version: "1.0.1".into(),
        };
        assert_eq!(
            status_after_failed_check(available.clone(), true),
            available
        );
        let install_failed = UpdateStatus::InstallFailed {
            version: "1.0.1".into(),
        };
        assert_eq!(
            status_after_failed_check(install_failed.clone(), true),
            install_failed
        );
        assert_eq!(
            status_after_failed_check(UpdateStatus::UpToDate, false),
            UpdateStatus::CheckFailed
        );
    }

    #[test]
    fn notifies_each_version_once() {
        assert!(should_notify(None, "1.0.1"));
        assert!(!should_notify(Some("1.0.1"), "1.0.1"));
        assert!(!should_notify(Some("1.0.1\n"), "1.0.1"));
        assert!(should_notify(Some("1.0.1"), "1.0.2"));
    }
}
