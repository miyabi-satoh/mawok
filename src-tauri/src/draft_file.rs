//! テキストウィンドウの「開く」「保存」で、ファイルの中身とテキストを行き来させる。

use crate::{error_codes, text};

/// ファイルの中身をテキストにする。UTF-8（BOM の有無を問わない）だけを読む。
/// ほかの文字コード（Shift_JIS など）は、推し量って読むと化けたまま書き換えてしまうので、読まずに符号を返す。
/// 行末は入力欄と履歴と同じ LF にそろえる
pub fn decode(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let decoded = std::str::from_utf8(bytes).map_err(|_| error_codes::FILE_NOT_UTF8.to_string())?;
    Ok(text::lf_line_endings(decoded))
}

/// テキストをファイルに書く中身にする。UTF-8 で BOM は付けない。Windows では行末を CR+LF にする（クリップボードと同じ OS の取り決め）
pub fn encode(text: &str) -> Vec<u8> {
    text::os_line_endings(text).into_owned().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_utf8_with_or_without_bom() {
        assert_eq!(decode("あ\nい".as_bytes()).unwrap(), "あ\nい");
        assert_eq!(decode(b"\xEF\xBB\xBFabc").unwrap(), "abc");
    }

    #[test]
    fn refuses_other_encodings() {
        // Shift_JIS の「あ」
        assert_eq!(
            decode(b"\x82\xA0").unwrap_err(),
            error_codes::FILE_NOT_UTF8.to_string()
        );
        // BOM の付いた UTF-16 も読まない
        assert!(decode(b"\xFF\xFEa\x00").is_err());
    }

    #[test]
    fn turns_line_endings_into_lf() {
        assert_eq!(decode(b"a\r\nb\rc\n").unwrap(), "a\nb\nc\n");
    }

    #[test]
    fn writes_utf8_with_the_line_endings_of_the_os() {
        let expected: &[u8] = if cfg!(windows) { b"a\r\nb" } else { b"a\nb" };
        assert_eq!(encode("a\nb"), expected);
    }
}
