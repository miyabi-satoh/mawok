mod atomic_file;
mod autostart;
mod backup;
mod backup_restore;
#[cfg(test)]
mod bindings;
mod config;
mod debounce;
mod device;
mod diagnostics;
mod draft_keys;
mod error_codes;
mod events;
mod focus;
mod folder_access;
mod hex;
mod history_store;
mod hotkey;
mod i18n;
#[cfg(target_os = "macos")]
mod menu_tracking;
#[cfg(windows)]
mod package;
mod placement;
#[cfg(target_os = "linux")]
mod portal_hotkey;
mod profile;
mod settings_files;
mod settings_watch;
#[cfg(test)]
mod test_support;
mod text;
#[cfg(target_os = "linux")]
mod toggle;
#[cfg(target_os = "macos")]
mod tray_press;
#[cfg(target_os = "macos")]
mod window_frame;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

use log::{error, info, warn};
use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::{
    image::Image,
    include_image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalRect, RunEvent, Theme as WindowTheme,
    Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::{
    config::{Config, Language, Snippet, Theme},
    draft_keys::{DraftAction, DraftKeys, Platform},
    folder_access::Reach,
    hotkey::Registrar as _,
    i18n::Lang,
    settings_files::Unreachable,
    text::{CharWidths, PunctuationStyle, Replacement, ReplacementMatch},
};

const MAIN_WINDOW: &str = "main";
pub(crate) const APP_NAME: &str = "Mawok";
/// ログファイルの名前（tauri-plugin-log が既定で使うアプリ名）
const LOG_FILE_STEM: &str = APP_NAME;
const TERMS_URL: &str = "https://amiiby.com/apps/mawok/terms/";
const PRIVACY_URL: &str = "https://amiiby.com/apps/mawok/privacy/";
/// 運営者と問い合わせのページ
const CONTACT_URL: &str = "https://amiiby.com/about/";
const SETTINGS_WINDOW: &str = "settings";
/// 第三者のソフトウェアのライセンスを出すウィンドウ。設定の「このアプリについて」から開き、設定を閉じたら一緒に閉じる
const LICENSES_WINDOW: &str = "licenses";
/// 使い方（マニュアル）を出すウィンドウ。メニューと設定の「このアプリについて」から開き、設定とは別に閉じる
const MANUAL_WINDOW: &str = "manual";
/// 設定ウィンドウの既定の大きさと、それより小さくできない大きさ（中身の大きさ、論理ピクセル）
const SETTINGS_SIZE: (f64, f64) = (720.0, 520.0);
const SETTINGS_MIN_SIZE: (f64, f64) = (560.0, 400.0);
const LICENSES_SIZE: (f64, f64) = (640.0, 560.0);
const LICENSES_MIN_SIZE: (f64, f64) = (480.0, 320.0);
/// 幅は、本文 (16px) の1行が日本語でおよそ33字 (一般に言う35〜40字の手前) になるように、目次のサイドバーの分を足して決めた
const MANUAL_SIZE: (f64, f64) = (800.0, 640.0);
const MANUAL_MIN_SIZE: (f64, f64) = (480.0, 320.0);
const TRAY_ID: &str = "main";

/// macOS のメニューバーでは、明暗に合わせて OS が色を付けるモノクロのテンプレート画像を使う
#[cfg(target_os = "macos")]
const TRAY_ICON: Image<'_> = include_image!("icons/tray-template/36x36.png");
/// タスクトレイは小さいので、アプリのアイコンの余白を削ったものを使う
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: Image<'_> = include_image!("icons/tray/32x32.png");

/// 起動から画面の読み込み完了までの時間をログに出すための、起動時刻
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

#[derive(Default)]
struct DraftState {
    return_target: Mutex<focus::ReturnTarget>,
    /// 設定ウィンドウを開くために下書きを隠したか。閉じたときに出し直すかの判断に使う
    hidden_for_settings: AtomicBool,
    /// フォーカスが外れた知らせを、落ち着いてから1回だけ確かめる。Windows の WebView2 は知らせが揺れるため
    blur: debounce::Debounce,
    /// 下書きを出してから、一度でもフォーカスが入ったか。入っていなければ、フォーカスが外れたとして隠さない
    focused_since_shown: AtomicBool,
}

/// 設定と、トレイに出す問題。設定画面から変えると、ここと設定のファイルの両方を更新する
struct AppState {
    /// このデバイスだけの設定のファイル（device.rs）。OS 標準のアプリ設定フォルダーにある
    device_path: PathBuf,
    device: Mutex<device::Device>,
    /// 設定の置き場（docs/config.md「置き場」）。利用者が選んだフォルダーか、OS 標準のアプリ設定フォルダー
    settings_dir: Mutex<PathBuf>,
    /// 置き場を選んでいないときの置き場。OS 標準のアプリ設定フォルダー
    default_settings_dir: PathBuf,
    /// MSIX 版で回される先を求めるための、AppData のフォルダー（shown_path）
    #[cfg(windows)]
    roaming_dir: PathBuf,
    #[cfg(windows)]
    local_dir: PathBuf,
    /// 選んだ置き場のフォルダーがあるか。無い間（クラウドストレージのドライブがまだつながっていないなど）は、
    /// 設定と履歴を書かない。既定のままの設定で書くと、つながった後に同期先のファイルを既定で上書きするため
    settings_dir_available: AtomicBool,
    /// 設定の置き場の見張り。置き場を替えたら張り直す
    watch: Mutex<Option<settings_watch::Watch>>,
    /// 置き場にするフォルダーの窓で選んだフォルダーと、その直後に作ったブックマーク（folder_access.rs）。
    /// 置き場を替えると決めたら device.json に残す。ブックマークは、窓で選んだ許可があるうちにしか作れないため
    picked_bookmark: Mutex<Option<(PathBuf, String)>>,
    /// 設定のバックアップの置き場（backup.rs）。置き場に置くと、同期したほかのデバイスのバックアップと混ざるので、デバイスの手元に置く
    backups_dir: PathBuf,
    /// アプリのバージョン。ログの先頭に出しているものと同じ出どころにして、突き合わせられるようにする
    version: String,
    /// OS の言語設定から決めた言語。表示言語が「システム」のときに使う
    system_lang: Lang,
    config: Mutex<Config>,
    problems: Mutex<Problems>,
    /// 設定ウィンドウを作っている最中か。作成は非同期なので、連打で2つ作ろうとするのを止める
    settings_opening: AtomicBool,
    /// トレイの ⚠ の項目で頼まれた、設定画面に出す分類。画面が取りに来たら空にする（open_settings_at）
    settings_category: Mutex<Option<SettingsCategory>>,
    /// メニューを開いている間だけ登録を外しているホットキー（macOS）。閉じたらこれを登録し直す
    #[cfg(target_os = "macos")]
    hotkey_paused_for_menu: Mutex<Option<String>>,
    #[cfg(target_os = "linux")]
    portal_hotkey: portal_hotkey::PortalHotkey,
    /// 開いているメニューの深さ（macOS）。サブメニューなどで開く・閉じるの通知が入れ子になっても、
    /// いちばん外のメニューを開いたときに外し、閉じたときに戻す
    #[cfg(target_os = "macos")]
    menu_depth: std::sync::atomic::AtomicUsize,
}

impl AppState {
    fn lang(&self) -> Lang {
        Lang::resolve(self.config.lock().unwrap().language, self.system_lang)
    }

    fn settings_dir(&self) -> PathBuf {
        self.settings_dir.lock().unwrap().clone()
    }

    /// 履歴のファイルを置くフォルダー（docs/config.md「履歴」）
    fn history_dir(&self) -> PathBuf {
        self.settings_dir().join(history_store::DIR_NAME)
    }

    /// このデバイスの履歴のファイル。ほかのデバイスのファイルは読むだけで書かない
    fn history_path(&self) -> PathBuf {
        let id = self.device.lock().unwrap().id.clone();
        self.history_dir().join(format!("{id}.json"))
    }
}

/// トレイメニューに ⚠ 付きで出し、設定画面の該当する行に詳しく出す問題。表示言語が変わったら文言を作り直すので、原因だけを持つ
#[derive(Default)]
struct Problems {
    config: Option<ConfigProblem>,
    hotkey_unavailable: bool,
    autostart_failed: Option<autostart::SetError>,
}

/// 設定の置き場についてトレイと設定画面に出すこと。直して読めたら消す
#[derive(PartialEq)]
enum ConfigProblem {
    /// 読めなかった設定のファイルの名前。読めたファイルの設定と、読めないファイルは前に読めた設定（起動のときは既定）で動かす
    Unreadable(Vec<String>),
    /// 選んだ置き場のフォルダーか、設定のファイルの symlink の先が無い（`unavailable_settings_place`）。現れるまで何も書かない
    FolderMissing(String),
    /// macOS のサンドボックスが、設定のファイルの symlink の先を読ませない。許可されるまで何も書かない
    /// （docs/config.md「macOS のサンドボックス」）。パスは許可が要る先
    AccessDenied(PathBuf),
}

impl ConfigProblem {
    fn unavailable(place: &Unreachable) -> Self {
        match place {
            Unreachable::Missing(path) => ConfigProblem::FolderMissing(path.display().to_string()),
            Unreachable::Denied(path) => ConfigProblem::AccessDenied(path.clone()),
        }
    }
}

/// 設定画面の「設定の保存先」に出す、設定の保存先の問題（ConfigProblem）
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SettingsProblem {
    /// 読めなかった設定のファイルの名前
    Unreadable { files: Vec<String> },
    /// 見つからない、選んだ置き場のフォルダーか symlink の先。置き場そのものなら、画面は settings_dir と同じ書き方で
    /// 受け取り、パスを繰り返さずに出す
    FolderMissing { path: String },
    /// 読む許可が要る、設定のファイルの symlink の先（macOS のサンドボックス）。画面は許可を求めるボタンを出す
    AccessNeeded { path: String },
}

impl SettingsProblem {
    fn new(problem: &ConfigProblem, state: &AppState) -> Self {
        match problem {
            ConfigProblem::Unreadable(files) => SettingsProblem::Unreadable {
                files: files.clone(),
            },
            ConfigProblem::FolderMissing(path) => SettingsProblem::FolderMissing {
                path: shown_path(state, PathBuf::from(path)).display().to_string(),
            },
            ConfigProblem::AccessDenied(target) => SettingsProblem::AccessNeeded {
                path: target.display().to_string(),
            },
        }
    }
}

/// トレイの ⚠ の項目から設定ウィンドウを開くときに出す分類。問題の行のある分類を出す（settings-categories.ts の value）
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
enum SettingsCategory {
    General,
    Keys,
}

impl Problems {
    fn is_empty(&self) -> bool {
        self.config.is_none() && !self.hotkey_unavailable && self.autostart_failed.is_none()
    }
}

/// 設定を画面に渡した回数。渡すたびに1つ進め、SettingsView の revision に入れる
static SETTINGS_REVISION: AtomicU64 = AtomicU64::new(0);

/// `get_settings` と `settings-changed` で画面側に渡す設定。
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    /// 何回目に渡した設定か。画面は、コマンドの返事より前の設定か後の設定かを、これで見分ける
    revision: u64,
    /// 下書きウィンドウを出すグローバルホットキー
    hotkey: String,
    /// 設定画面で既定から変えた印を付ける項目名
    modified_settings: Vec<String>,
    text_window_keys: DraftKeys,
    /// 「既定に戻す」を押せるかを見るための既定のキー。既定は Rust 側だけで決める
    default_draft_keys: DraftKeys,
    /// ホットキーの「既定に戻す」で戻すキー
    default_hotkey: &'static str,
    /// ホットキーをアプリでなくデスクトップで割り当てるか（Linux の Wayland。toggle.rs・portal_hotkey.rs）
    hotkey_by_desktop: bool,
    /// デスクトップが portal で付けたホットキーの表示。portal で付いていなければ None で、画面は `mawok --toggle` の割り当てを案内する
    desktop_hotkey: Option<String>,
    /// `desktop_hotkey` を設定のホットキーと同じ書き方に読めたもの。読めなければ None で、画面は `desktop_hotkey` をそのまま出す
    desktop_hotkey_keys: Option<String>,
    /// デスクトップの、ホットキーを割り当て直す画面を開けるか
    desktop_hotkey_configurable: bool,
    /// ログイン時に起動するか
    autostart: bool,
    language: Language,
    theme: Theme,
    /// 下書きウィンドウを常に最前面に表示するか
    text_window_always_on_top: bool,
    /// 下書きウィンドウからフォーカスが外れたら、コピーせずに隠すか
    hide_text_window_on_blur: bool,
    /// 下書きの入力欄の上下に、操作のボタンを出すか
    show_text_window_buttons: bool,
    /// 下書きの履歴の件数。0 なら覚えない
    text_history_size: u16,
    trim_trailing_whitespace: bool,
    replacements: Vec<Replacement>,
    /// 定型文。登録した順
    snippets: Vec<Snippet>,
    /// 設定の置き場のフォルダー
    settings_dir: String,
    /// 置き場が OS 標準のアプリ設定フォルダーか。そうでなければ画面は「既定に戻す」を出す
    settings_dir_is_default: bool,
    /// 設定の保存先の問題。画面は「設定の保存先」に知らせを出す
    settings_problem: Option<SettingsProblem>,
    /// 設定のホットキーを OS に登録できていないか。画面はホットキーの行に知らせを出す
    hotkey_unavailable: bool,
    /// ログイン時の起動を OS に設定できなかった理由。画面は「ログイン時に起動」の行に出す
    autostart_failed: Option<String>,
    punctuation_style: PunctuationStyle,
    char_widths: CharWidths,
    /// コピーするときに、クリップボードの履歴・同期・管理アプリに残さないよう印を付けるか
    exclude_from_clipboard_history: bool,
    /// 下書きの入力欄のフォント。CSS の font-family の並び。空なら OS 標準
    text_font_family: String,
    /// 下書きの入力欄の文字の大きさ（px）
    text_font_size: u16,
    /// 下書きの入力欄の案内。None なら既定の案内（文言は画面側で今の言語とホットキーから作る）
    input_guidance: Option<String>,
    /// 下書きの入力欄の文字色（ライト）。小文字の #rrggbb。空なら標準の色
    text_color_light: String,
    /// 下書きの入力欄の文字色（ダーク）。小文字の #rrggbb。空なら標準の色
    text_color_dark: String,
    /// アプリのバージョン。ログの先頭に出しているものと同じ
    version: String,
    /// 表示言語の設定と OS の言語から決めた Paraglide のロケール
    locale: &'static str,
    /// 画面は OS ごとにキーの表記や閉じるキーを変える
    platform: Platform,
}

fn settings_view(state: &AppState) -> SettingsView {
    // 番号は設定を読むのと同じロックの中で振り、番号の順と中身の順を揃える
    let (config, revision) = {
        let config = state.config.lock().unwrap();
        (
            config.clone(),
            SETTINGS_REVISION.fetch_add(1, Ordering::SeqCst) + 1,
        )
    };
    let lang = Lang::resolve(config.language, state.system_lang);
    let settings_dir = state.settings_dir();
    let settings_dir_is_default = state.device.lock().unwrap().settings_dir.is_none();
    let (settings_problem, hotkey_unavailable, autostart_failed) = {
        let problems = state.problems.lock().unwrap();
        (
            problems
                .config
                .as_ref()
                .map(|problem| SettingsProblem::new(problem, state)),
            problems.hotkey_unavailable,
            problems
                .autostart_failed
                .as_ref()
                .map(|error| autostart_error_text(error, lang)),
        )
    };
    let modified_settings = config::modified_settings(&config);
    #[cfg(target_os = "linux")]
    let desktop_hotkey = state.portal_hotkey.trigger.lock().unwrap().clone();
    #[cfg(not(target_os = "linux"))]
    let desktop_hotkey: Option<String> = None;
    SettingsView {
        revision,
        settings_dir: shown_path(state, settings_dir).display().to_string(),
        settings_dir_is_default,
        settings_problem,
        hotkey_unavailable,
        autostart_failed,
        locale: lang.code(),
        platform: Platform::current(),
        hotkey: config.hotkey,
        modified_settings,
        text_window_keys: config.text_window_keys,
        default_draft_keys: DraftKeys::default(),
        default_hotkey: config::DEFAULT_HOTKEY,
        hotkey_by_desktop: hotkey_by_desktop(),
        #[cfg(target_os = "linux")]
        desktop_hotkey_keys: desktop_hotkey
            .as_deref()
            .and_then(portal_hotkey::accelerator_from_trigger),
        #[cfg(not(target_os = "linux"))]
        desktop_hotkey_keys: None,
        desktop_hotkey,
        #[cfg(target_os = "linux")]
        desktop_hotkey_configurable: state.portal_hotkey.configurable.load(Ordering::Relaxed),
        #[cfg(not(target_os = "linux"))]
        desktop_hotkey_configurable: false,
        autostart: config.autostart,
        language: config.language,
        theme: config.theme,
        text_window_always_on_top: config.text_window_always_on_top,
        hide_text_window_on_blur: config.hide_text_window_on_blur,
        show_text_window_buttons: config.show_text_window_buttons,
        text_history_size: config.text_history_size,
        trim_trailing_whitespace: config.trim_trailing_whitespace,
        replacements: config.replacements,
        snippets: config.snippets,
        punctuation_style: config.punctuation_style,
        char_widths: config.char_widths,
        exclude_from_clipboard_history: config.exclude_from_clipboard_history,
        text_font_family: config.text_font_family,
        text_font_size: config.text_font_size,
        input_guidance: config.input_guidance,
        text_color_light: config.text_color_light,
        text_color_dark: config.text_color_dark,
        version: state.version.clone(),
    }
}

/// 画面に出すパス。MSIX 版では、AppData の下へ書いたファイルがパッケージの中へ回されるので、回された先を出す。
/// 元のパスは、パッケージの外（エディターや同期のアプリ）からは開けないため
fn shown_path(state: &AppState, path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        package::path_for_explorer(path, &state.roaming_dir, &state.local_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        path
    }
}

/// window-state プラグインに戻させるもの。Windows だけで使う。
/// macOS では AppKit に任せ（docs/platform.md「macOS の窓の位置と大きさ」）、Linux では位置も大きさも戻さず、毎回既定の大きさで開く（docs/platform.md「Linux のそのほか」）
fn window_state_flags() -> StateFlags {
    #[cfg(windows)]
    {
        StateFlags::POSITION | StateFlags::SIZE
    }
    #[cfg(not(windows))]
    {
        StateFlags::empty()
    }
}

/// ウィンドウの位置と大きさを記録するときの名前（window-state プラグインと、macOS の AppKit の frame autosave で使う）。
/// 最小の大きさがなかったころの記録（最小より小さいことがある）を戻さないよう、
/// 名前を変えて記録がない状態から始める。どちらも記録した大きさを最小と比べずに当てるため。
/// 新しい記録は最小の大きさがかかったウィンドウで取るので、最小を割らない。最小の大きさを引き上げたときも、同じく名前を変える
fn window_state_key(label: &str) -> &str {
    match label {
        SETTINGS_WINDOW => "settings-resizable",
        MAIN_WINDOW => "main-min-size",
        LICENSES_WINDOW => "licenses-min-480",
        _ => label,
    }
}

fn window_theme(theme: Theme) -> Option<WindowTheme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(WindowTheme::Light),
        Theme::Dark => Some(WindowTheme::Dark),
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 設定を開くときに、出ている下書きを隠す。コピーはしないので、書きかけはそのまま残る。
/// アプリごと隠す hide_and_return とは違い、ウィンドウだけを隠す（設定ウィンドウはこれから出す）
fn hide_draft_for_settings(app: &AppHandle) {
    let hidden = main_window(app)
        .filter(|window| window.is_visible().unwrap_or(false))
        .is_some_and(|window| {
            info!("hide draft for settings");
            window.hide().is_ok()
        });
    // 立てるだけで、寝かせない。すでに開いている設定を前面に出すときはここを通っても隠す下書きがなく、
    // false で上書きすると、最初に隠したことを忘れて出し直せなくなる。
    // 寝かせるのは、出し直したときと、ユーザーが自分で下書きを出し入れしたとき
    if hidden {
        app.state::<DraftState>()
            .hidden_for_settings
            .store(true, Ordering::Relaxed);
    }
}

fn show(app: &AppHandle) {
    show_draft(app, true);
}

/// トレイの「テキストウィンドウを表示／隠す」。出ていれば、Esc や閉じるボタンと同じくコピーせずに隠し、書きかけは残す。
/// 隠れていれば出す。ほかのウィンドウの裏にあって見えていなくても、出ていれば隠す（切り替えなので、前へは出さない）
fn toggle_draft(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        error!("tray: main window not found");
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        show(app);
        return;
    }
    let state = app.state::<DraftState>();
    // 下書きにフォーカスがあるとき（macOS はメニューを開いてもフォーカスが移らない）だけ、Esc と同じく戻り先へ戻す。
    // ないときは、ユーザーはすでにほかのアプリを使っているので、戻すとそこから前面を奪う。
    // Windows ではアイコンを押した時点でフォーカスがタスクバーへ移るので、いつもこちらになる
    if window.is_focused().unwrap_or(false) {
        info!("hide draft from tray");
        if let Err(error) = hide_draft_and_return(app, &state) {
            error!("hide from tray failed: {error}");
        }
        return;
    }
    info!("hide draft from tray without returning focus");
    state.hidden_for_settings.store(false, Ordering::Relaxed);
    if let Err(error) = hide_draft_in_place(app, &window) {
        error!("hide from tray failed: {error}");
    }
}

/// 設定ウィンドウを閉じた後に出し直す。出せたかどうかを返す。
/// 戻り先は記録し直さない。記録し直すと、隠す前に覚えた戻り先が設定ウィンドウで上書きされてしまう
#[must_use]
fn show_again(app: &AppHandle) -> bool {
    show_draft(app, false)
}

/// 下書きウィンドウを出す。出せたかどうかを返す
fn show_draft(app: &AppHandle, capture_return_target: bool) -> bool {
    let Some(window) = main_window(app) else {
        error!("show: main window not found");
        return false;
    };
    info!("show");
    if capture_return_target {
        *app.state::<DraftState>().return_target.lock().unwrap() = focus::capture(&window);
    }
    fit_to_screen(&window);
    // 出した後にフォーカスが入ったかを、ここから数え直す
    app.state::<DraftState>()
        .focused_since_shown
        .store(false, Ordering::Relaxed);
    if let Err(error) = focus::show_draft(app, &window) {
        error!("show: couldn't show the window: {error}");
        // 出せていないのに記録を寝かせると、隠れたまま戻せなくなる
        return false;
    }
    if capture_return_target {
        // 自分で出したものは、設定を閉じたときに出し直す対象ではない
        app.state::<DraftState>()
            .hidden_for_settings
            .store(false, Ordering::Relaxed);
    }
    let _ = app.emit(events::SHOWN, ());
    true
}

fn on_hotkey(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        error!("hotkey: main window not found");
        return;
    };
    // 表示中でも別のウィンドウが前面にあるときは、隠さずに前面へ出す
    if is_in_front(&window) {
        info!("hotkey: hide requested");
        let _ = app.emit(events::HIDE_REQUESTED, ());
    } else {
        show(app);
    }
}

/// 初めての起動で、portal の確かめの画面の返事を待って下書きを出すまでの上限
#[cfg(target_os = "linux")]
const PORTAL_CONFIRMATION_WAIT: Duration = Duration::from_secs(60);

/// Wayland のホットキーを portal に登録する。portal が無いデスクトップでは、`mawok --toggle` の案内のまま
#[cfg(target_os = "linux")]
fn start_portal_hotkey(app: AppHandle, show_after: bool) {
    // 初めての起動の下書きは、確かめの画面が閉じてから出す。返事が来ないまま（画面がほかの窓の裏にある・portal が固まった）でも、
    // 何も出ない常駐にならないよう、待つのは利用者が確かめの画面を読んで答える程度の間までにする
    let first_show = std::sync::Arc::new(AtomicBool::new(!show_after));
    let show_first = {
        let (app, first_show) = (app.clone(), first_show.clone());
        move || {
            if first_show.swap(true, Ordering::Relaxed) {
                return;
            }
            info!("first launch: show the draft");
            let shown = app.clone();
            let _ = app.run_on_main_thread(move || {
                show(&shown);
            });
        }
    };
    if show_after {
        let show_first = show_first.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PORTAL_CONFIRMATION_WAIT).await;
            show_first();
        });
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let (description, hotkey) = (
            state.lang().toggle_draft(),
            state.config.lock().unwrap().hotkey.clone(),
        );
        let (activated, changed) = (app.clone(), app.clone());
        let app_id = app.config().identifier.clone();
        let started = portal_hotkey::start(
            &state.portal_hotkey,
            &app_id,
            description,
            &hotkey,
            move |token| {
                let app = activated.clone();
                let _ = activated.run_on_main_thread(move || on_toggle(&app, token.as_deref()));
            },
            move || {
                let app = changed.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        portal_hotkey::refresh(&app.state::<AppState>().portal_hotkey).await
                    {
                        warn!("couldn't read the desktop hotkey: {error}");
                    }
                    emit_settings(&app);
                });
            },
        )
        .await;
        match started {
            Ok(()) => info!("hotkey registered with the desktop portal"),
            // portal が無い・利用者が断った・失敗した。どれも mawok --toggle の案内に落ちる
            Err(error) => info!("hotkey not registered with the desktop portal: {error}"),
        }
        emit_settings(&app);
        show_first();
    });
}

/// デスクトップの、ホットキーを割り当て直す画面を開く
#[tauri::command]
async fn configure_desktop_hotkey(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        portal_hotkey::configure(&app.state::<AppState>().portal_hotkey)
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = portal_hotkey::refresh(&app.state::<AppState>().portal_hotkey).await {
            warn!("couldn't read the desktop hotkey: {error}");
        }
        emit_settings(&app);
    }
    let _ = app;
    Ok(())
}

/// `mawok --toggle` で呼ばれたとき。呼んだデスクトップの印があれば、窓を前に出すのに使う
#[cfg(target_os = "linux")]
fn on_toggle(app: &AppHandle, activation_token: Option<&str>) {
    if let (Some(token), Some(window)) = (activation_token, main_window(app)) {
        use gtk::prelude::GtkWindowExt;
        match window.gtk_window() {
            Ok(gtk_window) => gtk_window.set_startup_id(token),
            Err(error) => warn!("couldn't pass the activation token: {error}"),
        }
    }
    on_hotkey(app);
}

/// 出ていて、フォーカスがあるか。確かめられなければ、ないものとする
fn is_in_front(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
}

/// 設定ウィンドウにフォーカスがあるか。確かめられなければ、ないものとする
fn is_settings_focused(app: &AppHandle) -> bool {
    app.get_webview_window(SETTINGS_WINDOW)
        .is_some_and(|settings| settings.is_focused().unwrap_or(false))
}

fn fit_to_screen(window: &WebviewWindow) {
    let (Ok(position), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) else {
        return;
    };
    let mut areas: Vec<placement::Rect> = monitors
        .iter()
        .map(|monitor| to_rect(monitor.work_area()))
        .collect();
    if let Ok(Some(primary)) = window.primary_monitor() {
        let primary = to_rect(primary.work_area());
        areas.retain(|area| *area != primary);
        areas.insert(0, primary);
    }
    let outer = placement::Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    };
    // 見えている枠で収める。Windows の外枠には見えないリサイズの枠（左右と下に数 px）が含まれ、
    // 外枠で収めると、画面の端に寄せた窓が出すたびに内側へ動くため
    let visible = visible_frame(window).unwrap_or(outer);
    let (x, y) = placement::fit(visible, &areas);
    if (x, y) != (visible.x, visible.y) {
        let _ = window.set_position(PhysicalPosition::new(
            x - (visible.x - outer.x),
            y - (visible.y - outer.y),
        ));
    }
}

/// 窓の見えている枠（物理ピクセル）。Windows では DWM の DWMWA_EXTENDED_FRAME_BOUNDS で、見えないリサイズの枠を除く
#[cfg(windows)]
fn visible_frame(window: &WebviewWindow) -> Option<placement::Rect> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};

    let hwnd = window.hwnd().ok()?;
    let mut rect = RECT::default();
    // SAFETY: 書き込み先は RECT 1 つ分で、その大きさを渡す
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            size_of::<RECT>() as u32,
        )
    }
    .ok()?;
    Some(placement::Rect {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

/// Windows のほかは、外枠がそのまま見えている枠
#[cfg(not(windows))]
fn visible_frame(_window: &WebviewWindow) -> Option<placement::Rect> {
    None
}

fn to_rect(area: &PhysicalRect<i32, u32>) -> placement::Rect {
    placement::Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    }
}

/// 入力内容をクリップボードへコピーし、直前のアプリへフォーカスを戻してウィンドウを隠す。
/// クリップボードへ渡したら true、整えた結果が空でクリップボードを変えなかったら false を返す（画面側は true のときだけ履歴に覚える）。
/// 同期コマンドなのでメインスレッドで実行される。エラーの文言は翻訳せずに画面に出る（見出しだけ画面の言語で出す）。
#[tauri::command]
fn commit(
    app: AppHandle,
    state: tauri::State<'_, DraftState>,
    text: String,
) -> Result<bool, String> {
    info!("commit");
    copy_and_hide(&app, &state, text).inspect_err(|error| error!("commit failed: {error}"))
}

fn copy_and_hide(app: &AppHandle, state: &DraftState, text: String) -> Result<bool, String> {
    let (trim, replacements, punctuation, widths, conceal) = {
        let state = app.state::<AppState>();
        let config = state.config.lock().unwrap();
        (
            config.trim_trailing_whitespace,
            config.replacements.clone(),
            config.punctuation_style,
            config.char_widths,
            config.exclude_from_clipboard_history,
        )
    };
    // 整えるのはクリップボードへ渡す内容だけ。置き換え辞書を先に通すのは、置き換えが末尾に空白文字を
    // 生んでも取り除けるようにするため。全角と半角・句読点を揃えるのはその後で、置き換えた結果にも効かせる。
    // 末尾の空白文字を取り除くのは最後。空になったら、空のまま隠したときと同じ扱いにする
    let replaced = text::apply_replacements(&text, &replacements);
    let widened = text::convert_widths(&replaced, &widths);
    let unified = text::unify_punctuation(&widened, punctuation);
    let text = if trim {
        text::trim_trailing_whitespace(&unified)
    } else {
        unified.as_ref()
    };
    let copied = !text.is_empty();
    if copied {
        write_clipboard(text, conceal).map_err(|error| error.to_string())?;
    }
    hide_draft_and_return(app, state)?;
    Ok(copied)
}

/// コピー時に置き換え辞書で書き換わる範囲を一覧にする（下書き入力中のハイライト表示用）。
/// `commit` と同じ辞書を読むが、クリップボードやウィンドウには触れない同期コマンド
#[tauri::command]
fn preview_replacement_matches(
    state: tauri::State<'_, AppState>,
    text: String,
) -> Vec<ReplacementMatch> {
    let replacements = state.config.lock().unwrap().replacements.clone();
    text::find_replacement_matches(&text, &replacements)
}

/// コピーせずに、直前のアプリへフォーカスを戻してウィンドウを隠す（Esc）。書きかけは画面側の入力欄に残る
#[tauri::command]
fn dismiss(app: AppHandle, state: tauri::State<'_, DraftState>) -> Result<(), String> {
    info!("dismiss");
    hide_draft_and_return(&app, &state).inspect_err(|error| error!("dismiss failed: {error}"))
}

/// フォーカスが外れた知らせから、隠すかを確かめるまで待つ時間。Windows の WebView2 はウィンドウの中のクリックでも
/// 知らせが外れて戻ることがあり（tauri#10767）、隠す操作そのものも知らせを起こすため、すぐには決めない
const HIDE_ON_BLUR_DELAY: std::time::Duration = std::time::Duration::from_millis(150);

/// フォーカスが外れた後に、下書きを隠すかを決める材料
#[derive(Debug, Clone, Copy)]
struct BlurCheck {
    /// 設定のテキストウィンドウの「ほかのアプリに移ったら隠す」
    enabled: bool,
    visible: bool,
    /// 出してから一度でもフォーカスが入ったか。Windows で前面に出せなかったとき（前面の制限）など、
    /// 一度も入っていないのに外れた知らせが届いても、ユーザーがほかへ移ったわけではない
    focused_since_shown: bool,
    /// 待つ間にフォーカスが戻っていないか
    focused: bool,
    /// 設定ウィンドウにフォーカスが移ったか
    settings_focused: bool,
    /// 設定ウィンドウを作っている最中か
    settings_opening: bool,
}

/// 隠すのは、出ていて、一度フォーカスが入った後に外れたままで、それが設定ウィンドウのためではないときだけ
fn should_hide_on_blur(check: BlurCheck) -> bool {
    check.enabled
        && check.visible
        && check.focused_since_shown
        && !check.focused
        && !check.settings_focused
        && !check.settings_opening
}

/// 初めての起動として下書きを出すか。このデバイスの設定のファイルがなかったうえで、作れたときだけ。
/// 作れなかったら、次の起動でもファイルがなく、起動のたびに出てしまうため。設定の置き場は見ない。
/// ほかのデバイスと同期した置き場を選んでいても、このデバイスで初めて起動したなら、使い方を伝えるため
fn is_first_launch(device_missing: bool, device_saved: bool) -> bool {
    device_missing && device_saved
}

/// 下書きウィンドウからフォーカスが外れたときに呼ぶ。知らせが落ち着いてから、まだ外れたままなら隠す
fn schedule_hide_on_blur(app: &AppHandle) {
    let handle = app.clone();
    app.state::<DraftState>()
        .blur
        .trigger(HIDE_ON_BLUR_DELAY, move || {
            let app = handle.clone();
            if let Err(error) = handle.run_on_main_thread(move || hide_on_blur(&app)) {
                error!("hide on blur: couldn't run on the main thread: {error}");
            }
        });
}

/// フォーカスが外れた下書きを、コピーせずに隠す。書きかけは画面側の入力欄に残る。
/// Esc の hide_draft_and_return とは違い、戻り先へフォーカスを戻さない。フォーカスはすでにクリックした先へ移っていて、
/// 戻すとそこから前面を奪ったり（Windows）、アプリごと隠して設定ウィンドウまで隠したり（macOS）するため
fn hide_on_blur(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let state = app.state::<AppState>();
    let check = BlurCheck {
        enabled: state.config.lock().unwrap().hide_text_window_on_blur,
        visible: window.is_visible().unwrap_or(false),
        focused_since_shown: app
            .state::<DraftState>()
            .focused_since_shown
            .load(Ordering::Relaxed),
        // 確かめられなければ、隠さない側に倒す
        focused: window.is_focused().unwrap_or(true),
        settings_focused: is_settings_focused(app),
        settings_opening: state.settings_opening.load(Ordering::Relaxed),
    };
    if !should_hide_on_blur(check) {
        // 隠さない設定で、ほかのアプリへ移ったなら、戻り先をそのアプリにする。出したときのアプリのままだと、
        // 別のアプリを経由して戻ってきてコピーしたときに、最初のアプリへ戻ってしまう（Windows）。
        // macOS と Linux は、戻り先を OS が決める前面の扱いに任せているので触らない
        if cfg!(windows)
            && !check.enabled
            && check.visible
            && !check.focused
            && !check.settings_focused
            && !check.settings_opening
            // 自分のほかの窓（ライセンス・使い方）へ移ったときは、戻り先にしない
            && !app
                .webview_windows()
                .values()
                .any(|other| other.is_focused().unwrap_or(false))
        {
            *app.state::<DraftState>().return_target.lock().unwrap() = focus::capture(&window);
        }
        return;
    }
    info!("hide on blur");
    if let Err(error) = hide_draft_in_place(app, &window) {
        error!("hide on blur failed: {error}");
    }
}

/// 下書きウィンドウの設定（`tauri.conf.json`）。設定では作らせず（`create: false`）、setup でこれから作る。
/// macOS では中央に置かせない。Tauri は中央の位置を、作った後に後回しで当てるので、AppKit で戻した位置が上書きされる。
/// 記録が無いときは window_frame が中央に置く
fn main_window_config(app: &AppHandle) -> Result<tauri::utils::config::WindowConfig, &'static str> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .ok_or("main window config not found")?;
    #[cfg(target_os = "macos")]
    {
        config.center = false;
    }
    Ok(config)
}

/// 下書きウィンドウを、戻り先へフォーカスを戻さずに隠す
fn hide_draft_in_place(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let _ = app.save_window_state(window_state_flags());
    window.hide()?;
    Ok(())
}

/// 下書きウィンドウを隠して、直前のアプリへフォーカスを戻す。コピーするときも、しないときも通る
fn hide_draft_and_return(app: &AppHandle, state: &DraftState) -> Result<(), String> {
    let _ = app.save_window_state(window_state_flags());
    // 自分で隠したものを、設定を閉じたときに出し直さない
    state.hidden_for_settings.store(false, Ordering::Relaxed);
    let window = main_window(app).ok_or("main window not found")?;
    let target = *state.return_target.lock().unwrap();
    focus::hide_and_return(app, &window, target).map_err(|error| error.to_string())
}

/// クリップボードへ文字列を書く。`conceal` のときは、クリップボードの履歴・同期・管理アプリに残さないよう印を付ける。
/// Tauri のクリップボードのプラグインは印を付けて書けないので、arboard を直接使う
fn write_clipboard(text: &str, conceal: bool) -> Result<(), arboard::Error> {
    // Windows では行末を CR+LF にする（text::crlf_line_endings）。履歴と入力欄は LF のまま持つ
    let text = if cfg!(windows) {
        text::crlf_line_endings(text)
    } else {
        std::borrow::Cow::Borrowed(text)
    };
    with_clipboard(|clipboard| write_text(clipboard, &text, conceal))
}

fn write_text(
    clipboard: &mut arboard::Clipboard,
    text: &str,
    conceal: bool,
) -> Result<(), arboard::Error> {
    let set = clipboard.set();
    #[cfg(target_os = "macos")]
    let set = if conceal {
        use arboard::SetExtApple;
        // クリップボード管理アプリに広く通じる慣習（nspasteboard.org）。従うかどうかは履歴を持つ側しだい
        set.exclude_from_history()
    } else {
        set
    };
    #[cfg(windows)]
    let set = if conceal {
        use arboard::SetExtWindows;
        // 履歴（Win+V）・ほかのデバイスへの同期・監視するアプリのすべてから外す。
        // これを付けたら、履歴と同期だけを外す指定は重ねない（arboard の説明による）
        set.exclude_from_monitoring()
    } else {
        set
    };
    // KDE の慣習の MIME 型（arboard の説明による）
    #[cfg(target_os = "linux")]
    let set = if conceal {
        use arboard::SetExtLinux;
        set.exclude_from_history()
    } else {
        set
    };
    set.text(text)
}

/// Linux のクリップボードは、書いたプロセスが求めに応じて中身を配る。arboard は最後の Clipboard を手放すと配るのをやめるので、
/// クリップボードマネージャーの無い環境でもコピーした中身が残るよう、プロセスの間ずっと持っておく
#[cfg(target_os = "linux")]
fn with_clipboard<T>(
    use_it: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
    let mut clipboard = CLIPBOARD.lock().unwrap();
    if clipboard.is_none() {
        *clipboard = Some(arboard::Clipboard::new()?);
    }
    use_it(clipboard.as_mut().expect("just created"))
}

#[cfg(not(target_os = "linux"))]
fn with_clipboard<T>(
    use_it: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    use_it(&mut arboard::Clipboard::new()?)
}

/// 画面の読み込みが終わったときに呼ばれる。表示中なら WebView にキーボードのフォーカスを移して true を返し、画面側は表示時の処理をする。
/// 読み込み中に表示されると shown を取り逃がすうえ、表示中に描画プロセスが落ちて再読み込みした後は、
/// ウィンドウにフォーカスがあっても WebView には戻らない（Windows）ため。
#[tauri::command]
fn page_ready(window: WebviewWindow) -> bool {
    let active = is_in_front(&window);
    let since_start = STARTED_AT
        .get()
        .map_or(0, |started| started.elapsed().as_millis());
    info!(
        "page ready ({} {since_start} ms after start, active: {active})",
        window.label()
    );
    if active {
        let webview: &Webview = window.as_ref();
        if let Err(error) = webview.set_focus() {
            error!("page ready: couldn't focus the webview: {error}");
        }
    }
    active
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> SettingsView {
    settings_view(&state)
}

/// 設定を変えて保存する。保存できなければ何も変えない。画面とトレイへの反映は `apply_config` で行う
fn save_config(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    save_config_as(app, false, change)
}

/// `restoring` なら、変えた項目だけでなく全部の項目を書き、読めないファイルは写して除けてから書き直す（バックアップから戻すとき）
fn save_config_as(
    app: &AppHandle,
    restoring: bool,
    change: impl FnOnce(&mut Config),
) -> Result<(), String> {
    settings_dir_ready(app);
    let state = app.state::<AppState>();
    let mut config = state.config.lock().unwrap();
    let mut next = config.clone();
    change(&mut next);
    write_config(&state, &config, &next, restoring)?;
    *config = next;
    Ok(())
}

/// 設定をファイルに書く。ログイン時の起動はデバイスの設定に、ほかは置き場の設定のファイルに書く。
/// 置き場には、ふだんは今の設定から変えた項目だけを書く（settings_files::Scope::Changed）
fn write_config(
    state: &AppState,
    current: &Config,
    next: &Config,
    restoring: bool,
) -> Result<(), String> {
    let autostart = (next.autostart != Config::default().autostart).then_some(next.autostart);
    {
        let mut device = state.device.lock().unwrap();
        if device.autostart != autostart {
            let updated = device::Device {
                autostart,
                ..device.clone()
            };
            device::save(&state.device_path, &updated).map_err(|error| error.to_string())?;
            *device = updated;
        }
    }
    let mut entries = config::stored_entries(next);
    entries.remove(config::key::AUTOSTART);
    // 置き場の設定と今の設定が同じなら書かない。置き場が無い間に、デバイスの設定（ログイン時の起動）だけを変えたときのため
    let mut unchanged = config::stored_entries(current);
    unchanged.remove(config::key::AUTOSTART);
    if !state.settings_dir_available.load(Ordering::SeqCst) {
        let denied = matches!(
            state.problems.lock().unwrap().config,
            Some(ConfigProblem::AccessDenied(_))
        );
        return if unchanged == entries {
            Ok(())
        } else if denied {
            Err(error_codes::SETTINGS_ACCESS_DENIED.to_string())
        } else {
            Err(error_codes::SETTINGS_FOLDER_UNAVAILABLE.to_string())
        };
    }
    let scope = if restoring {
        settings_files::Scope::All {
            set_aside_unreadable: true,
        }
    } else {
        settings_files::Scope::Changed(&unchanged)
    };
    settings_files::write(
        &state.settings_dir(),
        &os_name(),
        config::key::IN_FILES,
        scope,
        &entries,
    )
}

/// 設定のファイルで、OS ごとの欄に付ける名前（`macos`・`windows`・`linux`）
fn os_name() -> String {
    config::choice_name(&Platform::current())
}

/// 今の設定と問題を、開いているウィンドウとトレイに反映する
fn apply_config(app: &AppHandle) {
    emit_settings(app);
    refresh_tray(app);
}

/// 今の設定を、開いているウィンドウに知らせる
fn emit_settings(app: &AppHandle) {
    let _ = app.emit(
        events::SETTINGS_CHANGED,
        settings_view(&app.state::<AppState>()),
    );
}

/// 打つたびに呼ばれる設定を保存する。トレイは作り直さない
fn save_as_typed(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    save_config(app, change)
}

/// 設定を変えて保存し、開いているウィンドウとトレイに反映する。保存できなければ何も変えない
fn update_config(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    save_config(app, change)?;
    apply_config(app);
    Ok(())
}

/// ほかで変わった設定のファイルから読んだ設定・バックアップから戻す設定を入れ、画面から変えるコマンドと同じ反映を通す。
/// OS に断られて反映できなかった項目（最前面・ホットキー）は今の値のままにして、その項目名を返す。
/// `write` は、入れた設定をファイルに書くか（ファイルから読んだ設定は、断った項目を書き戻さずにファイルの値のまま残すので書かない）
fn adopt_config(
    app: &AppHandle,
    mut next: Config,
    write: bool,
) -> Result<Vec<&'static str>, String> {
    let state = app.state::<AppState>();
    let current = state.config.lock().unwrap().clone();
    let mut rejected = Vec::new();
    // ウィンドウとホットキーは、コマンドと同じく入れる前に当てる。当てられない値を入れると、設定と実際が食い違う
    if next.text_window_always_on_top != current.text_window_always_on_top
        && set_draft_window_always_on_top(app, next.text_window_always_on_top).is_err()
    {
        next.text_window_always_on_top = current.text_window_always_on_top;
        rejected.push(config::key::TEXT_WINDOW_ALWAYS_ON_TOP);
    }
    if next.hotkey != current.hotkey {
        if let Err(error) =
            hotkey::replace(&mut PluginRegistrar(app), &current.hotkey, &next.hotkey)
        {
            warn!("couldn't register the hotkey from the settings file: {error}");
            next.hotkey.clone_from(&current.hotkey);
            rejected.push(config::key::HOTKEY);
            // 読んだキーは読んだホットキーと重ならないことしか確かめていない。元のホットキーと重なるなら、キーも入れない
            if draft_keys::check_hotkey(&next.text_window_keys, &next.hotkey, Platform::current())
                .is_err()
            {
                next.text_window_keys = current.text_window_keys.clone();
                next.yielded_draft_keys = current.yielded_draft_keys.clone();
                rejected.push(config::key::TEXT_WINDOW_KEYS);
            }
        }
    }
    let saved = if write {
        save_config_as(app, true, |config| *config = next.clone())
    } else {
        *state.config.lock().unwrap() = next.clone();
        Ok(())
    };
    if let Err(error) = saved {
        // 入れなかったので、先に当てたものを設定に残る値へ戻す
        if next.hotkey != current.hotkey {
            if let Err(error) =
                hotkey::replace(&mut PluginRegistrar(app), &next.hotkey, &current.hotkey)
            {
                warn!("couldn't restore the hotkey: {error}");
            }
        }
        if next.text_window_always_on_top != current.text_window_always_on_top {
            let _ = set_draft_window_always_on_top(app, current.text_window_always_on_top);
        }
        return Err(error);
    }
    if next.hotkey != current.hotkey {
        show_hotkey_registered(app, true);
    }
    if next.theme != current.theme {
        apply_theme_to_windows(app, next.theme);
    }
    if next.language != current.language {
        retitle_windows(app);
    }
    if next.text_history_size == 0 && current.text_history_size != 0 {
        if let Err(error) = clear_draft_history_file(app, true) {
            warn!("couldn't clear draft history: {error}");
        }
    }
    apply_config(app);
    Ok(rejected)
}

/// テキストウィンドウの最前面の表示を変える。ウィンドウがまだ無ければ、作るときに設定から当たる
fn set_draft_window_always_on_top(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let Some(window) = main_window(app) else {
        return Ok(());
    };
    window.set_always_on_top(enabled).map_err(|error| {
        error!("couldn't change always on top of the draft window: {error}");
        error.to_string()
    })
}

/// タイトルバーの明暗を、テーマに合わせる
fn apply_theme_to_windows(app: &AppHandle, theme: Theme) {
    for window in app.webview_windows().values() {
        let _ = window.set_theme(window_theme(theme));
    }
}

/// 開いているウィンドウのタイトルを、今の表示言語にする
fn retitle_windows(app: &AppHandle) {
    let lang = app.state::<AppState>().lang();
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.set_title(lang.settings_title());
    }
    if let Some(window) = app.get_webview_window(LICENSES_WINDOW) {
        let _ = window.set_title(lang.licenses_title());
    }
    if let Some(window) = app.get_webview_window(MANUAL_WINDOW) {
        let _ = window.set_title(lang.manual());
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("set autostart: {enabled}");
    // 保存できたときだけ OS のログイン項目を変える。順番が逆だと、保存に失敗したときに OS 側だけ変わって残る
    save_config(&app, |config| config.autostart = enabled)?;
    let failed = apply_autostart(&app, enabled);
    // 設定は保存できているので、OS への登録に失敗したことは失敗として返さず、トレイの ⚠ と画面の行の知らせに出す
    app.state::<AppState>()
        .problems
        .lock()
        .unwrap()
        .autostart_failed = failed;
    // 画面とトレイへの反映は、⚠ も決まってから一度だけ行う
    apply_config(&app);
    Ok(())
}

#[tauri::command]
fn set_language(app: AppHandle, language: Language) -> Result<(), String> {
    info!("set language: {language:?}");
    update_config(&app, |config| config.language = language)?;
    retitle_windows(&app);
    Ok(())
}

#[tauri::command]
fn set_theme(app: AppHandle, theme: Theme) -> Result<(), String> {
    info!("set theme: {theme:?}");
    update_config(&app, |config| config.theme = theme)?;
    apply_theme_to_windows(&app, theme);
    Ok(())
}

#[tauri::command]
fn set_draft_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("set draft always on top: {enabled}");
    let previous = app
        .state::<AppState>()
        .config
        .lock()
        .unwrap()
        .text_window_always_on_top;
    // 画面・設定と実際のウィンドウが食い違わないよう、先にウィンドウへ当て、当てられなければ保存しない
    set_draft_window_always_on_top(&app, enabled)?;
    update_config(&app, |config| config.text_window_always_on_top = enabled).inspect_err(|_| {
        // 保存できなければ、ウィンドウも元の値に戻す
        let _ = set_draft_window_always_on_top(&app, previous);
    })
}

#[tauri::command]
fn set_hide_draft_on_blur(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("set hide draft on blur: {enabled}");
    update_config(&app, |config| config.hide_text_window_on_blur = enabled)
}

#[tauri::command]
fn set_show_draft_buttons(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("set show draft buttons: {enabled}");
    update_config(&app, |config| config.show_text_window_buttons = enabled)
}

/// 下書きの履歴の件数。0 なら覚えない。上限は型の幅（config::MAX_DRAFT_HISTORY_SIZE）なので、収め直さない
#[tauri::command]
fn set_draft_history_size(app: AppHandle, size: u16) -> Result<(), String> {
    info!("set draft history size: {size}");
    let previous = app
        .state::<AppState>()
        .config
        .lock()
        .unwrap()
        .text_history_size;
    update_config(&app, |config| config.text_history_size = size)?;
    if size == 0 {
        clear_draft_history_file(&app, previous != 0)?;
    }
    Ok(())
}

/// 履歴ファイルの読み込み・保存・消去を直列にする。保存の途中で消去が入ると、
/// 消した後に古い中身が差し替わってしまう。終了時にも取り、書き込み中に落ちないようにする。
/// 画面が持つ履歴の写しも、ファイルと一緒にこの排他で守る
static HISTORY_FILE_LOCK: Mutex<history_store::ScreenCopy> =
    Mutex::new(history_store::ScreenCopy::new());

/// 今の時刻。UNIX のミリ秒。履歴に付ける
fn now_millis() -> u64 {
    atomic_file::unix_millis(SystemTime::now()).unwrap_or(0)
}

fn draft_history_size(app: &AppHandle) -> usize {
    app.state::<AppState>()
        .config
        .lock()
        .unwrap()
        .text_history_size as usize
}

#[tauri::command]
fn load_draft_history(app: AppHandle) -> Result<Vec<String>, String> {
    let size = draft_history_size(&app);
    let path = app.state::<AppState>().history_path();
    if size == 0 {
        clear_draft_history_file(&app, false)?;
        return Ok(Vec::new());
    }
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    if !settings_dir_ready(&app) {
        // 画面は空の一覧で始まる。置き場の履歴を読んだことにすると、現れたときの保存が、このデバイスの前の履歴を
        // 空の一覧に合わせて落とすので、画面は空の履歴を持っているとして照らさせる
        screen.replaced_by_other_devices(history_store::History::default());
        return Ok(Vec::new());
    }
    match history_store::load_merged(&path) {
        Ok(history) => {
            screen.caught_up();
            let entries = history.truncated(size).texts();
            info!("loaded draft history: {} entries", entries.len());
            Ok(entries)
        }
        Err(error) => {
            warn!("couldn't read draft history: {error}");
            // 読めなかっただけ・除けられなかっただけなら、画面はほかのデバイスの履歴をまだ持っていない。
            // 持ったことにすると、次の保存が混ぜた履歴を画面の古い一覧で上書きする
            if let history_store::LoadError::Invalid(_) = error {
                match history_store::set_aside(&path, SystemTime::now()) {
                    Ok(Some(backup)) => {
                        screen.caught_up();
                        info!(
                            "set aside the unreadable draft history to {}",
                            backup.display()
                        );
                    }
                    Ok(None) => screen.caught_up(),
                    Err(error) => warn!("couldn't set aside the unreadable draft history: {error}"),
                }
            }
            Ok(Vec::new())
        }
    }
}

/// 選んだ置き場のフォルダーがあるかを、書く前に確かめる。動いている途中で無くなっていたら（クラウドストレージのドライブが
/// 外れたなど）、無いものとしてトレイに出し、現れるのを待つ。そのまま書くと、ドライブの場所に普通のフォルダーを作って、
/// 既定の設定を書くため。symlink の先を読む許可が無いときも、許可されるまで同じく待つ
fn settings_dir_ready(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    if !state.settings_dir_available.load(Ordering::SeqCst) {
        return false;
    }
    let chosen = state.device.lock().unwrap().settings_dir.is_some();
    let Some(place) = unavailable_settings_place(&state.settings_dir(), chosen) else {
        return true;
    };
    warn!("{place:?} went away; waiting for it");
    state.settings_dir_available.store(false, Ordering::SeqCst);
    state.problems.lock().unwrap().config = Some(ConfigProblem::unavailable(&place));
    *state.watch.lock().unwrap() = None;
    apply_config(app);
    wait_for_settings_dir(app.clone());
    false
}

/// 置き場のうち読めないもの（docs/config.md「置き場」）。選んだフォルダーか、設定のファイルの symlink の先が無いか、
/// サンドボックスが読ませない。既定の置き場は、無ければ作ってよい
fn unavailable_settings_place(dir: &Path, chosen: bool) -> Option<Unreachable> {
    // 既定の置き場が、先の無い symlink（stow がフォルダーごと張ったもの）のときも無いとみる
    if chosen || dir.is_symlink() {
        match folder_access::dir_reach(dir) {
            Reach::Readable => {}
            Reach::Missing => {
                let target = folder_access::link_target(dir).unwrap_or_else(|| dir.to_path_buf());
                return Some(Unreachable::Missing(target));
            }
            Reach::Denied => {
                let target = folder_access::link_target(dir).unwrap_or_else(|| dir.to_path_buf());
                return Some(Unreachable::Denied(target));
            }
        }
    }
    settings_files::unreachable_link(dir)
}

/// device.json のブックマークから、選んだ置き場と許可したフォルダーを読み書きする許可を戻す（folder_access.rs）。
/// 古くなっていたブックマークは作り直したものに替え、替えたかを返す（呼ぶ側が device.json に書く）。
/// 戻せないもの（フォルダーを消した・ドライブがつながっていない など）は飛ばす。そのフォルダーは、無いか許可が無いものとして
/// 扱われ、現れるのを待つ間に戻し直す。`log_failures` が false なら、戻せないことをログに出さない（5 秒ごとに出さないため）
fn restore_folder_access(device: &mut device::Device, log_failures: bool) -> bool {
    let mut renewed = false;
    let bookmarks = device
        .settings_dir
        .clone()
        .zip(device.settings_dir_bookmark.as_mut())
        .into_iter()
        .chain(
            device
                .granted_folders
                .iter_mut()
                .map(|folder| (folder.path.clone(), &mut folder.bookmark)),
        );
    for (path, bookmark) in bookmarks {
        match folder_access::restore(bookmark) {
            Ok(Some(next)) => {
                info!("renewed the bookmark of {}", path.display());
                *bookmark = next;
                renewed = true;
            }
            Ok(None) => {}
            Err(error) if log_failures => {
                warn!("couldn't restore access to {}: {error}", path.display())
            }
            Err(_) => {}
        }
    }
    renewed
}

/// 許可を戻し、作り直したブックマークがあれば device.json に残す。残せなくても、今の許可は持っているので、ログにだけ出す
fn restore_folder_access_and_save(device: &mut device::Device, path: &Path, log_failures: bool) {
    if restore_folder_access(device, log_failures) {
        if let Err(error) = device::save(path, device) {
            warn!("couldn't save the renewed bookmarks: {error}");
        }
    }
}

/// 置き場のフォルダーが無い間に、画面から届いた履歴の消去と保存。現れたら、この順で書く（消去の後に届いた一覧を保存する）
#[derive(Default)]
struct PendingHistory {
    /// 消した時刻。現れたときの時刻で消すと、ほかのデバイスがその間に覚えた履歴まで見せなくなる
    cleared_at: Option<u64>,
    texts: Option<Vec<String>>,
}

static PENDING_HISTORY: Mutex<PendingHistory> = Mutex::new(PendingHistory {
    cleared_at: None,
    texts: None,
});

/// 置き場のフォルダーが現れたときに、無い間に届いた履歴の消去と保存を書く
fn write_pending_history(app: &AppHandle) {
    let pending = std::mem::take(&mut *PENDING_HISTORY.lock().unwrap());
    if let Some(at) = pending.cleared_at {
        if let Err(error) = clear_history_file_at(app, true, at, true) {
            warn!("couldn't clear draft history after the folder appeared: {error}");
        }
    }
    if let Some(texts) = pending.texts {
        // 画面が持つのは、無くなる前にこのデバイスのファイルへ書いた履歴の続き。そう照らさないと、画面の一覧の全部に
        // 今の時刻を付け、無い間にほかのデバイスで消した履歴まで、消した時刻より後のものとして戻す
        let own = app.state::<AppState>().history_path();
        if let Ok(before) = history_store::load(&own) {
            HISTORY_FILE_LOCK
                .lock()
                .unwrap()
                .replaced_by_other_devices(before);
        }
        if let Err(error) = save_draft_history(app.clone(), texts) {
            warn!("couldn't save draft history after the folder appeared: {error}");
        }
    }
}

#[tauri::command]
fn save_draft_history(app: AppHandle, entries: Vec<String>) -> Result<(), String> {
    if !settings_dir_ready(&app) {
        // 画面の一覧はそのまま使え、現れたときに書く（write_pending_history）
        PENDING_HISTORY.lock().unwrap().texts = Some(entries);
        return Ok(());
    }
    let path = app.state::<AppState>().history_path();
    // 件数の設定は、ロックを取ってから読む。読んだ後に件数 0 へ変えられて消されると、
    // 消した後に古い履歴を書き戻してしまう
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    let size = draft_history_size(&app);
    let texts = history_store::truncate(entries, size);
    // 読めなかったファイルを空の履歴として扱って書くと、その履歴が届いた 1 件に置き換わる。
    // 壊れたファイルは写して退けてから書き、読めないだけ（一時的なエラー）なら書かない
    let merged = match history_store::load_merged(&path) {
        Ok(history) => history,
        Err(history_store::LoadError::Invalid(problem)) => {
            warn!("couldn't read draft history before saving: {problem}");
            history_store::set_aside(&path, SystemTime::now())
                .map_err(|error| error.to_string())?;
            history_store::History::default()
        }
        Err(error) => {
            warn!("couldn't read draft history before saving: {error}");
            return Err(error.to_string());
        }
    }
    .truncated(size);
    let next = screen.saved(&merged, texts, size, now_millis());
    // 画面は、読み込んだ履歴をそのまま保存し直すことがある。変わっていなければ書かない。置き場を同期していると、
    // 書くたびにほかのデバイスへ送られるため
    if next == merged {
        return Ok(());
    }
    info!("saving draft history: {} entries", next.entries.len());
    history_store::save(&path, &next).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_draft_history(app: AppHandle) -> Result<(), String> {
    // 件数が 0 のデバイスの画面は、起動のたびにこれを呼ぶ。そのたびに消した時刻を置くと、ほかのデバイスが
    // その後に覚えた履歴まで消す（docs/config.md「履歴」）
    let asked = draft_history_size(&app) != 0;
    clear_draft_history_file(&app, asked)?;
    app.emit(events::DRAFT_HISTORY_CLEARED, ())
        .map_err(|error| error.to_string())
}

/// 履歴を消し、消した時刻を置く（docs/config.md「履歴」）。ほかのデバイスの、その時刻より前の履歴も見せなくなる。
/// `always` が false なら、消す履歴があるときだけ置く
fn clear_draft_history_file(app: &AppHandle, always: bool) -> Result<(), String> {
    clear_history_file_at(app, always, now_millis(), false)
}

/// `own_only` は、置き場が無い間に消した分を後から書くとき。消した時刻を、このデバイスのファイルの履歴とだけ比べる。
/// 混ぜた履歴と比べると、ほかのデバイスがその間に覚えた履歴の時刻まで進み、それも見せなくなる。このデバイスのファイルは、
/// 無い間に増えないので、消したときに画面が持っていた履歴より新しいものを含まない
fn clear_history_file_at(
    app: &AppHandle,
    always: bool,
    now: u64,
    own_only: bool,
) -> Result<(), String> {
    if !settings_dir_ready(app) {
        let mut pending = PENDING_HISTORY.lock().unwrap();
        // 消した後に届く一覧は、消した後のもの。消す前に届いた一覧は書かない
        pending.texts = None;
        if always {
            pending.cleared_at = Some(now);
        }
        return Ok(());
    }
    let path = app.state::<AppState>().history_path();
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    screen.caught_up();
    let merged = if own_only {
        history_store::load(&path)
    } else {
        history_store::load_merged(&path)
    };
    if !always && matches!(&merged, Ok(history) if history.entries.is_empty()) {
        return Ok(());
    }
    let cleared = merged.unwrap_or_default().cleared(now);
    history_store::save(&path, &cleared).map_err(|error| error.to_string())?;
    info!("cleared draft history");
    Ok(())
}

/// ほかのデバイスの履歴のファイルが変わった。混ぜた履歴を自分のファイルにも入れ、テキストウィンドウに読み直させる。
/// 自分のファイルに入れておくと、次に画面から保存するときに、混ぜた履歴と照らして時刻を付けられる
fn merge_history_from_other_devices(app: &AppHandle) {
    if !settings_dir_ready(app) {
        return;
    }
    let path = app.state::<AppState>().history_path();
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    let size = draft_history_size(app);
    let (own, merged) = match (
        history_store::load(&path),
        history_store::load_merged(&path),
    ) {
        (Ok(own), Ok(merged)) => (own, merged.truncated(size)),
        (Err(error), _) | (_, Err(error)) => {
            warn!("couldn't read draft history after a change: {error}");
            return;
        }
    };
    if merged == own {
        return;
    }
    if let Err(error) = history_store::save(&path, &merged) {
        warn!("couldn't save the merged draft history: {error}");
        return;
    }
    info!(
        "merged draft history of the other devices: {} entries",
        merged.entries.len()
    );
    screen.replaced_by_other_devices(own);
    let _ = app.emit(events::DRAFT_HISTORY_MERGED, ());
}

#[tauri::command]
fn set_trim_trailing_whitespace(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("set trim trailing whitespace: {enabled}");
    update_config(&app, |config| config.trim_trailing_whitespace = enabled)
}

#[tauri::command]
fn set_exclude_from_clipboard_history(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("set exclude from clipboard history: {enabled}");
    update_config(&app, |config| {
        config.exclude_from_clipboard_history = enabled
    })
}

#[tauri::command]
fn set_punctuation_style(app: AppHandle, style: PunctuationStyle) -> Result<(), String> {
    info!("set punctuation style: {style:?}");
    update_config(&app, |config| config.punctuation_style = style)
}

#[tauri::command]
fn set_char_widths(app: AppHandle, widths: CharWidths) -> Result<(), String> {
    info!("set char widths: {widths:?}");
    update_config(&app, |config| config.char_widths = widths)
}

/// 下書きの入力欄のフォント。family は CSS の font-family の並びをそのまま受け取り、
/// 妥当かどうかは画面側（ブラウザーの CSS の解釈）に任せる。読めない大きさにならないよう、size だけ範囲に収める
#[tauri::command]
fn set_draft_font(app: AppHandle, family: String, size: u16) -> Result<(), String> {
    let size = size.clamp(config::MIN_DRAFT_FONT_SIZE, config::MAX_DRAFT_FONT_SIZE);
    info!("set draft font: {family:?} {size}px");
    update_config(&app, |config| {
        config.text_font_family = family;
        config.text_font_size = size;
    })
}

/// 下書きの入力欄の文字色。ライトとダークを一緒に受け取り、小文字の #rrggbb に揃えて保存する（空は標準の色）。
/// どちらかが色として読めなければ、何も変えずにエラーを返す
#[tauri::command]
fn set_draft_text_color(app: AppHandle, light: String, dark: String) -> Result<(), String> {
    let (Some(light), Some(dark)) = (
        config::normalize_text_color(&light),
        config::normalize_text_color(&dark),
    ) else {
        return Err(format!("not a #rrggbb color: {light:?} / {dark:?}"));
    };
    info!("set draft text color: {light:?} {dark:?}");
    update_config(&app, |config| {
        config.text_color_light = light;
        config.text_color_dark = dark;
    })
}

/// 下書きの入力欄の案内。None で既定の案内に戻し、空文字で出さない。内容はログに残さない（ユーザーが書いた文なので）
#[tauri::command]
fn set_draft_guidance(app: AppHandle, guidance: Option<String>) -> Result<(), String> {
    info!(
        "set draft guidance: {}",
        match &guidance {
            None => "default",
            Some(text) if text.is_empty() => "none",
            Some(_) => "custom",
        }
    );
    update_config(&app, |config| config.input_guidance = guidance)
}

/// 下書きウィンドウの設定のボタンから、設定ウィンドウを開く。トレイメニューと同じ入口
#[tauri::command]
fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

/// 下書きウィンドウの設定のキー（既定は Cmd+, / Ctrl+,）で、設定ウィンドウを開閉する。
/// 設定ウィンドウが存在する場合は、開いているか見えているかに関わらず閉じる。
#[tauri::command]
fn toggle_settings_window(app: AppHandle) {
    if app.get_webview_window(SETTINGS_WINDOW).is_some() {
        close_settings_window(app);
    } else {
        open_settings(&app);
    }
}

/// 設定ウィンドウをキーで閉じる（Esc / Cmd+W / Ctrl+W）。
/// 画面側から閉じられるようにするために core:window:allow-close を与えると、
/// 下書きウィンドウまで閉じられるようになるので、設定ウィンドウだけを閉じるコマンドにする
#[tauri::command]
fn close_settings_window(app: AppHandle) {
    close_window(&app, SETTINGS_WINDOW);
}

#[tauri::command]
fn set_replacements(
    app: AppHandle,
    replacements: Vec<Replacement>,
) -> Result<Vec<Replacement>, String> {
    info!("set replacements: {} entries", replacements.len());
    // 打つたびに呼ばれる。辞書はトレイにも下書きウィンドウにも関わらず、設定画面は自分で表の行を持っているので、
    // 保存するだけにして、開いているウィンドウとトレイへの反映はしない
    save_as_typed(&app, |config| config.replacements = replacements.clone())?;
    Ok(replacements)
}

#[tauri::command]
fn set_snippets(app: AppHandle, snippets: Vec<Snippet>) -> Result<Vec<Snippet>, String> {
    info!("set snippets: {} entries", snippets.len());
    // 打つたびに呼ばれる。設定画面は自分で欄を持っているが、下書きウィンドウの一覧が使うので、辞書と違い画面へは反映する。
    // トレイには関わらないので、打つたびに作り直さない
    save_as_typed(&app, |config| config.snippets = snippets.clone())?;
    emit_settings(&app);
    Ok(snippets)
}

/// 下書きウィンドウの定型文の一覧から、下書き（選んだ範囲）を定型文の末尾に足す。
/// 同じ本文の定型文がもうあれば足さずに false を返す。本文はログに残さない（ユーザーが書いた文なので）
#[tauri::command]
fn add_snippet(app: AppHandle, snippet: Snippet) -> Result<bool, String> {
    if snippet.body.trim().is_empty() {
        return Err("the snippet body is empty".to_string());
    }
    let exists = app
        .state::<AppState>()
        .config
        .lock()
        .unwrap()
        .snippets
        .iter()
        .any(|existing| existing.body == snippet.body);
    if exists {
        info!("add snippet: already registered");
        return Ok(false);
    }
    info!("add snippet");
    save_as_typed(&app, |config| config.snippets.push(snippet.clone()))?;
    emit_settings(&app);
    // 設定画面は定型文の並びを自分で持っていて settings-changed では写し直さないので、足した1件を別に知らせる。
    // 知らせないと、設定画面を開いたままにしていたとき、次に設定画面で直したときの保存で消える
    let _ = app.emit(events::SNIPPET_ADDED, &snippet);
    Ok(true)
}

/// 待つことのある処理（バックアップのファイルの読み書き）を、メインスレッドを止めずに別のスレッドで走らせる。
/// 走らせたスレッドが落ちたら、その理由を返す
async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())
}

/// バックアップの一覧。新しい順に、戻すと今の設定から変わる所を添える（docs/config.md「バックアップ」）
#[tauri::command]
async fn settings_backups(app: AppHandle) -> Result<Vec<backup_restore::Backup>, String> {
    let state = app.state::<AppState>();
    let current = state.config.lock().unwrap().clone();
    let dir = state.backups_dir.clone();
    run_blocking(move || {
        let mut backups = Vec::new();
        for name in backup::names(&dir)? {
            let backed_up = match read_backup(&dir, &name) {
                Ok(config) => config,
                Err(error) => {
                    warn!("couldn't read settings backup {name}: {error}");
                    continue;
                }
            };
            let restored = backup_restore::restore(&current, &backed_up);
            backups.push(backup_restore::Backup {
                changes: backup_restore::differences(&current, &restored),
                created_at: backup::created_ms(&name),
                name,
            });
        }
        Ok::<_, std::io::Error>(backups)
    })
    .await?
    .map_err(|error| error.to_string())
}

fn read_backup(dir: &std::path::Path, name: &str) -> std::io::Result<Config> {
    let entries = backup::read(dir, name)?;
    Ok(config::from_entries(&entries).config)
}

/// 今の設定をバックアップに書く。いちばん新しいバックアップと同じ中身なら書かずに false
#[tauri::command]
async fn back_up_settings(app: AppHandle) -> Result<bool, String> {
    info!("back up settings");
    back_up_now(&app).await.map(|written| written.is_some())
}

async fn back_up_now(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let entries = config::stored_entries(&state.config.lock().unwrap());
    let dir = state.backups_dir.clone();
    let written = run_blocking(move || {
        // 毎日のものと「今すぐ」が重なっても、同じ名前を空きと見て互いに上書きしない
        static BACKUP_LOCK: Mutex<()> = Mutex::new(());
        let _guard = BACKUP_LOCK.lock().unwrap();
        backup::write(&dir, &entries, SystemTime::now())
    })
    .await?
    .map_err(|error| error.to_string())?;
    if let Some(name) = &written {
        info!("backed up settings to {name}");
    }
    Ok(written)
}

/// 選んだバックアップの設定に戻す。戻す前の設定もバックアップに書くので、戻したことを戻せる。
/// 入れ方は、ほかで変わった設定のファイルを読んだときと同じ経路を通す
#[tauri::command]
async fn restore_settings_backup(app: AppHandle, name: String) -> Result<(), String> {
    if !backup::valid_name(&name) {
        return Err("invalid backup name".to_string());
    }
    info!("restore settings backup {name}");
    let dir = app.state::<AppState>().backups_dir.clone();
    let backed_up = run_blocking(move || read_backup(&dir, &name))
        .await?
        .map_err(|error| error.to_string())?;
    back_up_now(&app).await?;
    let current = app.state::<AppState>().config.lock().unwrap().clone();
    let next = backup_restore::restore(&current, &backed_up);
    if next == current {
        return Ok(());
    }
    let rejected = adopt_config(&app, next, true)?;
    let _ = app.emit(events::CONFIG_REPLACED, ());
    if rejected.is_empty() {
        Ok(())
    } else {
        // OS に断られた項目があっても、残りは入れてあるので、画面には伝える
        Err(error_codes::BACKUP_RESTORE_PARTIAL.to_string())
    }
}

/// 置き場のファイルを見張り始める。前の見張りは止める。見張れなくても設定は使えるので、ログにだけ出す
fn watch_settings_dir(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut watch = state.watch.lock().unwrap();
    *watch = None;
    let handle = app.clone();
    match settings_watch::start(
        &state.settings_dir(),
        &state.history_dir(),
        move |changed| {
            let app = handle.clone();
            // 設定の反映はウィンドウとホットキーを触るので、メインスレッドで行う
            let result = handle.run_on_main_thread(move || {
                if changed.settings {
                    reload_config_from_files(&app);
                    let state = app.state::<AppState>();
                    let outdated = state
                        .watch
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|watch| watch.targets_changed(&state.settings_dir()));
                    if outdated {
                        watch_settings_dir(&app);
                    }
                }
                if changed.history {
                    merge_history_from_other_devices(&app);
                }
            });
            if let Err(error) = result {
                error!("settings watch: couldn't run on the main thread: {error}");
            }
        },
    ) {
        Ok(started) => *watch = Some(started),
        Err(error) => warn!("couldn't watch the settings folder: {error}"),
    }
}

/// 選んだ置き場のフォルダーが現れる（symlink の先を読む許可が戻る）のを待つ。現れたら読み直して、見張りを始める
fn wait_for_settings_dir(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // クラウドストレージのドライブは、ログインの後しばらくしてつながる。気づくまでの遅れが気にならず、
        // 見に行く負荷も無視できる間隔にする
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let state = app.state::<AppState>();
            if state.settings_dir_available.load(Ordering::SeqCst) {
                return;
            }
            // 起動のときにつながっていなかったドライブのブックマークは、つながってから戻せる
            restore_folder_access_and_save(
                &mut state.device.lock().unwrap(),
                &state.device_path,
                false,
            );
            let chosen = state.device.lock().unwrap().settings_dir.is_some();
            if let Some(place) = unavailable_settings_place(&state.settings_dir(), chosen) {
                // 無いものが変わった（先が現れたが許可が無い など）ら、トレイと画面の知らせを替える
                let problem = ConfigProblem::unavailable(&place);
                let changed = {
                    let mut problems = state.problems.lock().unwrap();
                    let changed = problems.config.as_ref() != Some(&problem);
                    problems.config = Some(problem);
                    changed
                };
                if changed {
                    apply_config(&app);
                }
                continue;
            }
            resume_settings_dir(&app);
            return;
        }
    });
}

/// 置き場が現れた（許可された）ので、読み直して見張りを始め、無い間に控えた履歴を書く
fn resume_settings_dir(app: &AppHandle) {
    info!("the settings folder is available again");
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        // 読み直す直前に、メインスレッドで書けるようにする。先に書けるようにすると、その間に届いた設定の保存が、
        // 起動のときに読めなかったために持っている既定の設定を、置き場のファイルに書く。
        // 待つ間の見回りと許可の窓の両方から来るので、先に書けるようにした方だけが読み直す
        if handle
            .state::<AppState>()
            .settings_dir_available
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        reload_config_from_files(&handle);
        write_pending_history(&handle);
        merge_history_from_other_devices(&handle);
        watch_settings_dir(&handle);
        let _ = handle.emit(events::DRAFT_HISTORY_MERGED, ());
        // 読み直した設定が前と同じでも、トレイと画面の知らせを消す
        apply_config(&handle);
    });
    if let Err(error) = result {
        error!("couldn't reload the settings folder: {error}");
    }
}

/// symlink の先を読む許可を、フォルダーの窓で求める（docs/config.md「macOS のサンドボックス」）。窓は先の入っている
/// フォルダーで開き、利用者は「開く」を押すだけで済むようにする。選んだフォルダーが先を含まなければ、伝えて出し直す。
/// 許可されたら、そのフォルダーのブックマークを device.json に残して true。取り消されたら false
async fn ask_access(app: &AppHandle, target: &Path) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt as _, MessageDialogKind};
    let lang = app.state::<AppState>().lang();
    let shown = target.display().to_string();
    loop {
        let mut picker = app
            .dialog()
            .file()
            .set_directory(folder_access::grant_start(target))
            .set_title(lang.grant_access_prompt());
        // 設定の窓に結び付ける。結び付けないと、窓を開いたままボタンをもう一度押せて、2つ目が開く
        if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
            picker = picker.set_parent(&window);
        }
        let Some(picked) = run_blocking(move || picker.blocking_pick_folder()).await? else {
            return Ok(false);
        };
        let folder = picked.into_path().map_err(|error| error.to_string())?;
        if folder_access::contains(&folder, target) {
            remember_granted_folder(app, folder);
            return Ok(true);
        }
        info!(
            "{} doesn't contain {}; asking again",
            folder.display(),
            target.display()
        );
        let mut message = app
            .dialog()
            .message(lang.grant_access_wrong_folder(&shown))
            .kind(MessageDialogKind::Warning);
        if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
            message = message.parent(&window);
        }
        run_blocking(move || message.blocking_show()).await?;
    }
}

/// 窓で許可されたフォルダーのブックマークを残す。窓で選んだ許可はこのプロセスの間だけなので、起動し直したら
/// ブックマークから戻す。作れない・残せないときは、今は読めるのでログにだけ出す（次に起動したらまた求める）
fn remember_granted_folder(app: &AppHandle, folder: PathBuf) {
    let bookmark = match folder_access::bookmark(&folder) {
        Ok(Some(bookmark)) => bookmark,
        Ok(None) => return,
        Err(error) => {
            warn!("couldn't bookmark {}: {error}", folder.display());
            return;
        }
    };
    info!("granted access to {}", folder.display());
    let state = app.state::<AppState>();
    let mut device = state.device.lock().unwrap();
    let mut updated = device.clone();
    updated.grant(folder, bookmark);
    match device::save(&state.device_path, &updated) {
        Ok(()) => *device = updated,
        Err(error) => warn!("couldn't save the granted folder: {error}"),
    }
}

/// `dir` の symlink の先のうち、サンドボックスが読ませないものの許可を、1つずつ求める。読ませないものが残っていなければ
/// true。取り消されたら false
async fn grant_access_in(app: &AppHandle, dir: &Path, chosen: bool) -> Result<bool, String> {
    let mut asked = Vec::new();
    while let Some(Unreachable::Denied(target)) = unavailable_settings_place(dir, chosen) {
        // 許可しても読めない（ファイルの権限で断られている など）先に、窓を出し続けないため
        if asked.contains(&target) {
            warn!("still can't read {} after granting", target.display());
            return Ok(false);
        }
        if !ask_access(app, &target).await? {
            return Ok(false);
        }
        asked.push(target);
    }
    Ok(true)
}

/// 設定の画面の「アクセスを許可...」。今の置き場の symlink の先を読む許可を求め、読めるようになったら読み直す
#[tauri::command]
async fn grant_settings_access(app: AppHandle) -> Result<(), String> {
    let (dir, chosen) = {
        let state = app.state::<AppState>();
        let chosen = state.device.lock().unwrap().settings_dir.is_some();
        (state.settings_dir(), chosen)
    };
    if !grant_access_in(&app, &dir, chosen).await? {
        return Ok(());
    }
    // 許可した後に別の理由（ほかの先が無い など）で読めなければ、待つ間の見回りが知らせを替える
    if unavailable_settings_place(&dir, chosen).is_none() {
        resume_settings_dir(&app);
    }
    Ok(())
}

/// 選んだフォルダー。置き場を替える前に、画面がそちらの設定を使うかを聞くのに使う
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
struct PickedSettingsDir {
    /// 置き場を替えるときに渡すパス
    path: String,
    /// 画面に出すパス。MSIX 版では回された先（shown_path）
    shown_path: String,
    /// そのフォルダーに設定のファイルがあるか
    has_settings: bool,
}

/// 設定の置き場にするフォルダーを、OS のフォルダーの窓で選んでもらう。取り消したら None。
/// 中の設定のファイルの symlink の先をサンドボックスが読ませなければ、続けて許可を求め、取り消されたら None
#[tauri::command]
async fn pick_settings_dir(app: AppHandle) -> Result<Option<PickedSettingsDir>, String> {
    use tauri_plugin_dialog::DialogExt as _;
    let state = app.state::<AppState>();
    let mut picker = app
        .dialog()
        .file()
        .set_directory(state.settings_dir())
        .set_title(state.lang().pick_settings_folder());
    // 設定の窓に結び付ける。結び付けないと、窓を開いたまま「変更...」をもう一度押せて、2つ目が開く
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        picker = picker.set_parent(&window);
    }
    let picked = run_blocking(move || picker.blocking_pick_folder()).await?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    let bookmark = folder_access::bookmark(&path).unwrap_or_else(|error| {
        warn!("couldn't bookmark {}: {error}", path.display());
        None
    });
    *app.state::<AppState>().picked_bookmark.lock().unwrap() =
        bookmark.map(|bookmark| (path.clone(), bookmark));
    if !grant_access_in(&app, &path, true).await? {
        return Ok(None);
    }
    Ok(Some(picked_dir(&app.state::<AppState>(), path)))
}

/// 既定の置き場（OS 標準のアプリ設定フォルダー）。戻す前に、画面がそちらの設定を使うかを聞くのに使う。
/// 中の設定のファイルの symlink の先をサンドボックスが読ませなければ、許可を求め、取り消されたら None
#[tauri::command]
async fn default_settings_dir(app: AppHandle) -> Result<Option<PickedSettingsDir>, String> {
    let dir = app.state::<AppState>().default_settings_dir.clone();
    if !grant_access_in(&app, &dir, false).await? {
        return Ok(None);
    }
    Ok(Some(picked_dir(&app.state::<AppState>(), dir)))
}

fn picked_dir(state: &AppState, path: PathBuf) -> PickedSettingsDir {
    PickedSettingsDir {
        has_settings: settings_files::exists_in(&path),
        shown_path: shown_path(state, path.clone()).display().to_string(),
        path: path.display().to_string(),
    }
}

/// 設定の置き場を替える（docs/config.md「置き場」）。`path` が None なら既定に戻す。
/// `use_existing` なら、替えた先の設定を読んで使う。でなければ、今の設定を替えた先に書く（そちらの設定は上書きする）。
/// このデバイスの履歴は、替えた先の履歴に混ぜて持っていく。前の置き場のファイルは消さない（ほかのデバイスが使っているかもしれないため）
#[tauri::command]
fn set_settings_dir(
    app: AppHandle,
    path: Option<String>,
    use_existing: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let chosen = path.map(PathBuf::from);
    let next_dir = chosen
        .clone()
        .unwrap_or_else(|| state.default_settings_dir.clone());
    if !next_dir.is_absolute() {
        return Err("the settings folder must be an absolute path".to_string());
    }
    // 先の無い symlink に書くと、普通のファイルに置き換えるので、替えない（docs/config.md「置き場」）。
    // フォルダーそのものが先の無い symlink だと、作るところで OS のエラーになるので、作る前に見る
    if next_dir.is_symlink() && !next_dir.is_dir() {
        return Err(error_codes::SETTINGS_FOLDER_UNAVAILABLE.to_string());
    }
    match settings_files::unreachable_link(&next_dir) {
        Some(Unreachable::Missing(_)) => {
            return Err(error_codes::SETTINGS_FOLDER_UNAVAILABLE.to_string())
        }
        // 許可は、選ぶとき（pick_settings_dir）に求めている。ここに来るのは取り消した後に画面から呼ばれたとき
        Some(Unreachable::Denied(_)) => return Err(error_codes::SETTINGS_ACCESS_DENIED.to_string()),
        None => {}
    }
    std::fs::create_dir_all(&next_dir).map_err(|error| error.to_string())?;
    info!(
        "change the settings folder to {} (use existing: {use_existing})",
        next_dir.display()
    );
    let current = state.config.lock().unwrap().clone();
    let device = state.device.lock().unwrap().clone();
    let adopted = if use_existing {
        let (mut next, problem) = load_config(&next_dir, &device, &current);
        if problem.is_some() {
            return Err(error_codes::SETTINGS_FILE_UNREADABLE.to_string());
        }
        // ログイン時の起動は置き場に無く、OS への登録に合わせた今の値（起動のときにそろえたもの）を保つ。
        // デバイスの設定の値を使うと、OS の側で切ってあるのにオンに見える
        next.autostart = current.autostart;
        Some(next)
    } else {
        let mut entries = config::stored_entries(&current);
        entries.remove(config::key::AUTOSTART);
        settings_files::write(
            &next_dir,
            &os_name(),
            config::key::IN_FILES,
            settings_files::Scope::All {
                set_aside_unreadable: false,
            },
            &entries,
        )?;
        None
    };
    // 履歴は、混ぜた今の履歴を、替えた先の自分のファイルに混ぜて書く
    let old_history = state.history_path();
    let next_history = next_dir
        .join(history_store::DIR_NAME)
        .join(old_history.file_name().unwrap_or_default());
    {
        let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
        match (
            history_store::load_merged(&old_history),
            history_store::load(&next_history),
        ) {
            (Ok(old), Ok(there)) => {
                // 画面が読み直すまでは、前の置き場の履歴を持っている。替えた先のファイルと照らすと、
                // その間の保存が、替えた先にあった履歴を画面の一覧に合わせて落とす
                screen.replaced_by_other_devices(old.clone());
                // 替えた先の設定を使うなら、その「履歴の件数」で切る
                let size = adopted
                    .as_ref()
                    .map_or(current.text_history_size, |next| next.text_history_size);
                let merged = history_store::merge(&old, &there).truncated(size as usize);
                if let Err(error) = history_store::save(&next_history, &merged) {
                    warn!("couldn't move the draft history: {error}");
                }
            }
            (Err(error), _) | (_, Err(error)) => warn!("couldn't move the draft history: {error}"),
        }
    }
    // 窓で選んだ置き場なら、選んだときに作ったブックマークを残す。既定に戻すなら要らない
    let picked = state.picked_bookmark.lock().unwrap().take();
    let settings_dir_bookmark = match (&chosen, picked) {
        (Some(chosen), Some((path, bookmark))) if *chosen == path => Some(bookmark),
        (Some(chosen), _) if device.settings_dir.as_ref() == Some(chosen) => {
            device.settings_dir_bookmark.clone()
        }
        _ => None,
    };
    let updated = device::Device {
        settings_dir: chosen,
        settings_dir_bookmark,
        ..device
    };
    device::save(&state.device_path, &updated).map_err(|error| error.to_string())?;
    *state.device.lock().unwrap() = updated;
    *state.settings_dir.lock().unwrap() = next_dir;
    state.settings_dir_available.store(true, Ordering::SeqCst);
    state.problems.lock().unwrap().config = None;
    watch_settings_dir(&app);
    write_pending_history(&app);
    if let Some(next) = adopted {
        let changed = next != current;
        let rejected = adopt_config(&app, next, false)?;
        if !rejected.is_empty() {
            warn!("kept the current value of: {}", rejected.join(", "));
        }
        if changed {
            let _ = app.emit(events::CONFIG_REPLACED, ());
        }
    }
    apply_config(&app);
    let _ = app.emit(events::DRAFT_HISTORY_MERGED, ());
    Ok(())
}

/// 設定の置き場を、Finder・エクスプローラーなどで開く。設定のファイルがあれば、それを選んだ状態にする
#[tauri::command]
fn reveal_settings_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.state::<AppState>().settings_dir();
    let file = dir.join(settings_files::SETTINGS);
    reveal_item_in_dir(&app, if file.exists() { file } else { dir })
}

/// 毎日の自動のバックアップ（docs/config.md「バックアップ」）。起動したときと、その後は1時間ごとに、
/// いちばん新しいバックアップから1日たっていれば書く。常駐したまま日をまたぐので、起動のときだけでは足りない
fn start_daily_backups(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            interval.tick().await;
            // 置き場が無い間の設定は既定のままなので、控えに残さない。残すと、本当の設定の控えより新しい既定の控えが並ぶ
            if !app
                .state::<AppState>()
                .settings_dir_available
                .load(Ordering::SeqCst)
            {
                continue;
            }
            let dir = app.state::<AppState>().backups_dir.clone();
            match run_blocking(move || backup::due(&dir, SystemTime::now())).await {
                Ok(Ok(true)) => {
                    if let Err(error) = back_up_now(&app).await {
                        warn!("couldn't back up settings: {error}");
                    }
                }
                Ok(Ok(false)) => {}
                Ok(Err(error)) => warn!("couldn't list settings backups: {error}"),
                Err(error) => warn!("couldn't list settings backups: {error}"),
            }
        }
    });
}

/// ホットキーをデスクトップのキー設定で割り当てるか。Wayland ではアプリがキーを奪えない。
/// global-shortcut プラグインは XWayland 越しに登録できてしまうが、キーは XWayland の窓が前面のときしか届かない
fn hotkey_by_desktop() -> bool {
    static BY_DESKTOP: OnceLock<bool> = OnceLock::new();
    *BY_DESKTOP.get_or_init(|| {
        cfg!(target_os = "linux")
            && std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var("GDK_BACKEND").map_or(true, |backend| !backend.starts_with("x11"))
    })
}

/// global-shortcut プラグインでホットキーを登録・解除する。デスクトップのキー設定で割り当てるときは、何も登録せず、登録できている扱いにする
struct PluginRegistrar<'a>(&'a AppHandle);

/// 設定のホットキーから、実際に登録した形（registered_form）。途中でキー配列を切り替えると今の配列で作る形が変わるので、
/// 解除には登録したときの形を使い、登録できているかは今の配列の形と同じときだけにする（ずれていれば登録し直させる）
static REGISTERED_AS: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

impl PluginRegistrar<'_> {
    /// 前に登録した形が、今も登録されていれば解除する
    fn unregister_saved_form(&self, hotkey: &str) -> Result<(), String> {
        let Some(saved) = REGISTERED_AS.lock().unwrap().get(hotkey).cloned() else {
            return Ok(());
        };
        let shortcuts = self.0.global_shortcut();
        if shortcuts.is_registered(saved.as_str()) {
            shortcuts
                .unregister(saved.as_str())
                .map_err(|error| error.to_string())?;
        }
        REGISTERED_AS.lock().unwrap().remove(hotkey);
        Ok(())
    }
}

impl hotkey::Registrar for PluginRegistrar<'_> {
    fn register(&mut self, hotkey: &str) -> Result<(), String> {
        if hotkey_by_desktop() {
            return Ok(());
        }
        let Some(registered) = registered_form(hotkey) else {
            return Err(format!(
                "no key on the current keyboard layout registers as {hotkey}"
            ));
        };
        // 配列を切り替える前の形が残っていれば、先に外す
        self.unregister_saved_form(hotkey)?;
        self.0
            .global_shortcut()
            .register(registered.as_str())
            .map_err(|error| error.to_string())?;
        REGISTERED_AS
            .lock()
            .unwrap()
            .insert(hotkey.to_string(), registered);
        Ok(())
    }

    // 起動時に登録できなかったキーや、記録のために止めているキーは、解除するものがないので成功として扱う
    fn unregister(&mut self, hotkey: &str) -> Result<(), String> {
        if hotkey_by_desktop() {
            return Ok(());
        }
        self.unregister_saved_form(hotkey)
    }

    fn is_registered(&self, hotkey: &str) -> bool {
        if hotkey_by_desktop() {
            return true;
        }
        let Some(current) = registered_form(hotkey) else {
            return false;
        };
        REGISTERED_AS.lock().unwrap().get(hotkey) == Some(&current)
            && self.0.global_shortcut().is_registered(current.as_str())
    }
}

/// 登録に渡すホットキー。Windows では、今のキー配列で押した位置のキーに合わせる。合わせられなければ `None`（hotkey::for_layout）
fn registered_form(hotkey: &str) -> Option<String> {
    #[cfg(windows)]
    return hotkey::for_current_layout(hotkey);
    #[cfg(not(windows))]
    Some(hotkey.to_string())
}

/// 設定のホットキーが登録されている状態にし、登録できているかをトレイの ⚠ に反映する
fn ensure_hotkey_registered(app: &AppHandle) {
    let hotkey = app
        .state::<AppState>()
        .config
        .lock()
        .unwrap()
        .hotkey
        .clone();
    let registered = hotkey::ensure_registered(&mut PluginRegistrar(app), &hotkey);
    show_hotkey_registered(app, registered);
}

/// 設定のホットキーが登録できているかを、トレイの ⚠ と設定画面に反映する
fn show_hotkey_registered(app: &AppHandle, registered: bool) {
    let state = app.state::<AppState>();
    let changed = {
        let mut problems = state.problems.lock().unwrap();
        let changed = problems.hotkey_unavailable == registered;
        problems.hotkey_unavailable = !registered;
        changed
    };
    if changed {
        apply_config(app);
    }
}

/// 下書きウィンドウの操作にキーを割り当てる。空文字で割り当てを外す。
/// 重なっていて割り当てられなければ、理由の符号（draft_keys::Rejection::code）を返す
#[tauri::command]
fn set_draft_key(app: AppHandle, action: DraftAction, key: String) -> Result<(), String> {
    info!("set draft key: {} = {key:?}", action.name());
    let (keys, hotkey) = {
        let config = app.state::<AppState>().config.lock().unwrap().clone();
        (config.text_window_keys, config.hotkey)
    };
    let key = draft_keys::check(&keys, &hotkey, action, &key, Platform::current())
        .map_err(|rejection| rejection.code())?;
    update_config(&app, |config| {
        *config.text_window_keys.get_mut(action) = key;
        // 割り当てを決めたので、黙って外した扱いをやめて、設定に書く
        config
            .yielded_draft_keys
            .retain(|yielded| *yielded != action);
    })
}

/// 下書きウィンドウの操作のキーを既定に戻す。既定のキーがほかで使われていれば、戻さずに理由の符号を返す
#[tauri::command]
fn reset_draft_key(app: AppHandle, action: DraftAction) -> Result<(), String> {
    let key = DraftKeys::default().get(action).to_string();
    set_draft_key(app, action, key)
}

/// ホットキーを変える。空文字でホットキーを外す（下書きウィンドウはトレイのメニューから出せる）
#[tauri::command]
fn set_hotkey(app: AppHandle, accelerator: String) -> Result<(), String> {
    info!("set hotkey: {accelerator}");
    let (current, keys) = {
        let config = app.state::<AppState>().config.lock().unwrap().clone();
        (config.hotkey, config.text_window_keys)
    };
    // 下書きの操作のキーと重なると、下書きウィンドウに届かなくなる。登録を試す前に断り、止めていたホットキーは戻す
    if let Err(rejection) = draft_keys::check_hotkey(&keys, &accelerator, Platform::current()) {
        ensure_hotkey_registered(&app);
        return Err(rejection.code());
    }
    // 記録のために止めていたキーも、この中で戻す
    let (result, registered) =
        hotkey::change(&mut PluginRegistrar(&app), &current, &accelerator, || {
            update_config(&app, |config| config.hotkey = accelerator.clone())
        });
    show_hotkey_registered(&app, registered);
    result
}

/// ホットキーを記録している間は、押したキーで下書きウィンドウが出ないように、今のホットキーを止める
#[tauri::command]
fn pause_hotkey(app: AppHandle) {
    let hotkey = app
        .state::<AppState>()
        .config
        .lock()
        .unwrap()
        .hotkey
        .clone();
    if let Err(error) = PluginRegistrar(&app).unregister(&hotkey) {
        warn!("couldn't pause the hotkey {hotkey}: {error}");
    }
}

#[tauri::command]
fn resume_hotkey(app: AppHandle) {
    ensure_hotkey_registered(&app);
}

/// メニューを開いたら、ホットキーの登録を外す（macOS）。開いている間に押したホットキーが溜まり、
/// 閉じた直後に項目を選んだ操作と続けて効くのを防ぐ（menu_tracking.rs）。登録されていなければ何もしない
#[cfg(target_os = "macos")]
fn pause_hotkey_for_menu(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.menu_depth.fetch_add(1, Ordering::Relaxed) > 0 {
        return;
    }
    let hotkey = state.config.lock().unwrap().hotkey.clone();
    let mut registrar = PluginRegistrar(app);
    if !registrar.is_registered(&hotkey) {
        return;
    }
    match registrar.unregister(&hotkey) {
        Ok(()) => {
            info!("hotkey paused while a menu is open");
            *state.hotkey_paused_for_menu.lock().unwrap() = Some(hotkey);
        }
        Err(error) => warn!("couldn't pause the hotkey {hotkey} while a menu is open: {error}"),
    }
}

/// メニューを閉じたら、外していたホットキーを登録し直す（macOS）。開いている間に設定でホットキーが
/// 変わっていたら、変えたときに新しいキーが登録されているので、古いキーは戻さない
#[cfg(target_os = "macos")]
fn resume_hotkey_after_menu(app: &AppHandle) {
    let state = app.state::<AppState>();
    // 対になる開く通知を受けていない閉じる通知（観測を始める前に開いていたメニューなど）は数えない
    let Ok(depth) = state
        .menu_depth
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |depth| {
            depth.checked_sub(1)
        })
    else {
        return;
    };
    if depth > 1 {
        return;
    }
    let Some(hotkey) = state.hotkey_paused_for_menu.lock().unwrap().take() else {
        return;
    };
    if state.config.lock().unwrap().hotkey != hotkey {
        return;
    }
    info!("hotkey resumed after a menu closed");
    // 開いている間に設定画面の操作で登録し直されていることがあるので、登録済みなら何もしない
    if !hotkey::ensure_registered(&mut PluginRegistrar(app), &hotkey) {
        show_hotkey_registered(app, false);
    }
}

/// 設定ウィンドウを表示して前面に出す。ウィンドウは隠して作られるので、画面を描いてから画面側が呼ぶ
#[tauri::command]
fn show_settings_window(window: WebviewWindow) {
    show_created_window(&window, SETTINGS_WINDOW);
}

/// 隠して作ったウィンドウ（設定・ライセンス・使い方）を、呼んだのがそのウィンドウなら表示して前面に出す
fn show_created_window(window: &WebviewWindow, label: &str) {
    if window.label() != label {
        return;
    }
    // 記憶していた位置が、今のディスプレイ構成では画面の外になることがある
    fit_to_screen(window);
    bring_to_front(window);
}

/// ウィンドウを表示して前面に出す。表示しただけではアプリが前面に出ず、ほかのアプリの後ろに隠れることがある
fn bring_to_front(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// 開いていれば閉じる
fn close_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}

/// 設定・ライセンス・使い方のウィンドウを、隠して作る。表示は、画面を描いてから画面側が show_… のコマンドで行う。
/// 前回の位置と大きさは、window-state プラグイン（macOS は AppKit）が戻す
fn build_hidden_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    title: &str,
    size: (f64, f64),
    min_size: (f64, f64),
) -> tauri::Result<WebviewWindow> {
    let theme = app.state::<AppState>().config.lock().unwrap().theme;
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min_size.0, min_size.1)
        .visible(false)
        .minimizable(false)
        .maximizable(false)
        .theme(window_theme(theme));
    // macOS では中央に置かせない（main_window_config）
    #[cfg(not(target_os = "macos"))]
    let builder = builder.center();
    let window = builder.build()?;
    // 描画プロセスが落ちたら、下書きと同じく立て直す
    diagnostics::watch_webview_process(&window);
    // 別のタスクで作ることがあるので、メインスレッドで戻す。表示は画面を描いてからなので、それより先に済む
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let name = window_state_key(label).to_owned();
        let _ = window.run_on_main_thread(move || window_frame::restore_and_track(&target, &name));
    }
    Ok(window)
}

/// ログファイルを、置き場所のフォルダーで選んだ状態で表示する。
/// 不具合を調べるときの入口。中身は開かない（.log に関連付けられたアプリに左右されないため）
#[tauri::command]
fn reveal_log_file(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("couldn't find the log folder: {error}"))?;
    let file = dir.join(format!("{LOG_FILE_STEM}.log"));
    // まだ書き出されていなければ、フォルダーを表示する
    let target = if file.exists() { file } else { dir };
    reveal_item_in_dir(&app, target)
}

/// Finder・エクスプローラー・Linux のファイルマネージャーで、パスを選んだ状態にする。MSIX 版では、回された先のパスを渡す
fn reveal_item_in_dir(app: &AppHandle, path: PathBuf) -> Result<(), String> {
    #[cfg(windows)]
    let path = match (app.path().data_dir(), app.path().local_data_dir()) {
        (Ok(roaming), Ok(local)) => package::path_for_explorer(path, &roaming, &local),
        _ => path,
    };
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_terms_page(app: AppHandle) -> Result<(), String> {
    open_page(&app, TERMS_URL)
}

#[tauri::command]
fn open_privacy_page(app: AppHandle) -> Result<(), String> {
    open_page(&app, PRIVACY_URL)
}

#[tauri::command]
fn open_contact_page(app: AppHandle) -> Result<(), String> {
    open_page(&app, CONTACT_URL)
}

fn open_page(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// 設定と一緒に OS を受け取らないウィンドウ（ライセンス・使い方）の画面の URL。画面が閉じるキー（Cmd+W / Ctrl+W）や
/// 本文の書き分けを OS で変えるので、OS の名前を `?platform=` で渡す（画面は `$lib/keys` の `platformFromUrl` で読む）
fn url_with_platform(page: &str) -> WebviewUrl {
    let platform = config::choice_name(&Platform::current());
    WebviewUrl::App(format!("{page}?platform={platform}").into())
}

/// 第三者のソフトウェアのライセンスのウィンドウを開く。開いていれば前面に出す。
/// 設定の「このアプリについて」からだけ開くので、下書きはすでに隠れていて、macOS の Dock にも出ている
#[tauri::command]
fn open_licenses_window(app: AppHandle) {
    info!("open licenses");
    if let Some(window) = app.get_webview_window(LICENSES_WINDOW) {
        bring_to_front(&window);
        return;
    }
    // Windows では、イベントの処理の中でウィンドウを作ると固まることがあるので、別のタスクで作る
    tauri::async_runtime::spawn(async move {
        let url = url_with_platform("licenses");
        let title = app.state::<AppState>().lang().licenses_title();
        let result = build_hidden_window(
            &app,
            LICENSES_WINDOW,
            url,
            title,
            LICENSES_SIZE,
            LICENSES_MIN_SIZE,
        );
        match result {
            // 作っている間に設定が閉じられると、設定の Destroyed では閉じる相手が見つからず、この窓だけが残る。
            // 作り終えた時点で設定がもう無ければ、ここで閉じる
            Ok(window) if app.get_webview_window(SETTINGS_WINDOW).is_none() => {
                let _ = window.close();
            }
            Ok(_) => {}
            Err(error) => error!("couldn't open the licenses window: {error}"),
        }
    });
}

/// ライセンスのウィンドウを表示して前面に出す。ウィンドウは隠して作られるので、画面を描いてから画面側が呼ぶ
#[tauri::command]
fn show_licenses_window(window: WebviewWindow) {
    show_created_window(&window, LICENSES_WINDOW);
}

/// ライセンスのウィンドウをキーで閉じる（Esc / Cmd+W / Ctrl+W）。設定ウィンドウと同じ理由で専用のコマンドにする
#[tauri::command]
fn close_licenses_window(app: AppHandle) {
    close_window(&app, LICENSES_WINDOW);
}

/// 設定の「このアプリについて」から、使い方のウィンドウを開く。メニューと同じ入口
#[tauri::command]
fn open_manual_window(app: AppHandle) {
    open_manual(&app);
}

/// 使い方のウィンドウを表示して前面に出す。ウィンドウは隠して作られるので、画面を描いてから画面側が呼ぶ
#[tauri::command]
fn show_manual_window(window: WebviewWindow) {
    show_created_window(&window, MANUAL_WINDOW);
}

/// 使い方のウィンドウをキーで閉じる（Esc / Cmd+W / Ctrl+W）。設定ウィンドウと同じ理由で専用のコマンドにする
#[tauri::command]
fn close_manual_window(app: AppHandle) {
    close_window(&app, MANUAL_WINDOW);
}

/// 使い方のウィンドウを開く。開いていれば前面に出す。設定を開かずにメニューから読めるよう、設定とは別のウィンドウにする
fn open_manual(app: &AppHandle) {
    info!("open manual");
    // メニューから開くと Mawok は常駐のアプリのままなので、設定と同じく Dock と Cmd+Tab に出す。
    // 出さないと、ほかのアプリに移った後でこの窓へ戻る手段が無い
    #[cfg(target_os = "macos")]
    set_activation_policy(app, tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(MANUAL_WINDOW) {
        bring_to_front(&window);
        return;
    }
    // Windows では、イベントの処理の中でウィンドウを作ると固まることがあるので、別のタスクで作る
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let url = url_with_platform("manual");
        let title = app.state::<AppState>().lang().manual();
        let result = build_hidden_window(
            &app,
            MANUAL_WINDOW,
            url,
            title,
            MANUAL_SIZE,
            MANUAL_MIN_SIZE,
        );
        match result {
            // 作っている間に設定が閉じられると、設定の Destroyed がこの窓をまだ見つけられず、常駐のアプリに戻してしまう。
            // 作り終えたところで、もう一度 Dock に出す
            Ok(_) => {
                #[cfg(target_os = "macos")]
                set_activation_policy(&app, tauri::ActivationPolicy::Regular);
            }
            // 続けて2回開くと、2つ目は同じ名前のウィンドウを作れずにここへ来る。1つ目があれば Dock はそのまま
            Err(error) => {
                error!("couldn't open the manual window: {error}");
                #[cfg(target_os = "macos")]
                settle_activation_policy(&app);
            }
        }
    });
}

/// ライセンスの一覧のパッケージ名から、そのソースの置き場所を既定のブラウザーで開く。
/// 一覧はビルドのときに作ったもので、置き場所はパッケージの公開元に書かれた URL。念のため https だけを通す
#[tauri::command]
fn open_license_source(app: AppHandle, url: String) -> Result<(), String> {
    if !is_https_url(&url) {
        return Err(format!("not an https URL: {url}"));
    }
    open_page(&app, &url)
}

fn is_https_url(url: &str) -> bool {
    url.strip_prefix("https://")
        .is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'))
}

/// OS のログイン項目を設定に合わせる。合わせられなければ、トレイの ⚠ に出す理由を返す。
/// 開発中にビルドした実行ファイルをログイン項目に登録しないよう、OS への登録はリリースビルドだけで行う
fn apply_autostart(app: &AppHandle, enabled: bool) -> Option<autostart::SetError> {
    if cfg!(debug_assertions) {
        return None;
    }
    match read_autostart(app) {
        Ok(registered) if registered == enabled => None,
        Ok(_) => write_autostart(app, enabled),
        Err(error) => Some(autostart::SetError::Os(error)),
    }
}

/// OS のログイン項目に登録されていて、有効か。読めなければ、トレイの ⚠ と設定画面に出す理由を返す
fn read_autostart(app: &AppHandle) -> Result<bool, String> {
    autostart::is_enabled(app).inspect_err(|error| warn!("couldn't read launch at login: {error}"))
}

/// OS のログイン項目を登録する・外す。登録済みかは呼ぶ側が読んでおく。できなければ、トレイの ⚠ と設定画面に出す理由を返す
fn write_autostart(app: &AppHandle, enabled: bool) -> Option<autostart::SetError> {
    let error = autostart::set(app, enabled).err()?;
    warn!("couldn't configure launch at login: {error:?}");
    Some(error)
}

/// ログイン項目を設定できなかった理由を、設定画面の「ログイン時に起動」の行に出す文にする
fn autostart_error_text(error: &autostart::SetError, lang: Lang) -> String {
    match error {
        autostart::SetError::Os(error) => error.clone(),
        autostart::SetError::TurnedOffInWindowsSettings => lang.autostart_turned_off_in_windows(),
        autostart::SetError::SetByPolicy => lang.autostart_set_by_policy(),
    }
}

/// 起動したときに、ログイン項目をどうするか
#[derive(Debug, PartialEq)]
enum AutostartAtLaunch {
    Register,
    Unregister,
    /// OS の側で切られていたので、設定もオフとして扱う
    TurnOffSetting,
    /// 登録が有効なまま残っている。登録先が今の実行ファイルでなければ登録し直す（`registration_is_current`）
    Refresh,
    Nothing,
}

/// 起動したときのログイン項目の扱いを、設定（configured）と OS の登録（registered）から決める。
/// 初めての起動では設定のとおりに登録する。2回目からは、どちらかがオフならオフにそろえる。
/// タスクマネージャーやシステム設定で切ったのを、起動のたびに有効へ戻さないため（利用者が OS で選んだ状態を尊重する）。
/// 設定がオフで登録が残っていたら、OS の登録を外す。どちらもオンなら、登録先を今の実行ファイルにそろえる
fn autostart_at_launch(
    configured: bool,
    registered: bool,
    first_launch: bool,
) -> AutostartAtLaunch {
    match (configured, registered) {
        (true, false) if first_launch => AutostartAtLaunch::Register,
        (true, false) => AutostartAtLaunch::TurnOffSetting,
        (false, true) => AutostartAtLaunch::Unregister,
        (true, true) => AutostartAtLaunch::Refresh,
        (false, false) => AutostartAtLaunch::Nothing,
    }
}

/// 置き場のファイルから設定を読む（docs/config.md「読むとき」）。読めない項目は既定のままにしてログにだけ出す。
/// 読めないファイルの項目は `fallback`（起動のときは既定、ほかで変わったときは今の設定）のままにして、そのファイルを問題として返す。
/// ログイン時の起動は、デバイスの設定から読む
fn load_config(
    dir: &std::path::Path,
    device: &device::Device,
    fallback: &Config,
) -> (Config, Option<ConfigProblem>) {
    let read = settings_files::read(dir, &os_name());
    let mut entries = read.entries;
    let unreadable: Vec<String> = read
        .unreadable
        .iter()
        .map(|(name, error)| {
            warn!("couldn't read the settings file {name}: {error}");
            name.to_string()
        })
        .collect();
    if !unreadable.is_empty() {
        for (name, value) in config::stored_entries(fallback) {
            if unreadable
                .iter()
                .any(|file| file == settings_files::file_of(&name))
            {
                entries.insert(name, value);
            }
        }
    }
    entries.remove(config::key::AUTOSTART);
    if let Some(autostart) = device.autostart {
        entries.insert(
            config::key::AUTOSTART.to_string(),
            serde_json::Value::Bool(autostart),
        );
    }
    let loaded = config::from_entries(&entries);
    if !loaded.skipped.is_empty() {
        warn!(
            "reset unreadable settings to defaults: {}",
            loaded.skipped.join(", ")
        );
    }
    let problem = (!unreadable.is_empty()).then_some(ConfigProblem::Unreadable(unreadable));
    (loaded.config, problem)
}

/// 置き場の設定のファイルがほかで変わった。読み直して、変わった分を入れる。自分で書いた変化の知らせも届くが、
/// 読んだ設定が今と同じなら何もしない
fn reload_config_from_files(app: &AppHandle) {
    // 動いている途中でフォルダーが消えた知らせでは、無いファイルを既定の値として読んでしまう
    if !settings_dir_ready(app) {
        return;
    }
    let state = app.state::<AppState>();
    let current = state.config.lock().unwrap().clone();
    let device = state.device.lock().unwrap().clone();
    let (mut next, problem) = load_config(&state.settings_dir(), &device, &current);
    // ログイン時の起動は設定のファイルに無く、OS への登録に合わせた今の値（起動のときにそろえたもの）を保つ
    next.autostart = current.autostart;
    let problem_changed = {
        let mut problems = state.problems.lock().unwrap();
        let changed = problems.config != problem;
        problems.config = problem;
        changed
    };
    if next == current {
        if problem_changed {
            apply_config(app);
        }
        return;
    }
    info!("reloaded the settings changed outside the app");
    match adopt_config(app, next, false) {
        Ok(rejected) if !rejected.is_empty() => {
            warn!("kept the current value of: {}", rejected.join(", "))
        }
        Ok(_) => {}
        Err(error) => warn!("couldn't adopt the changed settings: {error}"),
    }
    // 設定画面は、行と打って直す欄（書体・色など）の写しを持つので、どの項目が変わっても写し直させる
    let _ = app.emit(events::CONFIG_REPLACED, ());
}

/// 起動したときに、ログイン項目と設定をそろえる（`autostart_at_launch`）。合わせられなければ、トレイの ⚠ に出す理由を返す。
/// 設定をオフにしたときは、ここでは保存しない。次に設定を保存するまでは置き場にオンが残るが、起動のたびに同じくオフにそろう
fn settle_autostart(
    app: &AppHandle,
    config: &mut Config,
    first_launch: bool,
) -> Option<autostart::SetError> {
    if cfg!(debug_assertions) {
        return None;
    }
    let registered = match read_autostart(app) {
        Ok(registered) => registered,
        Err(error) => return Some(autostart::SetError::Os(error)),
    };
    match autostart_at_launch(config.autostart, registered, first_launch) {
        AutostartAtLaunch::Register => write_autostart(app, true),
        AutostartAtLaunch::Unregister => write_autostart(app, false),
        AutostartAtLaunch::TurnOffSetting => {
            info!("launch at login was turned off outside Mawok; keeping it off");
            config.autostart = false;
            None
        }
        AutostartAtLaunch::Refresh if autostart::registration_is_current(app) => None,
        AutostartAtLaunch::Refresh => {
            info!("launch at login points elsewhere; registering this app again");
            write_autostart(app, true)
        }
        AutostartAtLaunch::Nothing => None,
    }
}

/// 多重起動を防ぐロックファイル（設定の置き場所に置く）
#[cfg(target_os = "macos")]
const LOCK_FILE_NAME: &str = "mawok.lock";

/// ロックを持っている間、ほかの Mawok は起動できない。プロセスが終われば（落ちても）OS が外す。
/// ファイルは読まないが、閉じるとロックが外れるので、アプリの状態として持ち続ける
#[cfg(target_os = "macos")]
struct InstanceLock {
    _file: std::fs::File,
}

/// macOS で多重起動を防ぐ。ほかの Mawok がロックを持っていれば false。
/// Finder や `open` での開き直しは、macOS が2つ目を立てずに `RunEvent::Reopen` で知らせるので、ここに来るのは
/// `open -n` や実行ファイルを直に起動したときだけ。そのときは下書きを出さずに終わる（動いている方へ知らせる道を持たない）
#[cfg(target_os = "macos")]
fn lock_single_instance(app: &AppHandle) -> Result<bool, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE_NAME))
        .map_err(|error| error.to_string())?;
    match file.try_lock() {
        Ok(()) => {
            app.manage(InstanceLock { _file: file });
            Ok(true)
        }
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(error)) => Err(error.to_string()),
    }
}

/// 設定と使い方のどちらのウィンドウも無ければ、常駐のアプリに戻す（Dock と Cmd+Tab から外す）。
/// 閉じたウィンドウの Destroyed の時点では、そのウィンドウはもう一覧から外れている
#[cfg(target_os = "macos")]
fn settle_activation_policy(app: &AppHandle) {
    if app.get_webview_window(SETTINGS_WINDOW).is_none()
        && app.get_webview_window(MANUAL_WINDOW).is_none()
    {
        set_activation_policy(app, tauri::ActivationPolicy::Accessory);
    }
}

/// メニューバーに常駐するアプリは Dock にも Cmd+Tab にも出ない。設定か使い方のウィンドウを開いている間だけ通常のアプリにする
#[cfg(target_os = "macos")]
fn set_activation_policy(app: &AppHandle, policy: tauri::ActivationPolicy) {
    if let Err(error) = app.set_activation_policy(policy) {
        warn!("couldn't change the activation policy: {error}");
    }
}

/// 設定ウィンドウを作っている間だけ立てる目印。
/// 早く戻る道を作っても寝かせ忘れないよう、Drop で寝かせる。立てっぱなしにすると、以後ずっと設定を開けなくなる。
/// 開発ビルドでは panic のときも巻き戻しで Drop が走る（リリースビルドは `panic = "abort"` なのでアプリごと落ちる）
struct OpeningGuard(AppHandle);

impl Drop for OpeningGuard {
    fn drop(&mut self) {
        self.0
            .state::<AppState>()
            .settings_opening
            .store(false, Ordering::SeqCst);
    }
}

/// 設定ウィンドウを、指定の分類で開く。開いていれば、その分類に切り替える。
/// 分類は画面が描き終えてから取りに来る（take_settings_category）。開いている窓へ直に送ると、
/// 作った直後でまだ受け取れない窓には届かないため、取り置いて知らせだけを送る
fn open_settings_at(app: &AppHandle, category: SettingsCategory) {
    *app.state::<AppState>().settings_category.lock().unwrap() = Some(category);
    let _ = app.emit_to(SETTINGS_WINDOW, events::SETTINGS_CATEGORY_REQUESTED, ());
    open_settings(app);
}

/// トレイの ⚠ の項目で頼まれた、設定画面に出す分類を受け取る。頼まれていなければ None
#[tauri::command]
fn take_settings_category(state: tauri::State<'_, AppState>) -> Option<SettingsCategory> {
    state.settings_category.lock().unwrap().take()
}

fn open_settings(app: &AppHandle) {
    info!("open settings");
    hide_draft_for_settings(app);
    focus::before_show(app);
    #[cfg(target_os = "macos")]
    set_activation_policy(app, tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        bring_to_front(&window);
        return;
    }
    // 作成は非同期なので、終わる前にもう一度呼ばれると2つ作ろうとする。
    // 作るのは1つだけにして、後から来た方は何もしない（下書きは上で隠してある）
    if app
        .state::<AppState>()
        .settings_opening
        .swap(true, Ordering::SeqCst)
    {
        info!("open settings: already opening");
        return;
    }
    // 立てた目印は、後始末まで終えてから寝かせる（OpeningGuard の Drop）。
    // 先に寝かせると、後始末の途中で入ってきた2つ目が設定を作り、戻した下書きと同時に出てしまう
    // Windows では、イベントの処理の中でウィンドウを作ると固まることがあるので、別のタスクで作る
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _opening = OpeningGuard(app.clone());
        let title = app.state::<AppState>().lang().settings_title();
        let result = build_hidden_window(
            &app,
            SETTINGS_WINDOW,
            WebviewUrl::App("settings".into()),
            title,
            SETTINGS_SIZE,
            SETTINGS_MIN_SIZE,
        );
        // 作っている間に使い方の窓が閉じられると、その Destroyed がこの窓をまだ見つけられず、常駐のアプリに戻してしまう。
        // 作り終えたところで、もう一度 Dock に出す
        #[cfg(target_os = "macos")]
        if result.is_ok() {
            set_activation_policy(&app, tauri::ActivationPolicy::Regular);
        }
        if let Err(error) = result {
            error!("couldn't open the settings window: {error}");
            // 作るのは1つだけなので、ここへ来たら設定ウィンドウはない。
            // 念のため確かめてから、開く前の状態へ戻す
            if app.get_webview_window(SETTINGS_WINDOW).is_none() {
                // ウィンドウがないのに Dock と Cmd+Tab に出したままにしない
                #[cfg(target_os = "macos")]
                settle_activation_policy(&app);
                // 設定は出ないので Destroyed も来ない。隠した下書きは、ここで戻さないと消えたままになる
                let hidden_for_settings = &app.state::<DraftState>().hidden_for_settings;
                if hidden_for_settings.load(Ordering::Relaxed) && show_again(&app) {
                    hidden_for_settings.store(false, Ordering::Relaxed);
                }
            }
        }
    });
}

/// トレイメニューに ⚠ 付きで出す問題の項目
#[derive(Clone, Copy, Debug, PartialEq)]
enum TrayProblem {
    /// 設定のファイルを読めない。読めたファイルには保存できるので、保存できないとは言わない
    SettingsUnreadable,
    /// 保存先が無いか、読む許可が無い。何も保存しない
    Settings,
    Hotkey,
    Autostart,
}

impl TrayProblem {
    const ALL: [TrayProblem; 4] = [
        TrayProblem::SettingsUnreadable,
        TrayProblem::Settings,
        TrayProblem::Hotkey,
        TrayProblem::Autostart,
    ];

    fn id(self) -> &'static str {
        match self {
            TrayProblem::SettingsUnreadable => "problem-settings-unreadable",
            TrayProblem::Settings => "problem-settings",
            TrayProblem::Hotkey => "problem-hotkey",
            TrayProblem::Autostart => "problem-autostart",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|problem| problem.id() == id)
    }

    fn text(self, lang: Lang) -> &'static str {
        match self {
            TrayProblem::SettingsUnreadable => lang.settings_file_problem(),
            TrayProblem::Settings => lang.settings_problem(),
            TrayProblem::Hotkey => lang.hotkey_problem(),
            TrayProblem::Autostart => lang.autostart_problem(),
        }
    }

    /// 選んだときに開く設定画面の分類。「設定の保存先」と「ログイン時に起動」は一般、ホットキーはキー操作にある
    fn category(self) -> SettingsCategory {
        match self {
            TrayProblem::SettingsUnreadable | TrayProblem::Settings | TrayProblem::Autostart => {
                SettingsCategory::General
            }
            TrayProblem::Hotkey => SettingsCategory::Keys,
        }
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let hotkey = state.config.lock().unwrap().hotkey.clone();
    let hotkey_unavailable = state.problems.lock().unwrap().hotkey_unavailable;
    // 項目は短い知らせにして、選ぶとその問題の行がある分類で設定画面を開く（TrayProblem）。
    // パスや理由まで項目に書くと、折り返せないメニューが横に長く伸びる
    let problems = {
        let problems = state.problems.lock().unwrap();
        let mut found = Vec::new();
        match problems.config {
            Some(ConfigProblem::Unreadable(_)) => found.push(TrayProblem::SettingsUnreadable),
            Some(_) => found.push(TrayProblem::Settings),
            None => {}
        }
        if problems.hotkey_unavailable {
            found.push(TrayProblem::Hotkey);
        }
        if problems.autostart_failed.is_some() {
            found.push(TrayProblem::Autostart);
        }
        found
    };

    let problem_items = problems
        .iter()
        .map(|problem| {
            MenuItem::with_id(
                app,
                problem.id(),
                format!("⚠ {}", problem.text(lang)),
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let problem_separator = PredefinedMenuItem::separator(app)?;
    // ホットキーを、OS の書き方で項目の右端に添える (macOS は ⌘⇧Space、Windows は Ctrl+Shift+Space)。
    // 登録できていないキーは押しても効かないので添えない。メニューの読める形でないキーは、Tauri が黙って添えずに作る。
    // Windows ではトレイのメニューがウィンドウに付かないので、添えたキーは見せるためだけで別に効かない。
    // Linux では添えても出ない（docs/platform.md「Linux のそのほか」）。
    // macOS ではメニューを開いている間ホットキーの登録を外すので、押すと項目のキーとして効く (menu_tracking.rs)
    let accelerator = (!hotkey_unavailable).then_some(hotkey.as_str());
    let show_item = MenuItem::with_id(app, "show", lang.toggle_draft(), true, accelerator)?;
    let settings_item = MenuItem::with_id(app, "settings", lang.settings(), true, None::<&str>)?;
    let manual_item = MenuItem::with_id(app, "manual", lang.manual(), true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", lang.quit(), true, None::<&str>)?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = problem_items
        .iter()
        .map(|item| item as &dyn IsMenuItem<Wry>)
        .collect();
    if !items.is_empty() {
        items.push(&problem_separator);
    }
    items.extend([
        &show_item as &dyn IsMenuItem<Wry>,
        &settings_item,
        &manual_item,
        &separator,
        &quit_item,
    ]);
    Menu::with_items(app, &items)
}

fn tray_tooltip(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let mut tooltip = String::from(APP_NAME);
    if !state.problems.lock().unwrap().is_empty() {
        tooltip.push_str(" ⚠");
    }
    tooltip
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(TRAY_ICON)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(tray_tooltip(app))
        .menu(&tray_menu(app)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            info!("tray: {} selected", event.id.as_ref());
            match event.id.as_ref() {
                "show" => toggle_draft(app),
                "settings" => open_settings(app),
                "manual" => open_manual(app),
                "quit" => app.exit(0),
                id => {
                    if let Some(problem) = TrayProblem::from_id(id) {
                        open_settings_at(app, problem.category());
                    }
                }
            }
        })
        .build(app)?;
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        tray.with_inner_tray_icon(move |inner| {
            if let Some(status_item) = inner.ns_status_item() {
                tray_press::on_press(&status_item, move || show_tray_menu(&app));
            }
        })?;
    }
    Ok(())
}

/// show_tray_menu でメニューを開いている間か。メインスレッドでだけ読み書きする
#[cfg(target_os = "macos")]
static TRAY_MENU_PRESSED: AtomicBool = AtomicBool::new(false);
/// show_tray_menu でメニューを開いている間に、トレイの作り直しを頼まれたか
#[cfg(target_os = "macos")]
static TRAY_REFRESH_PENDING: AtomicBool = AtomicBool::new(false);

/// VoiceOver などから押されたメニューバーのアイコンのメニューを開く (tray_press.rs)
#[cfg(target_os = "macos")]
fn show_tray_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    // tray-icon の show_menu は、メニューを閉じるまでトレイを借りたまま戻らない。その間にメニューを差し替えると
    // 二重に借りて落ちるので、作り直しは閉じてから行う (refresh_tray)
    TRAY_MENU_PRESSED.store(true, Ordering::Relaxed);
    if let Err(error) = tray.with_inner_tray_icon(|inner| inner.show_menu()) {
        error!("couldn't show the tray menu: {error}");
    }
    TRAY_MENU_PRESSED.store(false, Ordering::Relaxed);
    if TRAY_REFRESH_PENDING.swap(false, Ordering::Relaxed) {
        refresh_tray_now(app);
    }
}

/// 表示言語や問題が変わったときに、トレイメニューを作り直す
fn refresh_tray(app: &AppHandle) {
    // show_tray_menu がメニューを開いているかはメインスレッドで決まるので、見るのも作り直すのもメインスレッドで行う
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let result = app.run_on_main_thread(move || {
            if TRAY_MENU_PRESSED.load(Ordering::Relaxed) {
                TRAY_REFRESH_PENDING.store(true, Ordering::Relaxed);
            } else {
                refresh_tray_now(&handle);
            }
        });
        if let Err(error) = result {
            error!("couldn't rebuild the tray menu: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    refresh_tray_now(app);
}

fn refresh_tray_now(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match tray_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(error) => error!("couldn't rebuild the tray menu: {error}"),
    }
    let _ = tray.set_tooltip(Some(tray_tooltip(app)));
}

/// macOS のアプリのメニュー。Tauri の既定のメニューの代わりに、編集のメニューだけを付ける。
/// メニューバーには出ないが、下書きや設定を開いている間はキーが効く。編集のメニューは、入力欄で Cmd+C や Cmd+Z を効かせるのに要る。
/// 既定のメニューの Cmd+Q（書きかけごと終了する）・Cmd+H（下書きを隠す処理を通らない）・Ctrl+Cmd+F（ウィンドウが全画面になる）は付けない。
/// 終了はトレイのメニューから行う
#[cfg(target_os = "macos")]
fn macos_app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&edit])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED_AT.get_or_init(Instant::now);
    // 識別子が、設定・履歴・ログのフォルダーと単一起動の見分けを決める
    let mut context = tauri::generate_context!();
    let identifier = profile::scoped(&context.config().identifier);
    #[cfg(target_os = "linux")]
    if toggle::forward_to_running(&identifier) {
        return;
    }
    context.config_mut().identifier = identifier;

    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        // D-Bus を受けるスレッドから呼ばれる。窓の印を渡すのは GTK なので、メインスレッドで行う
        #[cfg(target_os = "linux")]
        if toggle::requested(&args) {
            let (app, token) = (
                app.clone(),
                toggle::activation_token(&args).map(str::to_string),
            );
            let _ = app
                .clone()
                .run_on_main_thread(move || on_toggle(&app, token.as_deref()));
            return;
        }
        let _ = args;
        show(app)
    }));
    let builder = builder
        .plugin(diagnostics::log_plugin())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if matches!(event.state, ShortcutState::Pressed) {
                        on_hotkey(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .map_label(window_state_key)
                .build(),
        )
        .manage(DraftState::default())
        .invoke_handler(tauri::generate_handler![
            commit,
            preview_replacement_matches,
            dismiss,
            page_ready,
            get_settings,
            settings_backups,
            back_up_settings,
            restore_settings_backup,
            pick_settings_dir,
            default_settings_dir,
            grant_settings_access,
            set_settings_dir,
            reveal_settings_dir,
            open_settings_window,
            take_settings_category,
            toggle_settings_window,
            close_settings_window,
            show_settings_window,
            set_autostart,
            set_language,
            set_theme,
            set_draft_always_on_top,
            set_hide_draft_on_blur,
            set_show_draft_buttons,
            set_draft_history_size,
            load_draft_history,
            save_draft_history,
            clear_draft_history,
            set_trim_trailing_whitespace,
            set_exclude_from_clipboard_history,
            set_punctuation_style,
            set_char_widths,
            set_draft_font,
            set_draft_guidance,
            set_draft_text_color,
            set_replacements,
            set_snippets,
            add_snippet,
            set_hotkey,
            set_draft_key,
            reset_draft_key,
            pause_hotkey,
            configure_desktop_hotkey,
            resume_hotkey,
            reveal_log_file,
            open_terms_page,
            open_privacy_page,
            open_contact_page,
            open_licenses_window,
            show_licenses_window,
            close_licenses_window,
            open_manual_window,
            show_manual_window,
            close_manual_window,
            open_license_source
        ])
        .on_window_event(|window, event| match event {
            // 下書きウィンドウは閉じずに、Esc と同じくコピーせずに隠す（書きかけは残る）。設定ウィンドウは普通に閉じる
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW => {
                api.prevent_close();
                info!("close requested: dismiss");
                let app = window.app_handle();
                if let Err(error) = hide_draft_and_return(app, &app.state::<DraftState>()) {
                    error!("dismiss failed: {error}");
                }
            }
            // ほかのアプリに移ったら、設定に従ってコピーせずに隠す（書きかけは残る）
            WindowEvent::Focused(false) if window.label() == MAIN_WINDOW => {
                schedule_hide_on_blur(window.app_handle());
            }
            // フォーカスが戻ったら、待っている確かめを待ち直させる（揺れの最中に確かめない）
            WindowEvent::Focused(true) if window.label() == MAIN_WINDOW => {
                let state = window.app_handle().state::<DraftState>();
                state.focused_since_shown.store(true, Ordering::Relaxed);
                state.blur.touch();
            }
            WindowEvent::Destroyed if window.label() == SETTINGS_WINDOW => {
                info!("settings window closed");
                let app = window.app_handle();
                // ライセンスのウィンドウは設定から開くものなので、一緒に閉じる。
                // 残すと、下の出し直しで下書きと重なり、macOS では常駐に戻した後も窓だけが残る
                close_window(app, LICENSES_WINDOW);
                // window-state プラグインは、閉じたときの位置と大きさをメモリに置くだけで、ファイルに書くのは終了時。
                // 落ちたり強制終了されたりしても残るよう、ここで書き出す。
                // この時点で設定ウィンドウは一覧から外れているので、閉じたときに置いた値がそのまま書かれる
                let _ = app.save_window_state(window_state_flags());
                #[cfg(target_os = "macos")]
                settle_activation_policy(app);
                // 設定を開くために隠していた下書きを出し直す。書きかけはそのまま残っている。
                // もともと出ていなければ、そのまま出さない
                // 出せたときだけ記録を寝かせる。先に寝かせると、出し損ねたまま戻せなくなる
                let hidden_for_settings = &app.state::<DraftState>().hidden_for_settings;
                if hidden_for_settings.load(Ordering::Relaxed) && show_again(app) {
                    hidden_for_settings.store(false, Ordering::Relaxed);
                }
                // 出ていれば（出し直したときも、設定を開いた後にホットキーで出したときも）、アプリごと前面にしてフォーカスを戻す。
                // macOS では常駐に戻す操作でアプリごと非アクティブになり、前面にしないパネルのままではキー入力が戻らないため
                if let Some(main) =
                    main_window(app).filter(|main| main.is_visible().unwrap_or(false))
                {
                    focus::before_show(app);
                    let _ = main.set_focus();
                }
                // ホットキーの記録中に閉じた場合に、止めていたホットキーを戻す
                ensure_hotkey_registered(app);
            }
            WindowEvent::Destroyed if window.label() == LICENSES_WINDOW => {
                info!("licenses window closed");
                let _ = window.app_handle().save_window_state(window_state_flags());
            }
            WindowEvent::Destroyed if window.label() == MANUAL_WINDOW => {
                info!("manual window closed");
                let app = window.app_handle();
                let _ = app.save_window_state(window_state_flags());
                #[cfg(target_os = "macos")]
                settle_activation_policy(app);
            }
            WindowEvent::Destroyed => warn!("window {} destroyed", window.label()),
            _ => {}
        })
        .setup(|app| {
            info!(
                "{APP_NAME} {} started ({} {})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            #[cfg(windows)]
            info!("packaged (MSIX): {}", package::packaged());
            #[cfg(windows)]
            package::register_restart_after_update();

            #[cfg(target_os = "macos")]
            match lock_single_instance(app.handle()) {
                Ok(true) => {}
                Ok(false) => {
                    info!("another instance is running; exiting");
                    std::process::exit(0);
                }
                Err(error) => warn!("couldn't check for another instance: {error}"),
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let main = WebviewWindowBuilder::from_config(
                app.handle(),
                &main_window_config(app.handle())?,
            )?
            .build()?;
            diagnostics::watch_webview_process(&main);

            let config_dir = app.path().app_config_dir()?;
            // デバイスの手元に置くもの（docs/config.md「デバイスの手元に置くもの」）は、既定の置き場と別のフォルダーに置く。
            // 既定の置き場を dotfiles などで同期しても、デバイスの見分けやバックアップがほかのデバイスに渡らないため
            let local_dir = app.path().app_local_data_dir()?;
            let device_path = local_dir.join(device::FILE_NAME);
            let device_missing = !device_path.exists();
            let mut device = device::load_or_recover(&device_path);
            let made_id = device::ensure_id(&mut device).unwrap_or_else(|error| {
                warn!("couldn't make the device id: {error}");
                false
            });
            let device_saved = !made_id
                || match device::save(&device_path, &device) {
                    Ok(()) => true,
                    Err(error) => {
                        warn!("couldn't save the device settings: {error}");
                        false
                    }
                };
            // 置き場を読む前に、サンドボックスで外のフォルダーを読み書きする許可を戻す
            restore_folder_access_and_save(&mut device, &device_path, true);
            let settings_dir = device
                .settings_dir
                .clone()
                .unwrap_or_else(|| config_dir.clone());
            info!("settings folder: {}", settings_dir.display());
            // 既定の置き場は作ってよいが、選んだ置き場は作らない。つながっていないドライブの場所に作ると、
            // つながった後のフォルダーと別物になるため
            let unavailable =
                unavailable_settings_place(&settings_dir, device.settings_dir.is_some());
            let settings_dir_available = unavailable.is_none();
            let (mut config, config_problem) = match unavailable {
                None => load_config(&settings_dir, &device, &Config::default()),
                Some(place) => {
                    warn!("{place:?}; waiting for it");
                    let (config, _) = load_config(&settings_dir, &device, &Config::default());
                    (config, Some(ConfigProblem::unavailable(&place)))
                }
            };
            let first_launch = is_first_launch(device_missing, device_saved);
            let mut problems = Problems {
                config: config_problem,
                ..Problems::default()
            };

            // 登録できなければ、ensure_registered がログに残す
            problems.hotkey_unavailable =
                !hotkey::ensure_registered(&mut PluginRegistrar(app.handle()), &config.hotkey);
            problems.autostart_failed = settle_autostart(app.handle(), &mut config, first_launch);

            if let Some(window) = main_window(app.handle()) {
                #[cfg(target_os = "macos")]
                {
                    focus::make_draft_panel(&window);
                    window_frame::restore_and_track(&window, window_state_key(MAIN_WINDOW));
                }
                let _ = window.set_theme(window_theme(config.theme));
                // tauri.conf.json では最前面にして作るので、設定でオフにしていれば外す
                if let Err(error) = window.set_always_on_top(config.text_window_always_on_top) {
                    warn!("couldn't change always on top of the draft window: {error}");
                }
            }

            app.manage(AppState {
                device_path,
                device: Mutex::new(device),
                settings_dir: Mutex::new(settings_dir),
                default_settings_dir: config_dir.clone(),
                settings_dir_available: AtomicBool::new(settings_dir_available),
                #[cfg(windows)]
                roaming_dir: app.path().data_dir()?,
                #[cfg(windows)]
                local_dir: app.path().local_data_dir()?,
                watch: Mutex::new(None),
                picked_bookmark: Mutex::new(None),
                backups_dir: backup::dir_in(&local_dir),
                version: app.package_info().version.to_string(),
                system_lang: Lang::system(),
                config: Mutex::new(config),
                problems: Mutex::new(problems),
                settings_opening: AtomicBool::new(false),
                settings_category: Mutex::new(None),
                #[cfg(target_os = "macos")]
                hotkey_paused_for_menu: Mutex::new(None),
                #[cfg(target_os = "linux")]
                portal_hotkey: portal_hotkey::PortalHotkey::default(),
                #[cfg(target_os = "macos")]
                menu_depth: std::sync::atomic::AtomicUsize::new(0),
            });
            build_tray(app.handle())?;
            // 初めての起動で下書きを出すのは、portal の確かめの画面が閉じてから。先に出すと、確かめの画面にフォーカスを取られて隠れる
            #[cfg(target_os = "linux")]
            let show_after_portal = hotkey_by_desktop() && first_launch;
            #[cfg(not(target_os = "linux"))]
            let show_after_portal = false;
            #[cfg(target_os = "linux")]
            if hotkey_by_desktop() {
                start_portal_hotkey(app.handle().clone(), show_after_portal);
            }
            #[cfg(target_os = "macos")]
            {
                let (begin, end) = (app.handle().clone(), app.handle().clone());
                menu_tracking::observe(
                    move || pause_hotkey_for_menu(&begin),
                    move || resume_hotkey_after_menu(&end),
                );
            }
            if settings_dir_available {
                watch_settings_dir(app.handle());
            } else {
                wait_for_settings_dir(app.handle().clone());
            }
            start_daily_backups(app.handle().clone());
            // 初めての起動では下書きを一度出す。常駐するだけで何も出ないと、入ったのか分からず、
            // 使い方を伝える入力欄の案内も、一度出すまで目に入らないため。
            // 画面の読み込みが終わる前に出すので、入力欄へのフォーカスは page_ready で移す
            if first_launch && !show_after_portal {
                info!("first launch: show the draft");
                show(app.handle());
            }
            // 動いていないときに `--toggle` で呼ばれたら、起動してそのまま出す
            #[cfg(target_os = "linux")]
            if !first_launch && toggle::requested(&std::env::args().collect::<Vec<_>>()) {
                show(app.handle());
            }
            Ok(())
        });

    // macOS のログイン時の起動はログイン項目、Linux は XDG autostart の .desktop を直接使う（autostart.rs）
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_autostart::Builder::new().build());

    // tauri-nspanel はテキストウィンドウをパネルにするのに使う（focus.rs の make_draft_panel）
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_nspanel::init())
        .on_web_content_process_terminate(diagnostics::web_content_process_terminated)
        .menu(macos_app_menu);

    builder
        .build(context)
        .expect("error while building tauri application")
        .run(
            |#[cfg_attr(not(target_os = "macos"), allow(unused_variables))] app, event| match event
            {
                // 動いている Mawok を Finder や `open` で開き直したとき。macOS は2つ目のプロセスを立てずに今のものへ知らせるので、
                // 単一起動のプラグインを通らない。どのウィンドウも出ていなければ、Windows で2つ目を起動したときと同じく下書きを出す。
                // 設定などが出ていれば、macOS のほかのアプリと同じく、前に出すだけにする
                #[cfg(target_os = "macos")]
                RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    info!("reopened (visible windows: {has_visible_windows})");
                    if !has_visible_windows {
                        show(app);
                    }
                }
                RunEvent::ExitRequested { code, .. } => info!("exit requested (code: {code:?})"),
                RunEvent::Exit => {
                    // 書き込み中の履歴を書き切ってから終わる
                    drop(HISTORY_FILE_LOCK.lock());
                    info!("exit")
                }
                _ => {}
            },
        );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// stow がフォルダーごと張った既定の置き場の先が無ければ、`..` を畳んだ先を無いものとして返す
    #[cfg(unix)]
    #[test]
    fn names_the_normalized_target_of_a_missing_settings_folder_link() {
        let dir = test_support::TempDir::new("lib-missing-folder-link");
        let config = dir.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let settings_dir = config.join("mawok");
        std::os::unix::fs::symlink("../dotfiles/mawok", &settings_dir).unwrap();
        assert_eq!(
            unavailable_settings_place(&settings_dir, false),
            Some(Unreachable::Missing(dir.join("dotfiles/mawok")))
        );
    }

    #[test]
    fn tray_problem_items_open_settings_where_their_row_is() {
        for problem in TrayProblem::ALL {
            assert_eq!(TrayProblem::from_id(problem.id()), Some(problem));
        }
        // ほかの項目の id は、問題の項目と取り違えない
        for id in ["show", "settings", "manual", "quit"] {
            assert_eq!(TrayProblem::from_id(id), None);
        }
        assert_eq!(
            TrayProblem::SettingsUnreadable.category(),
            SettingsCategory::General
        );
        assert_eq!(TrayProblem::Settings.category(), SettingsCategory::General);
        assert_eq!(TrayProblem::Autostart.category(), SettingsCategory::General);
        assert_eq!(TrayProblem::Hotkey.category(), SettingsCategory::Keys);
    }

    #[test]
    fn keeps_launch_at_login_off_when_either_side_turned_it_off() {
        use AutostartAtLaunch::*;
        for (configured, registered, first_launch, expected) in [
            (true, false, true, Register),
            (false, true, true, Unregister),
            (true, true, true, Refresh),
            // タスクマネージャーやシステム設定で切った
            (true, false, false, TurnOffSetting),
            // 設定はオフなのに登録が残っていた
            (false, true, false, Unregister),
            (true, true, false, Refresh),
            (false, false, false, Nothing),
        ] {
            assert_eq!(
                autostart_at_launch(configured, registered, first_launch),
                expected,
                "{configured} {registered} {first_launch}"
            );
        }
    }

    #[test]
    fn opens_only_https_urls_as_license_sources() {
        assert!(is_https_url("https://github.com/tauri-apps/tauri"));
        assert!(!is_https_url("http://github.com/tauri-apps/tauri"));
        assert!(!is_https_url("https://"));
        assert!(!is_https_url("https:///etc/passwd"));
        assert!(!is_https_url("file:///etc/passwd"));
        assert!(!is_https_url("javascript:alert(1)"));
        assert!(!is_https_url("github.com/tauri-apps/tauri"));
    }

    /// 隠す条件がそろった状態。各テストで1つずつ崩す
    fn blurred() -> BlurCheck {
        BlurCheck {
            enabled: true,
            visible: true,
            focused_since_shown: true,
            focused: false,
            settings_focused: false,
            settings_opening: false,
        }
    }

    #[test]
    fn reads_the_settings_files_and_keeps_the_fallback_for_an_unreadable_file() {
        let dir = test_support::TempDir::new("lib-load-config");
        std::fs::write(dir.join(settings_files::SETTINGS), "theme = \"dark\"\n").unwrap();
        std::fs::write(dir.join(settings_files::SNIPPETS), "snippets = [\n").unwrap();
        let fallback = Config {
            snippets: vec![Snippet {
                name: "a".to_string(),
                ..Snippet::default()
            }],
            ..Config::default()
        };
        let device = device::Device {
            autostart: Some(false),
            ..device::Device::default()
        };
        let (config, problem) = load_config(dir.path(), &device, &fallback);
        assert_eq!(config.theme, Theme::Dark);
        assert!(!config.autostart);
        assert_eq!(config.snippets, fallback.snippets);
        let Some(ConfigProblem::Unreadable(files)) = problem else {
            panic!("the snippets file is unreadable");
        };
        assert_eq!(files, [settings_files::SNIPPETS]);
    }

    #[test]
    fn shows_draft_only_when_the_device_file_was_created() {
        assert!(is_first_launch(true, true));
        // 2回目以降の起動
        assert!(!is_first_launch(false, true));
        // 作れなかったら、次の起動でもファイルがないので出さない
        assert!(!is_first_launch(true, false));
    }

    #[test]
    fn hides_when_focus_moved_to_another_app() {
        assert!(should_hide_on_blur(blurred()));
    }

    #[test]
    fn keeps_draft_when_setting_is_off() {
        assert!(!should_hide_on_blur(BlurCheck {
            enabled: false,
            ..blurred()
        }));
    }

    #[test]
    fn does_nothing_when_already_hidden() {
        // 隠す操作そのものが、フォーカスが外れた知らせを起こす
        assert!(!should_hide_on_blur(BlurCheck {
            visible: false,
            ..blurred()
        }));
    }

    #[test]
    fn keeps_draft_that_never_got_focus() {
        // Windows で前面に出せなかったとき（初めての起動やホットキーで出した直後など）は、ユーザーがほかへ移ったわけではない
        assert!(!should_hide_on_blur(BlurCheck {
            focused_since_shown: false,
            ..blurred()
        }));
    }

    #[test]
    fn keeps_draft_when_focus_came_back_while_waiting() {
        // ウィンドウの中のクリックで、知らせが外れて戻ることがある
        assert!(!should_hide_on_blur(BlurCheck {
            focused: true,
            ..blurred()
        }));
    }

    #[test]
    fn keeps_draft_for_settings_window() {
        assert!(!should_hide_on_blur(BlurCheck {
            settings_focused: true,
            ..blurred()
        }));
        assert!(!should_hide_on_blur(BlurCheck {
            settings_opening: true,
            ..blurred()
        }));
    }
}
