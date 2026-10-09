//! コマンドのアクション（docs/actions.md「コマンド」）。
//! 利用者が書いた1行のコマンドをシェルで実行し、実行する文を `{{t}}`・標準入力・環境変数 `MAWOK_TEXT` で渡して、標準出力を結果として受け取る。
//! 標準入力と標準出力は、アクションの文字コードで読み書きする（`{{t}}` と `MAWOK_TEXT` は OS の文字列で渡すので関わらない）。
//! コマンドの行・渡した文・標準出力・標準エラーはログに書かない（秘密を含みうるため）。記録するのは終了コードと失敗の種類だけ

use std::{
    borrow::Cow,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{
    actions::{ActionError, Failure, TEXT_MARK},
    config::ActionEncoding,
};

/// 実行する文を入れる環境変数
const TEXT_ENV: &str = "MAWOK_TEXT";
/// 実行する文を、受け取るプログラムの引数の規則で囲い直して入れる環境変数（Windows で `{{t}}` を埋め込むため。embed_text）
#[cfg(windows)]
const QUOTED_TEXT_ENV: &str = "MAWOK_TEXT_QUOTED";
/// `MAWOK_TEXT` に入れる文の大きさの上限。macOS は引数と環境変数を合わせて ARG_MAX（1 MiB）までなので、ほかの環境変数の分を残す
#[cfg(unix)]
const MAX_ENV_TEXT: usize = 256 * 1024;
/// `{{t}}` を埋め込んだシェルの行と `MAWOK_TEXT` を合わせた大きさの上限（macOS。ARG_MAX に、ほかの環境変数の分の余裕を見る）
#[cfg(unix)]
const MAX_EMBEDDED_TOTAL: usize = 768 * 1024;
/// `MAWOK_TEXT` に入れる文の大きさの上限。Windows の環境変数の値の上限（UTF-16 で数える）
#[cfg(windows)]
const MAX_ENV_TEXT: usize = 32_767;
/// `{{t}}` を展開した後の cmd の行の長さの上限（UTF-16 で数える）。cmd が1行として扱えるのは 8,191 文字まで
#[cfg(windows)]
const MAX_EXPANDED_LINE: usize = 8_191;

/// 標準出力の上限。止まらずに出力し続けるコマンドへの備え
pub const MAX_OUTPUT: usize = 1024 * 1024;
/// 失敗の帯に出す、標準エラーの末尾の行数
const STDERR_TAIL_LINES: usize = 5;
/// 標準エラーのうち、末尾の行を取り出すために覚えておく量。これより前は捨てる
const STDERR_KEEP: usize = 16 * 1024;
/// シェルが終わった後に、標準出力と標準エラーを読み終えるまで待つ長さ。
/// 裏で動き続けるプロセスが開いたままにしていると、読み終わらないため
const OUTPUT_GRACE: std::time::Duration = std::time::Duration::from_millis(200);

/// 走っているコマンドを止める口。取り消し（cancel_action）とアプリの終了から、走っている実行の外で呼ぶ。
/// 止めると、コマンドを子プロセスごと止める。起動する前に止めたら、起動したところですぐ止める
#[derive(Clone, Default)]
pub struct Stopper(Arc<Mutex<StopState>>);

#[derive(Default)]
struct StopState {
    /// 走っているコマンドのプロセスの木。終わったら手放す（残ったほかのプロセスまでは止めない）
    tree: Option<ProcessTree>,
    stopped: bool,
}

impl Stopper {
    pub fn stop(&self) {
        let mut state = self.0.lock().unwrap();
        state.stopped = true;
        if let Some(tree) = state.tree.take() {
            tree.kill();
        }
    }

    /// 起動したプロセスの木を覚える。すでに止められていれば、すぐ止めて false を返す
    fn started(&self, tree: ProcessTree) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.stopped {
            tree.kill();
            return false;
        }
        state.tree = Some(tree);
        true
    }

    /// 終わったら覚えたプロセスの木を手放す。この後に止めても何もしない
    fn finished(&self) {
        if let Some(tree) = self.0.lock().unwrap().tree.take() {
            tree.release();
        }
    }
}

/// 走っている間に実行ごと捨てられたら（取り消しで打ち切ったときなど）、コマンドを子プロセスごと止める
struct StopOnDrop(Stopper);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// シェルが、コマンドが見つからないときに返す終了コード。Windows の cmd /c は見つからなくても 1 で終わるので、見分けない。
/// 後ろに exit などを足して 9009 を拾う形は、for の do の後ろに入り込むなど、利用者の1行の意味を変えてしまう
#[cfg(unix)]
const NOT_FOUND_EXIT_CODE: i32 = 127;

/// 行の中の `{{t}}` を、実行する文を単引用符で囲んだ1つの引数に置き換える（macOS）
#[cfg(unix)]
fn embed_text(command: &str, text: &str) -> String {
    command.replace(TEXT_MARK, &format!("'{}'", text.replace('\'', "'\\''")))
}

/// 実行する文を `MAWOK_TEXT` で渡せるか。NUL を含む文は、環境変数にも引数にもできない
fn env_passable(text: &str) -> bool {
    if text.contains('\0') {
        return false;
    }
    #[cfg(unix)]
    let length = text.len();
    #[cfg(windows)]
    let length = text.encode_utf16().count();
    length <= MAX_ENV_TEXT
}

/// 行の `{{t}}` に実行する文を埋め込めるか。組み上がる行（macOS は `MAWOK_TEXT` と合わせて、Windows は展開した後の cmd の行）の長さで見る
fn embeddable(command: &str, text: &str) -> bool {
    if !env_passable(text) {
        return false;
    }
    #[cfg(unix)]
    return embed_text(command, text).len() + text.len() <= MAX_EMBEDDED_TOTAL;
    #[cfg(windows)]
    {
        let marks = command.matches(TEXT_MARK).count();
        let quoted = quote_windows_arg(text).encode_utf16().count();
        let rest = command.encode_utf16().count() - marks * TEXT_MARK.len();
        // 展開した値は、囲う引用符の中に入る
        rest + marks * (quoted + 2) <= MAX_EXPANDED_LINE
    }
}

/// 引用符で囲んだ引数の中身として、受け取るプログラムが元の文に戻せる形にする（Windows の CommandLineToArgvW と C ランタイムの規則）。
/// `"` の前には `\` を置き、`"` と文末の前の `\` の並びは倍にする。囲う引用符そのものは、呼ぶ側が付ける
#[cfg(any(windows, test))]
fn quote_windows_arg(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len());
    let mut backslashes = 0;
    for c in text.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
            }
        }
        if c != '\\' {
            quoted.push(c);
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted
}

/// 行の前後にある、空白だけの行を落とす（Windows）。貼り付けで付いただけの行で、cmd が実行するものを変えない。
/// 改行を含まない行の前後の空白は、`echo a ` の出力のように実行するものを変えうるので残す
#[cfg(any(windows, test))]
fn strip_blank_lines(command: &str) -> &str {
    let leading = command.len() - command.trim_start().len();
    let start = command[..leading]
        .rfind(['\n', '\r'])
        .map_or(0, |at| at + 1);
    let command = &command[start..];
    let content = command.trim_end().len();
    let end = command[content..]
        .find(['\n', '\r'])
        .map_or(command.len(), |at| content + at);
    &command[..end]
}

/// 行の中の `{{t}}` を、環境変数 `MAWOK_TEXT_QUOTED` の遅延展開に置き換える（Windows）。cmd には任意の文字列を確実に囲う方法が無いが、
/// 遅延展開は行を解釈した後に起きるので、中の記号がコマンドとして読まれない。
/// 受け取るプログラムは引用符と `\` の規則で引数を分け直すので、その規則で囲い直した文（quote_windows_arg）を展開する。
/// 空の環境変数は無いものとして扱われ、`!MAWOK_TEXT_QUOTED!` が文字どおり残るので、実行する文が空なら空の引数 `""` にする
#[cfg(windows)]
fn embed_text(command: &str, text: &str) -> String {
    let embedded = if text.is_empty() {
        "\"\"".to_string()
    } else {
        format!("\"!{QUOTED_TEXT_ENV}!\"")
    };
    command.replace(TEXT_MARK, &embedded)
}

/// コマンドを渡すシェル（macOS）。Dock などから起動した GUI のアプリはターミナルの PATH を引き継がないので、
/// ログインシェルで読む設定の PATH で動かす
#[cfg(unix)]
fn shell_command(command: &str, _expands_text: bool) -> tokio::process::Command {
    let shell = std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut process = tokio::process::Command::new(shell);
    process.arg("-l").arg("-c").arg(command);
    // 止めるときに子プロセスごと止められるよう、新しいプロセスグループにする
    process.process_group(0);
    process
}

/// コマンドを渡すシェル（Windows）。cmd は標準入出力を読まずに子へ引き継ぐので、下書きのバイトがそのまま届く。
/// PowerShell はパイプやコマンドレットで化け、起動も遅い
#[cfg(windows)]
fn shell_command(command: &str, expands_text: bool) -> tokio::process::Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut process = tokio::process::Command::new("cmd.exe");
    // /d はレジストリの AutoRun を走らせない。/v:on は `{{t}}` を埋め込む遅延展開（embed_text）のため。
    // 遅延展開は、行に `!` があると引用符の中でも `^` を消すので、`{{t}}` の無い行では切る。
    // 何も付けないとレジストリの既定（DelayedExpansion）に従うので、/v:off をはっきり付ける。
    // /s /c "…" で、コマンドの行を引用符ごとそのまま渡す
    let delayed = if expands_text { "/v:on" } else { "/v:off" };
    process.raw_arg(format!("/d {delayed} /s /c \"{command}\""));
    process.creation_flags(CREATE_NO_WINDOW);
    // Python は既定だと標準入出力を cp932 で扱い、下書きが化ける。利用者が決めていればそれに従う
    if std::env::var_os("PYTHONUTF8").is_none() {
        process.env("PYTHONUTF8", "1");
    }
    process
}

/// 起動したシェルと、その下で動くプロセス。macOS はプロセスグループ（起動するときに新しいグループにしている）
#[cfg(unix)]
struct ProcessTree(i32);

#[cfg(unix)]
impl ProcessTree {
    fn new(child: &tokio::process::Child) -> Result<Self, String> {
        let id = child
            .id()
            .ok_or("the command exited before it could be tracked")?;
        i32::try_from(id)
            .map(Self)
            .map_err(|_| format!("unexpected process id {id}"))
    }

    fn kill(self) {
        // SAFETY: kill はシグナルを送るだけで、メモリを触らない。負の値でプロセスグループを指す
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }

    fn release(self) {}
}

/// 起動したシェルと、その下で動くプロセス。Windows はジョブオブジェクトに入れる。入れた後で起こしたプロセスも同じジョブに入る。
/// 閉じると中のプロセスがすべて止まるようにしておく（Mawok が落ちてハンドルが閉じたときも止まる）
#[cfg(windows)]
struct ProcessTree(Job);

#[cfg(windows)]
struct Job(windows::Win32::Foundation::HANDLE);

// SAFETY: ジョブのハンドルは、どのスレッドから閉じても構わない
#[cfg(windows)]
unsafe impl Send for Job {}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: CreateJobObjectW で開いたハンドルで、閉じるのはここだけ
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
impl ProcessTree {
    fn new(child: &tokio::process::Child) -> Result<Self, String> {
        use windows::Win32::{Foundation::HANDLE, System::JobObjects::AssignProcessToJobObject};
        let process = child
            .raw_handle()
            .ok_or("the command exited before it could be tracked")?;
        // SAFETY: 名前も属性も渡さずにジョブを作る。ハンドルは Job が閉じる
        let job = Job(unsafe {
            windows::Win32::System::JobObjects::CreateJobObjectW(
                None,
                windows::core::PCWSTR::null(),
            )
        }
        .map_err(|error| format!("couldn't create a job object: {error}"))?);
        Self::set_kill_on_close(&job, true)?;
        // 起動してからここまでの間に cmd が起こしたプロセスは、ジョブの外に出る。cmd の起動に 30 ms ほどかかるのでまず起きないが、
        // 起動の時点でジョブに入れる手段（PROC_THREAD_ATTRIBUTE_JOB_LIST）は std・tokio の安定版にない
        // SAFETY: process は走っている子のハンドルで、この呼び出しの間は閉じられない
        unsafe { AssignProcessToJobObject(job.0, HANDLE(process)) }
            .map_err(|error| format!("couldn't assign the command to a job object: {error}"))?;
        Ok(Self(job))
    }

    fn set_kill_on_close(job: &Job, kill: bool) -> Result<(), String> {
        use windows::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = if kill {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        } else {
            JOB_OBJECT_LIMIT(0)
        };
        // SAFETY: info は関数の間だけ生きていればよく、大きさも合わせて渡す
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        }
        .map_err(|error| format!("couldn't set up the job object: {error}"))
    }

    /// ジョブを閉じて、中のプロセスをすべて止める
    fn kill(self) {}

    /// 閉じても止めないようにしてから閉じる。シェルが裏で起こしたプロセスを、終わった後まで止めない（macOS と揃える）
    fn release(self) {
        let _ = Self::set_kill_on_close(&self.0, false);
    }
}

/// コマンドを実行する。`input` は実行する文（前の空行と後ろの空白と改行を除いたもの）で、行の `{{t}}` と環境変数 `MAWOK_TEXT` にそのまま入れ、
/// 標準入力には改行を1つ足して `encoding` で書き、閉じる（空なら何も書かずに閉じる）。標準出力も `encoding` で読む。
/// 終了コードが 0 なら、標準出力から末尾の改行を落としたものを返す。`discard_output` なら標準出力を読み捨て、空の文を返す。
/// `folder` で動かす。`stopper` で外から止められる
pub async fn run(
    command: &str,
    input: &str,
    encoding: ActionEncoding,
    discard_output: bool,
    folder: &Path,
    stopper: Stopper,
) -> Result<String, ActionError> {
    // cmd は行の最初の改行より後ろを黙って捨て、1行目だけを実行して成功で終わるので、改行を含む行は実行する前に断る。
    // 貼り付けで前後に付いただけの空白の行は落とす
    #[cfg(windows)]
    let command = strip_blank_lines(command);
    #[cfg(windows)]
    if command.contains(['\n', '\r']) {
        return Err(ActionError::new(
            Failure::MultilineCommand,
            "the command line has a line break",
        ));
    }
    // 大きすぎる文や NUL を含む文は、環境変数にも引数にもできず、起動に失敗する。`{{t}}` の無い行なら、標準入力だけで渡す
    let has_mark = command.contains(TEXT_MARK);
    if has_mark && !embeddable(command, input) {
        return Err(ActionError::new(
            Failure::TextNotEmbeddable,
            format!("the text ({} bytes) can't be embedded", input.len()),
        ));
    }
    // 表せない文字があれば、起動する前に断る
    let stdin_bytes = if input.is_empty() {
        Vec::new()
    } else {
        encode_input(&format!("{input}\n"), encoding)?
    };
    let mut process = shell_command(&embed_text(command, input), has_mark);
    if env_passable(input) {
        process.env(TEXT_ENV, input);
    }
    #[cfg(windows)]
    if has_mark {
        process.env(QUOTED_TEXT_ENV, quote_windows_arg(input));
    }
    process
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(if discard_output {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = process.spawn().map_err(|error| {
        ActionError::new(
            Failure::CommandNotStarted,
            format!("couldn't start the shell: {error}"),
        )
    })?;
    let _stop_on_drop = StopOnDrop(stopper.clone());
    let tree = match ProcessTree::new(&child) {
        Ok(tree) => tree,
        Err(detail) => {
            // 止める手段がないまま走らせない
            let _ = child.start_kill();
            return Err(ActionError::new(Failure::CommandNotStarted, detail));
        }
    };
    if !stopper.started(tree) {
        return Err(ActionError::new(
            Failure::Unexpected,
            "stopped before start",
        ));
    }
    let stdout = child.stdout.take();
    let (Some(mut stdin), Some(stderr), true) = (
        child.stdin.take(),
        child.stderr.take(),
        stdout.is_some() || discard_output,
    ) else {
        return Err(ActionError::new(
            Failure::Unexpected,
            "the command's pipes weren't opened",
        ));
    };

    // 書き込みと標準エラーの読み取りは、標準出力と並べて進める。順に待つと、パイプが詰まってコマンドと待ち合う
    let writer = tokio::spawn(async move {
        // コマンドが標準入力を読まずに終わると書けないが、それは失敗にしない
        let _ = stdin.write_all(&stdin_bytes).await;
    });
    let stderr_kept = Arc::new(Mutex::new(Vec::new()));
    let mut stderr_reader = tokio::spawn(read_tail(stderr, stderr_kept.clone()));
    let (output, status) = match stdout {
        Some(stdout) => read_output(stdout, &mut child).await,
        None => (Ok(Vec::new()), None),
    };
    if matches!(output, Ok(ref bytes) if bytes.len() > MAX_OUTPUT) {
        stopper.stop();
    }
    let status = match status {
        Some(status) => status,
        None => child.wait().await,
    };
    stopper.finished();
    writer.abort();
    // 裏で動き続けるプロセスが標準エラーを開いたままだと読み終わらないので、シェルが終わったら長くは待たない
    // 読み終わらなければ、読んだところまでを使い、読み続けるタスクは残さない
    if tokio::time::timeout(OUTPUT_GRACE, &mut stderr_reader)
        .await
        .is_err()
    {
        stderr_reader.abort();
    }
    let stderr_tail = std::mem::take(&mut *stderr_kept.lock().unwrap());

    let output = output.map_err(|error| {
        ActionError::new(
            Failure::Unexpected,
            format!("couldn't read the output: {error}"),
        )
    })?;
    if output.len() > MAX_OUTPUT {
        return Err(ActionError::new(
            Failure::OutputTooLarge,
            format!("the output exceeded {MAX_OUTPUT} bytes"),
        ));
    }
    let status = status.map_err(|error| {
        ActionError::new(
            Failure::Unexpected,
            format!("couldn't wait for the command: {error}"),
        )
    })?;
    finish(
        status.code(),
        output,
        encoding,
        discard_output,
        &stderr_tail,
    )
}

/// 終了コードと出力から、結果か失敗を決める
fn finish(
    code: Option<i32>,
    output: Vec<u8>,
    encoding: ActionEncoding,
    discard_output: bool,
    stderr: &[u8],
) -> Result<String, ActionError> {
    match code {
        Some(0) => {}
        #[cfg(unix)]
        Some(NOT_FOUND_EXIT_CODE) => {
            return Err(failed(Failure::CommandNotFound, code, stderr));
        }
        _ => return Err(failed(Failure::CommandFailed, code, stderr)),
    }
    if discard_output {
        return Ok(String::new());
    }
    let text = decode_output(output, encoding).ok_or_else(|| {
        ActionError::new(
            Failure::OutputUndecodable,
            format!("the output isn't valid {}", encoding.name()),
        )
    })?;
    // 末尾の改行を落とす（シェルの $(...) と同じ）。コマンドが最後に付ける改行を下書きに残さないため
    // 改行は LF に揃える（Windows のコマンドの多くは CRLF で返す）
    let text = text.replace("\r\n", "\n");
    let text = text.trim_end_matches(['\n', '\r']);
    if text.is_empty() {
        return Err(ActionError::new(
            Failure::EmptyOutput,
            "the output was empty",
        ));
    }
    Ok(text.to_string())
}

fn failed(failure: Failure, code: Option<i32>, stderr: &[u8]) -> ActionError {
    let mut error = ActionError::new(failure, format!("exit code {code:?}"));
    error.exit_code = code;
    error.screen_detail = stderr_tail(stderr);
    error
}

/// 標準出力を、上限を1バイト超えるところまで読む。超えたかどうかは長さで見る。
/// シェルが終わったら、その終了状態も返し、そこから OUTPUT_GRACE だけ待って読み終わらなければ、読んだところまでで打ち切る。
/// 読み終えるまでにシェルが終わらなければ、終了状態は None
async fn read_output(
    mut stdout: impl tokio::io::AsyncRead + Unpin,
    child: &mut tokio::process::Child,
) -> (
    std::io::Result<Vec<u8>>,
    Option<std::io::Result<std::process::ExitStatus>>,
) {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    let mut status = None;
    let grace = tokio::time::sleep(std::time::Duration::MAX);
    tokio::pin!(grace);
    loop {
        tokio::select! {
            read = stdout.read(&mut buffer) => match read {
                Ok(0) => break,
                Ok(read) => {
                    output.extend_from_slice(&buffer[..read]);
                    if output.len() > MAX_OUTPUT {
                        break;
                    }
                }
                Err(error) => return (Err(error), status),
            },
            exited = child.wait(), if status.is_none() => {
                status = Some(exited);
                grace.as_mut().reset(tokio::time::Instant::now() + OUTPUT_GRACE);
            }
            () = &mut grace, if status.is_some() => break,
        }
    }
    (Ok(output), status)
}

/// 標準エラーを終わりまで読み、末尾の STDERR_KEEP バイトほどを `kept` に残す。読み終わらなくても、読んだところまでを使えるよう、読むたびに書く
async fn read_tail(mut stderr: impl tokio::io::AsyncRead + Unpin, kept: Arc<Mutex<Vec<u8>>>) {
    let mut buffer = [0; 8192];
    while let Ok(read @ 1..) = stderr.read(&mut buffer).await {
        let mut kept = kept.lock().unwrap();
        kept.extend_from_slice(&buffer[..read]);
        if kept.len() > STDERR_KEEP {
            // 行の途中から残すと、文字の途中で切れて読めなくなりうるので、次の改行の後から残す（改行が無ければそのまま切る）。末尾の数行しか使わない
            let cut = kept.len() - STDERR_KEEP;
            let cut = kept[cut..]
                .iter()
                .position(|&byte| byte == b'\n')
                .map_or(cut, |newline| cut + newline + 1);
            kept.drain(..cut);
        }
    }
}

/// アクションの文字コードにあたる encoding_rs の文字コード
fn encoding_rs_of(encoding: ActionEncoding) -> &'static encoding_rs::Encoding {
    match encoding {
        ActionEncoding::Utf8 => encoding_rs::UTF_8,
        ActionEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
        ActionEncoding::EucJp => encoding_rs::EUC_JP,
        ActionEncoding::Iso2022Jp => encoding_rs::ISO_2022_JP,
        ActionEncoding::Utf16Le => encoding_rs::UTF_16LE,
    }
}

/// JIS の文字コードで、Unicode の対応づけが cp932（Windows）と JIS で分かれる文字（いわゆる波ダッシュ問題）と、cp932 の側の文字。
/// encoding_rs（WHATWG）は cp932 の側に対応づけるので、JIS の側の文字（macOS や Web から来た文に多い）は表せない文字になる。
/// Windows の変換と同じく、cp932 の側に写してから書き出す
const JIS_TO_CP932: [(char, char); 7] = [
    ('\u{301C}', '\u{FF5E}'), // 〜 → ～
    ('\u{2016}', '\u{2225}'), // ‖ → ∥
    ('\u{2212}', '\u{FF0D}'), // − → －
    ('\u{2014}', '\u{2015}'), // — → ―
    ('\u{00A2}', '\u{FFE0}'), // ¢ → ￠
    ('\u{00A3}', '\u{FFE1}'), // £ → ￡
    ('\u{00AC}', '\u{FFE2}'), // ¬ → ￢
];

/// 標準入力に書く文を、アクションの文字コードのバイト列にする。表せない文字があれば失敗にする。
/// 置き換えて渡すと、化けた結果で下書きが置き換わり、終了コード 0 では気づけないため。
/// encoding_rs は、表せない文字の一部（¥ を `\`、半角カナを全角カナ、など）を黙って近い文字に書き出すので、読み戻して元の文と比べる
fn encode_input(text: &str, encoding: ActionEncoding) -> Result<Vec<u8>, ActionError> {
    let target = match encoding {
        ActionEncoding::Utf8 => return Ok(text.as_bytes().to_vec()),
        // encoding_rs は UTF-16 へは書き出さない（書き出す先が UTF-8 になる）ので、自前で並べる
        ActionEncoding::Utf16Le => {
            return Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect())
        }
        _ => encoding_rs_of(encoding),
    };
    let text: String = text
        .chars()
        .map(|c| {
            JIS_TO_CP932
                .iter()
                .find(|(jis, _)| *jis == c)
                .map_or(c, |&(_, cp932)| cp932)
        })
        .collect();
    let (bytes, _, unmappable) = target.encode(&text);
    let round_trips = !unmappable
        && target
            .decode_without_bom_handling_and_without_replacement(&bytes)
            .is_some_and(|decoded| decoded == text);
    if !round_trips {
        return Err(ActionError::new(
            Failure::TextNotEncodable,
            format!(
                "the text has characters that {} can't represent",
                encoding.name()
            ),
        ));
    }
    Ok(bytes.into_owned())
}

/// 標準出力を文字にする。UTF-8 のとき、Windows は UTF-8 として読めなければコンソールのコードページで読む。
/// cmd の組み込みコマンド（echo など）の出力はそちらで来るため。ほかの文字コードは、その文字コードとしてだけ読む
fn decode_output(output: Vec<u8>, encoding: ActionEncoding) -> Option<String> {
    if encoding != ActionEncoding::Utf8 {
        return encoding_rs_of(encoding)
            .decode_without_bom_handling_and_without_replacement(&output)
            .map(Cow::into_owned);
    }
    match String::from_utf8(output) {
        Ok(text) => Some(text),
        #[cfg(windows)]
        Err(error) => decode_console(error.as_bytes()),
        #[cfg(not(windows))]
        Err(_) => None,
    }
}

/// 標準エラーを文字にする。Windows の cmd や多くのコマンドのエラーは、UTF-8 ではなくコンソールのコードページ（日本語なら cp932）で来る
fn decode_stderr(stderr: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(stderr) {
        return text.to_string();
    }
    #[cfg(windows)]
    if let Some(text) = decode_console(stderr) {
        return text;
    }
    String::from_utf8_lossy(stderr).into_owned()
}

/// コンソールのコードページ（CP_OEMCP）のバイトを文字にする。そのコードページで読めないバイトがあれば None
#[cfg(windows)]
fn decode_console(bytes: &[u8]) -> Option<String> {
    use windows::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP, MB_ERR_INVALID_CHARS};
    // SAFETY: 渡すのは読み書きできるスライスだけ。1回目で長さを測り、2回目でその長さの領域に書かせる
    let length = unsafe { MultiByteToWideChar(CP_OEMCP, MB_ERR_INVALID_CHARS, bytes, None) };
    let length = usize::try_from(length).ok().filter(|&length| length > 0)?;
    let mut wide = vec![0u16; length];
    let written =
        unsafe { MultiByteToWideChar(CP_OEMCP, MB_ERR_INVALID_CHARS, bytes, Some(&mut wide)) };
    let written = usize::try_from(written)
        .ok()
        .filter(|&written| written > 0)?;
    wide.truncate(written);
    Some(String::from_utf16_lossy(&wide))
}

/// 標準エラーの末尾の、空でない数行。なければ None
fn stderr_tail(stderr: &[u8]) -> Option<String> {
    let text = decode_stderr(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(STDERR_TAIL_LINES)..].join("\n");
    (!tail.is_empty()).then_some(tail)
}

// 試すコマンドは macOS のシェルのもの
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn run_now(command: &str, input: &str) -> Result<String, ActionError> {
        run_with(command, input, false)
    }

    fn run_with(command: &str, input: &str, discard_output: bool) -> Result<String, ActionError> {
        run_in(command, input, ActionEncoding::Utf8, discard_output)
    }

    fn run_in(
        command: &str,
        input: &str,
        encoding: ActionEncoding,
        discard_output: bool,
    ) -> Result<String, ActionError> {
        tauri::async_runtime::block_on(run(
            command,
            input,
            encoding,
            discard_output,
            &std::env::temp_dir(),
            Stopper::default(),
        ))
    }

    #[test]
    fn embeds_the_text_as_one_argument() {
        assert_eq!(
            run_now("printf '[%s]' {{t}} {{t}}", "a b; echo 'x'\n$HOME").unwrap(),
            "[a b; echo 'x'\n$HOME][a b; echo 'x'\n$HOME]"
        );
        assert_eq!(run_now("printf '[%s]' {{t}}", "").unwrap(), "[]");
        assert_eq!(
            run_now("printf '%s' \"$MAWOK_TEXT\"", "あ\nい").unwrap(),
            "あ\nい"
        );
    }

    #[test]
    fn quotes_the_text_for_windows_arguments() {
        assert_eq!(quote_windows_arg(r#"say "hi"#), r#"say \"hi"#);
        assert_eq!(quote_windows_arg(r"C:\dir\"), r"C:\dir\\");
        assert_eq!(quote_windows_arg(r#"a\"b"#), r#"a\\\"b"#);
        assert_eq!(quote_windows_arg(r"a\b"), r"a\b");
    }

    #[test]
    fn strips_only_blank_lines_around_the_command() {
        assert_eq!(strip_blank_lines("sort\r\n"), "sort");
        assert_eq!(strip_blank_lines("echo hi\n "), "echo hi");
        assert_eq!(strip_blank_lines("echo hi\r\n\t"), "echo hi");
        assert_eq!(strip_blank_lines("  \r\necho hi"), "echo hi");
        assert_eq!(strip_blank_lines(" echo a "), " echo a ");
        assert_eq!(strip_blank_lines("\n echo a \n"), " echo a ");
        assert_eq!(
            strip_blank_lines("echo one\necho two\n"),
            "echo one\necho two"
        );
    }

    #[test]
    fn passes_text_too_large_to_embed_on_stdin_only() {
        let large = "a".repeat(MAX_ENV_TEXT + 1);
        assert_eq!(
            run_now(
                "wc -c | tr -d ' '; printf '%s' \"${MAWOK_TEXT:-none}\"",
                &large
            )
            .unwrap(),
            format!("{}\nnone", MAX_ENV_TEXT + 2)
        );
        assert_eq!(
            run_now("printf '%s' {{t}}", &large).unwrap_err().failure,
            Failure::TextNotEmbeddable
        );
        // 環境変数には入る大きさでも、埋め込んだ行と合わせて上限を超えれば埋め込まない（`'` は埋め込むと4バイトになる）
        let quotes = "'".repeat(MAX_ENV_TEXT);
        assert!(env_passable(&quotes));
        assert_eq!(
            run_now("printf '%s' {{t}}", &quotes).unwrap_err().failure,
            Failure::TextNotEmbeddable
        );
        let text = "a".repeat(MAX_ENV_TEXT);
        assert_eq!(
            run_now("printf '%s' {{t}} | wc -c | tr -d ' '", &text).unwrap(),
            MAX_ENV_TEXT.to_string()
        );
        assert_eq!(run_now("cat", "a\0b").unwrap(), "a\0b");
    }

    #[test]
    fn writes_nothing_on_stdin_when_the_text_is_empty() {
        assert_eq!(run_now("wc -c | tr -d ' '", "").unwrap(), "0");
    }

    #[test]
    fn discards_the_output_when_asked() {
        assert_eq!(run_with("cat >/dev/null", "x", true).unwrap(), "");
        assert_eq!(run_with("printf '\\377'", "x", true).unwrap(), "");
        assert_eq!(run_with("yes | head -c 2000000", "", true).unwrap(), "");
        assert_eq!(
            run_with("exit 2", "x", true).unwrap_err().failure,
            Failure::CommandFailed
        );
    }

    #[test]
    fn passes_the_text_on_stdin_and_drops_trailing_newlines() {
        assert_eq!(run_now("cat", "あいう\nえお").unwrap(), "あいう\nえお");
        assert_eq!(run_now("sort", "b\na").unwrap(), "a\nb");
        // 標準入力の末尾に改行を足すので、行を数えるコマンドも最後の行を数える
        assert_eq!(run_now("wc -l | tr -d ' '", "a\nb").unwrap(), "2");
        assert_eq!(run_now("printf 'x\\r\\n\\n\\n'", "").unwrap(), "x");
        // 改行は LF に揃える
        assert_eq!(run_now("printf 'a\\r\\nb'", "").unwrap(), "a\nb");
    }

    #[test]
    fn runs_through_the_shell() {
        assert_eq!(run_now("tr a-z A-Z | rev", "abc").unwrap(), "CBA");
        assert_eq!(
            run_now("pwd", "").unwrap(),
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .trim_end_matches('/')
        );
    }

    #[test]
    fn treats_a_non_zero_exit_as_a_failure_with_the_stderr_tail() {
        let error = run_now(
            "cat >/dev/null; for i in 1 2 3 4 5 6; do echo line$i >&2; done; exit 3",
            "x",
        )
        .unwrap_err();
        assert_eq!(error.failure, Failure::CommandFailed);
        assert_eq!(error.exit_code, Some(3));
        assert_eq!(
            error.screen_detail.as_deref(),
            Some("line2\nline3\nline4\nline5\nline6")
        );
        // ログに残す中身には、標準エラーを入れない
        assert!(!error.detail.contains("line"));
    }

    #[test]
    fn tells_a_missing_command_apart() {
        let error = run_now("mawok-no-such-command", "x").unwrap_err();
        assert_eq!(error.failure, Failure::CommandNotFound);
        assert_eq!(error.exit_code, Some(NOT_FOUND_EXIT_CODE));
    }

    #[test]
    fn treats_empty_or_unreadable_output_as_a_failure() {
        assert_eq!(
            run_now("cat >/dev/null", "x").unwrap_err().failure,
            Failure::EmptyOutput
        );
        assert_eq!(
            run_now("printf '\\n\\n'", "x").unwrap_err().failure,
            Failure::EmptyOutput
        );
        assert_eq!(
            run_now("printf '\\377'", "x").unwrap_err().failure,
            Failure::OutputUndecodable
        );
    }

    #[test]
    fn writes_and_reads_the_standard_streams_in_the_action_encoding() {
        let bytes = |input: &str, encoding| {
            run_in("od -An -tx1 | tr -d ' \\n'", input, encoding, false).unwrap()
        };
        assert_eq!(bytes("あ", ActionEncoding::ShiftJis), "82a00a");
        assert_eq!(bytes("あ", ActionEncoding::EucJp), "a4a20a");
        assert_eq!(bytes("あ", ActionEncoding::Iso2022Jp), "1b244224221b28420a");
        // UTF-16 は出力も UTF-16 として読むので、od の出力では見られない
        assert_eq!(
            encode_input("あ\n", ActionEncoding::Utf16Le).unwrap(),
            [0x42, 0x30, 0x0a, 0x00]
        );
        assert_eq!(bytes("あ", ActionEncoding::Utf8), "e381820a");
        for encoding in [
            ActionEncoding::ShiftJis,
            ActionEncoding::EucJp,
            ActionEncoding::Iso2022Jp,
            ActionEncoding::Utf16Le,
        ] {
            assert_eq!(
                run_in("cat", "りんご\n漢字 abc", encoding, false).unwrap(),
                "りんご\n漢字 abc"
            );
        }
        // 半角カナは Shift_JIS と EUC-JP では表せる
        assert_eq!(
            run_in("cat", "ｱｲｳ", ActionEncoding::ShiftJis, false).unwrap(),
            "ｱｲｳ"
        );
        // JIS と cp932 で対応づけが分かれる文字（波ダッシュなど）は、cp932 の側の文字に写して渡す
        for encoding in [
            ActionEncoding::ShiftJis,
            ActionEncoding::EucJp,
            ActionEncoding::Iso2022Jp,
        ] {
            assert_eq!(
                run_in("cat", "1〜2‖−—¢£¬", encoding, false).unwrap(),
                "1～2∥－―￠￡￢"
            );
        }
        // `{{t}}` と `MAWOK_TEXT` は OS の文字列のまま（UTF-8）
        assert_eq!(
            run_in(
                "printf '%s' \"$MAWOK_TEXT\" {{t}} | od -An -tx1 | tr -d ' \\n'",
                "あ",
                ActionEncoding::ShiftJis,
                false
            )
            .unwrap(),
            "e38182e38182"
        );
    }

    #[test]
    fn refuses_text_or_output_the_action_encoding_cannot_handle() {
        // 表せない文字は、起動する前に断る（起動していたら、ファイルができている）
        let marker =
            std::env::temp_dir().join(format!("mawok-not-encodable-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let command = format!("touch '{}'; cat", marker.display());
        assert_eq!(
            run_in(&command, "😀", ActionEncoding::ShiftJis, false)
                .unwrap_err()
                .failure,
            Failure::TextNotEncodable
        );
        assert!(!marker.exists());
        // 黙って近い文字に書き出される文字も断る（¥ は `\`、半角カナは ISO-2022-JP で全角カナになる）
        for (text, encoding) in [
            ("¥1,000", ActionEncoding::ShiftJis),
            ("¥1,000", ActionEncoding::EucJp),
            ("ｱｲｳ", ActionEncoding::Iso2022Jp),
        ] {
            assert_eq!(
                encode_input(text, encoding).unwrap_err().failure,
                Failure::TextNotEncodable,
                "{text}"
            );
        }
        // その文字コードとして読めない出力（Shift_JIS の2バイト目が欠けたもの）
        assert_eq!(
            run_in("printf '\\202'", "", ActionEncoding::ShiftJis, false)
                .unwrap_err()
                .failure,
            Failure::OutputUndecodable
        );
    }

    #[test]
    fn does_not_wait_for_background_processes_holding_the_output() {
        let started = std::time::Instant::now();
        assert_eq!(run_now("(sleep 5 &); echo done", "").unwrap(), "done");
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[test]
    fn stops_a_command_that_keeps_writing() {
        let error = run_now("yes", "").unwrap_err();
        assert_eq!(error.failure, Failure::OutputTooLarge);
    }

    #[test]
    fn stopping_kills_the_whole_process_group() {
        let marker = std::env::temp_dir().join(format!("mawok-stop-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let stopper = Stopper::default();
        let command = format!("(sleep 1; touch '{}') & sleep 30", marker.display());
        let running = {
            let stopper = stopper.clone();
            tauri::async_runtime::spawn(async move {
                run(
                    &command,
                    "",
                    ActionEncoding::Utf8,
                    false,
                    &std::env::temp_dir(),
                    stopper,
                )
                .await
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(300));
        stopper.stop();
        let result = tauri::async_runtime::block_on(running).unwrap();
        assert_eq!(result.unwrap_err().failure, Failure::CommandFailed);
        // 裏で動かした子プロセスも止まっているので、印のファイルは作られない
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(!marker.exists());
    }

    #[test]
    fn stopping_before_start_does_not_run_the_command() {
        let stopper = Stopper::default();
        stopper.stop();
        let error = tauri::async_runtime::block_on(run(
            "echo x",
            "",
            ActionEncoding::Utf8,
            false,
            &std::env::temp_dir(),
            stopper,
        ))
        .unwrap_err();
        assert_eq!(error.failure, Failure::Unexpected);
    }
}
