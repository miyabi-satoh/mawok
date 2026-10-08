//! Mac 版の更新の状態のうち、設定の画面へ渡すもの（docs/platform.md「Mac 版の更新」）。
//! 更新の仕組みは macOS にしか入れないが、境目の型は `cargo test` でどの OS でも書き出すので、テストでは Windows でも作る

use serde::Serialize;

/// 新しい版を確かめ、入れる様子
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    /// 起動してからまだ確かめていない
    #[default]
    Unchecked,
    Checking,
    UpToDate,
    /// 新しい版が見つかった
    Available {
        version: String,
    },
    /// 新しい版をダウンロードして入れている。終われば再起動する
    Installing {
        version: String,
    },
    /// 確かめられなかった。理由はログに残す
    CheckFailed,
    /// 新しい版を入れられなかった。理由はログに残す。もう一度入れられる
    InstallFailed {
        version: String,
    },
}

/// `update_status` と `update-changed` で設定の画面へ渡すもの
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export))]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub status: UpdateStatus,
    /// 下書きウィンドウに書きかけの文があるか。あれば、再起動で消えることを更新のボタンの近くに出す
    pub draft_has_text: bool,
}
