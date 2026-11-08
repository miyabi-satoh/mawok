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

    /// 設定の置き場にするフォルダーを選ぶ、OS のフォルダーの窓の題
    pub fn pick_settings_folder(self) -> &'static str {
        match self {
            Lang::En => "Choose the Settings Folder",
            Lang::Ja => "設定の保存先を選ぶ",
        }
    }

    /// トレイの ⚠ の項目。保存先が無いか読む許可が無く、変えた設定が保存されない。
    /// 何が起きているかは、選ぶと開く設定画面の「設定の保存先」に出す
    pub fn settings_problem(self) -> &'static str {
        match self {
            Lang::En => "Settings Can't Be Saved",
            Lang::Ja => "設定を保存できません",
        }
    }

    /// トレイの ⚠ の項目。設定のファイルを読めない（手で書きかけ・形が合わない）。読めたファイルには保存できる。
    /// どのファイルかは、選ぶと開く設定画面の「設定の保存先」に出す
    pub fn settings_file_problem(self) -> &'static str {
        match self {
            Lang::En => "Couldn't Read a Settings File",
            Lang::Ja => "設定のファイルを読めません",
        }
    }

    /// symlink の先を読む許可を求める、OS のフォルダーの窓の案内（macOS では窓の上に出る）。窓は先の入っている
    /// フォルダーで開くので、押すのは「開く」だけ
    pub fn grant_access_prompt(self) -> &'static str {
        match self {
            Lang::En => "Click Open to allow access.",
            Lang::Ja => "「開く」でアクセスを許可します。",
        }
    }

    /// 許可を求める窓で、symlink の先を含まないフォルダーを選んだ。閉じたら窓を出し直す
    pub fn grant_access_wrong_folder(self, target: &str) -> String {
        match self {
            Lang::En => format!(
                "The folder you chose doesn't contain {target}. Choose the folder that contains it."
            ),
            Lang::Ja => format!(
                "選んだフォルダーに {target} が含まれていません。これを含むフォルダーを選んでください。"
            ),
        }
    }

    /// トレイの ⚠ の項目。どのキーかは、選ぶと開く設定画面の「キー操作」に出す。原因（他のアプリとの衝突など）の詳細はログに残す
    pub fn hotkey_problem(self) -> &'static str {
        match self {
            Lang::En => "Couldn't Register the Hotkey",
            Lang::Ja => "ホットキーを登録できません",
        }
    }

    /// トレイの ⚠ の項目。理由は、選ぶと開く設定画面の「ログイン時に起動」の行に出す
    pub fn autostart_problem(self) -> &'static str {
        match self {
            Lang::En => "Couldn't Set Up Launch at Login",
            Lang::Ja => "ログイン時の起動を設定できません",
        }
    }

    /// 設定画面の「ログイン時に起動」の行に出す、設定できなかった理由（Windows の MSIX 版）
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
