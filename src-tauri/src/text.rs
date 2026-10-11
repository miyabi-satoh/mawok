//! クリップボードへ渡す前に、下書きの文字列を整える

use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

/// 置き換え辞書の1件。音声入力のよくある誤変換を直す（例: 「濃度」→「Node.js」）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(default)]
pub struct Replacement {
    /// 同期でこの1件を見分けるランダムな値
    pub id: String,
    /// 置き換える前の文字列
    pub from: String,
    /// 置き換えた後の文字列
    pub to: String,
    /// 誤って巻き込む語を辞書から消さずに止められるようにするため、1件ずつ切れる
    pub enabled: bool,
    /// ほかのデバイスと同期するか
    pub sync: bool,
}

impl Default for Replacement {
    fn default() -> Self {
        Self {
            id: String::new(),
            from: String::new(),
            to: String::new(),
            enabled: true,
            sync: true,
        }
    }
}

fn enabled_entries(replacements: &[Replacement]) -> Vec<&Replacement> {
    replacements
        .iter()
        .filter(|replacement| replacement.enabled && !replacement.from.is_empty())
        .collect()
}

/// 置き換えの対象になる位置。1つに見える文字（書記素）の区切りのバイト位置で、末尾（`text.len()`）を含む。
/// 書記素の途中で当てると、異体字セレクタや結合文字が置き換えた後の文字列に付いたり、ZWJ でつないだ絵文字が崩れたりするため、
/// 置き換える範囲は、始まりも終わりもこの区切りに揃える
fn grapheme_boundaries(text: &str) -> Vec<usize> {
    text.grapheme_indices(true)
        .map(|(index, _)| index)
        .chain([text.len()])
        .collect()
}

/// `text` の `position`（書記素の区切り）から始まる範囲に一致する項目のうち、置き換える前の文字列が最も長いものを選ぶ。
/// 終わりが書記素の区切りに当たらない項目は選ばない。同じ長さなら先の項目を残す。
/// `apply_replacements` と `find_replacement_matches` の判定基準を1箇所にまとめる
fn best_match_at<'a>(
    text: &str,
    position: usize,
    boundaries: &[usize],
    entries: &[&'a Replacement],
) -> Option<&'a Replacement> {
    let rest = &text[position..];
    entries.iter().fold(None::<&Replacement>, |best, &entry| {
        if !rest.starts_with(&entry.from)
            || boundaries
                .binary_search(&(position + entry.from.len()))
                .is_err()
        {
            return best;
        }
        match best {
            Some(current) if current.from.len() >= entry.from.len() => Some(current),
            _ => Some(entry),
        }
    })
}

/// 置き換え辞書を左から一度だけたどり、一致した項目とそのまま残す文字列を順に返す。
/// 書記素の境界と最長一致の判定をここで共有するので、適用結果と画面用の一致範囲が食い違わない。
enum ReplacementPart<'text, 'entries> {
    Unchanged(&'text str),
    Replaced(&'entries Replacement),
}

fn replacement_parts<'text, 'entries>(
    text: &'text str,
    replacements: &'entries [Replacement],
) -> Vec<ReplacementPart<'text, 'entries>> {
    let entries = enabled_entries(replacements);
    if entries.is_empty() {
        return vec![ReplacementPart::Unchanged(text)];
    }
    let boundaries = grapheme_boundaries(text);
    let mut parts = Vec::new();
    let mut index = 0;
    let mut unchanged_start = 0;
    while let Some(&position) = boundaries.get(index).filter(|&&p| p < text.len()) {
        match best_match_at(text, position, &boundaries, &entries) {
            Some(entry) => {
                if unchanged_start < position {
                    parts.push(ReplacementPart::Unchanged(&text[unchanged_start..position]));
                }
                parts.push(ReplacementPart::Replaced(entry));
                let end = position + entry.from.len();
                index = boundaries.binary_search(&end).expect("ends on a boundary");
                unchanged_start = end;
            }
            None => index += 1,
        }
    }
    if unchanged_start < text.len() {
        parts.push(ReplacementPart::Unchanged(&text[unchanged_start..]));
    }
    parts
}

/// 置き換え辞書を適用する。
/// 文章を先頭から1回だけ走査し、その位置で一致する項目のうち、置き換える前の文字列が最も長いものを置き換える。
/// 置き換えた結果には、もう一度適用しない（連鎖しない）。辞書の並び順は、次の場合にだけ効く:
/// 置き換える前の文字列が同じ項目が複数あれば、並びで最初の項目を使う。
/// 部分一致で、大文字と小文字は区別する。有効でない項目と、置き換える前の文字列が空の項目は何もしない。
/// 1つに見える文字（書記素）の途中では当てない（`grapheme_boundaries`）
pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
    let mut result = String::with_capacity(text.len());
    for part in replacement_parts(text, replacements) {
        match part {
            ReplacementPart::Unchanged(text) => result.push_str(text),
            ReplacementPart::Replaced(entry) => result.push_str(&entry.to),
        }
    }
    result
}

/// `apply_replacements` が置き換える範囲。`start`・`len` は文字数（コードポイント単位。UTF-16 コード単位ではない）で、
/// JS 側で `String.prototype.at` 相当の文字単位インデックスとして使う想定（サロゲートペアが絡む文字は対象外）。
/// `to` は置き換えた後の文字列（ホバーでの案内表示用）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ReplacementMatch {
    pub start: usize,
    pub len: usize,
    pub to: String,
}

/// `apply_replacements` と同じ判定基準で、置き換わる範囲だけを一覧にする（下書き入力中のハイライト表示用）。
/// 判定基準は `best_match_at` を共有しているので、`apply_replacements` の結果と食い違わない
pub fn find_replacement_matches(text: &str, replacements: &[Replacement]) -> Vec<ReplacementMatch> {
    let mut matches = Vec::new();
    let mut char_index = 0;
    for part in replacement_parts(text, replacements) {
        match part {
            ReplacementPart::Replaced(entry) => {
                let char_len = entry.from.chars().count();
                matches.push(ReplacementMatch {
                    start: char_index,
                    len: char_len,
                    to: entry.to.clone(),
                });
                char_index += char_len;
            }
            ReplacementPart::Unchanged(text) => char_index += text.chars().count(),
        }
    }
    matches
}

/// 句読点をどちらに揃えるか。
/// 半角の `,` `.` は数や小数点、コードに出るので対象にしない。全角どうしの行き来だけを扱う
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub enum PunctuationStyle {
    /// 揃えない（既定）
    #[default]
    Keep,
    /// 「、」「。」に揃える
    Kutouten,
    /// 「，」「．」に揃える
    Comma,
}

/// 半角と全角の数字。句読点を数の一部として使っているかどうかの判断に使う
fn is_digit(character: char) -> bool {
    character.is_ascii_digit() || ('\u{ff10}'..='\u{ff19}').contains(&character)
}

/// 句読点を揃える。`Keep` のときは何もしないので、借りたまま返す。
/// 数字に挟まれたものは、小数点や桁区切りとして使っているとみて変えない（`１．５` を `１。５` にしない）
pub fn unify_punctuation(text: &str, style: PunctuationStyle) -> std::borrow::Cow<'_, str> {
    let pairs = match style {
        PunctuationStyle::Keep => return std::borrow::Cow::Borrowed(text),
        PunctuationStyle::Kutouten => [('\u{ff0c}', '\u{3001}'), ('\u{ff0e}', '\u{3002}')],
        PunctuationStyle::Comma => [('\u{3001}', '\u{ff0c}'), ('\u{3002}', '\u{ff0e}')],
    };
    if !text.contains(pairs[0].0) && !text.contains(pairs[1].0) {
        return std::borrow::Cow::Borrowed(text);
    }
    let characters: Vec<char> = text.chars().collect();
    std::borrow::Cow::Owned(
        characters
            .iter()
            .enumerate()
            .map(|(index, &character)| {
                let Some((_, to)) = pairs.iter().find(|(from, _)| *from == character) else {
                    return character;
                };
                let between_digits = index > 0
                    && is_digit(characters[index - 1])
                    && characters.get(index + 1).copied().is_some_and(is_digit);
                if between_digits {
                    character
                } else {
                    *to
                }
            })
            .collect(),
    )
}

/// 英字・数字・空白・記号を、全角と半角のどちらに揃えるか
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub enum WidthStyle {
    /// 揃えない（既定）
    #[default]
    Keep,
    Full,
    Half,
}

/// カタカナは全角に揃えるだけにする。半角カナは文字化けしやすく、揃えたい場面が考えにくいため
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub enum KatakanaWidth {
    /// 揃えない（既定）
    #[default]
    Keep,
    Full,
}

/// 文字の種類ごとの、全角と半角の揃え方
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct CharWidths {
    pub alphabet: WidthStyle,
    pub digit: WidthStyle,
    pub space: WidthStyle,
    pub symbol: WidthStyle,
    pub katakana: KatakanaWidth,
}

/// 全角の英数字・記号（U+FF01〜U+FF5E）と、対応する半角（U+0021〜U+007E）の差
const FULLWIDTH_OFFSET: u32 = 0xfee0;

/// 半角カナ（U+FF61〜U+FF9D）に対応する全角の文字。並びは Unicode の順
const HALFWIDTH_KANA_TO_FULL: &str =
    "。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン";

/// 英字・数字・記号の、半角と全角の行き来。
/// `,` `.` は句読点を揃える設定に任せるので、記号に含めない。数字に挟まれたものは桁区切りや小数点とみて、数字に合わせる。
/// `~` `～` も含めない。日本語の文で範囲を表す「～」が `~` になると、別の記号に見えるため
fn convert_ascii_width(character: char, between_digits: bool, widths: &CharWidths) -> char {
    let (half, full) = if character.is_ascii_graphic() {
        (
            character,
            char::from_u32(character as u32 + FULLWIDTH_OFFSET),
        )
    } else if ('\u{ff01}'..='\u{ff5e}').contains(&character) {
        (
            char::from_u32(character as u32 - FULLWIDTH_OFFSET).expect("ASCII"),
            Some(character),
        )
    } else {
        return character;
    };
    let style = match half {
        'a'..='z' | 'A'..='Z' => widths.alphabet,
        '0'..='9' => widths.digit,
        ',' | '.' if between_digits => widths.digit,
        ',' | '.' | '~' => WidthStyle::Keep,
        _ => widths.symbol,
    };
    match style {
        WidthStyle::Keep => character,
        WidthStyle::Full => full.expect("U+FF01..U+FF5E"),
        WidthStyle::Half => half,
    }
}

/// 半角カナの濁点・半濁点を、前の全角カナと合わせた1文字にする。合わせられなければ None
fn compose_kana_mark(base: char, mark: char) -> Option<char> {
    let dakuten = mark == '\u{ff9e}';
    let code = base as u32;
    let composed = match base {
        _ if dakuten && "カキクケコサシスセソタチツテト".contains(base) => code + 1,
        'ハ'..='ホ' if (code - 'ハ' as u32).is_multiple_of(3) => {
            code + if dakuten { 1 } else { 2 }
        }
        'ウ' if dakuten => 'ヴ' as u32,
        'ワ' if dakuten => 'ヷ' as u32,
        'ヲ' if dakuten => 'ヺ' as u32,
        _ => return None,
    };
    char::from_u32(composed)
}

/// 全角と半角を、文字の種類ごとに揃える。何も変えないときは借りたまま返す
pub fn convert_widths<'a>(text: &'a str, widths: &CharWidths) -> std::borrow::Cow<'a, str> {
    if *widths == CharWidths::default() {
        return std::borrow::Cow::Borrowed(text);
    }
    let characters: Vec<char> = text.chars().collect();
    let mut converted = String::with_capacity(text.len());
    for (index, &character) in characters.iter().enumerate() {
        let next = match character {
            ' ' if widths.space == WidthStyle::Full => '\u{3000}',
            '\u{3000}' if widths.space == WidthStyle::Half => ' ',
            '\u{ff61}'..='\u{ff9d}' if widths.katakana == KatakanaWidth::Full => {
                HALFWIDTH_KANA_TO_FULL
                    .chars()
                    .nth((character as u32 - 0xff61) as usize)
                    .expect("U+FF61..U+FF9D")
            }
            '\u{ff9e}' | '\u{ff9f}' if widths.katakana == KatakanaWidth::Full => {
                let composed = converted
                    .chars()
                    .last()
                    .and_then(|base| compose_kana_mark(base, character));
                if let Some(composed) = composed {
                    converted.pop();
                    composed
                } else if character == '\u{ff9e}' {
                    '゛'
                } else {
                    '゜'
                }
            }
            _ => {
                let between_digits = index > 0
                    && is_digit(characters[index - 1])
                    && characters.get(index + 1).copied().is_some_and(is_digit);
                convert_ascii_width(character, between_digits, widths)
            }
        };
        converted.push(next);
    }
    if converted == text {
        std::borrow::Cow::Borrowed(text)
    } else {
        std::borrow::Cow::Owned(converted)
    }
}

/// 末尾の空白文字を取り除く。
/// `trim_end` は Unicode が空白とみなす文字を対象にするので、改行・全角スペース（U+3000）・タブのほか、
/// 垂直タブ（U+000B）やノーブレークスペース（U+00A0）なども落ちる。
/// 末尾にそれらを残したい場面は考えにくいので、文字を絞り込まない。
/// 入力欄の中身は変えないので、借りたまま返す
pub fn trim_trailing_whitespace(text: &str) -> &str {
    text.trim_end()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_trailing_newlines_and_spaces() {
        assert_eq!(trim_trailing_whitespace("git status  \n\n"), "git status");
    }

    #[test]
    fn removes_trailing_fullwidth_space_and_tab() {
        assert_eq!(trim_trailing_whitespace("git status　\t"), "git status");
    }

    #[test]
    fn removes_trailing_unicode_whitespace() {
        assert_eq!(
            trim_trailing_whitespace("git status\u{a0}\u{b}\u{c}"),
            "git status"
        );
    }

    #[test]
    fn keeps_leading_and_inner_whitespace() {
        assert_eq!(trim_trailing_whitespace("  git  status  "), "  git  status");
    }

    #[test]
    fn returns_empty_when_only_whitespace() {
        assert_eq!(trim_trailing_whitespace(" 　\n\t"), "");
    }

    #[test]
    fn keeps_text_without_trailing_whitespace() {
        assert_eq!(trim_trailing_whitespace("git status"), "git status");
    }

    fn replacement(from: &str, to: &str) -> Replacement {
        Replacement {
            from: from.to_string(),
            to: to.to_string(),
            ..Replacement::default()
        }
    }

    #[test]
    fn replaces_every_occurrence() {
        let dictionary = [replacement("濃度", "Node.js")];
        assert_eq!(
            apply_replacements("濃度と濃度のバージョン", &dictionary),
            "Node.jsとNode.jsのバージョン"
        );
    }

    #[test]
    fn replaces_partial_match() {
        let dictionary = [replacement("濃度", "Node.js")];
        assert_eq!(
            apply_replacements("高濃度の溶液", &dictionary),
            "高Node.jsの溶液"
        );
    }

    #[test]
    fn prefers_longest_match_regardless_of_order() {
        // 短い語が先にあっても、その位置で一致する最も長い左側を使う
        let dictionary = [
            replacement("濃度", "Node.js"),
            replacement("高濃度", "高濃度硫酸"),
        ];
        assert_eq!(
            apply_replacements("高濃度と濃度", &dictionary),
            "高濃度硫酸とNode.js"
        );
    }

    #[test]
    fn does_not_apply_to_replaced_text() {
        // 置き換えた結果には重ねない
        let dictionary = [
            replacement("濃度", "ノード"),
            replacement("ノード", "Node.js"),
        ];
        assert_eq!(
            apply_replacements("濃度とノード", &dictionary),
            "ノードとNode.js"
        );
    }

    #[test]
    fn uses_first_entry_for_same_from() {
        let dictionary = [replacement("濃度", "先"), replacement("濃度", "後")];
        assert_eq!(apply_replacements("濃度", &dictionary), "先");
    }

    #[test]
    fn skips_disabled_entries() {
        let dictionary = [Replacement {
            enabled: false,
            ..replacement("濃度", "Node.js")
        }];
        assert_eq!(apply_replacements("濃度", &dictionary), "濃度");
    }

    #[test]
    fn skips_entries_without_from() {
        // 画面で行を足した直後は、置き換える前の文字列が空のまま保存される
        let dictionary = [replacement("", "Node.js")];
        assert_eq!(apply_replacements("git status", &dictionary), "git status");
    }

    #[test]
    fn distinguishes_case() {
        let dictionary = [replacement("node", "Node.js")];
        assert_eq!(
            apply_replacements("Node と node", &dictionary),
            "Node と Node.js"
        );
    }

    #[test]
    fn does_not_apply_inside_a_grapheme() {
        // 異体字セレクタ付きの「葛」、ZWJ でつないだ家族の絵文字、結合アクセント付きの e
        let dictionary = [
            replacement("葛", "くず"),
            replacement("👨", "男"),
            replacement("e", "E"),
        ];
        let text = "葛\u{E0100}飾 👨\u{200D}👩\u{200D}👧 e\u{0301}";
        assert_eq!(apply_replacements(text, &dictionary), text);
        assert!(find_replacement_matches(text, &dictionary).is_empty());

        // 区切りに揃っていれば当てる。書記素ごと登録した語も当たる
        let dictionary = [replacement("葛\u{E0100}", "かつ"), replacement("e", "E")];
        assert_eq!(
            apply_replacements("葛\u{E0100}飾 e", &dictionary),
            "かつ飾 E"
        );
        assert_eq!(
            find_replacement_matches("e\u{0301}e", &dictionary),
            [ReplacementMatch {
                start: 2,
                len: 1,
                to: "E".to_string()
            }]
        );
    }

    #[test]
    fn keeps_text_with_empty_dictionary() {
        assert_eq!(apply_replacements("git status", &[]), "git status");
    }

    #[test]
    fn unifies_to_kutouten() {
        assert_eq!(
            unify_punctuation("これは，そうです．", PunctuationStyle::Kutouten),
            "これは、そうです。"
        );
    }

    #[test]
    fn unifies_to_comma() {
        assert_eq!(
            unify_punctuation("これは、そうです。", PunctuationStyle::Comma),
            "これは，そうです．"
        );
    }

    #[test]
    fn keeps_punctuation_when_off() {
        assert_eq!(
            unify_punctuation("これは、そうです．", PunctuationStyle::Keep),
            "これは、そうです．"
        );
    }

    #[test]
    fn keeps_halfwidth_comma_and_period() {
        // 小数点や桁区切り、コードの中のピリオドを壊さない
        let text = "3.14 と 1,000 と Node.js";
        assert_eq!(unify_punctuation(text, PunctuationStyle::Kutouten), text);
        assert_eq!(unify_punctuation(text, PunctuationStyle::Comma), text);
    }

    #[test]
    fn keeps_other_fullwidth_characters() {
        // 句読点以外の全角はそのまま
        let text = "Ｎｏｄｅ（濃度）［１］";
        assert_eq!(unify_punctuation(text, PunctuationStyle::Kutouten), text);
    }

    #[test]
    fn keeps_fullwidth_punctuation_between_digits() {
        // 全角の数字で書いた小数点や桁区切りを壊さない
        assert_eq!(
            unify_punctuation("１．５倍と１，０００円", PunctuationStyle::Kutouten),
            "１．５倍と１，０００円"
        );
        assert_eq!(
            unify_punctuation("１、０００円", PunctuationStyle::Comma),
            "１、０００円"
        );
    }

    #[test]
    fn unifies_punctuation_next_to_a_digit() {
        // 片側だけが数字なら、文の区切りとみて揃える
        assert_eq!(
            unify_punctuation("１つめ，あとは３．", PunctuationStyle::Kutouten),
            "１つめ、あとは３。"
        );
    }

    #[test]
    fn unifies_every_occurrence() {
        assert_eq!(
            unify_punctuation("あ，い，う．え．", PunctuationStyle::Kutouten),
            "あ、い、う。え。"
        );
    }

    #[test]
    fn can_remove_text() {
        // 置き換えた後の文字列を空にすると、その語を取り除ける
        let dictionary = [replacement("えーと、", "")];
        assert_eq!(
            apply_replacements("えーと、これです", &dictionary),
            "これです"
        );
    }

    #[test]
    fn finds_matches_at_character_positions() {
        // 「高」は1文字なので start は 1（バイト位置ではなく文字位置）
        let dictionary = [replacement("濃度", "Node.js")];
        assert_eq!(
            find_replacement_matches("高濃度の溶液", &dictionary),
            vec![ReplacementMatch {
                start: 1,
                len: 2,
                to: "Node.js".to_string()
            }]
        );
    }

    #[test]
    fn finds_every_occurrence() {
        let dictionary = [replacement("濃度", "Node.js")];
        assert_eq!(
            find_replacement_matches("濃度と濃度のバージョン", &dictionary),
            vec![
                ReplacementMatch {
                    start: 0,
                    len: 2,
                    to: "Node.js".to_string()
                },
                ReplacementMatch {
                    start: 3,
                    len: 2,
                    to: "Node.js".to_string()
                },
            ]
        );
    }

    #[test]
    fn finds_no_matches_without_a_dictionary() {
        assert_eq!(find_replacement_matches("濃度の溶液", &[]), vec![]);
    }

    #[test]
    fn finds_matches_using_the_same_rule_as_apply_replacements() {
        // 最長一致・連鎖しない・無効項目は無視、という判定基準が apply_replacements と食い違わないこと
        let mut disabled = replacement("skip", "Y");
        disabled.enabled = false;
        let dictionary = [replacement("ab", "AB"), replacement("a", "A"), disabled];
        let text = "cabab";
        assert_eq!(
            find_replacement_matches(text, &dictionary),
            vec![
                ReplacementMatch {
                    start: 1,
                    len: 2,
                    to: "AB".to_string()
                },
                ReplacementMatch {
                    start: 3,
                    len: 2,
                    to: "AB".to_string()
                },
            ]
        );
        assert_eq!(apply_replacements(text, &dictionary), "cABAB");
    }

    fn widths(
        alphabet: WidthStyle,
        digit: WidthStyle,
        space: WidthStyle,
        symbol: WidthStyle,
    ) -> CharWidths {
        CharWidths {
            alphabet,
            digit,
            space,
            symbol,
            katakana: KatakanaWidth::Keep,
        }
    }

    #[test]
    fn converts_only_the_chosen_kinds() {
        use WidthStyle::{Full, Half, Keep};
        let text = "Ａｂ１２ (x)　ｙ";
        assert_eq!(
            convert_widths(text, &widths(Half, Keep, Keep, Keep)),
            "Ab１２ (x)　y"
        );
        assert_eq!(
            convert_widths(text, &widths(Keep, Half, Keep, Keep)),
            "Ａｂ12 (x)　ｙ"
        );
        assert_eq!(
            convert_widths(text, &widths(Keep, Keep, Full, Keep)),
            "Ａｂ１２　(x)　ｙ"
        );
        assert_eq!(
            convert_widths(text, &widths(Keep, Keep, Half, Keep)),
            "Ａｂ１２ (x) ｙ"
        );
        assert_eq!(
            convert_widths(text, &widths(Keep, Keep, Keep, Full)),
            "Ａｂ１２ （x）　ｙ"
        );
        assert_eq!(
            convert_widths(text, &widths(Full, Full, Full, Full)),
            "Ａｂ１２　（ｘ）　ｙ"
        );
    }

    #[test]
    fn leaves_commas_and_periods_to_the_punctuation_setting() {
        use WidthStyle::{Full, Keep};
        assert_eq!(
            convert_widths("a, b.，", &widths(Full, Keep, Keep, Full)),
            "ａ, ｂ.，"
        );
    }

    #[test]
    fn converts_separators_between_digits_with_the_digits() {
        // 桁区切りと小数点だけが全角と半角で混ざらないようにする
        use WidthStyle::{Full, Half, Keep};
        assert_eq!(
            convert_widths("１，０００．５円", &widths(Keep, Half, Keep, Keep)),
            "1,000.5円"
        );
        assert_eq!(
            convert_widths("1,000.5円", &widths(Keep, Full, Keep, Keep)),
            "１，０００．５円"
        );
    }

    #[test]
    fn keeps_wave_dash_as_is() {
        use WidthStyle::{Full, Half, Keep};
        assert_eq!(
            convert_widths("10時～12時（予定）", &widths(Keep, Keep, Keep, Half)),
            "10時～12時(予定)"
        );
        assert_eq!(
            convert_widths("~/.ssh", &widths(Keep, Keep, Keep, Full)),
            "~／.ssh"
        );
    }

    #[test]
    fn converts_halfwidth_katakana_to_fullwidth() {
        let katakana = CharWidths {
            katakana: KatakanaWidth::Full,
            ..CharWidths::default()
        };
        assert_eq!(
            convert_widths("ｶﾞｷﾞﾂﾞﾄﾞﾊﾟﾎﾟｳﾞﾜﾞｦﾞ ｱｲｳｴｵｯｰﾝ｡｢ｶﾅ｣､･", &katakana),
            "ガギヅドパポヴヷヺ アイウエオッーン。「カナ」、・"
        );
        // 合わせられない濁点・半濁点は、全角の濁点・半濁点にする
        assert_eq!(convert_widths("ｱﾞﾟ", &katakana), "ア゛゜");
    }

    #[test]
    fn keeps_text_when_all_kinds_are_kept() {
        let text = "Ａb １ ｶﾅ";
        assert!(matches!(
            convert_widths(text, &CharWidths::default()),
            std::borrow::Cow::Borrowed(_)
        ));
    }
}
