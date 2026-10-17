//! トレイメニューとエラーメッセージの言語。画面側の文言は Paraglide JS（messages/*.json）で翻訳する。

use crate::config::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Ja,
}

impl Lang {
    /// 設定の表示言語から決める。「システム」なら、OS の言語設定から決めた言語を使う
    pub fn resolve(setting: Language, system: Lang) -> Self {
        match setting {
            Language::System => system,
            Language::Ja => Lang::Ja,
            Language::En => Lang::En,
        }
    }

    /// OS の言語設定から決める
    pub fn system() -> Self {
        sys_locale::get_locale().map_or(Lang::En, |locale| Self::from_locale(&locale))
    }

    /// "ja-JP" などのロケールから決める。日本語以外は英語にする。
    pub fn from_locale(locale: &str) -> Self {
        let language = locale.split(['-', '_']).next().unwrap_or_default();
        if language.eq_ignore_ascii_case("ja") {
            Lang::Ja
        } else {
            Lang::En
        }
    }

    /// トレイの、下書きウィンドウを出し入れする項目
    pub fn toggle_draft(self) -> &'static str {
        match self {
            Lang::En => "Show/Hide Text Window",
            Lang::Ja => "テキストウィンドウを表示／隠す",
        }
    }

    /// 画面側（Paraglide JS）に渡す言語のコード
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Ja => "ja",
        }
    }

    pub fn settings(self) -> &'static str {
        match self {
            Lang::En => "Settings…",
            Lang::Ja => "設定…",
        }
    }

    pub fn settings_title(self) -> &'static str {
        match self {
            Lang::En => "Settings",
            Lang::Ja => "設定",
        }
    }

    pub fn licenses_title(self) -> &'static str {
        match self {
            Lang::En => "Third-party software",
            Lang::Ja => "第三者のソフトウェア",
        }
    }

    /// メニューの項目と、使い方のウィンドウのタイトル
    pub fn manual(self) -> &'static str {
        match self {
            Lang::En => "User guide",
            Lang::Ja => "使い方",
        }
    }

    pub fn quit(self) -> &'static str {
        match self {
            Lang::En => "Quit",
            Lang::Ja => "終了",
        }
    }

    /// 設定の置き場を読めず、元のファイルを写してから既定の設定で作り直した
    pub fn settings_reset(self, file_name: &str) -> String {
        match self {
            Lang::En => format!("Couldn't read the settings, so started with the defaults. The original file was copied to {file_name}"),
            Lang::Ja => format!("設定を読めなかったため、元のファイルを {file_name} に写して、既定の設定で始めました"),
        }
    }

    /// 設定の置き場を開けず、作り直せもしなかった。変えた設定は保存されない
    pub fn settings_unsaved(self, error: &str) -> String {
        match self {
            Lang::En => format!("Couldn't save the settings: {error}"),
            Lang::Ja => format!("設定を保存できません: {error}"),
        }
    }

    /// 原因（他のアプリとの衝突など）の詳細はログに残す
    pub fn hotkey_unavailable(self, hotkey: &str) -> String {
        match self {
            Lang::En => format!("Couldn't register the hotkey {hotkey}"),
            Lang::Ja => format!("ホットキー {hotkey} を登録できません"),
        }
    }

    pub fn autostart_failed(self, error: &str) -> String {
        match self {
            Lang::En => format!("Couldn't configure launch at login: {error}"),
            Lang::Ja => format!("ログイン時の自動起動を設定できません: {error}"),
        }
    }

    /// `autostart_failed` と設定画面の失敗に差し込む理由（Windows の MSIX 版）
    pub fn autostart_turned_off_in_windows(self) -> String {
        match self {
            Lang::En => {
                "It's turned off in Startup apps in Windows Settings. Turn it on there.".into()
            }
            Lang::Ja => {
                "Windows の設定の「スタートアップ アプリ」でオフになっています。そこでオンにしてください。"
                    .into()
            }
        }
    }

    pub fn autostart_set_by_policy(self) -> String {
        match self {
            Lang::En => "It's set by your organization's policy.".into(),
            Lang::Ja => "組織のポリシーで決められています。".into(),
        }
    }

    /// Mac 版の新しい版を見つけたときの OS の通知
    #[cfg(target_os = "macos")]
    pub fn update_available(self, version: &str) -> String {
        match self {
            Lang::En => {
                format!("Mawok {version} is available. You can update it from About in Settings.")
            }
            Lang::Ja => format!(
                "Mawok {version} があります。設定の「このアプリについて」から更新できます。"
            ),
        }
    }

    /// Mawok のアカウントと結んだあと、窓口から戻ったブラウザーに Mawok の待ち受けが返すページの見出しと本文
    pub fn mawok_sign_in_page(self, signed_in: bool) -> (&'static str, &'static str) {
        match (self, signed_in) {
            (Lang::En, true) => (
                "Signed in to Mawok",
                "You can close this tab and go back to Mawok.",
            ),
            (Lang::En, false) => (
                "Couldn't sign in",
                "Go back to Mawok and sign in again from the settings.",
            ),
            (Lang::Ja, true) => (
                "Mawok にサインインしました",
                "このタブを閉じて、Mawok に戻ってください。",
            ),
            (Lang::Ja, false) => (
                "サインインできませんでした",
                "Mawok に戻り、設定からサインインし直してください。",
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn japanese_locales() {
        assert_eq!(Lang::from_locale("ja-JP"), Lang::Ja);
        assert_eq!(Lang::from_locale("ja"), Lang::Ja);
        assert_eq!(Lang::from_locale("JA_jp"), Lang::Ja);
    }

    #[test]
    fn fixed_language_setting_wins_over_os_language() {
        assert_eq!(Lang::resolve(Language::Ja, Lang::En), Lang::Ja);
        assert_eq!(Lang::resolve(Language::En, Lang::Ja), Lang::En);
    }

    #[test]
    fn system_language_setting_follows_os_language() {
        assert_eq!(Lang::resolve(Language::System, Lang::Ja), Lang::Ja);
        assert_eq!(Lang::resolve(Language::System, Lang::En), Lang::En);
    }

    /// 数字と単位の間は、そこで折り返さないようノーブレークスペースにする。
    /// 見る形は src/lib/messages.test.ts の BREAKABLE_NUMBER_UNIT と同じ（単位の一覧は UNIT の写し）
    #[test]
    fn no_breakable_space_between_number_and_unit() {
        const UNITS: [&str; 17] = [
            "秒", "分", "時間", "日", "週", "か月", "年", "件", "回", "文字", "行", "個", "つ",
            "KB", "MB", "GB", "TB",
        ];
        let is_japanese = |c: char| matches!(c, '一'..='龠' | '々' | 'ぁ'..='ん' | 'ァ'..='ヶ');
        let source = include_str!("i18n.rs");
        let messages = &source[..source.find("#[cfg(test)]").expect("tests follow messages")];
        let breakable: Vec<&str> = messages
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .filter(|line| {
                line.match_indices(' ').any(|(at, _)| {
                    let (before, after) = (&line[..at], &line[at + 1..]);
                    let unit_follows = UNITS.iter().any(|unit| after.starts_with(unit));
                    (before.ends_with(|c: char| c.is_ascii_digit())
                        && (unit_follows || after.starts_with(is_japanese)))
                        || (before.ends_with('}') && unit_follows)
                })
            })
            .collect();
        assert!(breakable.is_empty(), "{breakable:#?}");
    }

    #[test]
    fn other_locales_fall_back_to_english() {
        assert_eq!(Lang::from_locale("en-US"), Lang::En);
        assert_eq!(Lang::from_locale("fr-FR"), Lang::En);
        assert_eq!(Lang::from_locale(""), Lang::En);
    }
}
