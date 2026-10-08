//! トレイメニューとエラーメッセージの言語。画面側の文言は Paraglide JS（messages/*.json）で翻訳する。

use crate::config::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Ja,
}

impl Lang {
    /// 設定の表示言語から決める。「OS に従う」なら、OS の言語設定から決めた言語を使う
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

    /// トレイのツールチップに添える。届いた下書きをまだ見ていない間だけ出す
    pub fn draft_received(self) -> &'static str {
        match self {
            Lang::En => "Text has arrived",
            Lang::Ja => "届いたテキストがあります",
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

    pub fn config_unreadable(self, error: &str) -> String {
        match self {
            Lang::En => format!("Couldn't read the settings file: {error}"),
            Lang::Ja => format!("設定ファイルを読めません: {error}"),
        }
    }

    /// 既定値に直した項目や、重なって外したキーの名前（設定ファイルでの書き方）。多いときは先頭の数件だけを出し、すべてはログに残す
    pub fn config_repaired(self, keys: &[String]) -> String {
        const SHOWN: usize = 3;
        let shown = keys
            .iter()
            .take(SHOWN)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        let rest = keys.len().saturating_sub(SHOWN);
        match self {
            Lang::En if rest > 0 => {
                format!("Fixed unreadable settings and conflicting keys: {shown} and {rest} more")
            }
            Lang::En => format!("Fixed unreadable settings and conflicting keys: {shown}"),
            Lang::Ja if rest > 0 => {
                format!(
                    "設定ファイルの読めない値と重なったキーを直しました: {shown} ほか {rest} 件"
                )
            }
            Lang::Ja => format!("設定ファイルの読めない値と重なったキーを直しました: {shown}"),
        }
    }

    pub fn config_backed_up(self, file_name: &str) -> String {
        match self {
            Lang::En => format!("Saved a copy of the original settings file as {file_name}"),
            Lang::Ja => format!("元の設定ファイルを {file_name} に写しました"),
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

    /// Mawok のアカウントと結んだあと、窓口から戻ったブラウザに Mawok の待ち受けが返すページの見出しと本文
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

    #[test]
    fn lists_only_the_first_repaired_keys() {
        let keys = |count: usize| {
            (0..count)
                .map(|index| format!("replacements[{index}]"))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            Lang::Ja.config_repaired(&keys(3)),
            "設定ファイルの読めない値と重なったキーを直しました: replacements[0], replacements[1], replacements[2]"
        );
        assert_eq!(
            Lang::Ja.config_repaired(&keys(5)),
            "設定ファイルの読めない値と重なったキーを直しました: replacements[0], replacements[1], replacements[2] ほか 2 件"
        );
        assert_eq!(
            Lang::En.config_repaired(&keys(4)),
            "Fixed unreadable settings and conflicting keys: replacements[0], replacements[1], replacements[2] and 1 more"
        );
    }

    #[test]
    fn other_locales_fall_back_to_english() {
        assert_eq!(Lang::from_locale("en-US"), Lang::En);
        assert_eq!(Lang::from_locale("fr-FR"), Lang::En);
        assert_eq!(Lang::from_locale(""), Lang::En);
    }
}
