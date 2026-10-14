//! 宛先へ出す。
//! 1行目の行頭が `@ai` なら AI（ai.rs）へ、`@sh` ならシェル（command.rs）へ渡して、結果を下書きに出す（docs/actions.md）。
//! ここには実行先によらない決めごと（行の読み方、既定の定型文、失敗の種類）を置く

use crate::{
    config::{ActionEncoding, ActionOutput, Snippet},
    i18n::Lang,
};

/// 行頭にあれば、残りを指示文として AI サービスへ送る宛先
pub const AI_PREFIX: &str = "@ai";
/// 行頭にあれば、残りをコマンドとしてその機のシェルで実行する宛先
pub const SH_PREFIX: &str = "@sh";
/// 言語を替えても同じ既定の翻訳アクションを見分けるための ID。
const DEFAULT_TRANSLATE_ACTION_ID: &str = "6b6a77e6d4f846f2a8bbf953fbd0e0d3";
/// 言語を替えても同じ既定の並べ替えアクションを見分けるための ID。
const DEFAULT_SORT_ACTION_ID: &str = "9c4d11698d17426c8e930b8118ffb2f2";

/// 指示文から AI のアクションの行を作る
fn ai_line(instruction: &str) -> String {
    format!("{AI_PREFIX} {}", instruction.trim())
}

/// 行頭が宛先 `prefix` なら、その後ろ（前後の空白を除く）を返す。宛先の直後は空白か行の終わりに限る（`@aix` は `@ai` の行ではない）。
/// 大文字と小文字は区別しない（`@AI` と打っても宛先として読む）
fn addressed<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let head = line.trim_start();
    let word = head.get(..prefix.len())?;
    if !word.eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = &head[prefix.len()..];
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim())
}

/// 行頭が `@ai` なら、その後ろの指示文を返す
pub fn ai_instruction(line: &str) -> Option<&str> {
    addressed(line, AI_PREFIX)
}

/// 行頭が `@sh` なら、その後ろのコマンドを返す
pub fn sh_command(line: &str) -> Option<&str> {
    addressed(line, SH_PREFIX)
}

/// アクションが別の並びだったころのコマンドの行を、宛先で始まる定型文の本文にする。`@ai` の行はそのまま、ほかはシェルの行だったので `@sh` を付ける。
/// 複数行の指示文は、改行の所だけを空白にして1行につなぐ。選ぶと出す定型文は本文が1行のものだけなので、つながないと、挿入するだけの定型文に変わる
pub fn legacy_action_body(command: &str) -> String {
    // コマンドを書いていなかった行は、一覧に出ない空の定型文のままにする
    if command.trim().is_empty() {
        command.to_string()
    } else if ai_instruction(command).is_some() {
        command
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        format!("{SH_PREFIX} {command}")
    }
}

/// 既定の定型文。設定ファイルに定型文の項目がないときに、今の表示言語で使う。
/// AI の見本（英訳）と、どの OS にも入っているコマンドの見本（`sort`。標準入力を並べ替えて返す）を1つずつ。
/// Windows の `sort` はシステムの文字コードで読み書きするので、Shift_JIS にする。
/// 文字コードの既定が OS で違うコマンドの見本は、同期しない行にしておく（docs/sync.md「同期する単位」）
pub fn default_snippets(lang: Lang) -> Vec<Snippet> {
    let (translate, translate_instruction, sort) = match lang {
        Lang::Ja => (
            "英訳",
            "次の文章を、自然な英語に訳してください。訳した文章だけを返してください。",
            "行を並べ替え",
        ),
        Lang::En => (
            "Translate to English",
            "Translate the following text into natural English. Return only the translated text.",
            "Sort lines",
        ),
    };
    let sort_encoding = if cfg!(windows) {
        ActionEncoding::ShiftJis
    } else {
        ActionEncoding::Utf8
    };
    [
        (
            DEFAULT_TRANSLATE_ACTION_ID,
            translate,
            ai_line(translate_instruction),
            ActionEncoding::Utf8,
            true,
        ),
        (
            DEFAULT_SORT_ACTION_ID,
            sort,
            format!("{SH_PREFIX} sort"),
            sort_encoding,
            false,
        ),
    ]
    .into_iter()
    .map(|(id, name, body, encoding, sync)| Snippet {
        id: id.to_string(),
        name: name.to_string(),
        body,
        output: ActionOutput::Replace,
        encoding,
        enabled: true,
        sync,
    })
    .collect()
}

/// アクションの失敗の種類
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// AI が使えない（使わない、または今の AI サービスを了解していない）
    Disabled,
    /// キーを置いていない
    NoKey,
    /// キーが読めない（キーチェーンの許可を拒んだなど）
    KeyUnreadable,
    /// キーが無効、またはキーに権限がない（HTTP 401・403）
    InvalidKey,
    /// AI サービスに断られた（HTTP 400。キーかモデルの設定の誤りが多いが、原因は決めつけない）
    Rejected,
    /// モデルが見つからない（モデルの名前の書き間違い、提供が終わったモデルなど）
    ModelNotFound,
    /// 回数や量の上限
    RateLimited,
    /// 利用額やクレジットの上限（やり直しても直らない。AI サービスのアカウントの側で直す）
    Billing,
    /// Mawok のアカウントにサインインしていないか、トークンが外された
    SignInRequired,
    /// Mawok のアカウントの残高が無い
    NoCredit,
    /// 送る文が長すぎる（Mawok の窓口の上限）
    TextTooLong,
    /// 同じ Mawok のアカウントの前の AI のアクションが、窓口でまだ終わっていない（取り消した直後など）
    PreviousRunning,
    /// AI サービス側のエラー（混んでいる、止まっているなど）
    ServiceError,
    /// つながらない
    Network,
    /// 時間内に返事が来なかった
    Timeout,
    /// 返事が読めない、文が空など、ほかのどれにも当たらない
    Unexpected,
    /// コマンドを起動できなかった（シェルが見つからないなど）
    CommandNotStarted,
    /// テキストウィンドウで移った作業フォルダーが、移った後に消えたか移された（folder.rs）
    FolderMissing,
    /// シェルがコマンドを見つけられなかった（macOS の終了コード 127）。Windows は見分けない（command.rs の NOT_FOUND_EXIT_CODE）
    #[cfg_attr(windows, allow(dead_code))]
    CommandNotFound,
    /// コマンドが 0 以外の終了コードで終わったか、シグナルで止まった
    CommandFailed,
    /// コマンドの行に改行がある。Windows の cmd は最初の改行より後ろを黙って捨てるので、実行しない（command.rs の run）
    #[cfg_attr(not(windows), allow(dead_code))]
    MultilineCommand,
    /// コマンドの標準出力が空だった
    EmptyOutput,
    /// コマンドの標準出力が上限（command::MAX_OUTPUT）を超えた
    OutputTooLarge,
    /// 実行する文に、アクションの文字コードで表せない文字がある（Shift_JIS に絵文字など）
    TextNotEncodable,
    /// コマンドの標準出力が、アクションの文字コードとして読めない
    OutputUndecodable,
}

impl Failure {
    /// 画面に渡す符号。画面側のアクションの失敗の文言と揃える（src/lib/action-errors.ts）
    pub fn code(self) -> &'static str {
        match self {
            Self::Disabled => "action.disabled",
            Self::NoKey => "action.no_key",
            Self::KeyUnreadable => "action.key_unreadable",
            Self::InvalidKey => "action.invalid_key",
            Self::Rejected => "action.rejected",
            Self::ModelNotFound => "action.model_not_found",
            Self::RateLimited => "action.rate_limited",
            Self::Billing => "action.billing",
            Self::SignInRequired => "action.sign_in_required",
            Self::NoCredit => "action.no_credit",
            Self::TextTooLong => "action.text_too_long",
            Self::PreviousRunning => "action.previous_running",
            Self::ServiceError => "action.service_error",
            Self::Network => "action.network",
            Self::Timeout => "action.timeout",
            Self::Unexpected => "action.unexpected",
            Self::CommandNotStarted => "action.command_not_started",
            Self::FolderMissing => "action.folder_missing",
            Self::CommandNotFound => "action.command_not_found",
            Self::CommandFailed => "action.command_failed",
            Self::MultilineCommand => "action.multiline_command",
            Self::EmptyOutput => "action.empty_output",
            Self::OutputTooLarge => "action.output_too_large",
            Self::TextNotEncodable => "action.text_not_encodable",
            Self::OutputUndecodable => "action.output_undecodable",
        }
    }
}

/// 失敗の種類と、ログに残す詳しい中身。中身には、送った文や受け取った文を入れない
#[derive(Debug)]
pub struct ActionError {
    pub failure: Failure,
    pub detail: String,
    /// 画面の案内文の末尾にそのまま添える、実行先自身の言葉。ログには残さない（利用者自身の下書きの断片や秘密を含みうるため）。
    /// - AI: AI サービスが返す人間向けの短い文言（Rejected のときだけ、あれば持つ）。Rejected は原因を決めつけない分類なので、
    ///   サービス側の言葉をそのまま見せることで、キーの入れ間違いのような細かい原因を利用者が見分けられるようにする
    /// - コマンド: 失敗したときの標準エラーの末尾の数行
    pub screen_detail: Option<String>,
    /// コマンドの終了コード（CommandFailed のとき。シグナルで止まったときは None）
    pub exit_code: Option<i32>,
}

impl ActionError {
    pub fn new(failure: Failure, detail: impl Into<String>) -> Self {
        Self {
            failure,
            detail: detail.into(),
            screen_detail: None,
            exit_code: None,
        }
    }

    /// Rejected のときだけ、空でなければ screen_detail に持たせる（理由は ai::classify_gemini_error を参照）
    pub fn with_service_message(mut self, message: impl Into<String>) -> Self {
        let message = message.into();
        if self.failure == Failure::Rejected && !message.is_empty() {
            self.screen_detail = Some(message);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_command_sample_is_kept_out_of_sync() {
        for lang in [Lang::Ja, Lang::En] {
            let synced: Vec<_> = default_snippets(lang)
                .into_iter()
                .map(|snippet| (snippet.body == "@sh sort", snippet.sync))
                .collect();
            assert_eq!(synced, [(false, true), (true, false)]);
        }
    }

    #[test]
    fn has_one_ai_row_and_one_command_row_by_default_in_each_language() {
        let mut ids: Option<Vec<String>> = None;
        for lang in [Lang::Ja, Lang::En] {
            let snippets = default_snippets(lang);
            assert_eq!(snippets.len(), 2);
            assert!(snippets.iter().all(|snippet| !snippet.name.is_empty()
                && snippet.enabled
                && snippet.output == ActionOutput::Replace));
            assert!(ai_instruction(&snippets[0].body)
                .is_some_and(|instruction| !instruction.is_empty()));
            assert_eq!(sh_command(&snippets[1].body), Some("sort"));
            let current = snippets
                .iter()
                .map(|snippet| snippet.id.clone())
                .collect::<Vec<_>>();
            if let Some(ref ids) = ids {
                assert_eq!(current.as_slice(), ids.as_slice());
            } else {
                ids = Some(current);
            }
        }
    }

    #[test]
    fn reads_the_ai_prefix_only_at_the_head_of_the_line() {
        assert_eq!(ai_instruction("@ai 丁寧に: 敬語で"), Some("丁寧に: 敬語で"));
        assert_eq!(
            ai_instruction("  @ai\t訳して | sort "),
            Some("訳して | sort")
        );
        assert_eq!(ai_instruction("@ai"), Some(""));
        assert_eq!(ai_instruction("@AI 訳して"), Some("訳して"));
        assert_eq!(ai_instruction("@aix"), None);
        assert_eq!(ai_instruction("@あ"), None);
        assert_eq!(ai_instruction("echo @ai"), None);
        assert_eq!(ai_line(" 訳して "), "@ai 訳して");
    }

    #[test]
    fn reads_the_sh_prefix_only_at_the_head_of_the_line() {
        assert_eq!(sh_command("@sh sort | uniq"), Some("sort | uniq"));
        assert_eq!(sh_command("@sh"), Some(""));
        assert_eq!(sh_command("@Sh ls"), Some("ls"));
        assert_eq!(sh_command("@shell ls"), None);
        assert_eq!(sh_command("sort"), None);
    }

    #[test]
    fn turns_a_command_line_from_the_separate_action_list_into_an_addressed_body() {
        assert_eq!(legacy_action_body("sort"), "@sh sort");
        assert_eq!(legacy_action_body("@ai 訳して"), "@ai 訳して");
        assert_eq!(
            legacy_action_body("@ai 丁寧に直して。\n  例: \"a  b\"\n\n直した文だけを返して。"),
            "@ai 丁寧に直して。 例: \"a  b\" 直した文だけを返して。"
        );
        assert_eq!(legacy_action_body(""), "");
    }
}
