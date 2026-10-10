//! Rust と画面の間で送るイベント名。

pub const SETTINGS_CHANGED: &str = "settings-changed";
pub const DRAFT_HISTORY_CLEARED: &str = "draft-history-cleared";
pub const SNIPPET_ADDED: &str = "snippet-added";
pub const PAIRING_CODE_ENDED: &str = "pairing-code-ended";
pub const PAIRING_CODE_OFFERED: &str = "pairing-code-offered";
pub const DRAFT_RECEIVED: &str = "draft-received";
pub const SHOWN: &str = "shown";
pub const HIDE_REQUESTED: &str = "hide-requested";
pub const DRAFT_HIDDEN: &str = "draft-hidden";
/// Mawok のアカウントのサインインが済んだか、期限が切れた（中身は MawokSignInEnded）
pub const MAWOK_SIGN_IN_ENDED: &str = "mawok-sign-in-ended";
/// Mac 版の更新の様子か、下書きの書きかけのあるなしが変わった（中身は UpdateView）
#[cfg(any(target_os = "macos", test))]
pub const UPDATE_CHANGED: &str = "update-changed";
