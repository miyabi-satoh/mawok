//! バイト列を 16 進の文字列にする。デバイスの見分けをファイルの名前に使うため

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// N バイトの乱数を 16 進の文字列にする
pub fn random_hex<const N: usize>() -> Result<String, String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|error| format!("random: {error}"))?;
    Ok(to_hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_hex() {
        assert_eq!(to_hex(&[0x00, 0xab, 0xff]), "00abff");
    }
}
