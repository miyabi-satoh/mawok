//! テキストウィンドウの「開く」「保存」で、ファイルの中身とテキストを行き来させる。

use crate::{error_codes, text};

/// ファイルの中身をテキストにする。UTF-8（BOM の有無を問わない）と、BOM の付いた UTF-16 だけを読む。
/// ほかの文字コード（Shift_JIS など）は、推し量って読むと化けたまま書き換えてしまうので、読まずに符号を返す。
/// 行末は入力欄と履歴と同じ LF にそろえる
pub fn decode(bytes: &[u8]) -> Result<String, String> {
    let decoded = if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        String::from_utf8(rest.to_vec()).ok()
    } else if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        utf16(rest, u16::from_le_bytes)
    } else if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        utf16(rest, u16::from_be_bytes)
    } else {
        String::from_utf8(bytes.to_vec()).ok()
    };
    let decoded = decoded.ok_or_else(|| error_codes::FILE_NOT_UTF8.to_string())?;
    Ok(lf_line_endings(&decoded))
}

fn utf16(bytes: &[u8], from_bytes: fn([u8; 2]) -> u16) -> Option<String> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    let units: Vec<u16> = pairs.iter().map(|&pair| from_bytes(pair)).collect();
    String::from_utf16(&units).ok()
}

fn lf_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// テキストをファイルに書く中身にする。UTF-8 で BOM は付けない。Windows では行末を CR+LF にする（クリップボードと同じ OS の取り決め）
pub fn encode(text: &str) -> Vec<u8> {
    if cfg!(windows) {
        text::crlf_line_endings(text).into_owned().into_bytes()
    } else {
        text.as_bytes().to_vec()
    }
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
    fn reads_utf16_with_bom() {
        assert_eq!(decode(b"\xFF\xFEa\x00\x42\x30").unwrap(), "aあ");
        assert_eq!(decode(b"\xFE\xFF\x00a\x30\x42").unwrap(), "aあ");
    }

    #[test]
    fn refuses_other_encodings() {
        // Shift_JIS の「あ」
        assert_eq!(
            decode(b"\x82\xA0").unwrap_err(),
            error_codes::FILE_NOT_UTF8.to_string()
        );
        // 長さが奇数の UTF-16
        assert!(decode(b"\xFF\xFEa").is_err());
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
