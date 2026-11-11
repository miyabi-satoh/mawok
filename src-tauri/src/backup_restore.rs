//! バックアップから戻すときの設定と、戻すと今から変わる所（docs/config.md「バックアップ」）

use std::collections::BTreeSet;

use serde::Serialize;

use crate::{
    config::{key, Config, Language, Snippet, Theme},
    draft_keys::DraftKeys,
    text::{KatakanaWidth, PunctuationStyle, Replacement, WidthStyle},
};

/// 戻すと変わる1項目の値。種類は設定の項目名と、行の種類。戻す画面が、設定の画面と同じ言い方で出す
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum BackupValue {
    Language(Language),
    Theme(Theme),
    TextWindowAlwaysOnTop(bool),
    HideTextWindowOnBlur(bool),
    ShowTextWindowButtons(bool),
    TextHistorySize(u16),
    TrimTrailingWhitespace(bool),
    PunctuationStyle(PunctuationStyle),
    AlphabetWidth(WidthStyle),
    DigitWidth(WidthStyle),
    SpaceWidth(WidthStyle),
    SymbolWidth(WidthStyle),
    KatakanaWidth(KatakanaWidth),
    ExcludeFromClipboardHistory(bool),
    TextFontSize(u16),
    TextColorLight(String),
    TextColorDark(String),
    InputGuidance(Option<String>),
    Hotkey(String),
    TextWindowKeys(DraftKeys),
    TextFontFamily(String),
    Replacement(Replacement),
    Snippet(Snippet),
    /// 行の並び。値は一覧の項目名（`replacements`・`snippets`）
    Order(String),
    /// 行が無い（消える・戻る）
    Deleted,
}

/// 戻すと変わる1項目
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BackupDifference {
    /// 項目を見分ける名前。設定は項目名、行は種類と行の名前
    pub id: String,
    pub current: BackupValue,
    pub restored: BackupValue,
}

/// 戻す画面に並べるバックアップ。名前は UTC の作成日時で、画面は今との違いを選ぶ手がかりとして出す
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub name: String,
    /// 作った時刻（UNIX 時刻のミリ秒）。名前から読めなければ null
    #[cfg_attr(test, ts(type = "number | null"))]
    pub created_at: Option<u64>,
    pub changes: Vec<BackupDifference>,
}

/// バックアップへ戻した後の設定。デバイスごとに決める項目（ログイン時の起動）は今のまま残す
pub fn restore(current: &Config, backup: &Config) -> Config {
    Config {
        autostart: current.autostart,
        ..backup.clone()
    }
}

/// 今の設定と戻した後の設定の違い。行は、置き換え辞書は置き換える前の文字列、定型文は見出しと本文で見分ける。
/// 行に ID を持たないので、中身の主な所が同じ行を同じ行とみる
pub fn differences(current: &Config, restored: &Config) -> Vec<BackupDifference> {
    let mut differences: Vec<_> = settings(current)
        .into_iter()
        .zip(settings(restored))
        .filter(|((_, now), (_, then))| now != then)
        .map(|((id, now), (_, then))| BackupDifference {
            id: id.to_string(),
            current: now,
            restored: then,
        })
        .collect();
    differences.extend(row_differences(
        key::REPLACEMENTS,
        &current.replacements,
        &restored.replacements,
        |row| row.from.clone(),
        BackupValue::Replacement,
    ));
    differences.extend(row_differences(
        key::SNIPPETS,
        &current.snippets,
        &restored.snippets,
        |row| format!("{}\n{}", row.name, row.body),
        BackupValue::Snippet,
    ));
    differences
}

fn settings(config: &Config) -> Vec<(&'static str, BackupValue)> {
    use BackupValue as V;
    vec![
        (key::LANGUAGE, V::Language(config.language)),
        (key::THEME, V::Theme(config.theme)),
        (
            key::TEXT_WINDOW_ALWAYS_ON_TOP,
            V::TextWindowAlwaysOnTop(config.text_window_always_on_top),
        ),
        (
            key::HIDE_TEXT_WINDOW_ON_BLUR,
            V::HideTextWindowOnBlur(config.hide_text_window_on_blur),
        ),
        (
            key::SHOW_TEXT_WINDOW_BUTTONS,
            V::ShowTextWindowButtons(config.show_text_window_buttons),
        ),
        (
            key::TEXT_HISTORY_SIZE,
            V::TextHistorySize(config.text_history_size),
        ),
        (
            key::TRIM_TRAILING_WHITESPACE,
            V::TrimTrailingWhitespace(config.trim_trailing_whitespace),
        ),
        (
            key::PUNCTUATION_STYLE,
            V::PunctuationStyle(config.punctuation_style),
        ),
        (
            key::ALPHABET_WIDTH,
            V::AlphabetWidth(config.char_widths.alphabet),
        ),
        (key::DIGIT_WIDTH, V::DigitWidth(config.char_widths.digit)),
        (key::SPACE_WIDTH, V::SpaceWidth(config.char_widths.space)),
        (key::SYMBOL_WIDTH, V::SymbolWidth(config.char_widths.symbol)),
        (
            key::KATAKANA_WIDTH,
            V::KatakanaWidth(config.char_widths.katakana),
        ),
        (
            key::EXCLUDE_FROM_CLIPBOARD_HISTORY,
            V::ExcludeFromClipboardHistory(config.exclude_from_clipboard_history),
        ),
        (key::TEXT_FONT_SIZE, V::TextFontSize(config.text_font_size)),
        (
            key::TEXT_COLOR_LIGHT,
            V::TextColorLight(config.text_color_light.clone()),
        ),
        (
            key::TEXT_COLOR_DARK,
            V::TextColorDark(config.text_color_dark.clone()),
        ),
        (
            key::INPUT_GUIDANCE,
            V::InputGuidance(config.input_guidance.clone()),
        ),
        (key::HOTKEY, V::Hotkey(config.hotkey.clone())),
        (
            key::TEXT_WINDOW_KEYS,
            V::TextWindowKeys(config.text_window_keys.clone()),
        ),
        (
            key::TEXT_FONT_FAMILY,
            V::TextFontFamily(config.text_font_family.clone()),
        ),
    ]
}

fn row_differences<T: Clone + PartialEq>(
    list: &str,
    current: &[T],
    restored: &[T],
    identity: impl Fn(&T) -> String,
    wrap: fn(T) -> BackupValue,
) -> Vec<BackupDifference> {
    let ids: BTreeSet<String> = current.iter().chain(restored).map(&identity).collect();
    let mut differences = Vec::new();
    for id in ids {
        let now: Vec<_> = current.iter().filter(|row| identity(row) == id).collect();
        let then: Vec<_> = restored.iter().filter(|row| identity(row) == id).collect();
        for index in 0..now.len().max(then.len()) {
            let (a, b) = (now.get(index).copied(), then.get(index).copied());
            if a != b {
                differences.push(BackupDifference {
                    // 同じ名前の2行目からは番号を付ける。区切りを変えて、名前にどんな文字があっても 1行目の形と重ならないようにする
                    id: if index == 0 {
                        format!("{list}:{id}")
                    } else {
                        format!("{list}#{index}:{id}")
                    },
                    current: a.cloned().map_or(BackupValue::Deleted, wrap),
                    restored: b.cloned().map_or(BackupValue::Deleted, wrap),
                });
            }
        }
    }
    let order = |rows: &[T]| rows.iter().map(&identity).collect::<Vec<_>>();
    if order(current) != order(restored) {
        differences.push(BackupDifference {
            id: format!("{list}:order"),
            current: BackupValue::Order(list.to_string()),
            restored: BackupValue::Order(list.to_string()),
        });
    }
    differences
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replacement(from: &str, to: &str) -> Replacement {
        Replacement {
            from: from.to_string(),
            to: to.to_string(),
            ..Replacement::default()
        }
    }

    #[test]
    fn detects_changes_to_the_second_replacement_with_the_same_from() {
        let current = vec![replacement("a", "first"), replacement("a", "old")];
        let restored = vec![replacement("a", "first"), replacement("a", "new")];
        let differences = row_differences(
            "replacements",
            &current,
            &restored,
            |row| row.from.clone(),
            BackupValue::Replacement,
        );
        assert_eq!(differences.len(), 1);
    }

    #[test]
    fn keeps_autostart_and_lists_what_changes() {
        let current = Config {
            autostart: false,
            theme: Theme::Dark,
            replacements: vec![replacement("濃度", "Node.js"), replacement("a", "b")],
            ..Config::default()
        };
        let backup = Config {
            replacements: vec![replacement("a", "c"), replacement("くろーど", "Claude")],
            ..Config::default()
        };
        let restored = restore(&current, &backup);
        assert!(!restored.autostart);
        let changes = differences(&current, &restored);
        let ids: Vec<_> = changes.iter().map(|change| change.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "theme",
                "replacements:a",
                "replacements:くろーど",
                "replacements:濃度",
                "replacements:order"
            ]
        );
        assert_eq!(changes[2].current, BackupValue::Deleted);
        assert_eq!(changes[3].restored, BackupValue::Deleted);
    }

    #[test]
    fn nothing_differs_from_the_same_settings() {
        let config = Config {
            replacements: vec![replacement("a", "b")],
            ..Config::default()
        };
        assert!(differences(&config, &restore(&config, &config)).is_empty());
    }
}
