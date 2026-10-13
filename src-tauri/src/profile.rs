//! 常用の Mawok と、設定・履歴・ログ・資格情報の置き場を分けて起動するためのプロファイル。
//! 自動の確認と開発版が、その機でサインインしているアカウントで同期しないようにする（docs/platform.md「プロファイル」）。

use std::env::VarError;
use std::sync::OnceLock;

/// プロファイルの名前を渡す環境変数
pub const ENV: &str = "MAWOK_PROFILE";

/// 開発版（デバッグビルド）の既定のプロファイル
const DEV: &str = "dev";

const INVALID: &str = "must be 1-32 characters of a-z, 0-9 and '-'";

/// フォルダー名と資格情報の service に入るので、どの OS でもそのまま使える文字に限る
fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn with_profile(base: &str, profile: Option<&str>) -> String {
    match profile {
        Some(name) => format!("{base}.{name}"),
        None => base.to_string(),
    }
}

/// 環境変数の値とビルドの種類から、プロファイルを決める。名前として使えない値は、理由を返す
fn resolve(value: Result<String, VarError>, debug: bool) -> Result<Option<String>, String> {
    let name = match value {
        Ok(name) => name,
        // 開発版は、何も付けなくても常用の設定と資格情報に触れない
        Err(VarError::NotPresent) if debug => DEV.to_string(),
        Err(VarError::NotPresent) => return Ok(None),
        Err(VarError::NotUnicode(_)) => return Err(INVALID.to_string()),
    };
    // 空にすると、開発版でも常用の置き場を使う
    if name.is_empty() {
        Ok(None)
    } else if valid(&name) {
        Ok(Some(name))
    } else {
        Err(INVALID.to_string())
    }
}

fn current() -> Option<&'static str> {
    static PROFILE: OnceLock<Option<String>> = OnceLock::new();
    PROFILE
        .get_or_init(|| {
            resolve(std::env::var(ENV), cfg!(debug_assertions)).unwrap_or_else(|error| {
                // ログの置き場が決まる前なので、標準エラーに出す。常用の置き場で黙って動くと、分けたつもりの起動が常用の設定を書き換える
                eprintln!("{ENV} {error}");
                std::process::exit(2);
            })
        })
        .as_deref()
}

/// アプリの識別子か資格情報の service に、プロファイルの名前を添える。プロファイルが無ければ、そのまま返す
pub fn scoped(base: &str) -> String {
    with_profile(base, current())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_name_is_limited_to_characters_safe_in_a_folder_name() {
        assert!(valid("e2e"));
        assert!(valid("dev-2"));
        for name in ["", "E2E", "a.b", "a/b", "a b", &"a".repeat(33)] {
            assert!(!valid(name), "{name:?}");
        }
    }

    #[test]
    fn the_profile_comes_from_the_variable_and_a_debug_build_defaults_to_dev() {
        let set = |value: &str| Ok(value.to_string());
        assert_eq!(resolve(set("e2e"), false), Ok(Some("e2e".to_string())));
        assert_eq!(resolve(Err(VarError::NotPresent), false), Ok(None));
        assert_eq!(
            resolve(Err(VarError::NotPresent), true),
            Ok(Some("dev".to_string()))
        );
        // 空の値は、開発版でも常用の置き場
        assert_eq!(resolve(set(""), true), Ok(None));
        // 使えない値を、付けなかったことにして常用の置き場で動かさない
        assert!(resolve(set("a/b"), false).is_err());
        let not_unicode = VarError::NotUnicode(std::ffi::OsString::new());
        assert!(resolve(Err(not_unicode), false).is_err());
    }

    #[test]
    fn the_profile_is_appended_to_the_identifier() {
        assert_eq!(
            with_profile("com.amiiby.mawok", Some("e2e")),
            "com.amiiby.mawok.e2e"
        );
        assert_eq!(with_profile("com.amiiby.mawok", None), "com.amiiby.mawok");
    }
}
