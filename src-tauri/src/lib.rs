mod account;
mod account_credentials;
mod actions;
mod ai;
mod atomic_file;
mod autostart;
mod backup;
#[cfg(test)]
mod bindings;
mod command;
mod config;
mod debounce;
mod diagnostics;
mod draft_keys;
mod error_codes;
mod events;
mod focus;
mod folder;
mod hex;
mod history_store;
mod hotkey;
mod i18n;
#[cfg(target_os = "macos")]
mod menu_tracking;
#[cfg(not(target_os = "macos"))]
mod package;
mod placement;
mod pro;
mod profile;
mod secrets;
mod store;
mod sync;
mod sync_key;
#[cfg(test)]
mod test_support;
mod text;
// 境目の型は、Windows でもテストで書き出す。Windows では書き出すだけで使わない
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod update_status;
#[cfg(target_os = "macos")]
mod updater;

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
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
    ai::AiService,
    config::{ActionEncoding, ActionOutput, Config, Language, Snippet, Theme},
    draft_keys::{DraftAction, DraftKeys, Platform},
    hotkey::Registrar as _,
    i18n::Lang,
    sync_key::SyncKeyStatus,
    text::{CharWidths, PunctuationStyle, Replacement, ReplacementMatch},
};

const MAIN_WINDOW: &str = "main";
pub(crate) const APP_NAME: &str = "Mawok";
/// ログファイルの名前（tauri-plugin-log が既定で使うアプリ名）
const LOG_FILE_STEM: &str = APP_NAME;
const TERMS_URL: &str = "https://mawok.amiiby.com/terms/";
const PRIVACY_URL: &str = "https://mawok.amiiby.com/privacy/";
/// 運営者と問い合わせのページ。AI の不適切な出力も、ここから知らせてもらう（Microsoft Store Policies 11.16）
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
const MANUAL_SIZE: (f64, f64) = (720.0, 640.0);
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

/// アクションの実行（actions.rs・ai.rs）
#[derive(Default)]
struct ActionState {
    /// 使い回す HTTP クライアント。最初に窓口か AI とやり取りするときに作る
    client: OnceLock<reqwest::Client>,
    /// テキストウィンドウで移った作業フォルダー。None ならホームフォルダー（folder.rs）
    folder: Mutex<Option<PathBuf>>,
    /// 最近移ったフォルダー（folder.rs の remember）。最初に使うときにファイルから読む
    recent_folders: Mutex<Option<Vec<PathBuf>>>,
    /// アクションに振った番号の最大。起動中ずっと増やすので、窓を読み込み直しても番号は戻らない
    last_request: AtomicU64,
    /// 走っているアクションと、取り消した番号
    requests: Mutex<ActionRequests>,
    /// AI サービスのキーをキーチェーンから読んでいる数。読んでいる間は、フォーカスが外れても下書きを隠さない
    reading_key: AtomicUsize,
    /// フォルダーを選ぶ画面を出しているか。出している間は、フォーカスが外れても下書きを隠さない（pick_folder）
    picking_folder: AtomicBool,
    /// キーを読んでいる間に、フォーカスが外れても隠さずに見送ったか。読み終えたら、下書きにフォーカスを戻すかどうかに使う
    blur_kept_for_key: AtomicBool,
    /// Mawok のアカウントと結ぶため、127.0.0.1 で戻りを待ち受けているタスク（start_mawok_sign_in）
    mawok_sign_in: Mutex<Option<PendingMawokSignIn>>,
    /// Mawok のアカウントと結ぶ申し込みに振った番号の最大
    mawok_sign_in_id: AtomicU64,
    /// AI サービス・了解・キーを変えるコマンドを1つずつ流す。
    /// キーチェーンを待つ間に別のコマンドが設定を変えると、確かめた前提が崩れるため（キーを消した後に、保存前のキーで上書きするなど）
    settings: tauri::async_runtime::Mutex<()>,
}

/// アクションの番号は begin_action が振り、画面はその番号で run_action と cancel_action を呼ぶ。コマンドは届いた順に走るとは限らないので、
/// 取り消しが実行より先に走っても、後から始まった古い実行が新しい実行を打ち切らないよう、番号で見分ける
#[derive(Default)]
struct ActionRequests {
    /// 走っているアクションの番号と、それを打ち切る関数
    running: Option<(u64, AbortAction)>,
    /// これまでに始めたか取り消した番号の最大。これ以下の番号のアクションは始めない
    settled_through: u64,
}

/// アクションの実行を打ち切る関数
type AbortAction = Box<dyn Fn() + Send>;

/// 設定と、トレイに出す問題。設定画面から変えると、ここと設定の置き場の両方を更新する
struct AppState {
    /// 設定・同期の oplog・同期の記録の置き場（store.rs）
    store: Mutex<store::Store>,
    /// 設定のバックアップの置き場（backup.rs）
    backups_dir: PathBuf,
    pro_state_path: PathBuf,
    /// アプリのバージョン。ログの先頭に出しているものと同じ出どころにして、突き合わせられるようにする
    version: String,
    /// OS の言語設定から決めた言語。表示言語が「システム」のときに使う
    system_lang: Lang,
    config: Mutex<Config>,
    problems: Mutex<Problems>,
    /// 設定ウィンドウを作っている最中か。作成は非同期なので、連打で2つ作ろうとするのを止める
    settings_opening: AtomicBool,
    /// 現在選んでいる AI サービスのキーが資格情報管理にあるか。None は未確認。
    ai_key_available: Mutex<Option<(AiService, bool)>>,
    /// 最後に窓口が答えた Pro の状態。通信できない間は、期限の7日後までだけ使う。
    pro_state: Mutex<Option<pro::State>>,
    /// 資格情報管理で Mawok のアカウントトークンを読めたか。Pro の案内をサインイン前と区別する。
    mawok_account_signed_in: AtomicBool,
    /// Pro の状態を消すたびに進める。問い合わせている間にサインアウトやアカウントの替わりがあったら、その答えを捨てる。
    pro_generation: AtomicUsize,
    /// 資格情報管理にある同期の鍵（docs/sync.md「同期のパスワード」）。設定の置き場には置かない。
    sync_key: Mutex<Option<[u8; 32]>>,
    /// 同期に使う鍵の見分け。Pro で窓口と照らした後だけある。
    sync_key_id: Mutex<Option<String>>,
    /// Pro の同期で、窓口が覚えている鍵と手元の鍵が揃っているか。Pro でなければ None。
    sync_key_status: Mutex<SyncKeyStatus>,
    /// 鍵の確かめ・作成・窓口への登録・資格情報管理への保存を、一続きにする。
    sync_key_refresh: tokio::sync::Mutex<()>,
    /// 窓口と鍵を照らせた回数。読み直しを頼んだ側が、照らせたかを見分けるのに使う（recheck_sync_key）
    sync_key_checks: AtomicUsize,
    /// 設定を保存するたびに進める。同期の通信の間に利用者が変えた設定を、通信の前の設定から作った結果で戻さない。
    sync_generation: AtomicUsize,
    /// 同期の記録を消すたびに進める。サインアウトや鍵の替わりの後に、通信中だった同期が古い記録を書き戻さない。
    sync_record_generation: AtomicUsize,
    /// 同期の記録を保存する処理と消す処理を直列にする。消した直後に通信中の古い記録が戻らないようにする。
    sync_commit: tokio::sync::Mutex<()>,
    sync_schedule: Mutex<SyncSchedule>,
    sync_debounce: debounce::Debounce,
    /// テキストウィンドウを出したことをきっかけに、最後に同期を頼んだ時刻
    synced_on_show: Mutex<Option<Instant>>,
    /// テキストウィンドウから AI の設定を頼まれた。設定ウィンドウが、開いたときに受け取る
    ai_settings_requested: AtomicBool,
    /// メニューを開いている間だけ登録を外しているホットキー（macOS）。閉じたらこれを登録し直す
    #[cfg(target_os = "macos")]
    hotkey_paused_for_menu: Mutex<Option<String>>,
    /// 開いているメニューの深さ（macOS）。サブメニューなどで開く・閉じるの通知が入れ子になっても、
    /// いちばん外のメニューを開いたときに外し、閉じたときに戻す
    #[cfg(target_os = "macos")]
    menu_depth: std::sync::atomic::AtomicUsize,
}

#[derive(Default)]
struct SyncSchedule {
    running: bool,
    pending: bool,
}

impl AppState {
    fn lang(&self) -> Lang {
        Lang::resolve(self.config.lock().unwrap().language, self.system_lang)
    }

    /// Pro の同期で、窓口が覚えている鍵と手元の鍵が揃っているか。Pro を使えない間は None
    fn shown_sync_key_status(&self) -> SyncKeyStatus {
        if !self.pro_available() {
            return SyncKeyStatus::None;
        }
        *self.sync_key_status.lock().unwrap()
    }

    fn pro_available(&self) -> bool {
        self.pro_state
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|pro| pro.available_at(pro::now()))
    }

    /// `service` のキーが資格情報管理にあるか。確かめていないか、確かめたのが別の AI サービスなら None
    fn ai_key_available(&self, service: AiService) -> Option<bool> {
        self.ai_key_available
            .lock()
            .unwrap()
            .and_then(|(checked, available)| (checked == service).then_some(available))
    }

    /// `service` のキーがあるかを覚える
    fn remember_ai_key(&self, service: AiService, available: bool) {
        *self.ai_key_available.lock().unwrap() = Some((service, available));
    }

    /// 覚えていたキーのあるなしを忘れ、未確認に戻す
    fn forget_ai_key(&self) {
        *self.ai_key_available.lock().unwrap() = None;
    }
}

/// トレイメニューに ⚠ 付きで出す問題。表示言語が変わったら文言を作り直すので、原因だけを持つ
#[derive(Default)]
struct Problems {
    config: Option<ConfigProblem>,
    hotkey_unavailable: bool,
    autostart_failed: Option<autostart::SetError>,
}

/// 設定の置き場についてトレイに出すこと。次に起動し直すまで出す
enum ConfigProblem {
    /// 置き場を読めなかったので、元のファイルを写してから既定の設定で作り直した。写した先のファイル名
    Reset(String),
    /// 置き場を開けず、作り直せもしなかった。設定は保存されない
    Unsaved(String),
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
    /// 定型文。登録した順。変えていなければ、今の表示言語の既定の定型文
    snippets: Vec<Snippet>,
    /// 同期を使える Pro か
    pro_available: bool,
    /// 同期で、窓口が覚えている鍵とこのデバイスの鍵が揃っているか。Pro でなければ None
    sync_key_status: SyncKeyStatus,
    /// Mawok のアカウントトークンを資格情報管理から読めたか
    mawok_account_signed_in: bool,
    /// デバイスごとに選ぶ同期する種類
    sync_kinds: sync::Kinds,
    /// 種類「設定」から外した設定の項目名
    sync_excluded_settings: Vec<String>,
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
    ai_service: AiService,
    /// 今の AI サービスと送り先（OpenAI ならベース URL も）に了解しているか
    ai_consented: bool,
    /// AI サービスごとに設定したモデル。書いていないサービスは既定のモデル
    ai_models: BTreeMap<AiService, String>,
    /// AI サービスごとの既定のモデル。既定は Rust 側だけで決める
    default_ai_models: BTreeMap<AiService, String>,
    /// AI サービスが OpenAI のときに送る API の URL。空なら OpenAI（`CONSTANTS.OPENAI_BASE_URL`）
    ai_base_url: String,
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
    let pro_available = state.pro_available();
    let modified_settings = config::modified_settings(&config);
    SettingsView {
        revision,
        sync_kinds: sync::kinds(&config),
        sync_excluded_settings: config.sync_excluded_settings.clone(),
        locale: lang.code(),
        ai_service: config.ai_service,
        ai_consented: config.ai_consented(),
        ai_models: config.ai_models,
        ai_base_url: config.ai_base_url,
        default_ai_models: AiService::ALL
            .into_iter()
            .filter(|service| *service != AiService::None)
            .map(|service| (service, service.default_model().to_string()))
            .collect(),
        platform: Platform::current(),
        hotkey: config.hotkey,
        modified_settings,
        text_window_keys: config.text_window_keys,
        default_draft_keys: DraftKeys::default(),
        default_hotkey: config::DEFAULT_HOTKEY,
        autostart: config.autostart,
        language: config.language,
        theme: config.theme,
        text_window_always_on_top: config.text_window_always_on_top,
        hide_text_window_on_blur: config.hide_text_window_on_blur,
        show_text_window_buttons: config.show_text_window_buttons,
        text_history_size: config.text_history_size,
        trim_trailing_whitespace: config.trim_trailing_whitespace,
        replacements: config.replacements,
        snippets: config
            .snippets
            .unwrap_or_else(|| actions::default_snippets(lang)),
        pro_available,
        sync_key_status: state.shown_sync_key_status(),
        mawok_account_signed_in: state.mawok_account_signed_in.load(Ordering::Relaxed),
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

fn window_state_flags() -> StateFlags {
    StateFlags::POSITION | StateFlags::SIZE
}

/// ウィンドウの位置と大きさを記録するときの名前。最小の大きさがなかったころの記録（最小より小さいことがある）を戻さないよう、
/// 名前を変えて記録がない状態から始める。window-state プラグインは記録した大きさを最小と比べずに当てるため。
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
        notify_draft_hidden(app);
    }
}

/// 下書きウィンドウを隠したことを画面に知らせる。アクションは取り消さずに続け、隠れている間に届いた結果は、画面が出し直したときに差し替える。
/// フォーカスが外れたときと閉じるボタンは画面を通らずに隠すので、隠すところで知らせる
fn notify_draft_hidden(app: &AppHandle) {
    let _ = app.emit(events::DRAFT_HIDDEN, ());
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
    request_sync_on_show(app);
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
    let current = placement::Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    };
    let (x, y) = placement::fit(current, &areas);
    if (x, y) != (current.x, current.y) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
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
    /// 設定の「ほかのアプリに移ったら下書きを隠す」
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
    /// AI サービスのキーを読んでいる最中か。macOS はキーチェーンの許可のダイアログを前面に出すので、
    /// フォーカスが外れても、ユーザーがほかへ移ったわけではない（許可に応じている間に下書きが消えないようにする）
    reading_ai_key: bool,
    /// フォルダーを選ぶ画面を出しているか。画面にフォーカスが移っても、ユーザーがほかへ移ったわけではない
    picking_folder: bool,
}

/// 隠すのは、出ていて、一度フォーカスが入った後に外れたままで、それが設定ウィンドウのためではないときだけ
fn should_hide_on_blur(check: BlurCheck) -> bool {
    check.enabled
        && check.visible
        && check.focused_since_shown
        && !check.focused
        && !check.settings_focused
        && !check.settings_opening
        && !check.reading_ai_key
        && !check.picking_folder
}

/// 初めての起動として下書きを出すか。設定の置き場がなかったうえで、作れたときだけ。
/// 作れなかったら、次の起動でも置き場がなく、起動のたびに出てしまうため
fn is_first_launch(store_missing: bool, problem: Option<&ConfigProblem>) -> bool {
    store_missing && !matches!(problem, Some(ConfigProblem::Unsaved(_)))
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
        reading_ai_key: app
            .state::<ActionState>()
            .reading_key
            .load(Ordering::Relaxed)
            > 0,
        picking_folder: app
            .state::<ActionState>()
            .picking_folder
            .load(Ordering::Relaxed),
    };
    if !should_hide_on_blur(check) {
        if check.reading_ai_key
            && should_hide_on_blur(BlurCheck {
                reading_ai_key: false,
                ..check
            })
        {
            app.state::<ActionState>()
                .blur_kept_for_key
                .store(true, Ordering::Relaxed);
        }
        return;
    }
    info!("hide on blur");
    if let Err(error) = hide_draft_in_place(app, &window) {
        error!("hide on blur failed: {error}");
    }
}

/// 下書きウィンドウを、戻り先へフォーカスを戻さずに隠す。隠せたら画面に知らせる
fn hide_draft_in_place(app: &AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let _ = app.save_window_state(window_state_flags());
    window.hide()?;
    notify_draft_hidden(app);
    Ok(())
}

/// 下書きウィンドウを隠して、直前のアプリへフォーカスを戻す。コピーするときも、しないときも通る
fn hide_draft_and_return(app: &AppHandle, state: &DraftState) -> Result<(), String> {
    let _ = app.save_window_state(window_state_flags());
    // 自分で隠したものを、設定を閉じたときに出し直さない
    state.hidden_for_settings.store(false, Ordering::Relaxed);
    let window = main_window(app).ok_or("main window not found")?;
    let target = *state.return_target.lock().unwrap();
    focus::hide_and_return(app, &window, target).map_err(|error| error.to_string())?;
    notify_draft_hidden(app);
    Ok(())
}

/// クリップボードへ文字列を書く。`conceal` のときは、クリップボードの履歴・同期・管理アプリに残さないよう印を付ける。
/// Tauri のクリップボードのプラグインは印を付けて書けないので、arboard を直接使う
fn write_clipboard(text: &str, conceal: bool) -> Result<(), arboard::Error> {
    let mut clipboard = arboard::Clipboard::new()?;
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
    set.text(text)
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

/// 設定を変えて保存する。保存できなければ何も変えない。画面とトレイへの反映は `apply_config` で行う。
/// 変えた同期の項目は、手元で変えたものとして oplog に積む
fn save_config(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    save_config_if_current(app, None, true, change).map(|saved| saved.expect("unconditional save"))
}

/// `expected_generation` を指定した同期だけ、利用者の保存と競合していない設定を保存する。
/// `record_changes` は、変えた同期の項目を oplog に積むか。同期で届いた値は手元で変えたものではないので積まない。
/// 設定と oplog は、置き場の同じトランザクションで書く
fn save_config_if_current(
    app: &AppHandle,
    expected_generation: Option<usize>,
    record_changes: bool,
    change: impl FnOnce(&mut Config),
) -> Result<Option<()>, String> {
    let state = app.state::<AppState>();
    let mut config = state.config.lock().unwrap();
    if expected_generation
        .is_some_and(|generation| state.sync_generation.load(Ordering::SeqCst) != generation)
    {
        return Ok(None);
    }
    let mut next = config.clone();
    change(&mut next);
    let changed = if record_changes {
        let at = now_millis();
        sync::changed_items(&config, &next)
            .into_iter()
            .map(|name| (name, at))
            .collect()
    } else {
        Vec::new()
    };
    state.store.lock().unwrap().commit(&store::Commit {
        entries: Some(&config::stored_entries(&next)),
        changed,
        ..store::Commit::default()
    })?;
    *config = next;
    state.sync_generation.fetch_add(1, Ordering::SeqCst);
    Ok(Some(()))
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
    save_config(app, change)?;
    schedule_sync_after_change(app);
    Ok(())
}

/// 設定を変えて保存し、開いているウィンドウとトレイに反映する。保存できなければ何も変えない
fn update_config(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    save_config(app, change)?;
    apply_config(app);
    schedule_sync_after_change(app);
    Ok(())
}

/// 同期で届いた設定・バックアップから戻す設定を保存し、画面から変えるコマンドと同じ反映を通す（docs/sync.md「1回の同期」）。
/// OS に断られて反映できなかった項目は、手元の値のままにして返す。同期では、呼び出し元が読み捨ての記録に置く。
/// `record_changes` は、変えた同期の項目を oplog に積むか（バックアップから戻すときは、ほかのデバイスにも届けるので積む）。
/// 読んでいる間に設定が変わっていたら、何も変えずに None を返す
fn save_received_config(
    app: &AppHandle,
    generation: usize,
    record_changes: bool,
    mut next: Config,
) -> Result<Option<Vec<sync::ItemKey>>, String> {
    let state = app.state::<AppState>();
    let current = state.config.lock().unwrap().clone();
    let mut rejected = Vec::new();
    // ウィンドウとホットキーは、コマンドと同じく保存の前に当てる。当てられない値を保存すると、設定と実際が食い違う
    if next.text_window_always_on_top != current.text_window_always_on_top
        && set_draft_window_always_on_top(app, next.text_window_always_on_top).is_err()
    {
        next.text_window_always_on_top = current.text_window_always_on_top;
        rejected.push(sync::setting_item(config::key::TEXT_WINDOW_ALWAYS_ON_TOP));
    }
    if next.hotkey != current.hotkey {
        if let Err(error) =
            hotkey::replace(&mut PluginRegistrar(app), &current.hotkey, &next.hotkey)
        {
            warn!("couldn't register the hotkey received by sync: {error}");
            next.hotkey.clone_from(&current.hotkey);
            rejected.push(sync::hotkey_item());
            // 届いたキーは届いたホットキーと重ならないことしか確かめていない。元のホットキーと重なるなら、キーも入れない
            if draft_keys::check_hotkey(&next.text_window_keys, &next.hotkey, Platform::current())
                .is_err()
            {
                next.text_window_keys = current.text_window_keys.clone();
                next.yielded_draft_keys = current.yielded_draft_keys.clone();
                rejected.push(sync::text_window_keys_item());
            }
        }
    }
    let saved = save_config_if_current(app, Some(generation), record_changes, |config| {
        *config = next.clone()
    });
    if !matches!(saved, Ok(Some(_))) {
        // 保存しなかったので、先に当てたものを設定に残る値へ戻す
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
        return saved.map(|_| None);
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
            warn!("couldn't clear draft history after sync: {error}");
        }
    }
    // キーはサービスごと、OpenAI はベース URL ごとに置くので、替わったら確かめ直す
    if next.ai_service != current.ai_service || next.ai_base_url != current.ai_base_url {
        state.forget_ai_key();
    }
    Ok(Some(rejected))
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
    let state = app.state::<AppState>();
    // 設定は保存できているので、OS への登録に失敗したことはトレイの ⚠ にも出す
    state.problems.lock().unwrap().autostart_failed = failed.clone();
    // 画面とトレイへの反映は、⚠ も決まってから一度だけ行う
    apply_config(&app);
    failed.map_or(Ok(()), |error| {
        Err(autostart_error_text(&error, state.lang()))
    })
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

/// 下書きの履歴の件数。0 なら覚えない。範囲の外は上限に収める
#[tauri::command]
fn set_draft_history_size(app: AppHandle, size: u16) -> Result<(), String> {
    let size = size.min(config::MAX_DRAFT_HISTORY_SIZE);
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

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(history_store::FILE_NAME))
}

/// 今の時刻。UNIX のミリ秒。履歴と同期の oplog に付ける
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
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
    let path = history_path(&app)?;
    if size == 0 {
        clear_draft_history_file(&app, false)?;
        return Ok(Vec::new());
    }
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    match history_store::load(&path) {
        Ok(history) => {
            screen.caught_up();
            let entries = history.truncated(size).texts();
            info!("loaded draft history: {} entries", entries.len());
            Ok(entries)
        }
        Err(error) => {
            warn!("couldn't read draft history: {error}");
            // 読めなかっただけ・除けられなかっただけなら、画面は同期で届いた履歴をまだ持っていない。
            // 持ったことにすると、次の保存が届いた履歴を画面の古い一覧で上書きする
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

#[tauri::command]
fn save_draft_history(app: AppHandle, entries: Vec<String>) -> Result<(), String> {
    let path = history_path(&app)?;
    // 件数の設定は、ロックを取ってから読む。読んだ後に件数 0 へ変えられて消されると、
    // 消した後に古い履歴を書き戻してしまう
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    let size = draft_history_size(&app);
    let texts = history_store::truncate(entries, size);
    let file = history_store::load(&path).unwrap_or_else(|error| {
        warn!("couldn't read draft history before saving: {error}");
        history_store::History::default()
    });
    let next = screen.saved(&file, texts, size, now_millis());
    // 画面は、読み込んだ履歴をそのまま保存し直すことがある。変わっていなければ、書かず、同期もさせない
    if next == file {
        return Ok(());
    }
    info!("saving draft history: {} entries", next.entries.len());
    history_store::save(&path, &next).map_err(|error| error.to_string())?;
    drop(screen);
    schedule_sync_after_change(&app);
    Ok(())
}

#[tauri::command]
fn clear_draft_history(app: AppHandle) -> Result<(), String> {
    // 件数が 0 のデバイスの画面は、起動のたびにこれを呼ぶ。そのたびに消した時刻を置くと、まだ件数が届いていない
    // デバイスが覚えた履歴まで消す（docs/sync.md「混ぜ方」）
    let asked = draft_history_size(&app) != 0;
    clear_draft_history_file(&app, asked)?;
    app.emit(events::DRAFT_HISTORY_CLEARED, ())
        .map_err(|error| error.to_string())
}

/// 履歴を消し、消した時刻を置く（docs/sync.md「履歴の同期」）。`always` が false なら、消す履歴があるときだけ置く
fn clear_draft_history_file(app: &AppHandle, always: bool) -> Result<(), String> {
    let path = history_path(app)?;
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    screen.caught_up();
    let file = history_store::load(&path);
    if !always && matches!(&file, Ok(history) if history.entries.is_empty()) {
        return Ok(());
    }
    let cleared = file.unwrap_or_default().cleared(now_millis());
    history_store::save(&path, &cleared).map_err(|error| error.to_string())?;
    info!("cleared draft history");
    drop(screen);
    schedule_sync_after_change(app);
    Ok(())
}

/// 同期で混ぜた履歴を保存し、テキストウィンドウに知らせる（docs/sync.md「履歴の同期」）。`snapshot` は、同期を
/// 始めたときの手元の履歴。保存した履歴が `next` と違う（もう一度同期して窓口へ書く分がある）かを返す
fn apply_synced_history(
    app: &AppHandle,
    snapshot: &history_store::History,
    next: history_store::History,
) -> Result<bool, String> {
    let path = history_path(app)?;
    let mut screen = HISTORY_FILE_LOCK.lock().unwrap();
    let size = draft_history_size(app);
    let current = history_store::load(&path).map_err(|error| error.to_string())?;
    let merged = history_store::applied_from_sync(&current, snapshot, &next, size);
    if merged != current {
        history_store::save(&path, &merged).map_err(|error| error.to_string())?;
        info!(
            "applied synced draft history: {} entries",
            merged.entries.len()
        );
        screen.replaced_by_sync(current);
        let _ = app.emit(events::DRAFT_HISTORY_SYNCED, ());
    }
    // 届いた履歴を今の件数に切り詰めた分は、手元を変えたことにしない。もう一度同期しても同じ値が届く
    Ok(merged != next.truncated(size))
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

/// 下書きウィンドウの AI のエラーの帯から、設定ウィンドウを「AI」で開く。
/// 開いている設定ウィンドウにはイベントで、これから作る設定ウィンドウには目印で伝える
#[tauri::command]
fn open_ai_settings(app: AppHandle) {
    app.state::<AppState>()
        .ai_settings_requested
        .store(true, Ordering::SeqCst);
    open_settings(&app);
    let _ = app.emit_to(SETTINGS_WINDOW, events::AI_SETTINGS_REQUESTED, ());
}

/// 設定ウィンドウが、「AI」で開くよう頼まれていたかを受け取る。受け取ったら頼みは消える
#[tauri::command]
fn take_ai_settings_request(state: tauri::State<'_, AppState>) -> bool {
    state.ai_settings_requested.swap(false, Ordering::SeqCst)
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
    let mut replacements = replacements;
    config::repair_item_ids(&mut replacements)?;
    save_as_typed(&app, |config| config.replacements = replacements.clone())?;
    Ok(replacements)
}

#[tauri::command]
fn set_snippets(app: AppHandle, snippets: Vec<Snippet>) -> Result<Vec<Snippet>, String> {
    info!("set snippets: {} entries", snippets.len());
    // 打つたびに呼ばれる。設定画面は自分で欄を持っているが、下書きウィンドウの一覧が使うので、辞書と違い画面へは反映する。
    // トレイには関わらないので、打つたびに作り直さない
    let mut snippets = snippets;
    config::repair_item_ids(&mut snippets)?;
    save_as_typed(&app, |config| config.snippets = Some(snippets.clone()))?;
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
    let state = app.state::<AppState>();
    let lang = state.lang();
    let exists = state
        .config
        .lock()
        .unwrap()
        .snippets
        .clone()
        // 既定の定型文のままなら、この後に書き出す既定の定型文と比べる
        .unwrap_or_else(|| actions::default_snippets(lang))
        .iter()
        .any(|existing| existing.body == snippet.body);
    if exists {
        info!("add snippet: already registered");
        return Ok(false);
    }
    let mut snippet = snippet;
    config::repair_item_ids(std::slice::from_mut(&mut snippet))?;
    info!("add snippet");
    // 既定の定型文のままなら、既定の定型文を書き出してから足す。足した1件だけを書くと、既定の定型文が消える
    save_as_typed(&app, |config| {
        config
            .snippets
            .get_or_insert_with(|| actions::default_snippets(lang))
            .push(snippet.clone())
    })?;
    emit_settings(&app);
    // 設定画面は定型文の並びを自分で持っていて settings-changed では写し直さないので、足した1件を別に知らせる。
    // 知らせないと、設定画面を開いたままにしていたとき、次に設定画面で直したときの保存で消える
    let _ = app.emit(events::SNIPPET_ADDED, &snippet);
    Ok(true)
}

/// 待つことのある処理（資格情報管理、同期のパスワードからの鍵の導出、バックアップのファイルの読み書き）を、メインスレッドを止めずに別のスレッドで走らせる。
/// 走らせたスレッドが落ちたら、その理由を返す
async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())
}

/// AI サービスのキーがあるかを、キーチェーンを待つ間メインスレッドを止めずに確かめる
/// `user` は資格情報管理に置くときの名前（`Config::ai_credential_user`）
async fn ai_key_exists(service: AiService, user: String) -> Result<bool, String> {
    run_blocking(move || match service {
        AiService::Mawok => account_credentials::has_token(),
        _ => secrets::exists(&user),
    })
    .await?
    .inspect_err(|error| warn!("couldn't check the AI key: {error}"))
}

/// 送る内容と扱いを了解する。画面が出した AI サービスと送り先（OpenAI ならベース URL）が、今のものと違えば断る。
#[tauri::command]
async fn consent_ai(app: AppHandle, service: AiService, base_url: String) -> Result<(), String> {
    info!("acknowledge AI with {}", service.name());
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    let (current, current_url) = {
        let state = app.state::<AppState>();
        let config = state.config.lock().unwrap();
        (config.ai_service, config.ai_base_url.clone())
    };
    if current != service || service == AiService::None {
        return Err(format!(
            "the AI service changed to {} before consenting",
            current.name(),
        ));
    }
    if service == AiService::OpenAi && current_url != base_url {
        return Err("the base URL changed before consenting".to_string());
    }
    update_config(&app, |config| {
        config.ai_consent = Some(service);
        // 記録するのは、検査済みの今のベース URL。OpenAI でなければ送り先の URL は無い
        config.ai_consent_base_url = if service == AiService::OpenAi {
            current_url
        } else {
            String::new()
        };
    })?;
    Ok(())
}

/// AI サービスを替える。キーとモデルと了解の記録はサービスごとに残す。
#[tauri::command]
async fn set_ai_service(app: AppHandle, service: AiService) -> Result<(), String> {
    info!("set AI service: {}", service.name());
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    app.state::<AppState>().forget_ai_key();
    update_config(&app, |config| config.ai_service = service)
}

/// AI サービスのモデル。空文字（前後の空白だけのものを含む）で既定のモデルに戻す
#[tauri::command]
fn set_ai_model(app: AppHandle, service: AiService, model: String) -> Result<(), String> {
    let model = model.trim().to_string();
    info!(
        "set AI model for {}: {}",
        service.name(),
        if model.is_empty() { "default" } else { &model }
    );
    update_config(&app, |config| {
        if model.is_empty() {
            config.ai_models.remove(&service);
        } else {
            config.ai_models.insert(service, model);
        }
    })
}

/// AI サービスが OpenAI のときに送る API の URL。空か OpenAI の URL で既定に戻す。
/// 送り先が変わるので、OpenAI への了解を取り直す（docs/actions.md「AI（`@ai`）」）
#[tauri::command]
async fn set_ai_base_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = ai::normalize_base_url(&url).ok_or_else(|| "invalid base URL".to_string())?;
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    if app.state::<AppState>().config.lock().unwrap().ai_base_url == url {
        return Ok(());
    }
    // ログにはホストだけを出す。パスに秘密を入れるサービスがありうるため
    let host = reqwest::Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string));
    info!("set AI base URL: {}", host.as_deref().unwrap_or("default"));
    // 了解は送り先の URL と組で記録しているので、替えた先には了解していないことになる（Config::ai_consented）
    update_config(&app, |config| config.ai_base_url = url)?;
    // キーは送り先ごとに置くので、替えた先のキーを確かめ直す
    app.state::<AppState>().forget_ai_key();
    Ok(())
}

/// 今の表示言語の既定の定型文。設定画面は、打っている途中の定型文を消さないよう、並びを自分で持ち、
/// これを後ろに足してから set_snippets で保存する
#[tauri::command]
fn default_snippets(app: AppHandle) -> Vec<Snippet> {
    actions::default_snippets(app.state::<AppState>().lang())
}

/// 今の AI サービスと、そのキーを資格情報管理に置くときの名前
fn ai_service_and_user(app: &AppHandle) -> (AiService, String) {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap();
    (config.ai_service, config.ai_credential_user())
}

/// 今の AI サービスのキーがあるか。中身は読まない
#[tauri::command]
async fn has_ai_key(app: AppHandle) -> Result<bool, String> {
    // 確かめている間に、キーの保存・削除やサービスの切り替えがキャッシュを書き換えて、古い結果で上書きしないようにする
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    let (service, user) = ai_service_and_user(&app);
    if service == AiService::None {
        app.state::<AppState>().forget_ai_key();
        return Ok(false);
    }
    let available = match ai_key_exists(service, user).await {
        Ok(available) => available,
        Err(error) => {
            app.state::<AppState>().forget_ai_key();
            apply_config(&app);
            return Err(error);
        }
    };
    app.state::<AppState>().remember_ai_key(service, available);
    apply_config(&app);
    Ok(available)
}

/// 今の AI サービスのキーを入れる（入れ直す）。前後の空白は取り除く。キーはログに残さない
#[tauri::command]
async fn set_ai_key(app: AppHandle, key: String) -> Result<(), String> {
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    let (service, user) = ai_service_and_user(&app);
    // Mawok はキーを入れず、アカウントと結んで受け取る（start_mawok_sign_in）
    if service == AiService::None || service == AiService::Mawok {
        return Err(actions::Failure::Disabled.code().to_string());
    }
    info!("set the AI key for {}", service.name());
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("the key is empty".to_string());
    }
    // 了解の記録を消す保存を先にする。キーの保存の後で終了しても、入れ直したキーが了解なしで使われないようにするため。
    // キーの保存が失敗しても、記録は消えたまま（了解のダイアログをもう一度出すだけ）なので、画面には知らせる
    save_config(&app, |config| config.ai_consent = None)?;
    let written = run_blocking(move || secrets::write(&user, &key))
        .await
        .and_then(|result| result.inspect_err(|error| error!("couldn't save the AI key: {error}")));
    if written.is_ok() {
        app.state::<AppState>().remember_ai_key(service, true);
    }
    apply_config(&app);
    written
}

/// 今の AI サービスのキーを消す。選択・了解・ほかの AI サービスのキーは残す
#[tauri::command]
async fn delete_ai_key(app: AppHandle) -> Result<(), String> {
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    let (service, user) = ai_service_and_user(&app);
    // Mawok はキーを持たない。トークンはサインアウトで消す（sign_out_mawok）
    if service == AiService::None || service == AiService::Mawok {
        return Err(actions::Failure::Disabled.code().to_string());
    }
    info!("delete the AI key for {}", service.name());
    run_blocking(move || secrets::delete(&user))
        .await?
        .inspect_err(|error| error!("couldn't delete the AI key: {error}"))?;
    app.state::<AppState>().remember_ai_key(service, false);
    apply_config(&app);
    Ok(())
}

/// Mawok のアカウントと結ぶ申し込み。終わりの知らせと組にする番号
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
struct MawokSignIn {
    /// 申し込みの番号。終わりの知らせ（MawokSignInEnded）に同じ番号が付く
    #[cfg_attr(test, ts(type = "number"))]
    id: u64,
}

/// Mawok のアカウントと結ぶ申し込みが終わった（MAWOK_SIGN_IN_ENDED の中身）。結べたら true、期限が切れたか失敗したら false。
/// 画面は、出している申し込みと同じ番号の知らせだけを受ける（やり直す前の申し込みの終わりで、表示を戻さないため）
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
struct MawokSignInEnded {
    #[cfg_attr(test, ts(type = "number"))]
    id: u64,
    signed_in: bool,
}

/// 続いている申し込み。待ち受けるタスクと、開き直すサインインのページの URL
struct PendingMawokSignIn {
    shown: MawokSignIn,
    url: String,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// 窓口とのやり取りにも、AI のアクションと同じ HTTP クライアントを使い回す
fn http_client(app: &AppHandle) -> Result<reqwest::Client, String> {
    let state = app.state::<ActionState>();
    if let Some(client) = state.client.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(ai::CONNECT_TIMEOUT)
        .timeout(ai::TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(state.client.get_or_init(|| client).clone())
}

/// 設定か履歴を続けて変えたときは最後から3秒だけ待ち、1回の同期へまとめる。
fn schedule_sync_after_change(app: &AppHandle) {
    let debounce = &app.state::<AppState>().sync_debounce;
    let app = app.clone();
    debounce.trigger(Duration::from_secs(3), move || request_sync(&app));
}

/// テキストウィンドウを出すたびに窓口へ問い合わせないための間隔。出して隠すのを続けて繰り返しても、窓口の回数の上限に届かない長さにする
const SYNC_ON_SHOW_INTERVAL: Duration = Duration::from_secs(10);

/// テキストウィンドウを出したときに同期する。ほかのデバイスで覚えた履歴を、出してすぐたどれるようにするため（docs/sync.md「いつ同期するか」）
fn request_sync_on_show(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut last = state.synced_on_show.lock().unwrap();
        if last.is_some_and(|at| at.elapsed() < SYNC_ON_SHOW_INTERVAL) {
            return;
        }
        *last = Some(Instant::now());
    }
    request_sync(app);
}

/// 同期は1つだけ走らせ、実行中に届いたきっかけは終わった後の1回へまとめる。
fn request_sync(app: &AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut schedule = state.sync_schedule.lock().unwrap();
        if schedule.running {
            schedule.pending = true;
            return;
        }
        schedule.running = true;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            run_sync(&app).await;
            let again = {
                let state = app.state::<AppState>();
                let mut schedule = state.sync_schedule.lock().unwrap();
                if schedule.pending {
                    schedule.pending = false;
                    true
                } else {
                    schedule.running = false;
                    false
                }
            };
            if !again {
                break;
            }
        }
    });
}

/// 窓口の同期の入口と話すのに要るもの。
struct SyncAccess {
    client: reqwest::Client,
    token: String,
    key: [u8; 32],
    key_id: String,
}

impl SyncAccess {
    fn transport(&self) -> sync::HttpTransport<'_> {
        sync::HttpTransport {
            client: &self.client,
            token: &self.token,
            key: &self.key,
            key_id: &self.key_id,
        }
    }
}

/// 同期が動く条件（docs/sync.md 冒頭）を満たしていれば、窓口と話すのに要るものを返す。
async fn sync_access(app: &AppHandle) -> Option<SyncAccess> {
    let (key, key_id) = {
        let state = app.state::<AppState>();
        if !state.pro_available() || *state.sync_key_status.lock().unwrap() != SyncKeyStatus::Ready
        {
            return None;
        }
        let key = *state.sync_key.lock().unwrap();
        let key_id = state.sync_key_id.lock().unwrap().clone();
        (key?, key_id?)
    };
    let token = match run_blocking(account_credentials::read_token).await {
        Ok(Ok(token)) => token,
        Ok(Err(error)) => {
            warn!("couldn't read the Mawok account token for sync: {error:?}");
            return None;
        }
        Err(error) => {
            warn!("couldn't read the Mawok account token for sync: {error}");
            return None;
        }
    };
    let client = match http_client(app) {
        Ok(client) => client,
        Err(error) => {
            warn!("couldn't create a sync client: {error}");
            return None;
        }
    };
    Some(SyncAccess {
        client,
        token,
        key,
        key_id,
    })
}

/// 設定と、それを読んだときの保存の世代。設定の保存は、設定の排他の中で世代を進めるので、同じ排他の中で読む。
/// 別々に読むと、間に入った保存を見落として、古い設定で上書きしうる
fn config_with_generation(state: &AppState) -> (Config, usize) {
    let config = state.config.lock().unwrap();
    (config.clone(), state.sync_generation.load(Ordering::SeqCst))
}

/// 置き場にある同期の記録。読めなければ、記録が無いものとして初めての同期からやり直す
fn read_sync_record(state: &AppState) -> Option<sync::State> {
    let text = match state.store.lock().unwrap().sync_state() {
        Ok(text) => text?,
        Err(error) => {
            warn!("couldn't read the sync state: {error}");
            return None;
        }
    };
    sync::parse_state(&text)
}

/// 同期の記録を読む。別の鍵の記録は、無いものとして扱う
fn load_sync_record(app: &AppHandle, key_id: &str) -> Option<sync::State> {
    read_sync_record(&app.state::<AppState>()).filter(|state| state.key_id == key_id)
}

/// まだ窓口へ送っていない手元の変更（oplog）。読めなければ None。空として同期すると、送っていない手元の変更を
/// 窓口の値で上書きする
fn load_outbox(app: &AppHandle) -> Option<BTreeMap<String, u64>> {
    app.state::<AppState>()
        .store
        .lock()
        .unwrap()
        .outbox()
        .inspect_err(|error| warn!("couldn't read the sync outbox: {error}"))
        .ok()
}

async fn run_sync(app: &AppHandle) {
    let (config, generation, record_generation, outbox) = {
        let state = app.state::<AppState>();
        // oplog も設定と同じ排他の中で読む。後で読むと、間に入った保存の時刻を古い値に付けて書き、
        // 書けた時刻で oplog から外すので、新しい値を送らないまま落とす
        let config = state.config.lock().unwrap();
        let outbox = load_outbox(app);
        let generation = state.sync_generation.load(Ordering::SeqCst);
        let record_generation = state.sync_record_generation.load(Ordering::SeqCst);
        (config.clone(), generation, record_generation, outbox)
    };
    let kinds = sync::kinds(&config);
    let Some(outbox) = outbox.filter(|_| kinds.any()) else {
        return;
    };
    let Some(access) = sync_access(app).await else {
        return;
    };
    let key_id = &access.key_id;
    // 読めない履歴ファイルは、画面が読み込むときに除けるので、この回は履歴を同期しない
    let local_history = match history_path(app) {
        _ if !kinds.history => None,
        Ok(path) => run_blocking(move || {
            let _guard = HISTORY_FILE_LOCK.lock().unwrap();
            history_store::load(&path).ok()
        })
        .await
        .ok()
        .flatten(),
        _ => None,
    };
    let before = load_sync_record(app, key_id);
    let synced = sync::sync_once(
        access.transport(),
        &config,
        before.clone(),
        &outbox,
        local_history.as_ref(),
    )
    .await;
    match synced {
        Ok(mut result) => {
            if result.reset {
                info!("sync server reset the local record");
            }
            let app_state = app.state::<AppState>();
            let _commit = lock_sync_commit(
                app,
                result.changed && ai_destination_changes(&config, &result.config),
            )
            .await;
            if app_state.sync_record_generation.load(Ordering::SeqCst) != record_generation {
                // サインアウトや鍵の替わりで記録を消した後。この結果は、前の鍵・前のアカウントのもの
                return;
            }
            // 通信の間に設定が変わっていたら、読んだ値は手元に入れずに捨てて、もう一度同期する
            let mut discard = app_state.sync_generation.load(Ordering::SeqCst) != generation;
            let mut retry = discard;
            if !discard && result.changed {
                match save_received_config(app, generation, false, result.config.clone()) {
                    Ok(Some(rejected)) => {
                        let previous = before.as_ref().filter(|_| !result.reset);
                        for item in &rejected {
                            sync::ignore_applied(&mut result.state, previous, item);
                        }
                        apply_received_config(app);
                    }
                    Ok(None) => {
                        discard = true;
                        retry = true;
                    }
                    Err(error) => {
                        warn!("couldn't save settings received by sync: {error}");
                        discard = true;
                    }
                }
            }
            // 履歴は設定と別に手元へ入れる。設定の結果を捨てる回も、混ぜた履歴は捨てない
            if let (Some(snapshot), Some(next)) = (&local_history, result.history.take()) {
                match apply_synced_history(app, snapshot, next) {
                    Ok(again) => retry |= again,
                    Err(error) => warn!("couldn't save draft history received by sync: {error}"),
                }
            }
            // 窓口の値を入れた項目は、入れたときだけ oplog から外す。書けた項目は、捨てる回も外す
            let (record, settled) = if discard {
                (
                    sync::merge_written(before, &result.written, result.reset, key_id),
                    result.sent,
                )
            } else {
                let mut settled = result.accepted;
                settled.append(&mut result.sent);
                (result.state, settled)
            };
            let _ = save_sync_record(app, record, settled).await;
            if retry {
                request_sync(app);
            }
        }
        Err(failure) => {
            // 途中まで書けていたら、その項目の記録だけは置く。忘れると、次の回に自分の書き込みを他人の変更と取り違える
            if !failure.written.items.is_empty() || !failure.written.retired.is_empty() {
                let app_state = app.state::<AppState>();
                let _commit = app_state.sync_commit.lock().await;
                if app_state.sync_record_generation.load(Ordering::SeqCst) == record_generation {
                    let record =
                        sync::merge_written(before, &failure.written, failure.reset, key_id);
                    let _ = save_sync_record(app, record, failure.sent).await;
                }
            }
            match failure.error {
                sync::Error::KeyMismatch => {
                    info!("sync key mismatch; refreshing the sync key");
                    let _ = refresh_mawok_account_status(app).await;
                }
                sync::Error::SignedOut => {
                    info!("sync account token was rejected");
                    if let Err(error) = forget_mawok_token(app).await {
                        warn!("couldn't clear a rejected Mawok token: {error}");
                    }
                }
                error => warn!("sync failed: {error}"),
            }
        }
    }
}

/// 同期する種類を変える（docs/sync.md 冒頭）。オンにした種類は、すぐに同期する。
/// オフにした種類の記録は消さないので、オンに戻すと続きから合わせる
async fn change_sync_kind(app: &AppHandle, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    save_config(app, change)?;
    apply_config(app);
    mark_paused_sync_kinds(app).await;
    request_sync(app);
    Ok(())
}

/// オフにした種類を、同期の記録に残す。オフにした後の同期の回に任せると、全部オフの間（通信しない）と
/// つながらない間は残らず、オンに戻した回が、オフにしていたことを知らない（docs/sync.md 冒頭）。
/// 一度も同期していなければ、記録が無いので何もしない。オンに戻した回は、初めての同期になる
async fn mark_paused_sync_kinds(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _commit = state.sync_commit.lock().await;
    let config = state.config.lock().unwrap().clone();
    let Some(mut record) = read_sync_record(&state) else {
        return;
    };
    if record.pause(&config) {
        let text = sync::state_text(&record);
        if let Err(error) = state.store.lock().unwrap().commit(&store::Commit {
            sync_state: Some(Some(&text)),
            ..store::Commit::default()
        }) {
            warn_unsaved_sync_record(&error);
        }
    }
}

fn warn_unsaved_sync_record(error: &str) {
    warn!("couldn't save sync state: {error}");
}

/// 同期の記録を保存し、窓口と揃った項目を oplog から外す。通信の間にスイッチがオフになった種類は、
/// 前の記録から作った結果でオフの印を上書きしないよう、保存する前に置き直す。`sync_commit` の中で呼ぶ。
/// 保存できなければ、警告を出してからその理由を返す
async fn save_sync_record(
    app: &AppHandle,
    mut record: sync::State,
    settled: Vec<(String, u64)>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    record.pause(&config);
    let text = sync::state_text(&record);
    let saved = state.store.lock().unwrap().commit(&store::Commit {
        settled,
        sync_state: Some(Some(&text)),
        ..store::Commit::default()
    });
    if let Err(error) = &saved {
        warn_unsaved_sync_record(error);
    }
    saved
}

/// AI の送り先（AI サービスか、OpenAI のベース URL）が替わるか。キーの置き場の名前が替わるので、
/// キーを扱うコマンドと同じ排他（`ActionState.settings`）の中で替える
fn ai_destination_changes(before: &Config, after: &Config) -> bool {
    before.ai_service != after.ai_service || before.ai_base_url != after.ai_base_url
}

/// 同期の結果や、同期の外で作った設定と記録を置く間の排他。AI の送り先が替わるなら（`ai_destination_changes`）、
/// AI サービスを替えるコマンドと同じ排他も取る。
/// サインアウトは、その排他の中で同期の記録を消すので、記録の排他より先に取る
async fn lock_sync_commit(app: &AppHandle, ai_service_changes: bool) -> SyncCommitGuard<'_> {
    let settings = if ai_service_changes {
        Some(app.state::<ActionState>().inner().settings.lock().await)
    } else {
        None
    };
    let commit = app.state::<AppState>().inner().sync_commit.lock().await;
    SyncCommitGuard {
        _commit: commit,
        _settings: settings,
    }
}

/// `lock_sync_commit` で取った排他。取ったのと逆の順に返すよう、記録の排他を先に置く
struct SyncCommitGuard<'a> {
    _commit: tokio::sync::MutexGuard<'a, ()>,
    _settings: Option<tokio::sync::MutexGuard<'a, ()>>,
}

/// 同期やバックアップから入れた設定を、開いている窓とトレイに反映する。
fn apply_received_config(app: &AppHandle) {
    apply_config(app);
    // 設定の窓は、一覧と打っている欄を自分で持っていて settings-changed では写し直さない
    let _ = app.emit(
        events::CONFIG_REPLACED,
        settings_view(&app.state::<AppState>()),
    );
}

#[tauri::command]
async fn set_sync_kind(app: AppHandle, kind: sync::SyncKind, enabled: bool) -> Result<(), String> {
    info!("set sync kind {kind:?}: {enabled}");
    change_sync_kind(&app, |config| match kind {
        sync::SyncKind::Settings => config.sync_settings = enabled,
        sync::SyncKind::Keys => config.sync_keys = enabled,
        sync::SyncKind::Replacements => config.sync_replacements = enabled,
        sync::SyncKind::Snippets => config.sync_snippets = enabled,
        sync::SyncKind::History => config.sync_history = enabled,
    })
    .await
}

#[tauri::command]
async fn set_sync_excluded_setting(app: AppHandle, name: String, sync: bool) -> Result<(), String> {
    if !sync::known_syncable_setting(&name) {
        return Err("unknown syncable setting".to_string());
    }
    change_sync_kind(&app, move |config| {
        config
            .sync_excluded_settings
            .retain(|excluded| excluded != &name);
        if !sync {
            config.sync_excluded_settings.push(name);
        }
    })
    .await
}

/// バックアップの一覧。新しい順に、戻すと今の設定から変わる所を添える（docs/config.md「バックアップ」）
#[tauri::command]
async fn settings_backups(app: AppHandle) -> Result<Vec<sync::Backup>, String> {
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
            let restored = sync::restore_backup(&current, &backed_up);
            backups.push(sync::Backup {
                changes: sync::backup_differences(&current, &restored),
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
    config::from_entries(&entries)
        .map(|loaded| loaded.config)
        .map_err(std::io::Error::other)
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
/// 保存と反映は同期で届いた設定と同じ経路を通し、戻した値は手元で変えた値として、ほかのデバイスにも届ける
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
    let state = app.state::<AppState>();
    // 排他を待つ間に同期の結果が入ると世代が進むので、今の設定から作り直して、もう一度保存する
    for _ in 0..RESTORE_ATTEMPTS {
        let (current, _) = config_with_generation(&state);
        let ai_service_changes =
            ai_destination_changes(&current, &sync::restore_backup(&current, &backed_up));
        let _commit = lock_sync_commit(&app, ai_service_changes).await;
        // 同期の排他の中で、戻す直前の設定を残す。外で残すと、その後に入った同期の結果が戻す前の設定から漏れ、
        // 戻したことを戻せない
        back_up_now(&app).await?;
        let (current, generation) = config_with_generation(&state);
        let next = sync::restore_backup(&current, &backed_up);
        if next == current {
            return Ok(());
        }
        // 排他を取った後に AI の送り先の替わりが入った。AI サービスを替えるコマンドの排他も取り直す
        if ai_destination_changes(&current, &next) && !ai_service_changes {
            continue;
        }
        if let Some(rejected) = save_received_config(&app, generation, true, next)? {
            // OS に断られた項目があっても、残りは保存してあるので、画面と同期には伝える
            apply_received_config(&app);
            request_sync(&app);
            return if rejected.is_empty() {
                Ok(())
            } else {
                Err(error_codes::BACKUP_RESTORE_PARTIAL.to_string())
            };
        }
    }
    Err("settings kept changing while restoring the backup".to_string())
}

/// 戻す間に設定が変わったときに、作り直して保存し直す回数。続けて変わるのは同期の結果が重なったときだけで、数回で揃う
const RESTORE_ATTEMPTS: usize = 3;

/// 毎日の自動のバックアップ（docs/config.md「バックアップ」）。起動したときと、その後は1時間ごとに、
/// いちばん新しいバックアップから1日たっていれば書く。常駐したまま日をまたぐので、起動のときだけでは足りない
fn start_daily_backups(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            interval.tick().await;
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

/// サインインを待つ長さ。メールのリンクの期限（送ってから15分）より、送るまでの分だけ長く
const MAWOK_SIGN_IN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Mawok のアカウントと結ぶ（docs/account-server.md「Mawok とアカウントを結ぶ」）。127.0.0.1 で待ち受け、ブラウザで窓口の結ぶ画面を開く。
/// 窓口で結ぶと、ブラウザがこの待ち受けへ戻ってくるので、届いたコードをトークンに替える。
/// 設定の画面を閉じても、時間切れまでは待ち続ける（メールのリンクを待つ間に画面を移ることがあるため）。
/// 結べたらトークンを資格情報管理に置き、MAWOK_SIGN_IN_ENDED で知らせる。前の申し込みが続いていれば打ち切る
#[tauri::command]
async fn start_mawok_sign_in(app: AppHandle) -> Result<MawokSignIn, String> {
    info!("start signing in to the Mawok account");
    let client = http_client(&app)?;
    let link = account::LinkRequest::new()?;
    // ループバックだけで待ち受ける。ほかのアドレスで待ち受けると、OS がファイアウォールの許可を求めるため
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| {
            error!("couldn't listen for the sign-in: {error}");
            error.to_string()
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let lang = app.state::<AppState>().lang();
    // コンピューター名は macOS ではコマンド（scutil）を待って読むので、非同期の処理を止めない
    let name = run_blocking(account::device_name).await?;
    let url = link.url(port, &name, lang.code());
    if let Err(error) = open_page(&app, &url) {
        // ブラウザが開かなくても、画面の「ページを開き直す」から開ける
        warn!("couldn't open the sign-in page: {error}");
    }
    let action_state = app.state::<ActionState>();
    let id = action_state.mawok_sign_in_id.fetch_add(1, Ordering::SeqCst) + 1;
    let shown = MawokSignIn { id };
    let task_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let signed_in = tokio::time::timeout(
            MAWOK_SIGN_IN_TIMEOUT,
            wait_for_link(&task_app, &client, &listener, &link, lang),
        )
        .await
        .unwrap_or(false);
        info!("signing in to the Mawok account ended (signed in: {signed_in})");
        // 終わった申し込みを片付ける。やり直した後の新しい申し込みは残す
        {
            let action_state = task_app.state::<ActionState>();
            let mut pending = action_state.mawok_sign_in.lock().unwrap();
            if pending
                .as_ref()
                .is_some_and(|pending| pending.shown.id == id)
            {
                *pending = None;
            }
        }
        let _ = task_app.emit(
            events::MAWOK_SIGN_IN_ENDED,
            MawokSignInEnded { id, signed_in },
        );
    });
    let previous = action_state
        .mawok_sign_in
        .lock()
        .unwrap()
        .replace(PendingMawokSignIn {
            shown: shown.clone(),
            url,
            task,
        });
    if let Some(previous) = previous {
        previous.task.abort();
    }
    Ok(shown)
}

/// 窓口から戻ったブラウザを待ち、届いたコードをトークンに替えて置く。替えられなければ false。
/// ブラウザにはこの待ち受けが答え、結果を伝えて Mawok へ戻るよう促す
async fn wait_for_link(
    app: &AppHandle,
    client: &reqwest::Client,
    listener: &tokio::net::TcpListener,
    link: &account::LinkRequest,
    lang: i18n::Lang,
) -> bool {
    use tokio::io::AsyncWriteExt;
    let (mut stream, code) = accept_callback(listener, &link.state).await;
    let token = account::exchange_code(client, &code, &link.verifier)
        .await
        .inspect_err(|error| error!("couldn't get the Mawok account token: {error:?}"))
        .ok();
    // 置くのは別のタスクにする。置いている途中で申し込みが打ち切られても、置いたことと覚えたことが食い違わないように
    let signed_in = match token {
        Some(token) => {
            let save_app = app.clone();
            tauri::async_runtime::spawn(async move { save_mawok_token(&save_app, token).await })
                .await
                .unwrap_or(false)
        }
        None => false,
    };
    let (title, body) = lang.mawok_sign_in_page(signed_in);
    let page = format!(
        "<!doctype html><html lang=\"{lang}\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">\
         <meta name=\"color-scheme\" content=\"light dark\">\
         <title>{title}</title><body style=\"font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.7;word-break:auto-phrase\">\
         <h1 style=\"font-size:1.25rem\">{title}</h1><p>{body}</p></body></html>",
        lang = lang.code()
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.get_mut().write_all(response.as_bytes()).await;
    let _ = stream.get_mut().shutdown().await;
    signed_in
}

/// 同時に読む接続の上限。ブラウザが開く接続は数本なので、十分に多く
const MAX_CALLBACK_READERS: usize = 32;

/// 結ぶ画面から戻った要求が届くまで待ち受け、その接続とコードを返す。
/// 接続ごとに別のタスクで読む。ブラウザは要求を送らないままの接続を先に開くことがあり、
/// 1件ずつ読むと、その接続を待つ間に本物の戻りが後回しになるため
async fn accept_callback(
    listener: &tokio::net::TcpListener,
    state: &str,
) -> (tokio::io::BufReader<tokio::net::TcpStream>, String) {
    let (found_tx, mut found_rx) = tokio::sync::mpsc::channel(1);
    let mut readers = tokio::task::JoinSet::new();
    loop {
        while readers.try_join_next().is_some() {}
        tokio::select! {
            accepted = listener.accept() => match accepted {
                // 読みかけが多すぎれば、新しい接続は読まずに切る（読み取りのタスクを際限なく増やさないため）
                Ok(_) if readers.len() >= MAX_CALLBACK_READERS => {}
                Ok((stream, _)) => {
                    let found_tx = found_tx.clone();
                    let state = state.to_string();
                    readers.spawn(async move {
                        if let Some(found) = read_callback(stream, &state).await {
                            let _ = found_tx.send(found).await;
                        }
                    });
                }
                Err(error) => {
                    // 続けて失敗しても（記述子が尽きたときなど）回り続けないよう、少し待つ
                    warn!("couldn't accept the sign-in connection: {error}");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            },
            // 残りの接続は、readers を落とすときに読むのをやめる
            Some(found) = found_rx.recv() => return found,
        }
    }
}

/// 待ち受けに届いた接続の1行目を読み、結ぶ画面から戻った要求ならコードと組にして返す。
/// ほかの要求（ファビコンなど）や、ほかの申し込みの戻りには 404 を返す。読めない・長すぎる要求は、何も答えずに切る
async fn read_callback(
    stream: tokio::net::TcpStream,
    state: &str,
) -> Option<(tokio::io::BufReader<tokio::net::TcpStream>, String)> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::io::BufReader::new(stream);
    let mut line = String::new();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        (&mut stream).take(8192).read_line(&mut line),
    )
    .await;
    if !matches!(read, Ok(Ok(_))) {
        return None;
    }
    match account::code_from(state, line.trim_end()) {
        Some(code) => Some((stream, code)),
        None => {
            let _ = stream
                .get_mut()
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            None
        }
    }
}

/// 受け取ったトークンを置き、サインインした状態にする。置けなければ false
async fn save_mawok_token(app: &AppHandle, token: String) -> bool {
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    clear_pro_state(app).await;
    let saved = run_blocking(move || account_credentials::write_token(&token))
        .await
        .and_then(|result| result)
        .inspect_err(|error| error!("couldn't save the Mawok account token: {error}"))
        .is_ok();
    if saved {
        app.state::<AppState>()
            .remember_ai_key(AiService::Mawok, true);
        app.state::<AppState>()
            .mawok_account_signed_in
            .store(true, Ordering::Relaxed);
        apply_config(app);
        let refresh_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = refresh_mawok_account_status(&refresh_app).await;
        });
    }
    saved
}

/// 続いている申し込み。設定の「アカウント」を開き直したときに、サインインの途中であることを出し直す
#[tauri::command]
fn mawok_sign_in_pending(app: AppHandle) -> Option<MawokSignIn> {
    app.state::<ActionState>()
        .mawok_sign_in
        .lock()
        .unwrap()
        .as_ref()
        .map(|pending| pending.shown.clone())
}

/// 続いている申し込みを打ち切る（画面で「キャンセル」を押したとき）
#[tauri::command]
fn cancel_mawok_sign_in(app: AppHandle) {
    let pending = app
        .state::<ActionState>()
        .mawok_sign_in
        .lock()
        .unwrap()
        .take();
    if let Some(pending) = pending {
        pending.task.abort();
    }
}

/// 続いている申し込みのサインインのページを開き直す（ブラウザが開かなかったとき、閉じてしまったとき）
#[tauri::command]
fn reopen_mawok_sign_in_page(app: AppHandle) -> Result<(), String> {
    let url = app
        .state::<ActionState>()
        .mawok_sign_in
        .lock()
        .unwrap()
        .as_ref()
        .map(|pending| pending.url.clone());
    match url {
        Some(url) => open_page(&app, &url),
        None => Ok(()),
    }
}

/// Mawok のアカウントのメールアドレスと残り。サインインしていなければ None。
/// Pro の状態もこの問い合わせで更新する。トークンが窓口で外されていれば、手元のトークンも消して None を返す
#[tauri::command]
async fn mawok_account_status(app: AppHandle) -> Result<Option<account::AccountStatus>, String> {
    refresh_mawok_account_status(&app).await
}

async fn refresh_mawok_account_status(
    app: &AppHandle,
) -> Result<Option<account::AccountStatus>, String> {
    let generation = current_pro_generation(app);
    let stale = || !pro_generation_is_current(app, generation);
    let exists = run_blocking(account_credentials::exists)
        .await?
        .inspect_err(|error| warn!("couldn't check the Mawok account token: {error}"))?;
    if stale() {
        // 資格情報を確かめている間にサインインかサインアウトがあった。前の結果では、今の状態に触らない。
        return Ok(None);
    }
    // サインインしていない状態を、まだ片付けていないときだけ片付ける
    let clear_if_needed = || async {
        let already_cleared = {
            let state = app.state::<AppState>();
            state.pro_state.lock().unwrap().is_none()
                && !state.mawok_account_signed_in.load(Ordering::Relaxed)
        };
        if !already_cleared {
            clear_pro_state(app).await;
        }
    };
    if !exists {
        clear_if_needed().await;
        return Ok(None);
    }
    let reading = ReadingAiKey::start(app);
    let read = run_blocking(account_credentials::read_token).await?;
    drop(reading);
    if stale() {
        // 読んでいる間にサインインかサインアウトがあった。前のトークンの結果では、今の状態に触らない。
        return Ok(None);
    }
    let token = match read {
        Ok(token) => {
            let was_signed_in = app
                .state::<AppState>()
                .mawok_account_signed_in
                .swap(true, Ordering::Relaxed);
            if !was_signed_in {
                apply_config(app);
            }
            token
        }
        // 項目が同期の鍵だけ（サインアウトと鍵の保存が重なった）のときも、ここに来る
        Err(secrets::ReadError::NotFound) => {
            clear_if_needed().await;
            return Ok(None);
        }
        Err(secrets::ReadError::Unreadable(detail)) => {
            error!("couldn't read the Mawok account token: {detail}");
            app.state::<AppState>()
                .mawok_account_signed_in
                .store(false, Ordering::Relaxed);
            apply_config(app);
            return Err(actions::Failure::KeyUnreadable.code().to_string());
        }
    };
    let client = http_client(app)?;
    let answer = account::status(&client, &token).await;
    if stale() {
        // 前のトークンへの答え。今のアカウントの状態にも、今のトークンにも触らない。
        return Ok(None);
    }
    match answer {
        Ok(status) => {
            let changed_account = app
                .state::<AppState>()
                .pro_state
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|old| old.account_id != status.account_id);
            if changed_account {
                forget_sync_key(app).await;
            }
            remember_pro_state(app, &status, generation).await;
            if status.pro.active {
                refresh_sync_key(app, &client, &token, generation).await;
            } else {
                *app.state::<AppState>().sync_key_id.lock().unwrap() = None;
                set_sync_key_status(app, SyncKeyStatus::None);
            }
            Ok(Some(status))
        }
        Err(account::AccountError::SignedOut) => {
            info!("the Mawok account token was removed on the account page");
            forget_mawok_token(app).await?;
            Ok(None)
        }
        Err(error) => {
            warn!("couldn't ask the Mawok account: {error:?}");
            if app.state::<AppState>().pro_available()
                && *app.state::<AppState>().sync_key_status.lock().unwrap() == SyncKeyStatus::None
            {
                restore_local_sync_key(app).await;
            } else {
                apply_config(app);
            }
            Err(error_codes::ACCOUNT_UNREACHABLE.to_string())
        }
    }
}

/// 窓口へつながらない間は、最後に確かめた Pro の猶予と資格情報管理の鍵で同期を続ける。
async fn restore_local_sync_key(app: &AppHandle) {
    // 読んでから置くまでの間に、パスワードで開いた鍵を、読んだ前の鍵で上書きしない
    let state = app.state::<AppState>();
    let _refresh = state.sync_key_refresh.lock().await;
    if let Some(local) = load_sync_key().await {
        use_unverified_sync_key(app, local);
    }
}

fn use_unverified_sync_key(app: &AppHandle, local: Option<[u8; 32]>) {
    *app.state::<AppState>().sync_key.lock().unwrap() = local;
    // 同期は鍵の見分けも要る（sync_access）。窓口と照らせない間は、手元の鍵から導く
    *app.state::<AppState>().sync_key_id.lock().unwrap() = local.as_ref().map(sync_key::key_id);
    set_sync_key_status(app, sync_key::offline_status(local.as_ref()));
}

/// 同期の鍵の状態を置き、画面に反映する。
fn set_sync_key_status(app: &AppHandle, status: SyncKeyStatus) {
    *app.state::<AppState>().sync_key_status.lock().unwrap() = status;
    apply_config(app);
}

/// 資格情報管理の同期の鍵。鍵が無ければ `Some(None)`、読めなければ警告を出して None
async fn load_sync_key() -> Option<Option<[u8; 32]>> {
    match run_blocking(sync_key::load).await {
        Ok(Ok(key)) => Some(key),
        Ok(Err(error)) | Err(error) => {
            warn!("couldn't read the sync key: {error}");
            None
        }
    }
}

fn current_pro_generation(app: &AppHandle) -> usize {
    app.state::<AppState>()
        .pro_generation
        .load(Ordering::SeqCst)
}

fn pro_generation_is_current(app: &AppHandle, generation: usize) -> bool {
    current_pro_generation(app) == generation
}

/// Pro の確認の直後に、窓口の包んだ鍵と資格情報管理の鍵を照らして、同期の鍵の状態を決める（docs/sync.md「同期のパスワード」）。
async fn refresh_sync_key(
    app: &AppHandle,
    client: &reqwest::Client,
    token: &str,
    generation: usize,
) {
    let state = app.state::<AppState>();
    let _refresh = state.sync_key_refresh.lock().await;
    if !pro_generation_is_current(app, generation) {
        return;
    }
    // 読めない・壊れた手元の鍵は「無い」として照らす。抜けられない None のままにせず、包んだ鍵があれば「入力」、
    // 無ければ「作成」の欄を出す（パスワードを入れれば上書きされる）
    let local = load_sync_key().await.flatten();
    let server = match account::sync_key(client, token).await {
        Ok(server) => server,
        Err(error) => {
            warn!("couldn't check the sync key: {error:?}");
            // 窓口と照らして決まっていた状態（NeedsPassword・NotStarted・Ready）は、一時的な失敗で手元の鍵から決め直さない。
            // 決め直すと、画面が「入力」と同期の設定の間で揺れ、古い鍵で同期が始まる。まだ照らしていない（None）ときだけ使う
            let unverified =
                *app.state::<AppState>().sync_key_status.lock().unwrap() == SyncKeyStatus::None;
            if unverified && pro_generation_is_current(app, generation) {
                use_unverified_sync_key(app, local);
            }
            return;
        }
    };
    if !pro_generation_is_current(app, generation) {
        return;
    }
    app.state::<AppState>()
        .sync_key_checks
        .fetch_add(1, Ordering::SeqCst);
    let status = sync_key::decide(
        server.key_id.as_deref(),
        server.wrapped_key.is_some(),
        local.as_ref(),
    );
    *app.state::<AppState>().sync_key.lock().unwrap() = local;
    *app.state::<AppState>().sync_key_id.lock().unwrap() = server.key_id;
    if status != SyncKeyStatus::Ready {
        // 窓口の鍵と揃うまでは同期しない。前の鍵の記録は、揃った後の鍵では使えないので消す
        clear_sync_state(app).await;
    }
    set_sync_key_status(app, status);
    if status == SyncKeyStatus::Ready {
        request_sync(app);
    }
}

async fn clear_sync_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _commit = state.sync_commit.lock().await;
    state.sync_record_generation.fetch_add(1, Ordering::SeqCst);
    let cleared = state.store.lock().unwrap().commit(&store::Commit {
        sync_state: Some(None),
        ..store::Commit::default()
    });
    if let Err(error) = cleared {
        warn!("couldn't clear the sync state: {error}");
    }
}

/// サインアウトとアカウントの替わりで、同期の鍵の状態と進みを消す。
/// 鍵の状態を置く処理（確かめ・始める・パスワードで開く）と同じ排他を取り、消すのを必ず後にする
async fn forget_sync_key(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _refresh = state.sync_key_refresh.lock().await;
    *app.state::<AppState>().sync_key.lock().unwrap() = None;
    *app.state::<AppState>().sync_key_id.lock().unwrap() = None;
    *app.state::<AppState>().sync_key_status.lock().unwrap() = SyncKeyStatus::None;
    clear_sync_state(app).await;
    apply_config(app);
}

const PRO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 定期同期の間隔（docs/sync.md「いつ同期するか」）。
const SYNC_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// 起動直後と6時間ごとに窓口へ確かめる。トークンが無いときは、問い合わせずに状態を片付ける。
fn start_periodic_pro_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(PRO_CHECK_INTERVAL);
        loop {
            interval.tick().await;
            if let Err(error) = refresh_mawok_account_status(&app).await {
                info!("couldn't refresh the Pro state: {error}");
            }
        }
    });
}

fn start_periodic_sync(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // スイッチを切り替えた後、記録を置く前にアプリが止まったときのため、起動のときにも置く
        mark_paused_sync_kinds(&app).await;
        let mut interval = tokio::time::interval(SYNC_INTERVAL);
        loop {
            interval.tick().await;
            request_sync(&app);
        }
    });
}

/// 窓口が答えた状態は、次の起動でオフライン猶予を使えるよう別の状態ファイルに置く。保存に失敗しても、今回の窓口の答えは使う。
async fn remember_pro_state(app: &AppHandle, status: &account::AccountStatus, generation: usize) {
    let state = pro::State::from_status(status.account_id.clone(), &status.pro);
    let path = app.state::<AppState>().pro_state_path.clone();
    *app.state::<AppState>().pro_state.lock().unwrap() = Some(state.clone());
    let saved_path = path.clone();
    if let Err(error) = run_blocking(move || pro::save(&saved_path, &state)).await {
        warn!("couldn't save the Pro state: {error}");
    }
    if !pro_generation_is_current(app, generation) {
        // 保存している間に消された。消した後の状態に合わせ直す。
        *app.state::<AppState>().pro_state.lock().unwrap() = None;
        if let Ok(Err(error)) = run_blocking(move || pro::clear(&path)).await {
            warn!("couldn't clear the Pro state: {error}");
        }
    }
    apply_config(app);
}

/// サインインしていない状態にする。アカウントが替わったときに前のアカウントの猶予を使わないよう、メモリーと状態ファイルの両方を消す。
async fn clear_pro_state(app: &AppHandle) {
    let path = app.state::<AppState>().pro_state_path.clone();
    app.state::<AppState>()
        .pro_generation
        .fetch_add(1, Ordering::SeqCst);
    *app.state::<AppState>().pro_state.lock().unwrap() = None;
    app.state::<AppState>()
        .mawok_account_signed_in
        .store(false, Ordering::Relaxed);
    forget_sync_key(app).await;
    match run_blocking(move || pro::clear(&path)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) | Err(error) => warn!("couldn't clear the Pro state: {error}"),
    }
    apply_config(app);
}

/// 手元のトークンを消し、サインインしていない状態にする
async fn forget_mawok_token(app: &AppHandle) -> Result<(), String> {
    let action_state = app.state::<ActionState>();
    let _settings = action_state.settings.lock().await;
    run_blocking(account_credentials::delete_token)
        .await?
        .inspect_err(|error| error!("couldn't delete the Mawok account token: {error}"))?;
    app.state::<AppState>()
        .remember_ai_key(AiService::Mawok, false);
    clear_pro_state(app).await;
    Ok(())
}

/// Mawok のアカウントからサインアウトする。窓口でトークンを外し、手元のトークンを消す。
/// 窓口に届かなくても手元のトークンは消す（窓口の画面からも外せる）
#[tauri::command]
async fn sign_out_mawok(app: AppHandle) -> Result<(), String> {
    info!("sign out of the Mawok account");
    if let Ok(Ok(token)) = run_blocking(account_credentials::read_token).await {
        let client = http_client(&app)?;
        if let Err(error) = account::sign_out(&client, &token).await {
            warn!("couldn't remove the token on the account server: {error:?}");
        }
    }
    forget_mawok_token(&app).await
}

/// 窓口と同期の鍵の状態を照らし直し、画面に「状態が変わった」と返す。鍵の排他（sync_key_refresh）は放してから呼ぶ
/// 読み直しそのものに失敗したら（つながらない・窓口の不調）、画面の欄は移っていないので、その失敗を返す
async fn recheck_sync_key(app: &AppHandle) -> String {
    let checks = || {
        app.state::<AppState>()
            .sync_key_checks
            .load(Ordering::SeqCst)
    };
    let before = checks();
    match refresh_mawok_account_status(app).await {
        Err(error) => {
            info!("couldn't recheck the sync key: {error}");
            error
        }
        // Pro は確かめられたが、鍵を窓口と照らせなかった（refresh_sync_key は一時的な失敗で状態を保つ）
        Ok(Some(status)) if status.pro.active && checks() == before => {
            info!("couldn't recheck the sync key against the account server");
            error_codes::ACCOUNT_UNREACHABLE.to_string()
        }
        Ok(_) => error_codes::SYNC_STATE_CHANGED.to_string(),
    }
}

/// 鍵の排他を取った後に、サインインのトークンと、そのときの Pro の世代を読む。
/// 排他を待つ間にサインアウトや別のアカウントへのサインインが済んでいても、今のアカウントのトークンで送るため
async fn token_in_generation(app: &AppHandle) -> Result<(String, usize), String> {
    let generation = current_pro_generation(app);
    let token = mawok_token().await?;
    if !pro_generation_is_current(app, generation) {
        return Err(error_codes::SYNC_STATE_CHANGED.to_string());
    }
    Ok((token, generation))
}

/// 窓口とのやり取りの失敗を、画面に渡す符号にする。トークンが外されていれば、手元もサインアウトする。
/// 鍵の排他（sync_key_refresh）は放してから呼ぶ（Pro が終わったときに、鍵の状態を読み直すため）
async fn account_failure(app: &AppHandle, context: &str, error: account::AccountError) -> String {
    match error {
        account::AccountError::SignedOut => {
            info!("{context}: the Mawok account token was removed on the account page");
            if let Err(error) = forget_mawok_token(app).await {
                warn!("couldn't forget the Mawok account token: {error}");
            }
            actions::Failure::SignInRequired.code().to_string()
        }
        // Pro が終わっていた。Pro の状態を読み直すと、同期の所が閉じる
        account::AccountError::Http(403) => {
            info!("{context}: Pro is no longer active");
            recheck_sync_key(app).await
        }
        account::AccountError::Http(status) if status == 429 || status >= 500 => {
            warn!("{context}: HTTP {status}");
            error_codes::ACCOUNT_UNREACHABLE.to_string()
        }
        // 送った要求の形が窓口と合わない。利用者には直せないので、ログを見るよう案内する
        account::AccountError::Http(status) => {
            warn!("{context}: HTTP {status}");
            actions::Failure::Unexpected.code().to_string()
        }
        account::AccountError::Other(detail) => {
            warn!("{context}: {detail}");
            error_codes::ACCOUNT_UNREACHABLE.to_string()
        }
    }
}

/// サインインのトークン。無ければ「サインインが要る」の符号
async fn mawok_token() -> Result<String, String> {
    match run_blocking(account_credentials::read_token).await? {
        Ok(token) => Ok(token),
        Err(secrets::ReadError::NotFound) => {
            Err(actions::Failure::SignInRequired.code().to_string())
        }
        Err(secrets::ReadError::Unreadable(detail)) => {
            error!("couldn't read the Mawok account token: {detail}");
            Err(actions::Failure::KeyUnreadable.code().to_string())
        }
    }
}

/// パスワードで鍵を包む・開くのは重い（Argon2id）ので、画面のスレッドを止めない
async fn unwrap_sync_key(wrapped: String, password: String) -> Result<[u8; 32], String> {
    match run_blocking(move || sync_key::unwrap(&wrapped, &password)).await? {
        Ok(key) => Ok(key),
        Err(sync_key::UnwrapError::WrongPassword) => {
            Err(error_codes::SYNC_WRONG_PASSWORD.to_string())
        }
        // 新しい版が包んだ鍵など。この版では開けない
        Err(sync_key::UnwrapError::Unreadable(detail)) => {
            warn!("couldn't read the wrapped sync key: {detail}");
            Err(actions::Failure::Unexpected.code().to_string())
        }
    }
}

/// 資格情報管理に鍵を置く。失敗は、ログに残して設定の失敗として返す
async fn store_sync_key(key: [u8; 32]) -> Result<(), String> {
    run_blocking(move || sync_key::store(&key))
        .await?
        .inspect_err(|error| error!("couldn't store the sync key: {error}"))
}

/// 窓口に断られたときに、資格情報管理の鍵を、置き換える前に戻す。前の鍵が無かった・読めなかった（`None`）なら消す。
/// 読めなかった鍵は、新しい鍵を置いたときに上書きされていて、戻すものが無いため
async fn restore_sync_key(previous: Option<Option<[u8; 32]>>) {
    let restored = match previous.flatten() {
        Some(key) => run_blocking(move || sync_key::store(&key)).await,
        None => run_blocking(account_credentials::clear_key).await,
    };
    if let Ok(Err(error)) | Err(error) = restored {
        warn!("couldn't restore the previous sync key: {error}");
    }
}

/// 窓口の鍵と揃った鍵（資格情報管理には置いてある）をメモリーに置き、同期を始める。前の鍵の記録は消す
async fn adopt_sync_key(app: &AppHandle, key: [u8; 32]) {
    *app.state::<AppState>().sync_key.lock().unwrap() = Some(key);
    *app.state::<AppState>().sync_key_id.lock().unwrap() = Some(sync_key::key_id(&key));
    clear_sync_state(app).await;
    set_sync_key_status(app, SyncKeyStatus::Ready);
    request_sync(app);
}

/// 同期を始める。新しい鍵を作って同期のパスワードで包み、窓口に置く。各デバイスの設定と履歴は消さない。
/// `replace` が false（「同期を開始」）なら、窓口にまだ包んだ鍵が無いときだけ始める（ほかのデバイスがもう始めていれば、
/// 画面を「入力」へ移す）。true（「同期をリセット」）なら、窓口の写しを消して新しい鍵で始め直す。
/// ほかのデバイスは、新しいパスワードを入れるまで同期が止まる
#[tauri::command]
async fn start_sync(app: AppHandle, password: String, replace: bool) -> Result<(), String> {
    info!("start sync (replace: {replace})");
    if !sync_key::password_long_enough(&password) {
        return Err(error_codes::SYNC_PASSWORD_TOO_SHORT.to_string());
    }
    let state = app.state::<AppState>();
    let refresh = state.sync_key_refresh.lock().await;
    let (token, generation) = token_in_generation(&app).await?;
    // None は読めなかった。読めない鍵は、無かった鍵と同じに消さない（戻すときに触らない）
    let previous = load_sync_key().await;
    let key = run_blocking(sync_key::generate).await??;
    let wrapped = run_blocking(move || sync_key::wrap(&key, &password)).await??;
    let client = http_client(&app)?;
    // 包んでいる間（1秒ほど）に、サインアウトや別のアカウントへのサインインが済んでいたら、何も置かない
    if !pro_generation_is_current(&app, generation) {
        return Err(error_codes::SYNC_STATE_CHANGED.to_string());
    }
    // 窓口より先に手元へ置く。窓口が受け付けた後に手元へ置けないと、窓口だけが新しい鍵になり、このデバイスが加われない
    store_sync_key(key).await?;
    let started =
        account::start_sync(&client, &token, &sync_key::key_id(&key), &wrapped, replace).await;
    match started {
        Ok(true) => {
            adopt_sync_key(&app, key).await;
            Ok(())
        }
        Ok(false) => {
            info!("sync was already started on another device");
            restore_sync_key(previous).await;
            drop(refresh);
            Err(recheck_sync_key(&app).await)
        }
        // 窓口が受けたか分からない（つながらない・窓口の不調）。窓口の今の key_id を読めて、新しい鍵なら受けていたので
        // 新しい鍵で続ける。違う・読めないなら前の鍵に戻す。新しい鍵を残すのは、窓口が受けたと分かったときだけにし、
        // 手元と窓口の鍵が食い違ったまま再起動して、新しいパスワードが黙って無くなるのを防ぐ
        Err(error @ (account::AccountError::Other(_) | account::AccountError::Http(500..))) => {
            let new_key_id = sync_key::key_id(&key);
            match account::sync_key(&client, &token).await {
                Ok(server) if server.key_id.as_deref() == Some(new_key_id.as_str()) => {
                    info!("sync was started although the answer was lost");
                    adopt_sync_key(&app, key).await;
                    return Ok(());
                }
                Ok(_) => {}
                Err(detail) => info!("couldn't check whether sync was started: {detail:?}"),
            }
            restore_sync_key(previous).await;
            drop(refresh);
            Err(account_failure(&app, "couldn't start sync", error).await)
        }
        // 窓口が断った（受けていない）。置く前の鍵に戻す。サインアウトは、トークンと一緒に鍵も消える
        Err(error) => {
            if !matches!(error, account::AccountError::SignedOut) {
                restore_sync_key(previous).await;
            }
            drop(refresh);
            Err(account_failure(&app, "couldn't start sync", error).await)
        }
    }
}

/// 窓口の包んだ鍵と、その鍵の見分けを読む。どちらかが無い（ほかのデバイスでリセットされて写しが消えた）ときは、
/// 状態を読み直して画面の欄を移す。読み直しは鍵の排他を取るので、失敗したときは受け取った排他を放してから行う
async fn read_wrapped_key<'a>(
    app: &AppHandle,
    client: &reqwest::Client,
    token: &str,
    refresh: tokio::sync::MutexGuard<'a, ()>,
) -> Result<(tokio::sync::MutexGuard<'a, ()>, String, String), String> {
    let server = match account::sync_key(client, token).await {
        Ok(server) => server,
        Err(error) => {
            drop(refresh);
            return Err(account_failure(app, "couldn't read the sync key", error).await);
        }
    };
    let (Some(key_id), Some(wrapped)) = (server.key_id, server.wrapped_key) else {
        drop(refresh);
        return Err(recheck_sync_key(app).await);
    };
    Ok((refresh, key_id, wrapped))
}

/// ほかのデバイスで始めた同期に加わる。窓口の包んだ鍵を同期のパスワードで開き、このデバイスに置く
#[tauri::command]
async fn unlock_sync(app: AppHandle, password: String) -> Result<(), String> {
    info!("unlock sync");
    let state = app.state::<AppState>();
    let refresh = state.sync_key_refresh.lock().await;
    let (token, generation) = token_in_generation(&app).await?;
    let client = http_client(&app)?;
    // 鍵を置き終えるまで排他を持つ（読み直しと重ならないように）
    let (_refresh, key_id, wrapped) = read_wrapped_key(&app, &client, &token, refresh).await?;
    let key = unwrap_sync_key(wrapped, password).await?;
    if sync_key::key_id(&key) != key_id {
        warn!("the wrapped sync key doesn't match its key ID");
        return Err(actions::Failure::Unexpected.code().to_string());
    }
    // 開いている間に、サインアウトや別のアカウントへのサインインが済んでいたら、置かない
    if !pro_generation_is_current(&app, generation) {
        return Err(error_codes::SYNC_STATE_CHANGED.to_string());
    }
    store_sync_key(key).await?;
    adopt_sync_key(&app, key).await;
    Ok(())
}

/// 同期のパスワードを変える。同じ鍵を新しいパスワードで包み直して窓口に置く。ほかのデバイスは、入れ直さずに同期を続ける
#[tauri::command]
async fn change_sync_password(
    app: AppHandle,
    current: String,
    password: String,
) -> Result<(), String> {
    info!("change the sync password");
    if !sync_key::password_long_enough(&password) {
        return Err(error_codes::SYNC_PASSWORD_TOO_SHORT.to_string());
    }
    let state = app.state::<AppState>();
    let refresh = state.sync_key_refresh.lock().await;
    let (token, generation) = token_in_generation(&app).await?;
    let client = http_client(&app)?;
    let (refresh, key_id, wrapped) = read_wrapped_key(&app, &client, &token, refresh).await?;
    // 先に窓口の鍵と手元の鍵を照らす。ほかのデバイスがリセットして手元の鍵が古いと、前のパスワードは開けず、
    // 「パスワードが正しくありません」が出続けるため。違えば状態を読み直して「入力」の欄へ移す
    let local = *app.state::<AppState>().sync_key.lock().unwrap();
    if local.as_ref().map(sync_key::key_id) != Some(key_id) {
        drop(refresh);
        return Err(recheck_sync_key(&app).await);
    }
    // 今のパスワードで開けることで、変えてよい人かを確かめる（窓口はパスワードを知らない）
    let key = unwrap_sync_key(wrapped, current).await?;
    if local != Some(key) {
        warn!("the wrapped sync key doesn't match its key ID");
        return Err(actions::Failure::Unexpected.code().to_string());
    }
    let rewrapped = run_blocking(move || sync_key::wrap(&key, &password)).await??;
    if !pro_generation_is_current(&app, generation) {
        return Err(error_codes::SYNC_STATE_CHANGED.to_string());
    }
    match account::put_sync_key(&client, &token, &sync_key::key_id(&key), &rewrapped).await {
        Ok(true) => Ok(()),
        // 開いた後に、ほかのデバイスがリセットした
        Ok(false) => {
            drop(refresh);
            Err(recheck_sync_key(&app).await)
        }
        Err(error) => {
            drop(refresh);
            Err(account_failure(&app, "couldn't change the sync password", error).await)
        }
    }
}

/// 同じアカウントにサインインしているデバイスの一覧（設定の「アカウント」の「デバイス」）
#[tauri::command]
async fn mawok_devices(app: AppHandle) -> Result<Vec<account::SignedInDevice>, String> {
    let token = mawok_token().await?;
    let client = http_client(&app)?;
    match account::devices(&client, &token).await {
        Ok(devices) => Ok(devices),
        Err(error) => Err(account_failure(&app, "couldn't list the devices", error).await),
    }
}

/// ほかのデバイスをサインアウトさせる。このデバイス自身は `sign_out_mawok` でサインアウトする
#[tauri::command]
async fn sign_out_mawok_device(app: AppHandle, id: String) -> Result<(), String> {
    info!("sign out another device");
    let token = mawok_token().await?;
    let client = http_client(&app)?;
    match account::sign_out_device(&client, &token, &id).await {
        // 404 は、ほかの所で先にサインアウトしていた。画面は一覧を読み直すだけでよい
        Ok(()) | Err(account::AccountError::Http(404)) => Ok(()),
        Err(error) => Err(account_failure(&app, "couldn't sign out the device", error).await),
    }
}

/// 残高を買い足す入口をブラウザで開く
#[tauri::command]
fn open_mawok_buy_page(app: AppHandle) -> Result<(), String> {
    let lang = app.state::<AppState>().lang();
    open_page(&app, &account::buy_page_url(lang.code()))
}

/// Pro の料金ページをブラウザーで開く。デバイスの画面の案内にも使う。
#[tauri::command]
fn open_mawok_pro_page(app: AppHandle) -> Result<(), String> {
    open_page(&app, &account::pro_page_url())
}

/// 失敗したときに画面へ渡すもの。code は符号（actions.rs の Failure::code）。
/// detail は実行先自身の言葉（actions.rs の ActionError::screen_detail）。
/// 利用者自身の下書きの断片を含みうるのでログには残さず、画面にだけ渡す。exit_code はコマンドの終了コード
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
struct ActionFailure {
    code: String,
    detail: Option<String>,
    exit_code: Option<i32>,
}

impl From<actions::Failure> for ActionFailure {
    fn from(failure: actions::Failure) -> Self {
        Self {
            code: failure.code().to_string(),
            detail: None,
            exit_code: None,
        }
    }
}

impl From<&str> for ActionFailure {
    fn from(code: &str) -> Self {
        Self {
            code: code.to_string(),
            detail: None,
            exit_code: None,
        }
    }
}

impl From<actions::ActionError> for ActionFailure {
    fn from(error: actions::ActionError) -> Self {
        Self {
            code: error.failure.code().to_string(),
            detail: error.screen_detail,
            exit_code: error.exit_code,
        }
    }
}

/// 宛先の行を実行し、結果の文を返す。行頭が `@ai` なら指示文と実行する文を AI サービスへ送り、`@sh` ならシェルで実行する。
/// 画面から渡された行をそのまま実行する（テキストウィンドウの1行目に書いた行も実行するため）。
/// 結果の出し方が「出さない」なら、結果は空の文を返す。
/// 失敗したら符号（actions.rs の Failure::code）を返し、詳しい中身はログにだけ残す。送った文と結果はログに書かない。
/// `request` は begin_action で受け取った番号。より大きい番号のアクションを始めるか、
/// cancel_action でこの番号以上を取り消すと、この実行を打ち切り（コマンドは子プロセスごと止める）、`action.cancelled` を返す
#[tauri::command]
async fn run_action(
    app: AppHandle,
    request: u64,
    text: String,
    line: String,
    output: ActionOutput,
    encoding: ActionEncoding,
) -> Result<String, ActionFailure> {
    let state = app.state::<ActionState>();
    if request <= state.requests.lock().unwrap().settled_through {
        info!("action {request} cancelled before it started");
        return Err(error_codes::ACTION_CANCELLED.into());
    }
    let stopper = command::Stopper::default();
    let discard_output = output == ActionOutput::None;
    let tauri::async_runtime::JoinHandle::Tokio(task) =
        match (actions::ai_instruction(&line), actions::sh_command(&line)) {
            (Some(instruction), _) => start_ai_action(
                &app,
                request,
                ai::Prompt::new(instruction, &text),
                discard_output,
            )?,
            (None, Some(command)) => start_command_action(
                &app,
                request,
                text,
                command.to_string(),
                encoding,
                discard_output,
                stopper.clone(),
            )?,
            // 画面は、宛先が `@ai`・`@sh` の行だけを渡す
            (None, None) => {
                return Err(actions::ActionError::new(
                    actions::Failure::Unexpected,
                    "the line has no executable addressee",
                )
                .into())
            }
        };
    let abort = task.abort_handle();
    {
        let mut requests = state.requests.lock().unwrap();
        // 始める前の確かめの後に、この番号を取り消したか、より新しいアクションが始まっていたら、始めずに打ち切る
        if request <= requests.settled_through {
            drop(requests);
            stopper.stop();
            abort.abort();
            info!("action {request} cancelled before it started");
            return Err(error_codes::ACTION_CANCELLED.into());
        }
        requests.settled_through = request;
        // 前のアクションが残っていれば打ち切る（画面は1つずつしか実行しないが、取り消しの知らせが遅れたときのため）
        if let Some((previous, abort_previous)) = requests.running.replace((
            request,
            Box::new(move || {
                stopper.stop();
                abort.abort();
            }),
        )) {
            info!("action {previous} cancelled by action {request}");
            abort_previous();
        }
    }
    let result = task.await;
    {
        let mut requests = state.requests.lock().unwrap();
        if requests
            .running
            .as_ref()
            .is_some_and(|(running, _)| *running == request)
        {
            requests.running = None;
        }
    }
    match result {
        Ok(Ok(text)) => {
            info!("action {request} finished");
            Ok(text)
        }
        Ok(Err(error)) => {
            warn!(
                "action {request} failed: {} ({})",
                error.failure.code(),
                error.detail
            );
            Err(error.into())
        }
        // 打ち切った。取り消しのログは cancel_action と次のアクションが出す
        Err(error) if error.is_cancelled() => Err(error_codes::ACTION_CANCELLED.into()),
        Err(error) => {
            error!("action {request} panicked: {error}");
            Err(actions::Failure::Unexpected.into())
        }
    }
}

type ActionTask = tauri::async_runtime::JoinHandle<Result<String, actions::ActionError>>;

/// AI のアクションを始める。AI サービスのキーを読み、指示文と実行する文を送る。`discard_output` なら返事は捨てる
fn start_ai_action(
    app: &AppHandle,
    request: u64,
    prompt: ai::Prompt,
    discard_output: bool,
) -> Result<ActionTask, ActionFailure> {
    let (service, model, base_url, user, available, key_available) = {
        let state = app.state::<AppState>();
        let config = state.config.lock().unwrap().clone();
        let key_available = state.ai_key_available(config.ai_service);
        (
            config.ai_service,
            config.ai_model(),
            config.openai_base_url().to_string(),
            config.ai_credential_user(),
            config.ai_available(key_available),
            key_available,
        )
    };
    if !available {
        // サービスを選んであり、キーが無いと分かっていれば、キーを入れるよう知らせる。ほかは AI を使える状態にするよう知らせる
        let failure = if service == AiService::Mawok && key_available == Some(false) {
            actions::Failure::SignInRequired
        } else if service != AiService::None && key_available == Some(false) {
            actions::Failure::NoKey
        } else {
            actions::Failure::Disabled
        };
        return Err(failure.into());
    }
    info!("action {request} started ({}, {model})", service.name());
    let task_app = app.clone();
    Ok(tauri::async_runtime::spawn(async move {
        let reading = ReadingAiKey::start(&task_app);
        let read = run_blocking(move || match service {
            AiService::Mawok => account_credentials::read_token(),
            _ => secrets::read(&user),
        })
        .await;
        drop(reading);
        let key = match read {
            Ok(Ok(key)) => key,
            Ok(Err(secrets::ReadError::NotFound)) => {
                let failure = if service == AiService::Mawok {
                    actions::Failure::SignInRequired
                } else {
                    actions::Failure::NoKey
                };
                return Err(actions::ActionError::new(failure, "no key"));
            }
            Ok(Err(secrets::ReadError::Unreadable(detail))) => {
                return Err(actions::ActionError::new(
                    actions::Failure::KeyUnreadable,
                    detail,
                ))
            }
            Err(error) => {
                return Err(actions::ActionError::new(
                    actions::Failure::Unexpected,
                    error,
                ))
            }
        };
        let client = http_client(&task_app)
            .map_err(|error| actions::ActionError::new(actions::Failure::Unexpected, error))?;
        let output = ai::send(&client, service, &key, &model, &base_url, &prompt).await?;
        Ok(if discard_output {
            String::new()
        } else {
            output
        })
    }))
}

/// コマンドのアクションを始める。作業フォルダーは、テキストウィンドウで移ったフォルダー（移っていなければホームフォルダー）
fn start_command_action(
    app: &AppHandle,
    request: u64,
    text: String,
    command: String,
    encoding: ActionEncoding,
    discard_output: bool,
    stopper: command::Stopper,
) -> Result<ActionTask, ActionFailure> {
    if command.trim().is_empty() {
        warn!("action {request} refused: the command is empty");
        return Err(actions::Failure::Unexpected.into());
    }
    let moved_to = app.state::<ActionState>().folder.lock().unwrap().clone();
    let folder = match moved_to {
        // 移った後にフォルダーが消えていれば、ホームで動かさずに断る。思っていない場所で動くと、相対パスのコマンドが別のファイルに触れるため
        Some(folder) if !folder.is_dir() => {
            warn!("action {request} refused: the working folder is gone");
            return Err(actions::Failure::FolderMissing.into());
        }
        Some(folder) => folder,
        None => app.path().home_dir().map_err(|error| {
            error!("couldn't find the home folder: {error}");
            ActionFailure::from(actions::Failure::CommandNotStarted)
        })?,
    };
    info!("action {request} started (command)");
    Ok(tauri::async_runtime::spawn(async move {
        command::run(&command, &text, encoding, discard_output, &folder, stopper).await
    }))
}

/// キーを読み終えたら、読んでいる間にフォーカスが外れたのを見送っていたときだけ、下書きウィンドウにフォーカスを戻す。
/// macOS はキーチェーンの許可のダイアログにフォーカスを移し、閉じても下書きには戻さない。戻さないと、フォーカスが外れた知らせがもう来ず、
/// ほかのアプリへ移っても下書きが隠れない。Windows の資格情報マネージャーは読むときにダイアログを出さないので、戻さない
fn refocus_draft_after_key_prompt(app: &AppHandle) {
    let kept = app
        .state::<ActionState>()
        .blur_kept_for_key
        .swap(false, Ordering::Relaxed);
    if !kept || !cfg!(target_os = "macos") {
        return;
    }
    refocus_draft_on_main_thread(app, "reading the AI key");
}

/// 出ている下書きにフォーカスが無く、設定ウィンドウにも無ければ、下書きにフォーカスを戻す。
/// macOS のパネルの操作（make_key_window）はメインスレッドでしか行えないので、async のコマンドから呼ばれてもメインスレッドに移して行う
fn refocus_draft_on_main_thread(app: &AppHandle, after: &'static str) {
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        let Some(window) = main_window(&handle) else {
            return;
        };
        if window.is_visible().unwrap_or(false)
            && !window.is_focused().unwrap_or(true)
            && !is_settings_focused(&handle)
        {
            info!("refocus the draft after {after}");
            focus::refocus_draft(&handle, &window);
        }
    });
    if let Err(error) = result {
        error!("refocus the draft: couldn't run on the main thread: {error}");
    }
}

/// AI サービスのキーを読んでいる間の印。アクションを打ち切って捨てられたときも、読み終えたことにする
struct ReadingAiKey(AppHandle);

impl ReadingAiKey {
    fn start(app: &AppHandle) -> Self {
        app.state::<ActionState>()
            .reading_key
            .fetch_add(1, Ordering::Relaxed);
        Self(app.clone())
    }
}

impl Drop for ReadingAiKey {
    /// アクションを打ち切って捨てられたときも通る。重なって読んでいたときは、最後に読み終えたときだけフォーカスを戻す
    /// （先に読み終えた方が、まだ出ているほかの許可のダイアログからフォーカスを奪わないように）
    fn drop(&mut self) {
        let before = self
            .0
            .state::<ActionState>()
            .reading_key
            .fetch_sub(1, Ordering::Relaxed);
        if before == 1 {
            refocus_draft_after_key_prompt(&self.0);
        }
    }
}

/// アクションの番号を振る。画面は実行を始める前に呼び、受け取った番号で run_action と cancel_action を呼ぶ。
/// 番号を受け取る前に取り消したときは、受け取ってから cancel_action を呼ぶ
#[tauri::command]
fn begin_action(state: tauri::State<'_, ActionState>) -> u64 {
    state.last_request.fetch_add(1, Ordering::Relaxed) + 1
}

/// `request` までの番号のアクションを取り消す。走っていれば打ち切り、まだ始まっていなければ始めない
#[tauri::command]
fn cancel_action(state: tauri::State<'_, ActionState>, request: u64) {
    let mut requests = state.requests.lock().unwrap();
    requests.settled_through = requests.settled_through.max(request);
    if requests
        .running
        .as_ref()
        .is_some_and(|(running, _)| *running <= request)
    {
        let (running, abort) = requests.running.take().unwrap();
        drop(requests);
        info!("action {running} cancelled");
        abort();
    }
}

/// 今の作業フォルダーの見せる形（folder.rs の display）。移っていなければホームフォルダー
#[tauri::command]
fn current_folder(app: AppHandle) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(folder::display(&working_folder(&app, &home), &home))
}

/// 今の作業フォルダー。移っていなければホームフォルダー
fn working_folder(app: &AppHandle, home: &std::path::Path) -> PathBuf {
    app.state::<ActionState>()
        .folder
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| home.to_path_buf())
}

/// コマンドのアクションの作業フォルダーを、打たれたパスへ移す（folder.rs の resolve）。空ならホームに戻る。
/// 移った先をテキストウィンドウのタイトルバーに出す（ホームならアプリの名前だけ）。移れなければ符号を返す。
/// つながらないネットワークのパスではファイルシステムの確かめが長く止まるので、画面を止めないよう async にし、確かめる間はロックを持たない。
/// 利用者のフォルダーの名前はログに書かない
#[tauri::command]
async fn change_folder(app: AppHandle, input: String) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|error| {
        error!("couldn't find the home folder: {error}");
        folder::FolderError::NotFound.code().to_string()
    })?;
    let base = working_folder(&app, &home);
    let resolved = folder::resolve(&base, &home, &input).map_err(|error| {
        info!("couldn't change the working folder: {}", error.code());
        // メニューの最近のフォルダーから選んで、消えていたら外す（メニューは、あるかを確かめずに出すため）
        let input = std::path::Path::new(input.trim());
        if folder::is_gone(error, input) {
            forget_folder(&app, input);
        }
        error.code().to_string()
    })?;
    let title = if resolved == home {
        APP_NAME.to_string()
    } else {
        format!("{APP_NAME} — {}", folder::display(&resolved, &home))
    };
    remember_folder(&app, &resolved, &home);
    *app.state::<ActionState>().folder.lock().unwrap() = (resolved != home).then_some(resolved);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(error) = window.set_title(&title) {
            warn!("couldn't set the title of the draft window: {error}");
        }
    }
    info!("changed the working folder");
    Ok(())
}

fn recent_folders_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join(folder::RECENT_FILE_NAME))
}

/// 最近のフォルダーを、まだ読んでいなければファイルから読んでから渡す
fn with_recent_folders<T>(app: &AppHandle, f: impl FnOnce(&mut Vec<PathBuf>) -> T) -> T {
    let state = app.state::<ActionState>();
    let mut recent = state.recent_folders.lock().unwrap();
    let recent = recent.get_or_insert_with(|| {
        recent_folders_path(app)
            .map(|path| folder::load_recent(&path))
            .unwrap_or_default()
    });
    f(recent)
}

/// 最近のフォルダーを書く。書けなければ警告だけにする
fn save_recent_folders(app: &AppHandle, recent: &[PathBuf]) {
    if let Some(path) = recent_folders_path(app) {
        if let Err(error) = folder::save_recent(&path, recent) {
            warn!("couldn't save the recent folders: {error}");
        }
    }
}

/// 移った先を最近のフォルダーに入れて書く。書けなくても移るのは止めない（次に覚え直せる）
fn remember_folder(app: &AppHandle, folder: &std::path::Path, home: &std::path::Path) {
    let recent = with_recent_folders(app, |recent| {
        folder::remember(recent, folder, home);
        recent.clone()
    });
    save_recent_folders(app, &recent);
}

/// 移れなかったフォルダーを最近のフォルダーから外して書く
fn forget_folder(app: &AppHandle, folder: &std::path::Path) {
    let Some(recent) = with_recent_folders(app, |recent| {
        folder::forget(recent, folder).then(|| recent.clone())
    }) else {
        return;
    };
    save_recent_folders(app, &recent);
}

/// テキストウィンドウの下のフォルダーのボタンとメニューに出すもの（folder.rs の menu）
#[tauri::command]
fn folder_menu(app: AppHandle) -> Result<folder::FolderMenu, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let current = working_folder(&app, &home);
    let recent = with_recent_folders(&app, |recent| recent.clone());
    Ok(folder::menu(&current, &home, &recent))
}

/// 欄に打ちかけのパスを、今の作業フォルダーから見て補う（folder.rs の complete）。
/// change_folder と同じく、つながらないフォルダーで画面を止めないよう async にする。フォルダーの名前はログに書かない
#[tauri::command]
async fn complete_folder(
    app: AppHandle,
    input: String,
) -> Result<folder::FolderCompletion, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let base = working_folder(&app, &home);
    Ok(folder::complete(&base, &home, &input))
}

/// OS のフォルダーを選ぶ画面を今の作業フォルダーから出し、選んだフォルダーへ移る（change_folder と同じく確かめる）。
/// 選ばずに閉じたら false。画面を出している間は、フォーカスが外れても下書きを隠さず、閉じたら下書きにフォーカスを戻す
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let home = app.path().home_dir().map_err(|error| {
        error!("couldn't find the home folder: {error}");
        folder::FolderError::NotFound.code().to_string()
    })?;
    // フォルダーがあるかは、ロックを放してから確かめる。つながらないネットワークのフォルダーで、ほかのコマンドを待たせないため
    let moved_to = app.state::<ActionState>().folder.lock().unwrap().clone();
    let base = moved_to.filter(|folder| folder.is_dir()).unwrap_or(home);
    let Some(window) = main_window(&app) else {
        return Err("main window not found".to_string());
    };
    // 選ぶ画面を開くまでの間に押し直されても、2つ目は開かない。2つ開くと、先に閉じた方で印が外れ、残った方の裏で下書きが隠れるため
    if app
        .state::<ActionState>()
        .picking_folder
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return Ok(false);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_directory(&base)
        .set_parent(&window)
        .pick_folder(move |picked| {
            let _ = sender.send(picked);
        });
    let picked = receiver.await.ok().flatten();
    app.state::<ActionState>()
        .picking_folder
        .store(false, Ordering::Relaxed);
    refocus_draft_on_main_thread(&app, "picking a folder");
    let Some(path) = picked.and_then(|picked| picked.into_path().ok()) else {
        return Ok(false);
    };
    change_folder(app, path.to_string_lossy().into_owned()).await?;
    Ok(true)
}

/// 下書きウィンドウが隠れている間に終わったアクションを、OS の通知で知らせる。
/// 文言は画面が表示言語で作る。押しても何もしない（Tauri の通知は、押したことを受け取れない）。
/// 文言はアクションの名前を含み、利用者が付けた名前なのでログには書かない
#[tauri::command]
fn notify_action_finished(app: AppHandle, message: String) {
    show_notification(&app, message);
}

/// OS の通知を出す。文言だけで、押しても何もしない
fn show_notification(app: &AppHandle, message: String) {
    // MSIX 版は、差出人をパッケージの AUMID にしないと出ない。プラグインは識別子（com.amiiby.mawok）を差出人にする
    #[cfg(windows)]
    if let Some(app_id) = package::app_user_model_id() {
        // show は WinRT を待つ同期の呼び出しなので、メインスレッドを止めないよう別のスレッドで出す（プラグインも別に出す）
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = tauri_winrt_notification::Toast::new(app_id)
                .title(&message)
                .show()
            {
                warn!("couldn't show the notification: {error}");
            }
        });
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app.notification().builder().title(message).show() {
        warn!("couldn't show the notification: {error}");
    }
}

/// global-shortcut プラグインでホットキーを登録・解除する
struct PluginRegistrar<'a>(&'a AppHandle);

impl hotkey::Registrar for PluginRegistrar<'_> {
    fn register(&mut self, hotkey: &str) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(hotkey)
            .map_err(|error| error.to_string())
    }

    // 起動時に登録できなかったキーや、記録のために止めているキーは、解除するものがないので成功として扱う
    fn unregister(&mut self, hotkey: &str) -> Result<(), String> {
        if !self.is_registered(hotkey) {
            return Ok(());
        }
        self.0
            .global_shortcut()
            .unregister(hotkey)
            .map_err(|error| error.to_string())
    }

    fn is_registered(&self, hotkey: &str) -> bool {
        self.0.global_shortcut().is_registered(hotkey)
    }
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

/// 設定のホットキーが登録できているかを、トレイの ⚠ に反映する
fn show_hotkey_registered(app: &AppHandle, registered: bool) {
    let state = app.state::<AppState>();
    let changed = {
        let mut problems = state.problems.lock().unwrap();
        let changed = problems.hotkey_unavailable == registered;
        problems.hotkey_unavailable = !registered;
        changed
    };
    if changed {
        refresh_tray(app);
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
/// 前回の位置と大きさは window-state プラグインが戻す
fn build_hidden_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    title: &str,
    size: (f64, f64),
    min_size: (f64, f64),
) -> tauri::Result<WebviewWindow> {
    let theme = app.state::<AppState>().config.lock().unwrap().theme;
    let window = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min_size.0, min_size.1)
        .visible(false)
        .minimizable(false)
        .maximizable(false)
        .theme(window_theme(theme))
        .center()
        .build()?;
    // 描画プロセスが落ちたら、下書きと同じく立て直す
    diagnostics::watch_webview_process(&window);
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

/// Finder やエクスプローラーで、パスを選んだ状態にする。MSIX 版では、回された先のパスを渡す
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

/// OS のログイン項目に登録されていて、有効か。読めなければ、トレイの ⚠ に出す理由を返す
fn read_autostart(app: &AppHandle) -> Result<bool, String> {
    autostart::is_enabled(app).inspect_err(|error| warn!("couldn't read launch at login: {error}"))
}

/// OS のログイン項目を登録する・外す。登録済みかは呼ぶ側が読んでおく。できなければ、トレイの ⚠ に出す理由を返す
fn write_autostart(app: &AppHandle, enabled: bool) -> Option<autostart::SetError> {
    let error = autostart::set(app, enabled).err()?;
    warn!("couldn't configure launch at login: {error:?}");
    Some(error)
}

/// ログイン項目を設定できなかった理由を、トレイの ⚠ と設定画面に出す文にする
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

/// 設定の置き場を開く。壊れていれば、元のファイルを写して退けてから作り直す（docs/config.md「読むとき」）。
/// 作り直せもしないときと、壊れてはいないが開けないとき（ロック・権限など）は、ファイルに手を付けず、保存しない置き場で動かす
fn open_store(path: &std::path::Path) -> (store::Store, Option<ConfigProblem>) {
    let opened = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .map_err(|error| store::OpenError {
            broken: false,
            message: error.to_string(),
        })
        .and_then(|()| store::Store::open(path));
    let error = match opened {
        Ok(store) => return (store, None),
        Err(error) => error,
    };
    warn!("couldn't open the settings store: {}", error.message);
    if !error.broken {
        return (
            store::Store::in_memory(),
            Some(ConfigProblem::Unsaved(error.message)),
        );
    }
    // 書きかけの記録を先に消す。本体を消した後に失敗すると、作り直せないうえ元のファイルも残らない
    let reset = atomic_file::back_up(path, SystemTime::now())
        .and_then(|copy| store::remove_side_files(path).map(|()| copy))
        .and_then(|copy| std::fs::remove_file(path).map(|()| copy))
        .map_err(|error| error.to_string())
        .and_then(|copy| {
            store::Store::open(path)
                .map(|store| (store, copy))
                .map_err(|error| error.message)
        });
    match reset {
        Ok((store, copy)) => {
            let name = copy
                .and_then(|copy| {
                    copy.file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                })
                .unwrap_or_default();
            info!("moved the unreadable settings store to {name}");
            (store, Some(ConfigProblem::Reset(name)))
        }
        Err(error) => {
            warn!("couldn't recreate the settings store: {error}");
            (
                store::Store::in_memory(),
                Some(ConfigProblem::Unsaved(error)),
            )
        }
    }
}

/// 置き場から設定を読む。読めない項目は既定のままにしてログにだけ出す。振り直した行の ID は、次も同じ行を
/// 見分けられるよう書き戻す
fn load_config(store: &mut store::Store) -> Config {
    let loaded = store
        .entries()
        .and_then(|entries| config::from_entries(&entries));
    let loaded = match loaded {
        Ok(loaded) => loaded,
        Err(error) => {
            warn!("couldn't read the settings: {error}");
            return Config::default();
        }
    };
    if !loaded.skipped.is_empty() {
        warn!(
            "reset unreadable settings to defaults: {}",
            loaded.skipped.join(", ")
        );
    }
    if loaded.repaired_item_ids {
        if let Err(error) = store.commit(&store::Commit {
            entries: Some(&config::stored_entries(&loaded.config)),
            ..store::Commit::default()
        }) {
            warn!("couldn't save repaired row ids: {error}");
        }
    }
    loaded.config
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

/// ロックを持っている間、ほかの Mawok は起動できない。プロセスが終われば（落ちても）OS が外す
#[cfg(target_os = "macos")]
struct InstanceLock {
    file: std::fs::File,
}

/// 多重起動を防ぐロックを、終わる前に放す。再起動で立ち上がる次のプロセスが、まだ終わっていないこのプロセスを
/// ほかの Mawok と取り違えて終わらないようにする
#[cfg(target_os = "macos")]
fn release_single_instance_lock(app: &AppHandle) {
    if let Some(lock) = app.try_state::<InstanceLock>() {
        if let Err(error) = lock.file.unlock() {
            warn!("couldn't release the instance lock: {error}");
        }
    }
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
            app.manage(InstanceLock { file });
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

fn open_settings(app: &AppHandle) {
    info!("open settings");
    request_sync(app);
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

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let lang = state.lang();
    let hotkey = state.config.lock().unwrap().hotkey.clone();
    let hotkey_unavailable = state.problems.lock().unwrap().hotkey_unavailable;
    let problem_texts = {
        let problems = state.problems.lock().unwrap();
        let mut texts = Vec::new();
        match &problems.config {
            Some(ConfigProblem::Reset(file_name)) => texts.push(lang.settings_reset(file_name)),
            Some(ConfigProblem::Unsaved(error)) => texts.push(lang.settings_unsaved(error)),
            None => {}
        }
        if problems.hotkey_unavailable {
            texts.push(lang.hotkey_unavailable(&hotkey));
        }
        if let Some(error) = &problems.autostart_failed {
            texts.push(lang.autostart_failed(&autostart_error_text(error, lang)));
        }
        texts
    };

    let problem_items = problem_texts
        .iter()
        .map(|problem| {
            MenuItem::with_id(app, "problem", format!("⚠ {problem}"), false, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let problem_separator = PredefinedMenuItem::separator(app)?;
    // ホットキーを、OS の書き方で項目の右端に添える (macOS は ⌘⇧Space、Windows は Ctrl+Shift+Space)。
    // 登録できていないキーは押しても効かないので添えない。メニューの読める形でないキーは、Tauri が黙って添えずに作る。
    // Windows ではトレイのメニューがウィンドウに付かないので、添えたキーは見せるためだけで別に効かない。
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
    TrayIconBuilder::with_id(TRAY_ID)
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
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// 表示言語や問題が変わったときに、トレイメニューを作り直す
fn refresh_tray(app: &AppHandle) {
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
    // AI のアクションの HTTPS の暗号の実装（Cargo.toml の reqwest の注を参照）。reqwest のクライアントを作る前に入れる
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        warn!("a TLS crypto provider was already installed");
    }

    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .map_label(window_state_key)
                .build(),
        )
        .manage(DraftState::default())
        .manage(ActionState::default())
        .invoke_handler(tauri::generate_handler![
            commit,
            preview_replacement_matches,
            dismiss,
            page_ready,
            get_settings,
            set_sync_kind,
            set_sync_excluded_setting,
            settings_backups,
            back_up_settings,
            restore_settings_backup,
            open_ai_settings,
            take_ai_settings_request,
            open_settings_window,
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
            consent_ai,
            set_ai_service,
            set_ai_model,
            set_ai_base_url,
            default_snippets,
            has_ai_key,
            set_ai_key,
            delete_ai_key,
            start_mawok_sign_in,
            mawok_sign_in_pending,
            cancel_mawok_sign_in,
            reopen_mawok_sign_in_page,
            mawok_account_status,
            sign_out_mawok,
            open_mawok_buy_page,
            open_mawok_pro_page,
            run_action,
            change_folder,
            complete_folder,
            folder_menu,
            pick_folder,
            current_folder,
            begin_action,
            cancel_action,
            notify_action_finished,
            set_hotkey,
            set_draft_key,
            reset_draft_key,
            pause_hotkey,
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
            open_license_source,
            start_sync,
            unlock_sync,
            change_sync_password,
            mawok_devices,
            sign_out_mawok_device,
            #[cfg(target_os = "macos")]
            updater::update_status,
            #[cfg(target_os = "macos")]
            updater::check_for_update,
            #[cfg(target_os = "macos")]
            updater::install_update,
            #[cfg(target_os = "macos")]
            updater::set_draft_has_text
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

            match main_window(app.handle()) {
                Some(window) => diagnostics::watch_webview_process(&window),
                None => error!("setup: main window not found"),
            }

            let config_dir = app.path().app_config_dir()?;
            let pro_state_path = config_dir.join(pro::STATE_FILE_NAME);
            let pro_state = match pro::load(&pro_state_path) {
                Ok(state) => state,
                Err(error) => {
                    warn!("couldn't read the Pro state: {error}");
                    None
                }
            };
            let store_path = config_dir.join(store::FILE_NAME);
            // 開くとファイルができるので、その前に見る
            let store_missing = !store_path.exists();
            let (mut store, config_problem) = open_store(&store_path);
            let mut config = load_config(&mut store);
            let first_launch = is_first_launch(store_missing, config_problem.as_ref());
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
                focus::make_draft_panel(&window);
                let _ = window.set_theme(window_theme(config.theme));
                // tauri.conf.json では最前面にして作るので、設定でオフにしていれば外す
                if let Err(error) = window.set_always_on_top(config.text_window_always_on_top) {
                    warn!("couldn't change always on top of the draft window: {error}");
                }
            }

            app.manage(AppState {
                store: Mutex::new(store),
                backups_dir: backup::dir_in(&config_dir),
                pro_state_path,
                version: app.package_info().version.to_string(),
                system_lang: Lang::system(),
                config: Mutex::new(config),
                problems: Mutex::new(problems),
                settings_opening: AtomicBool::new(false),
                ai_key_available: Mutex::new(None),
                pro_state: Mutex::new(pro_state),
                mawok_account_signed_in: AtomicBool::new(false),
                pro_generation: AtomicUsize::new(0),
                sync_key: Mutex::new(None),
                sync_key_id: Mutex::new(None),
                sync_key_status: Mutex::new(SyncKeyStatus::None),
                sync_key_refresh: tokio::sync::Mutex::new(()),
                sync_key_checks: AtomicUsize::new(0),
                sync_generation: AtomicUsize::new(0),
                sync_record_generation: AtomicUsize::new(0),
                sync_commit: tokio::sync::Mutex::new(()),
                sync_schedule: Mutex::new(SyncSchedule::default()),
                sync_debounce: debounce::Debounce::default(),
                synced_on_show: Mutex::new(None),
                ai_settings_requested: AtomicBool::new(false),
                #[cfg(target_os = "macos")]
                hotkey_paused_for_menu: Mutex::new(None),
                #[cfg(target_os = "macos")]
                menu_depth: std::sync::atomic::AtomicUsize::new(0),
            });
            build_tray(app.handle())?;
            #[cfg(target_os = "macos")]
            {
                let (begin, end) = (app.handle().clone(), app.handle().clone());
                menu_tracking::observe(
                    move || pause_hotkey_for_menu(&begin),
                    move || resume_hotkey_after_menu(&end),
                );
            }
            start_periodic_pro_checks(app.handle().clone());
            start_periodic_sync(app.handle().clone());
            start_daily_backups(app.handle().clone());
            #[cfg(target_os = "macos")]
            updater::start_periodic_checks(app.handle());
            // 初めての起動では下書きを一度出す。常駐するだけで何も出ないと、入ったのか分からず、
            // 使い方を伝える入力欄の案内も、一度出すまで目に入らないため。
            // 画面の読み込みが終わる前に出すので、入力欄へのフォーカスは page_ready で移す
            if first_launch {
                info!("first launch: show the draft");
                show(app.handle());
            }
            Ok(())
        });

    // macOS のログイン時の起動は、プラグインを通さずにログイン項目を使う（autostart.rs）
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::Builder::new().build());

    // 更新は Mac 版だけが自分で行う。Windows は Microsoft Store が受け持つ（docs/platform.md「Mac 版の更新」）
    // tauri-nspanel はテキストウィンドウをパネルにするのに使う（focus.rs の make_draft_panel）
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_nspanel::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::UpdateState::default())
        .on_web_content_process_terminate(diagnostics::web_content_process_terminated)
        .menu(macos_app_menu);

    // 識別子が、設定・履歴・ログのフォルダーと単一起動の見分けを決める
    let mut context = tauri::generate_context!();
    let identifier = profile::scoped(&context.config().identifier);
    context.config_mut().identifier = identifier;

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
                    // 走っているコマンドを子プロセスごと止める。残すと、アプリを終えた後も動き続ける
                    let running = app
                        .state::<ActionState>()
                        .requests
                        .lock()
                        .unwrap()
                        .running
                        .take();
                    if let Some((request, abort)) = running {
                        info!("action {request} cancelled by exit");
                        abort();
                    }
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

    #[test]
    fn all_sync_kinds_off_do_not_start_a_sync() {
        let config = Config {
            sync_settings: false,
            sync_keys: false,
            sync_replacements: false,
            sync_snippets: false,
            sync_history: false,
            ..Config::default()
        };
        assert!(!sync::kinds(&config).any());
    }

    #[test]
    fn takes_the_callback_even_behind_a_silent_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let accepting = accept_callback(&listener, "s1");
            let requests = async {
                // 要求を送らない接続（ブラウザの先読みなど）を開いたまま、ほかの要求を送る
                let _silent = tokio::net::TcpStream::connect(address).await.unwrap();
                let mut other = tokio::net::TcpStream::connect(address).await.unwrap();
                other
                    .write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                    .await
                    .unwrap();
                let mut answer = String::new();
                other.read_to_string(&mut answer).await.unwrap();
                assert!(answer.starts_with("HTTP/1.1 404"));
                let mut callback = tokio::net::TcpStream::connect(address).await.unwrap();
                callback
                    .write_all(b"GET /callback?code=c1&state=s1 HTTP/1.1\r\n\r\n")
                    .await
                    .unwrap();
                callback
            };
            let ((_, code), _callback) =
                tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    tokio::join!(accepting, requests)
                })
                .await
                .expect("the callback is taken without waiting for the silent connection");
            assert_eq!(code, "c1");
        });
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
            reading_ai_key: false,
            picking_folder: false,
        }
    }

    #[test]
    fn an_unreadable_settings_store_is_copied_aside_and_recreated() {
        let dir = test_support::TempDir::new("lib-broken-store");
        let path = dir.join(store::FILE_NAME);
        std::fs::write(&path, "not a database").unwrap();
        let journal = dir.join(format!("{}-journal", store::FILE_NAME));
        std::fs::write(&journal, "a journal of the broken file").unwrap();
        let (mut store, problem) = open_store(&path);
        let Some(ConfigProblem::Reset(copy)) = problem else {
            panic!("the store should be recreated");
        };
        assert!(copy.starts_with("settings.broken-") && copy.ends_with(".db"));
        assert!(!journal.exists());
        assert_eq!(std::fs::read(dir.join(&copy)).unwrap(), b"not a database");
        assert_eq!(load_config(&mut store), Config::default());
        // 作り直した置き場は、次の起動でそのまま開ける
        drop(store);
        assert!(open_store(&path).1.is_none());
    }

    #[test]
    fn a_store_that_only_fails_to_open_is_left_as_it_is() {
        let dir = test_support::TempDir::new("lib-unopenable-store");
        // 置き場の名前のフォルダーは、SQLite が開けない（壊れたファイルではない）
        let path = dir.join(store::FILE_NAME);
        std::fs::create_dir(&path).unwrap();
        let (_, problem) = open_store(&path);
        assert!(matches!(problem, Some(ConfigProblem::Unsaved(_))));
        assert!(path.is_dir());
    }

    #[test]
    fn row_ids_repaired_on_loading_are_written_back() {
        let mut store = store::Store::in_memory();
        let entries = std::collections::BTreeMap::from([(
            "replacements".to_string(),
            serde_json::json!([{ "from": "a", "to": "b" }]),
        )]);
        store
            .commit(&store::Commit {
                entries: Some(&entries),
                ..store::Commit::default()
            })
            .unwrap();
        let first = load_config(&mut store);
        // 振り直した ID を書き戻したので、読み直しても同じ行として見分けられる
        assert_eq!(load_config(&mut store).replacements, first.replacements);
    }

    #[test]
    fn shows_draft_only_when_settings_store_was_created() {
        assert!(is_first_launch(true, None));
        // 2回目以降の起動
        assert!(!is_first_launch(false, None));
        // 作れなかったら、次の起動でも置き場がないので出さない
        let unwritable = ConfigProblem::Unsaved("permission denied".to_string());
        assert!(!is_first_launch(true, Some(&unwritable)));
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
    fn keeps_draft_while_reading_ai_key() {
        // macOS のキーチェーンの許可のダイアログにフォーカスが移っても、隠さない
        assert!(!should_hide_on_blur(BlurCheck {
            reading_ai_key: true,
            ..blurred()
        }));
    }

    #[test]
    fn keeps_draft_while_picking_folder() {
        // OS のフォルダーを選ぶ画面にフォーカスが移っても、隠さない
        assert!(!should_hide_on_blur(BlurCheck {
            picking_folder: true,
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
