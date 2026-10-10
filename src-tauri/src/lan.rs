//! 同じ LAN の同じアカウントの機器へ、下書きを送る（docs/lan.md「同じ LAN の自分の機器へ送る」）。
//! 相手は UDP のブロードキャストの名乗りで見つける。mDNS は、無線の端末どうしのマルチキャストを中継しないアクセスポイントで届かないため使わない。
//! ペアリングは、片方に出す 6 桁のコードから SPAKE2 で鍵を作り、それを事前共有鍵にした Noise の XXpsk2 でアカウントの鍵を渡す。
//! コードをそのまま鍵にしないのは、やり取りを盗み見た相手に総当たりで当てられるため。
//! 送るのはアカウントの鍵から導いた事前共有鍵を使う Noise の IKpsk1 で、同じ鍵の相手とだけつながる。

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use log::{info, warn};
use snow::{Builder, HandshakeState, TransportState};
use spake2::{Ed25519Group, Identity, Password, Spake2};

use crate::{atomic_file, APP_NAME};

/// この機器の鍵を置くファイルの名前（設定ファイルと同じフォルダー）。設定ファイルは人に見せることがあるので分ける
pub const KEY_FILE_NAME: &str = "device-key";
/// 下書きと組み合わせのやり取りを受ける TCP のポート。アドレスを手で入れる道を後で足すときに、ポートまで入れさせないよう固定する
const TCP_PORT: u16 = 47626;
/// 名乗りを送り合う UDP のポート
const UDP_PORT: u16 = 47625;
/// 名乗りの先頭の印。形を変えたら数字を上げる
const HELLO: &str = "mawok3";
/// 名乗りの間隔。コードを出している間は、相手がすぐ見つけられるよう短くする
const HELLO_INTERVAL: Duration = Duration::from_secs(3);
const OFFER_HELLO_INTERVAL: Duration = Duration::from_secs(1);
/// 止めるように言われたかを見る間隔
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// コードを出してから使えなくなるまで
const OFFER_TTL: Duration = Duration::from_secs(120);
/// UDP の名乗りは誰でも偽れるので、同じ公開鍵への接続を何度も試さない時間を置く。
const REJECTED_DISCOVERY_TTL: Duration = Duration::from_secs(10 * 60);

/// コードが使えなくなるまでの残り秒。画面の表示用で、切り上げる（出した直後に 120 と出すため）
fn offer_remaining_seconds(expires: Instant) -> u64 {
    let remaining = expires.saturating_duration_since(Instant::now());
    remaining.as_millis().div_ceil(1000) as u64
}

fn hello_interval(offering: bool, wants_pairing: bool) -> Duration {
    if offering || wants_pairing {
        OFFER_HELLO_INTERVAL
    } else {
        HELLO_INTERVAL
    }
}

/// コードを入れてから、コードを出している相手の名乗りを待つ時間。
/// 初めて待ち受けるときに出る OS の許可のダイアログ（Windows のファイアウォール、macOS のローカルネットワーク）を押す間に切れないよう、長めにとる
const JOIN_WAIT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// 1回に送れる下書きの大きさ（UTF-8 のバイト数）
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const PAIR_PATTERN: &str = "Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s";
// ADR: 事前共有鍵は1通目に混ぜる（psk1）。psk2 だと、受ける側は握手を終えても、相手が鍵を持つかを
// 最初の本文を読むまで確かめられず、鍵を持たない相手を機器の一覧に足してしまう
const SEND_PATTERN: &str = "Noise_IKpsk1_25519_ChaChaPoly_BLAKE2s";
const SPAKE2_IDENTITY: &[u8] = b"mawok pairing v1";
/// Noise の1通の上限と、暗号化で付く認証タグの長さ
const NOISE_MAX: usize = 65535;
const TAG_LEN: usize = 16;
/// つないだ直後の1バイトで、何をしに来たかを伝える
const KIND_PAIR: u8 = 1;
const KIND_SEND: u8 = 2;
/// 生存確認。握手だけして切る
const KIND_PING: u8 = 3;
/// 受け取った側が、最後まで受け取れたことを返す印
const ACK: &[u8] = b"ok";
/// 本文の前に、同じ Pro のアカウントかを確かめ終えたことを返す。
const READY: &[u8] = b"ready";
const REJECT_PRO_REQUIRED: &[u8] = b"pro_required";
const REJECT_ACCOUNT_MISMATCH: &[u8] = b"account_mismatch";
const REJECT_KEY_MISMATCH: &[u8] = b"key_mismatch";
pub const ACCOUNT_TAG_LEN: usize = 32;

type Result<T> = std::result::Result<T, String>;

/// 組み合わせと送信の失敗の種類。画面は符号から、何をすればよいかの案内を出す（src/lib/lan-errors.ts）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 同じアカウントで見つけた機器がない
    NoDevice,
    /// 見つけた機器はあるが、送信先に選んだ機器がない
    NoTarget,
    /// 相手とつながらない（場所が分からない、つなげない、コードを出している相手が見つからない）。
    /// 原因はネットワークや OS しだいで、どれでも確かめる所は同じなので分けない
    Unreachable,
    /// つながったが、相手が受け取らなかった
    Refused,
    /// この機器で Pro を使えない
    ProRequired,
    /// Pro だが、まだアカウントの鍵を受け取っていない
    NeedsPairing,
    /// 相手の機器で Pro を使えない
    ReceiverProRequired,
    /// 相手が別の Mawok アカウントに結ばれている
    AccountMismatch,
    /// 受け取ったアカウントの鍵が、窓口が覚えている鍵と違う
    KeyMismatch,
    TooLong,
    /// 入れたコードが6桁の数字でない
    BadCode,
    /// コードが違うか、もう使えない
    WrongCode,
    /// 待ち受けを始められない、鍵が読めないなど、OS やファイルから返ったエラー。原因は追いかけず、ログに残す
    Internal,
}

impl Failure {
    /// 画面に渡す符号。src/lib/lan-errors.ts の MESSAGES と揃える
    pub fn code(self) -> &'static str {
        match self {
            Self::NoDevice => "lan.no_device",
            Self::NoTarget => "lan.no_target",
            Self::Unreachable => "lan.unreachable",
            Self::Refused => "lan.refused",
            Self::ProRequired => "lan.pro_required",
            Self::NeedsPairing => "lan.needs_pairing",
            Self::ReceiverProRequired => "lan.receiver_pro_required",
            Self::AccountMismatch => "lan.account_mismatch",
            Self::KeyMismatch => "lan.key_mismatch",
            Self::TooLong => "lan.too_long",
            Self::BadCode => "lan.bad_code",
            Self::WrongCode => "lan.wrong_code",
            Self::Internal => "lan.internal",
        }
    }
}

/// 失敗の種類と、ログに残す詳しい中身
#[derive(Debug)]
pub struct LanError {
    pub failure: Failure,
    pub detail: String,
}

impl LanError {
    fn new(failure: Failure, detail: &str) -> Self {
        Self {
            failure,
            detail: detail.to_string(),
        }
    }
}

/// 中の処理の失敗（詳しい中身の文字列）に、種類を付ける
trait FailAs<T> {
    fn fail_as(self, failure: Failure) -> std::result::Result<T, LanError>;
}

impl<T> FailAs<T> for Result<T> {
    fn fail_as(self, failure: Failure) -> std::result::Result<T, LanError> {
        self.map_err(|detail| LanError { failure, detail })
    }
}

/// この機器の鍵。秘密鍵をログに出さないよう、Debug は付けない
#[derive(Clone)]
pub struct DeviceKey {
    private: Vec<u8>,
    public: Vec<u8>,
}

/// 組み合わせで分かった相手
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    /// 相手が名乗った名前
    pub name: String,
    pub public_key: Vec<u8>,
}

/// 動いているアプリの側に任せること（設定ファイルと画面）
pub trait Host: Send + Sync + 'static {
    /// 出していたコードが使われて、もう使えなくなった（組み合わせの成否は問わない）
    fn on_pairing_code_ended(&self);
    /// 自動でコードを出した。設定画面は、取り逃がしたときだけ pairing_offer を読み直す。
    fn on_pairing_code_offered(&self, code: String, remaining_seconds: u64, automatic: bool);
    /// 同じアカウントの機器から下書きが届いた。受け入れたら true。
    fn on_received(&self, from: &[u8], text: String) -> bool;
    /// この機器で使える Pro のアカウントの印。無ければ、相手の下書きは受け取らない。
    fn pro_account_tag(&self) -> Option<[u8; ACCOUNT_TAG_LEN]>;
    /// 資格情報管理にあるアカウントの鍵。Pro が失効していても、相手へ pro_required を返すために読む。
    fn account_key(&self) -> Option<[u8; 32]>;
    /// 窓口から読んだ鍵の見分け。鍵を受け取る側だけが照らす。
    fn account_key_id(&self) -> Option<String>;
    /// ペアリングで受け取った鍵を置く。置けたときだけ ACK を返す。
    fn receive_account_key(&self, key: [u8; 32]) -> bool;
    /// 同じアカウントの機器を見つけた。
    fn on_device_found(&self, peer: Peer, address: IpAddr) -> bool;
    /// 握手が通った機器の場所。名前が分からない場合も、既存の一覧の場所は直せる。
    fn on_device_address_seen(&self, public_key: &[u8], address: IpAddr);
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok())
        .collect()
}

/// 組み合わせるときに相手へ名乗り、Mawok のアカウントと結ぶときに窓口へ送る、この機器の名前。コンピューター名を使い、取れなければ Mawok。
/// macOS の `hostname` はローカルホスト名で、同じ名前の機器が LAN にいると見なされると macOS が番号を付け替える
/// （`my-mac` が `my-mac-2` になる）ので使わず、利用者が付けたコンピューター名を読む
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    let name = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    #[cfg(not(target_os = "macos"))]
    let name = std::env::var("COMPUTERNAME").ok();
    name.map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| APP_NAME.to_string())
}

fn generate_key() -> Result<DeviceKey> {
    let params = SEND_PATTERN.parse().map_err(|error| format!("{error:?}"))?;
    let keypair = Builder::new(params)
        .generate_keypair()
        .map_err(|error| format!("generate key: {error}"))?;
    Ok(DeviceKey {
        private: keypair.private,
        public: keypair.public,
    })
}

/// この機器の鍵を読む。まだないか、中身が壊れていれば作って書き出す。作り直すと、次の名乗りでほかの機器から見つけ直される
fn load_or_create_key(path: &Path) -> Result<DeviceKey> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let mut lines = text.lines();
            if let (Some(private), Some(public)) = (
                lines.next().and_then(from_hex),
                lines.next().and_then(from_hex),
            ) {
                if private.len() == 32 && public.len() == 32 {
                    return Ok(DeviceKey { private, public });
                }
            }
            warn!("lan: the device key is broken, making a new one");
        }
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            warn!("lan: the device key is broken, making a new one");
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        // ほかのプロセスが開いているなど、一時的に読めないだけかもしれない。作り直すと組み合わせが切れるので、作らない
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    }
    let key = generate_key()?;
    let contents = format!("{}\n{}\n", to_hex(&key.private), to_hex(&key.public));
    // 秘密鍵なので、ほかのユーザーが読めないように書く
    atomic_file::write_private(path, contents.as_bytes())
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    Ok(key)
}

/// 6 桁のコード。OS の乱数から作る
fn new_code() -> Result<String> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|error| format!("random: {error}"))?;
    Ok(format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000))
}

fn write_frame(stream: &mut impl Write, bytes: &[u8]) -> Result<()> {
    let length = u16::try_from(bytes.len()).map_err(|_| "frame too long".to_string())?;
    stream
        .write_all(&length.to_be_bytes())
        .and_then(|()| stream.write_all(bytes))
        .map_err(|error| format!("write: {error}"))
}

fn read_frame(stream: &mut impl Read) -> Result<Vec<u8>> {
    let mut length = [0u8; 2];
    stream
        .read_exact(&mut length)
        .map_err(|error| format!("read: {error}"))?;
    let mut bytes = vec![0; usize::from(u16::from_be_bytes(length))];
    stream
        .read_exact(&mut bytes)
        .map_err(|error| format!("read: {error}"))?;
    Ok(bytes)
}

fn handshake_write(
    noise: &mut HandshakeState,
    payload: &[u8],
    stream: &mut impl Write,
) -> Result<()> {
    let mut message = vec![0; NOISE_MAX];
    let length = noise
        .write_message(payload, &mut message)
        .map_err(|error| format!("handshake: {error}"))?;
    write_frame(stream, &message[..length])
}

fn handshake_read(noise: &mut HandshakeState, stream: &mut impl Read) -> Result<Vec<u8>> {
    let message = read_frame(stream)?;
    let mut payload = vec![0; NOISE_MAX];
    let length = noise
        .read_message(&message, &mut payload)
        .map_err(|error| format!("handshake: {error}"))?;
    payload.truncate(length);
    Ok(payload)
}

fn transport_write(
    noise: &mut TransportState,
    payload: &[u8],
    stream: &mut impl Write,
) -> Result<()> {
    let mut message = vec![0; NOISE_MAX];
    let length = noise
        .write_message(payload, &mut message)
        .map_err(|error| format!("encrypt: {error}"))?;
    write_frame(stream, &message[..length])
}

fn transport_read(noise: &mut TransportState, stream: &mut impl Read) -> Result<Vec<u8>> {
    let message = read_frame(stream)?;
    let mut payload = vec![0; NOISE_MAX];
    let length = noise
        .read_message(&message, &mut payload)
        .map_err(|error| format!("decrypt: {error}"))?;
    payload.truncate(length);
    Ok(payload)
}

fn builder(pattern: &str) -> Result<Builder<'static>> {
    Ok(Builder::new(
        pattern.parse().map_err(|error| format!("{error:?}"))?,
    ))
}

/// コードから、両側で同じになる 32 バイトの鍵を作る。コードが違えば、違う鍵になる（ここでは食い違いに気づかず、次の Noise で失敗する）
fn spake2_key(stream: &mut (impl Read + Write), code: &str) -> Result<[u8; 32]> {
    let (spake, outbound) = Spake2::<Ed25519Group>::start_symmetric(
        &Password::new(code.as_bytes()),
        &Identity::new(SPAKE2_IDENTITY),
    );
    write_frame(stream, &outbound)?;
    let inbound = read_frame(stream)?;
    let key = spake
        .finish(&inbound)
        .map_err(|error| format!("spake2: {error:?}"))?;
    key.try_into()
        .map_err(|_| "spake2: unexpected key length".to_string())
}

fn remote_peer(noise: &HandshakeState, name: &[u8]) -> Result<Peer> {
    let public_key = noise
        .get_remote_static()
        .ok_or("handshake: no remote key")?
        .to_vec();
    Ok(Peer {
        name: String::from_utf8_lossy(name).into_owned(),
        public_key,
    })
}

fn remote_peer_name(public_key: &[u8], name: &[u8]) -> Peer {
    Peer {
        name: String::from_utf8_lossy(name).into_owned(),
        public_key: public_key.to_vec(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Hello {
    Device(Vec<u8>),
    Offer(Vec<u8>),
    Want(Vec<u8>, [u8; ACCOUNT_TAG_LEN]),
}

fn read_hello(datagram: &[u8]) -> Option<Hello> {
    let text = std::str::from_utf8(datagram).ok()?;
    let mut parts = text.split_whitespace();
    if parts.next()? != HELLO {
        return None;
    }
    match parts.next()? {
        "hello" => {
            let key = from_hex(parts.next()?)?;
            (key.len() == 32 && parts.next().is_none()).then_some(Hello::Device(key))
        }
        "pair" => {
            let key = from_hex(parts.next()?)?;
            (key.len() == 32 && parts.next().is_none()).then_some(Hello::Offer(key))
        }
        "want" => {
            let key = from_hex(parts.next()?)?;
            if key.len() != 32 {
                return None;
            }
            let tag: [u8; ACCOUNT_TAG_LEN] = from_hex(parts.next()?)?.try_into().ok()?;
            parts.next().is_none().then_some(Hello::Want(key, tag))
        }
        _ => None,
    }
}

fn hello_message(kind: &Hello) -> String {
    match kind {
        Hello::Device(key) => format!("{HELLO} hello {}", to_hex(key)),
        Hello::Offer(key) => format!("{HELLO} pair {}", to_hex(key)),
        Hello::Want(key, tag) => format!("{HELLO} want {} {}", to_hex(key), to_hex(tag)),
    }
}

/// コードを出した側の組み合わせ
fn pair_as_offerer(
    stream: &mut (impl Read + Write),
    code: &str,
    key: &DeviceKey,
    name: &str,
    account_tag: &[u8; ACCOUNT_TAG_LEN],
    account_key: &[u8; 32],
) -> Result<Peer> {
    let psk = spake2_key(stream, code)?;
    let mut noise = builder(PAIR_PATTERN)?
        .local_private_key(&key.private)
        .and_then(|builder| builder.psk(2, &psk))
        .and_then(Builder::build_responder)
        .map_err(|error| format!("handshake: {error}"))?;
    handshake_read(&mut noise, stream)?;
    handshake_write(&mut noise, name.as_bytes(), stream)?;
    let remote_name = handshake_read(&mut noise, stream)?;
    let peer = remote_peer(&noise, &remote_name)?;
    let mut transport = noise
        .into_transport_mode()
        .map_err(|error| format!("handshake: {error}"))?;
    transport_write(&mut transport, account_tag, stream)?;
    match transport_read(&mut transport, stream)?.as_slice() {
        READY => {}
        REJECT_PRO_REQUIRED => return Err("the joining device is not Pro".to_string()),
        REJECT_ACCOUNT_MISMATCH => return Err("the devices use different accounts".to_string()),
        _ => return Err("the joining device refused".to_string()),
    }
    transport_write(&mut transport, account_key, stream)?;
    if transport_read(&mut transport, stream)? != ACK {
        return Err("the joining device did not store the account key".to_string());
    }
    Ok(peer)
}

/// コードを入れた側の組み合わせ
fn pair_as_joiner(
    stream: &mut (impl Read + Write),
    code: &str,
    key: &DeviceKey,
    name: &str,
    account_tag: &[u8; ACCOUNT_TAG_LEN],
    expected_key_id: Option<&str>,
    accept_key: impl FnOnce([u8; 32]) -> bool,
) -> Result<Peer> {
    let psk = spake2_key(stream, code)?;
    let mut noise = builder(PAIR_PATTERN)?
        .local_private_key(&key.private)
        .and_then(|builder| builder.psk(2, &psk))
        .and_then(Builder::build_initiator)
        .map_err(|error| format!("handshake: {error}"))?;
    handshake_write(&mut noise, &[], stream)?;
    let remote_name = handshake_read(&mut noise, stream)?;
    handshake_write(&mut noise, name.as_bytes(), stream)?;
    let peer = remote_peer(&noise, &remote_name)?;
    let mut transport = noise
        .into_transport_mode()
        .map_err(|error| format!("handshake: {error}"))?;
    let remote_tag = transport_read(&mut transport, stream)?;
    if remote_tag.as_slice() != account_tag {
        transport_write(&mut transport, REJECT_ACCOUNT_MISMATCH, stream)?;
        return Err("the devices use different accounts".to_string());
    }
    transport_write(&mut transport, READY, stream)?;
    let received = transport_read(&mut transport, stream)?;
    let key: [u8; 32] = received
        .try_into()
        .map_err(|_| "the account key has the wrong length".to_string())?;
    if expected_key_id.is_some_and(|id| crate::account_key::key_id(&key) != id) {
        transport_write(&mut transport, REJECT_KEY_MISMATCH, stream)?;
        return Err("the account key does not match the account server".to_string());
    }
    if !accept_key(key) {
        return Err("couldn't store the account key".to_string());
    }
    transport_write(&mut transport, ACK, stream)?;
    Ok(peer)
}

/// 送る側の握手。共通のアカウントの鍵を持つ相手だけが通る。
fn handshake_as_sender(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    remote_public: &[u8],
    psk: &[u8; 32],
) -> Result<TransportState> {
    let mut noise = builder(SEND_PATTERN)?
        .local_private_key(&key.private)
        .and_then(|builder| builder.remote_public_key(remote_public))
        .and_then(|builder| builder.psk(1, psk))
        .and_then(Builder::build_initiator)
        .map_err(|error| format!("handshake: {error}"))?;
    handshake_write(&mut noise, &[], stream)?;
    handshake_read(&mut noise, stream)?;
    noise
        .into_transport_mode()
        .map_err(|error| format!("handshake: {error}"))
}

/// 受ける側の握手。公開鍵をまだ覚えていなくても、共通の鍵を持つ相手なら通す。
fn handshake_as_receiver(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    psk: &[u8; 32],
) -> Result<(TransportState, Vec<u8>)> {
    let mut noise = builder(SEND_PATTERN)?
        .local_private_key(&key.private)
        .and_then(|builder| builder.psk(1, psk))
        .and_then(Builder::build_responder)
        .map_err(|error| format!("handshake: {error}"))?;
    handshake_read(&mut noise, stream)?;
    let remote = noise
        .get_remote_static()
        .ok_or("handshake: no remote key")?
        .to_vec();
    handshake_write(&mut noise, &[], stream)?;
    let transport = noise
        .into_transport_mode()
        .map_err(|error| format!("handshake: {error}"))?;
    Ok((transport, remote))
}

/// 下書きを送る。相手が最後まで受け取ったと返すまで待つ
fn send_text(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    remote_public: &[u8],
    psk: &[u8; 32],
    text: &str,
) -> std::result::Result<(), LanError> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(LanError::new(
            Failure::TooLong,
            "the draft is too long to send",
        ));
    }
    let mut transport =
        handshake_as_sender(stream, key, remote_public, psk).fail_as(Failure::Refused)?;
    match transport_read(&mut transport, stream)
        .fail_as(Failure::Refused)?
        .as_slice()
    {
        READY => {}
        REJECT_PRO_REQUIRED => {
            return Err(LanError::new(
                Failure::ReceiverProRequired,
                "the receiving device is not Pro",
            ))
        }
        _ => {
            return Err(LanError::new(
                Failure::Refused,
                "the receiving device refused",
            ))
        }
    }
    // 1通に入りきらない分は分けて送り、空の1通で終わりを伝える
    for chunk in text.as_bytes().chunks(NOISE_MAX - TAG_LEN) {
        transport_write(&mut transport, chunk, stream).fail_as(Failure::Refused)?;
    }
    transport_write(&mut transport, &[], stream).fail_as(Failure::Refused)?;
    if transport_read(&mut transport, stream).fail_as(Failure::Refused)? != ACK {
        return Err(LanError::new(Failure::Refused, "unexpected reply"));
    }
    Ok(())
}

/// 下書きを受け取る。握手を通った同じアカウントの機器からだけ、中身を受け取る。
/// 受け取り終えたら `deliver` に渡し、受け入れられた（true）ときだけ相手に受け取れたと返す。送ってきた相手の公開鍵を返す
fn receive_text(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    psk: &[u8; 32],
    pro_available: bool,
    deliver: impl FnOnce(&[u8], String) -> bool,
) -> Result<Vec<u8>> {
    let (mut transport, remote) = handshake_as_receiver(stream, key, psk)?;
    if !pro_available {
        transport_write(&mut transport, REJECT_PRO_REQUIRED, stream)?;
        return Err("this device is not Pro".to_string());
    }
    transport_write(&mut transport, READY, stream)?;
    let mut bytes = Vec::new();
    loop {
        let chunk = transport_read(&mut transport, stream)?;
        if chunk.is_empty() {
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_TEXT_BYTES {
            return Err("the draft is too long".to_string());
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| "the draft is not UTF-8".to_string())?;
    // 受け入れられなければ、相手へ完了を返さない
    if !deliver(&remote, text) {
        return Err("the device was unpaired while receiving".to_string());
    }
    transport_write(&mut transport, ACK, stream)?;
    Ok(remote)
}

/// 生存確認も送信と同じ Pro・アカウントの判定を通す。送信先の一覧が、実際に送れる機器だけを選べるようにする。
fn probe_peer(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    remote_public: &[u8],
    psk: &[u8; 32],
) -> std::result::Result<(), LanError> {
    let mut transport =
        handshake_as_sender(stream, key, remote_public, psk).fail_as(Failure::Unreachable)?;
    let _name = transport_read(&mut transport, stream).fail_as(Failure::Unreachable)?;
    match transport_read(&mut transport, stream)
        .fail_as(Failure::Unreachable)?
        .as_slice()
    {
        READY => Ok(()),
        REJECT_PRO_REQUIRED => Err(LanError::new(
            Failure::ReceiverProRequired,
            "the receiving device is not Pro",
        )),
        _ => Err(LanError::new(
            Failure::Unreachable,
            "the receiving device refused",
        )),
    }
}

/// 名乗りを送る先。各インターフェースのサブネットのブロードキャストと 255.255.255.255
fn broadcast_targets() -> Vec<Ipv4Addr> {
    let mut targets: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) if !v4.ip.is_loopback() => {
                Some(Ipv4Addr::from(u32::from(v4.ip) | !u32::from(v4.netmask)))
            }
            _ => None,
        })
        .collect();
    targets.push(Ipv4Addr::BROADCAST);
    targets.sort();
    targets.dedup();
    targets
}

/// ポートを開く。止めた直前の待ち受けがまだ閉じ終わっていないことがあるので、少し待ってやり直す
fn bind_with_retry<T>(bind: impl Fn() -> io::Result<T>) -> io::Result<T> {
    let mut attempts = 0;
    loop {
        match bind() {
            Err(error) if error.kind() == io::ErrorKind::AddrInUse && attempts < 10 => {
                attempts += 1;
                thread::sleep(Duration::from_millis(100));
            }
            result => return result,
        }
    }
}

fn connect(ip: IpAddr) -> Result<TcpStream> {
    let address = SocketAddr::new(ip, TCP_PORT);
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|error| format!("connect to {address}: {error}"))?;
    set_timeouts(&stream)?;
    Ok(stream)
}

/// 相手へつなぎ、何をしに来たかの1バイトを送る
fn connect_for(ip: IpAddr, kind: u8) -> std::result::Result<TcpStream, LanError> {
    let mut stream = connect(ip).fail_as(Failure::Unreachable)?;
    stream
        .write_all(&[kind])
        .map_err(|error| format!("write: {error}"))
        .fail_as(Failure::Unreachable)?;
    Ok(stream)
}

fn set_timeouts(stream: &TcpStream) -> Result<()> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|error| format!("set timeout: {error}"))
}

struct Offer {
    code: String,
    expires: Instant,
    automatic: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingOffer {
    pub code: String,
    pub remaining_seconds: u64,
    pub automatic: bool,
}

#[derive(Clone, Copy)]
enum DiscoverySource {
    Announcement,
    Authenticated,
}

fn remember_seen_address(
    seen: &mut HashMap<Vec<u8>, IpAddr>,
    remote_public: &[u8],
    ip: IpAddr,
    source: DiscoverySource,
) -> bool {
    let known = seen.contains_key(remote_public);
    if known || matches!(source, DiscoverySource::Authenticated) {
        seen.insert(remote_public.to_vec(), ip);
    }
    known
}

fn discovery_is_rejected(source: DiscoverySource, rejected_at: Option<Instant>) -> bool {
    matches!(source, DiscoverySource::Announcement)
        && rejected_at.is_some_and(|at| at.elapsed() < REJECTED_DISCOVERY_TTL)
}

fn should_want_pairing(
    devices_open: bool,
    pro_available: bool,
    has_account_key: bool,
    has_account_key_id: bool,
) -> bool {
    devices_open && pro_available && !has_account_key && has_account_key_id
}

/// 待ち受けと名乗り。Pro で同じアカウントの鍵を持つか、ペアリングの途中だけ動かし、使わない人には OS の許可を求めない
pub struct Lan {
    key_path: PathBuf,
    /// 初めて要るときに読む（作る）。使わない人のために鍵のファイルを作らない
    key: Mutex<Option<DeviceKey>>,
    name: String,
    host: Arc<dyn Host>,
    /// 動いている間の、止める印
    running: Mutex<Option<Arc<AtomicBool>>>,
    offer: Mutex<Option<Offer>>,
    /// コードを出している相手を、名乗りで最後に見た場所
    offer_seen: Mutex<Option<IpAddr>>,
    /// 組み合わせのやり取りの最中か（コードを入れて、出している相手を探している間を含む）。その間は待ち受けを止めない
    pairing: AtomicBool,
    devices_open: AtomicBool,
    wanted: Mutex<Option<Instant>>,
    /// 同じアカウントの機器を、名乗りや受け取りで最後に見た場所（公開鍵ごと）
    seen: Mutex<HashMap<Vec<u8>, IpAddr>>,
    /// UDP の名乗りだけを根拠に失敗した相手へ、しばらく握手を試さない。
    rejected: Mutex<HashMap<Vec<u8>, Instant>>,
    /// 生存確認を始めた相手。同じ相手への確認を同時に走らせない。
    discovering: Mutex<HashSet<Vec<u8>>>,
}

impl Lan {
    pub fn new(key_path: PathBuf, name: String, host: Arc<dyn Host>) -> Arc<Self> {
        Arc::new(Self {
            key_path,
            key: Mutex::new(None),
            name,
            host,
            running: Mutex::new(None),
            offer: Mutex::new(None),
            offer_seen: Mutex::new(None),
            pairing: AtomicBool::new(false),
            devices_open: AtomicBool::new(false),
            wanted: Mutex::new(None),
            seen: Mutex::new(HashMap::new()),
            rejected: Mutex::new(HashMap::new()),
            discovering: Mutex::new(HashSet::new()),
        })
    }

    fn key(&self) -> Result<DeviceKey> {
        let mut key = self.key.lock().unwrap();
        if let Some(key) = &*key {
            return Ok(key.clone());
        }
        let loaded = load_or_create_key(&self.key_path)?;
        *key = Some(loaded.clone());
        Ok(loaded)
    }

    fn offering(&self) -> bool {
        self.offer
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|offer| offer.expires > Instant::now())
    }

    pub fn set_devices_open(self: &Arc<Self>, open: bool) {
        self.devices_open.store(open, Ordering::Relaxed);
        if !open && self.offer.lock().unwrap().take().is_some() {
            self.host.on_pairing_code_ended();
        }
        if open
            && self.host.pro_account_tag().is_some()
            && self.host.account_key().is_some()
            && self
                .wanted
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|at| at.elapsed() < OFFER_TTL)
            && !self.offering()
        {
            let _ = self.start_pairing(true);
        }
        self.refresh();
    }

    fn wants_pairing(&self) -> bool {
        should_want_pairing(
            self.devices_open.load(Ordering::Relaxed),
            self.host.pro_account_tag().is_some(),
            self.host.account_key().is_some(),
            self.host.account_key_id().is_some(),
        )
    }

    fn needed(&self) -> bool {
        self.offering()
            || self.pairing.load(Ordering::Relaxed)
            || self.wants_pairing()
            || (self.host.pro_account_tag().is_some() && self.host.account_key().is_some())
    }

    /// 要るなら動かし、要らなくなったら止める。鍵や発見した機器が変わったら呼ぶ。動いているかを返す
    pub fn refresh(self: &Arc<Self>) -> bool {
        let mut running = self.running.lock().unwrap();
        match (self.needed(), running.as_ref()) {
            (true, None) => match self.start() {
                Ok(stop) => *running = Some(stop),
                Err(error) => warn!("lan: couldn't start: {error}"),
            },
            (false, Some(stop)) => {
                stop.store(true, Ordering::Relaxed);
                *running = None;
                info!("lan: stopped");
            }
            _ => {}
        }
        running.is_some()
    }

    fn start(self: &Arc<Self>) -> Result<Arc<AtomicBool>> {
        let key = self.key()?;
        let listener = bind_with_retry(|| TcpListener::bind((Ipv4Addr::UNSPECIFIED, TCP_PORT)))
            .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
            .map_err(|error| format!("tcp {TCP_PORT}: {error}"))?;
        let socket = bind_with_retry(|| UdpSocket::bind((Ipv4Addr::UNSPECIFIED, UDP_PORT)))
            .and_then(|socket| {
                socket.set_broadcast(true)?;
                socket.set_read_timeout(Some(POLL_INTERVAL))?;
                Ok(socket)
            })
            .map_err(|error| format!("udp {UDP_PORT}: {error}"))?;
        let receiver = socket
            .try_clone()
            .map_err(|error| format!("udp {UDP_PORT}: {error}"))?;
        let stop = Arc::new(AtomicBool::new(false));

        let lan = Arc::clone(self);
        let accept_stop = Arc::clone(&stop);
        thread::spawn(move || lan.accept(listener, &accept_stop));
        let lan = Arc::clone(self);
        let receive_stop = Arc::clone(&stop);
        let own = key.public.clone();
        thread::spawn(move || lan.receive_hellos(receiver, &own, &receive_stop));
        let lan = Arc::clone(self);
        let hello_stop = Arc::clone(&stop);
        thread::spawn(move || lan.send_hellos(socket, &to_hex(&key.public), &hello_stop));
        info!("lan: listening on tcp {TCP_PORT} and udp {UDP_PORT}");
        Ok(stop)
    }

    fn accept(self: Arc<Self>, listener: TcpListener, stop: &AtomicBool) {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, peer)) => {
                    let lan = Arc::clone(&self);
                    thread::spawn(move || lan.handle(stream, peer));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(POLL_INTERVAL);
                }
                Err(error) => {
                    warn!("lan: accept failed: {error}");
                    thread::sleep(POLL_INTERVAL);
                }
            }
        }
    }

    fn handle(self: Arc<Self>, mut stream: TcpStream, peer: SocketAddr) {
        let result = self.serve(&mut stream, peer.ip());
        if let Err(error) = result {
            warn!("lan: connection from {peer} failed: {error}");
        }
    }

    fn serve(self: &Arc<Self>, stream: &mut TcpStream, ip: IpAddr) -> Result<()> {
        // Windows と macOS では、待ち受けのノンブロッキングが受け付けた接続にも引き継がれる
        stream
            .set_nonblocking(false)
            .map_err(|error| format!("set blocking: {error}"))?;
        set_timeouts(stream)?;
        let key = self.key()?;
        let mut kind = [0u8; 1];
        stream
            .read_exact(&mut kind)
            .map_err(|error| format!("read: {error}"))?;
        match kind[0] {
            KIND_PAIR => {
                // コードを取り出すと、まだ鍵を持つ機器がなければ一瞬待ち受けが要らなくなる。
                // やり取りの間に止めてしまわないよう、取り出す前に立てる
                self.pairing.store(true, Ordering::Relaxed);
                let result = self.accept_pairing(stream, ip, &key);
                self.pairing.store(false, Ordering::Relaxed);
                // ペアリングできなければ、ほかに要るものがなければ止める
                self.refresh();
                result
            }
            KIND_SEND => {
                let account_key = self.host.account_key().ok_or("no account key")?;
                let from = receive_text(
                    stream,
                    &key,
                    &crate::account_key::lan_psk(&account_key),
                    self.host.pro_account_tag().is_some(),
                    |remote, text| self.host.on_received(remote, text),
                )?;
                info!("lan: received a draft");
                self.start_discovery(from, ip, DiscoverySource::Authenticated);
                Ok(())
            }
            KIND_PING => {
                let account_key = self.host.account_key().ok_or("no account key")?;
                let (mut transport, from) = handshake_as_receiver(
                    stream,
                    &key,
                    &crate::account_key::lan_psk(&account_key),
                )?;
                transport_write(&mut transport, self.name.as_bytes(), stream)?;
                let reply = if self.host.pro_account_tag().is_some() {
                    READY
                } else {
                    REJECT_PRO_REQUIRED
                };
                transport_write(&mut transport, reply, stream)?;
                match reply {
                    READY => {
                        self.start_discovery(from, ip, DiscoverySource::Authenticated);
                        Ok(())
                    }
                    REJECT_PRO_REQUIRED => Err("this device is not Pro".to_string()),
                    _ => unreachable!(),
                }
            }
            other => Err(format!("unknown request {other}")),
        }
    }

    /// コードを出した側の組み合わせ。コードは1回で使い捨て、違うコードで何度も試させない
    fn accept_pairing(&self, stream: &mut TcpStream, ip: IpAddr, key: &DeviceKey) -> Result<()> {
        let offer = self
            .offer
            .lock()
            .unwrap()
            .take()
            .filter(|offer| offer.expires > Instant::now())
            .ok_or("no pairing code is shown")?;
        self.host.on_pairing_code_ended();
        let account_tag = self
            .host
            .pro_account_tag()
            .ok_or("this device is not Pro")?;
        let account_key = self.host.account_key().ok_or("no account key")?;
        let peer = pair_as_offerer(
            stream,
            &offer.code,
            key,
            &self.name,
            &account_tag,
            &account_key,
        )?;
        info!("lan: paired");
        if !self.host.on_device_found(peer, ip) {
            return Err("couldn't remember the device".into());
        }
        self.wanted.lock().unwrap().take();
        Ok(())
    }

    fn send_hellos(self: Arc<Self>, socket: UdpSocket, public_hex: &str, stop: &AtomicBool) {
        let mut last: Option<Instant> = None;
        let mut warned = false;
        while !stop.load(Ordering::Relaxed) {
            if !self.needed() {
                // コードが切れたなどで不要になった。止める印が立つので、次の周で抜ける
                self.refresh();
                continue;
            }
            let offering = self.offering();
            if !offering {
                let expired = self.offer.lock().unwrap().take().is_some();
                if expired {
                    self.host.on_pairing_code_ended();
                    if self.devices_open.load(Ordering::Relaxed)
                        && self
                            .wanted
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|at| at.elapsed() < OFFER_TTL)
                    {
                        let _ = self.start_pairing(true);
                    }
                }
            }
            let interval = hello_interval(offering, self.wants_pairing());
            let due = last.is_none_or(|at| at.elapsed() >= interval);
            if due
                && (offering
                    || self.host.account_key().is_some()
                    || self.pairing.load(Ordering::Relaxed)
                    || self.wants_pairing())
            {
                let message = if offering {
                    Some(hello_message(&Hello::Offer(
                        from_hex(public_hex).expect("our public key is hexadecimal"),
                    )))
                } else if self.pairing.load(Ordering::Relaxed) || self.wants_pairing() {
                    self.host.pro_account_tag().map(|tag| {
                        hello_message(&Hello::Want(
                            from_hex(public_hex).expect("our public key is hexadecimal"),
                            tag,
                        ))
                    })
                } else {
                    Some(hello_message(&Hello::Device(
                        from_hex(public_hex).expect("our public key is hexadecimal"),
                    )))
                };
                let Some(message) = message else {
                    thread::sleep(POLL_INTERVAL);
                    continue;
                };
                for target in broadcast_targets() {
                    if let Err(error) = socket.send_to(message.as_bytes(), (target, UDP_PORT)) {
                        // 仮想のアダプターなどでは送れないことがある。毎回は出さない
                        if !warned {
                            warn!("lan: hello to {target} failed: {error}");
                            warned = true;
                        }
                    }
                }
                last = Some(Instant::now());
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn receive_hellos(self: Arc<Self>, socket: UdpSocket, own: &[u8], stop: &AtomicBool) {
        let mut buffer = [0u8; 512];
        while !stop.load(Ordering::Relaxed) {
            match socket.recv_from(&mut buffer) {
                Ok((length, from)) => self.on_hello(&buffer[..length], from.ip(), own),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(error) => {
                    warn!("lan: receiving hellos failed: {error}");
                    thread::sleep(POLL_INTERVAL);
                }
            }
        }
    }

    fn on_hello(self: &Arc<Self>, datagram: &[u8], ip: IpAddr, own: &[u8]) {
        let Some(hello) = read_hello(datagram) else {
            return;
        };
        let key = match &hello {
            Hello::Device(key) | Hello::Offer(key) | Hello::Want(key, _) => key.clone(),
        };
        if key == own {
            return;
        }
        match hello {
            Hello::Offer(_) if self.pairing.load(Ordering::Relaxed) => {
                *self.offer_seen.lock().unwrap() = Some(ip)
            }
            Hello::Want(_, tag) => {
                if self.host.pro_account_tag().is_some_and(|own| own == tag) {
                    *self.wanted.lock().unwrap() = Some(Instant::now());
                    if self.devices_open.load(Ordering::Relaxed) && !self.offering() {
                        let _ = self.start_pairing(true);
                    }
                }
            }
            Hello::Device(_) | Hello::Offer(_)
                if self.host.pro_account_tag().is_some() && self.host.account_key().is_some() =>
            {
                self.start_discovery(key, ip, DiscoverySource::Announcement);
            }
            _ => {}
        }
    }

    /// 同じ公開鍵への生存確認は、名乗りと相手からの生存確認のどちらからでも1回だけ始める。
    fn start_discovery(
        self: &Arc<Self>,
        remote_public: Vec<u8>,
        ip: IpAddr,
        source: DiscoverySource,
    ) {
        if self.host.pro_account_tag().is_none() || self.host.account_key().is_none() {
            return;
        }
        let mut seen = self.seen.lock().unwrap();
        let known = remember_seen_address(&mut seen, &remote_public, ip, source);
        drop(seen);
        if matches!(source, DiscoverySource::Authenticated) {
            self.host.on_device_address_seen(&remote_public, ip);
        }
        if known {
            return;
        }
        if discovery_is_rejected(
            source,
            self.rejected.lock().unwrap().get(&remote_public).copied(),
        ) {
            return;
        }
        if !self
            .discovering
            .lock()
            .unwrap()
            .insert(remote_public.clone())
        {
            return;
        }
        let lan = Arc::clone(self);
        thread::spawn(move || lan.probe_discovered(remote_public, ip, source));
    }

    fn probe_discovered(
        self: Arc<Self>,
        remote_public: Vec<u8>,
        ip: IpAddr,
        source: DiscoverySource,
    ) {
        let Some(account_key) = self.host.account_key() else {
            self.discovering.lock().unwrap().remove(&remote_public);
            return;
        };
        let result = (|| {
            let key = self.key()?;
            let mut stream = connect_for(ip, KIND_PING).map_err(|error| error.detail)?;
            let mut transport = handshake_as_sender(
                &mut stream,
                &key,
                &remote_public,
                &crate::account_key::lan_psk(&account_key),
            )?;
            let name = transport_read(&mut transport, &mut stream)?;
            if transport_read(&mut transport, &mut stream)?.as_slice() != READY {
                return Err("the device is not Pro".to_string());
            }
            Ok::<_, String>(remote_peer_name(&remote_public, &name))
        })();
        match result {
            Ok(peer) => {
                self.seen.lock().unwrap().insert(remote_public.clone(), ip);
                self.rejected.lock().unwrap().remove(&remote_public);
                if !self.host.on_device_found(peer, ip) {
                    warn!("lan: couldn't remember a discovered device");
                }
            }
            Err(_) => {
                if matches!(source, DiscoverySource::Announcement) {
                    self.rejected
                        .lock()
                        .unwrap()
                        .insert(remote_public.clone(), Instant::now());
                }
            }
        }
        self.discovering.lock().unwrap().remove(&remote_public);
    }

    /// コードを出して、相手が入れるのを待つ。コードと画面表示用の残り秒を返す
    pub fn start_pairing(
        self: &Arc<Self>,
        automatic: bool,
    ) -> std::result::Result<PairingOffer, LanError> {
        if self.host.pro_account_tag().is_none() {
            return Err(LanError::new(
                Failure::ProRequired,
                "this device is not ready to pair",
            ));
        }
        if self.host.account_key().is_none() {
            return Err(LanError::new(
                Failure::NeedsPairing,
                "this device does not have an account key",
            ));
        }
        let code = new_code().fail_as(Failure::Internal)?;
        let expires = Instant::now() + OFFER_TTL;
        *self.offer.lock().unwrap() = Some(Offer {
            code: code.clone(),
            expires,
            automatic,
        });
        // 待ち受けを始められなければ、相手はつなげないので、コードを出さない
        if !self.refresh() {
            *self.offer.lock().unwrap() = None;
            return Err(LanError::new(Failure::Internal, "couldn't start listening"));
        }
        let offer = PairingOffer {
            code,
            remaining_seconds: offer_remaining_seconds(expires),
            automatic,
        };
        if automatic {
            self.host.on_pairing_code_offered(
                offer.code.clone(),
                offer.remaining_seconds,
                offer.automatic,
            );
        }
        Ok(offer)
    }

    /// 今出しているコード。設定画面を開いた後に `want` を受けて自動で出したコードを画面に表示するために読む。
    pub fn pairing_offer(&self) -> Option<PairingOffer> {
        let offer = self.offer.lock().unwrap();
        let offer = offer
            .as_ref()
            .filter(|offer| offer.expires > Instant::now())?;
        Some(PairingOffer {
            code: offer.code.clone(),
            remaining_seconds: offer_remaining_seconds(offer.expires),
            automatic: offer.automatic,
        })
    }

    pub fn cancel_pairing(self: &Arc<Self>) {
        if self.offer.lock().unwrap().take().is_some() {
            self.host.on_pairing_code_ended();
        }
        self.refresh();
    }

    /// 一覧から忘れた機器は、次の名乗りで再び生存確認できるようにする。
    pub fn forget_device(&self, public_key: &[u8]) {
        self.seen.lock().unwrap().remove(public_key);
        self.rejected.lock().unwrap().remove(public_key);
        self.discovering.lock().unwrap().remove(public_key);
    }

    /// 相手に出ているコードを入れて組み合わせる。コードを出している相手を名乗りで探すので、終わるまで数秒かかる
    pub fn join_pairing(self: &Arc<Self>, code: &str) -> std::result::Result<(), LanError> {
        if self.host.pro_account_tag().is_none() {
            return Err(LanError::new(
                Failure::ProRequired,
                "this device is not waiting for an account key",
            ));
        }
        if self.host.account_key().is_some() || self.host.account_key_id().is_none() {
            return Err(LanError::new(
                Failure::Internal,
                "this device is not waiting for an account key",
            ));
        }
        let code: String = code.chars().filter(char::is_ascii_digit).collect();
        if code.len() != 6 {
            return Err(LanError::new(Failure::BadCode, "the code must be 6 digits"));
        }
        let key = self.key().fail_as(Failure::Internal)?;
        *self.offer_seen.lock().unwrap() = None;
        self.pairing.store(true, Ordering::Relaxed);
        // 名乗りを受けるのに待ち受けが要る
        if !self.refresh() {
            self.pairing.store(false, Ordering::Relaxed);
            return Err(LanError::new(Failure::Internal, "couldn't start listening"));
        }
        let result =
            self.find_offer()
                .fail_as(Failure::Unreachable)
                .and_then(|ip| {
                    let mut stream = connect_for(ip, KIND_PAIR)?;
                    // つながった後の失敗は、コードが違う（鍵が合わずに握手が通らない）か、相手でコードが使えなくなっている
                    let account_tag = self.host.pro_account_tag().ok_or_else(|| {
                        LanError::new(Failure::ProRequired, "this device is not Pro")
                    })?;
                    pair_as_joiner(
                        &mut stream,
                        &code,
                        &key,
                        &self.name,
                        &account_tag,
                        self.host.account_key_id().as_deref(),
                        |account_key| self.host.receive_account_key(account_key),
                    )
                    .map_err(|detail| {
                        let failure = if detail.contains("different accounts") {
                            Failure::AccountMismatch
                        } else if detail.contains("does not match") {
                            Failure::KeyMismatch
                        } else {
                            Failure::WrongCode
                        };
                        LanError::new(failure, &detail)
                    })
                    .map(|peer| (peer, ip))
                });
        match result {
            Ok((peer, ip)) => {
                info!("lan: paired");
                let remembered = self.host.on_device_found(peer, ip);
                // 覚えた機器で待ち受けが要るようになってから下ろす。先に下ろすと、一瞬要らないとみなして止めてしまう
                self.pairing.store(false, Ordering::Relaxed);
                if remembered {
                    Ok(())
                } else {
                    // 覚えられなければ送れも受け取れもしないので、組み合わせられたとは返さない
                    self.refresh();
                    Err(LanError::new(
                        Failure::Internal,
                        "couldn't remember the device",
                    ))
                }
            }
            Err(error) => {
                self.pairing.store(false, Ordering::Relaxed);
                self.refresh();
                Err(error)
            }
        }
    }

    fn find_offer(&self) -> Result<IpAddr> {
        let started = Instant::now();
        loop {
            if let Some(ip) = *self.offer_seen.lock().unwrap() {
                return Ok(ip);
            }
            if started.elapsed() > JOIN_WAIT {
                return Err("couldn't find a device showing a pairing code".to_string());
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    /// 同じアカウントで見つけた機器へ下書きを送る。名乗りで見た場所がなければ、覚えていた場所へ送る。送れた場所を返す
    pub fn send(
        &self,
        remote_public: &[u8],
        saved: Option<IpAddr>,
        account_key: Option<[u8; 32]>,
        text: &str,
    ) -> std::result::Result<IpAddr, LanError> {
        // 送れない長さなら、相手につなぐ前にやめる
        if text.len() > MAX_TEXT_BYTES {
            return Err(LanError::new(
                Failure::TooLong,
                "the draft is too long to send",
            ));
        }
        let account_key = account_key
            .ok_or_else(|| LanError::new(Failure::ProRequired, "this device is not Pro"))?;
        let key = self.key().fail_as(Failure::Internal)?;
        let ip = self.locate(remote_public, saved)?;
        let mut stream = connect_for(ip, KIND_SEND)?;
        // つながった後に切られたのは、相手が受け取らなかったとみなす
        send_text(
            &mut stream,
            &key,
            remote_public,
            &crate::account_key::lan_psk(&account_key),
            text,
        )?;
        self.remember_peer_address(remote_public, ip);
        Ok(ip)
    }

    /// 同じアカウントで見つけた機器が動いていて、つながるかを確かめる（握手まで）。つながった場所を返す。
    /// 握手が通らなかったときも、送れないので、つながらないとみなす
    pub fn probe(
        &self,
        remote_public: &[u8],
        saved: Option<IpAddr>,
        account_key: Option<[u8; 32]>,
    ) -> std::result::Result<IpAddr, LanError> {
        let account_key = account_key
            .ok_or_else(|| LanError::new(Failure::ProRequired, "this device is not Pro"))?;
        let key = self.key().fail_as(Failure::Internal)?;
        let ip = self.locate(remote_public, saved)?;
        let mut stream = connect_for(ip, KIND_PING)?;
        probe_peer(
            &mut stream,
            &key,
            remote_public,
            &crate::account_key::lan_psk(&account_key),
        )?;
        self.remember_peer_address(remote_public, ip);
        Ok(ip)
    }

    fn remember_peer_address(&self, remote_public: &[u8], ip: IpAddr) {
        self.seen.lock().unwrap().insert(remote_public.to_vec(), ip);
        self.host.on_device_address_seen(remote_public, ip);
    }

    /// 同じアカウントで見つけた機器の場所。名乗りで見た場所がなければ、覚えていた場所
    fn locate(
        &self,
        remote_public: &[u8],
        saved: Option<IpAddr>,
    ) -> std::result::Result<IpAddr, LanError> {
        self.seen
            .lock()
            .unwrap()
            .get(remote_public)
            .copied()
            .or(saved)
            .ok_or_else(|| {
                LanError::new(
                    Failure::Unreachable,
                    "the device hasn't been found on the network",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT_TAG: [u8; ACCOUNT_TAG_LEN] = [7; ACCOUNT_TAG_LEN];
    const ACCOUNT_KEY: [u8; 32] = [9; 32];
    const LAN_PSK: [u8; 32] = [3; 32];

    struct TestHost;

    impl Host for TestHost {
        fn on_pairing_code_ended(&self) {}

        fn on_pairing_code_offered(&self, _: String, _: u64, _: bool) {}

        fn on_received(&self, _: &[u8], _: String) -> bool {
            true
        }

        fn pro_account_tag(&self) -> Option<[u8; ACCOUNT_TAG_LEN]> {
            Some(ACCOUNT_TAG)
        }

        fn account_key(&self) -> Option<[u8; 32]> {
            Some(ACCOUNT_KEY)
        }

        fn account_key_id(&self) -> Option<String> {
            Some(crate::account_key::key_id(&ACCOUNT_KEY))
        }

        fn receive_account_key(&self, _: [u8; 32]) -> bool {
            true
        }

        fn on_device_found(&self, _: Peer, _: IpAddr) -> bool {
            true
        }

        fn on_device_address_seen(&self, _: &[u8], _: IpAddr) {}
    }

    /// つながった TCP の両端
    fn connected() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        for stream in [&client, &server] {
            set_timeouts(stream).unwrap();
        }
        (client, server)
    }

    #[test]
    fn pairs_with_the_same_code() {
        let (offerer, joiner) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let offerer_key = offerer.clone();
        let offered = thread::spawn(move || {
            pair_as_offerer(
                &mut server,
                "123456",
                &offerer_key,
                "Mac",
                &ACCOUNT_TAG,
                &ACCOUNT_KEY,
            )
        });

        let joined = pair_as_joiner(
            &mut client,
            "123456",
            &joiner,
            "desk-pc",
            &ACCOUNT_TAG,
            None,
            |received_key| received_key == ACCOUNT_KEY,
        )
        .unwrap();

        assert_eq!(
            joined,
            Peer {
                name: "Mac".to_string(),
                public_key: offerer.public.clone(),
            }
        );
        assert_eq!(
            offered.join().unwrap().unwrap(),
            Peer {
                name: "desk-pc".to_string(),
                public_key: joiner.public.clone(),
            }
        );
    }

    #[test]
    fn does_not_pair_with_a_different_code() {
        let (offerer, joiner) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let offered = thread::spawn(move || {
            pair_as_offerer(
                &mut server,
                "123456",
                &offerer,
                "Mac",
                &ACCOUNT_TAG,
                &ACCOUNT_KEY,
            )
        });

        let joined = pair_as_joiner(
            &mut client,
            "654321",
            &joiner,
            "desk-pc",
            &ACCOUNT_TAG,
            None,
            |_| true,
        );
        // 実際の接続と同じく、失敗したら切る
        drop(client);

        assert!(joined.is_err());
        assert!(offered.join().unwrap().is_err());
    }

    #[test]
    fn does_not_transfer_the_key_to_another_account() {
        let (offerer, joiner) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let offered = thread::spawn(move || {
            pair_as_offerer(
                &mut server,
                "123456",
                &offerer,
                "Mac",
                &ACCOUNT_TAG,
                &ACCOUNT_KEY,
            )
        });
        let joined = pair_as_joiner(
            &mut client,
            "123456",
            &joiner,
            "desk-pc",
            &[8; ACCOUNT_TAG_LEN],
            None,
            |_| panic!("a different account must not receive a key"),
        );
        assert!(joined.unwrap_err().contains("different accounts"));
        assert!(offered
            .join()
            .unwrap()
            .unwrap_err()
            .contains("different accounts"));
    }

    #[test]
    fn discards_a_key_that_does_not_match_the_server() {
        let (offerer, joiner) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let offered = thread::spawn(move || {
            pair_as_offerer(
                &mut server,
                "123456",
                &offerer,
                "Mac",
                &ACCOUNT_TAG,
                &ACCOUNT_KEY,
            )
        });
        let joined = pair_as_joiner(
            &mut client,
            "123456",
            &joiner,
            "desk-pc",
            &ACCOUNT_TAG,
            Some("00"),
            |_| panic!("a mismatched key must not be stored"),
        );
        assert!(joined.unwrap_err().contains("does not match"));
        assert!(offered
            .join()
            .unwrap()
            .unwrap_err()
            .contains("did not store"));
    }

    #[test]
    fn sends_a_draft_to_a_device_with_the_same_account_key() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_key = receiver.clone();
        let received = thread::spawn(move || {
            let mut delivered = None;
            let from = receive_text(&mut server, &receiver_key, &LAN_PSK, true, |_, text| {
                delivered = Some(text);
                true
            });
            (from, delivered)
        });
        // 1通に入りきらない長さでも、分けて送って元に戻る
        let text = format!("{}\n末尾", "あ".repeat(30_000));

        send_text(&mut client, &sender, &receiver.public, &LAN_PSK, &text).unwrap();

        let (from, delivered) = received.join().unwrap();
        assert_eq!(from.unwrap(), sender.public);
        assert_eq!(delivered, Some(text));
    }

    #[test]
    fn accepts_an_unremembered_device_only_with_the_same_account_key() {
        let (sender, receiver, stranger) = (
            generate_key().unwrap(),
            generate_key().unwrap(),
            generate_key().unwrap(),
        );

        // 同じアカウントの鍵を持つ相手なら、握手が通る
        let (mut client, mut server) = connected();
        let receiver_key = receiver.clone();
        let answered = thread::spawn(move || {
            handshake_as_receiver(&mut server, &receiver_key, &LAN_PSK).map(|(_, remote)| remote)
        });
        assert!(handshake_as_sender(&mut client, &sender, &receiver.public, &LAN_PSK).is_ok());
        assert_eq!(answered.join().unwrap().unwrap(), sender.public);

        // 組み合わせていない相手とは、握手が通らない
        let (mut client, mut server) = connected();
        let receiver_key = receiver.clone();
        let refused = thread::spawn(move || {
            handshake_as_receiver(&mut server, &receiver_key, &LAN_PSK).map(|_| ())
        });
        assert!(handshake_as_sender(&mut client, &stranger, &receiver.public, &[4; 32]).is_err());
        assert!(refused.join().unwrap().is_err());
    }

    #[test]
    fn refuses_a_device_with_a_different_account_key() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_public = receiver.public.clone();
        let received = thread::spawn(move || {
            receive_text(&mut server, &receiver, &LAN_PSK, true, |_, _| true)
        });

        let sent = send_text(&mut client, &sender, &receiver_public, &[4; 32], "secret");

        assert!(sent.is_err());
        assert!(received.join().unwrap().is_err());
    }

    #[test]
    fn refuses_when_the_receiver_does_not_accept_the_text() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_public = receiver.public.clone();
        let deliveries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&deliveries);
        // 握手のときは組み合わせてあり、受け取り終えて渡すときには解除されていて受け入れられない
        let received = thread::spawn(move || {
            receive_text(&mut server, &receiver, &LAN_PSK, true, |_, _| {
                counted.fetch_add(1, Ordering::Relaxed);
                false
            })
        });

        let sent = send_text(&mut client, &sender, &receiver_public, &LAN_PSK, "secret");

        // 受け入れられなければ、相手には受け取れたと返さない
        assert!(sent.is_err());
        assert!(received.join().unwrap().is_err());
        assert_eq!(deliveries.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn refuses_a_sender_with_a_different_key_before_receiving_its_text() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_public = receiver.public.clone();
        let received = thread::spawn(move || {
            receive_text(&mut server, &receiver, &LAN_PSK, true, |_, _| {
                panic!("a mismatched account must not deliver text")
            })
        });

        let sent = send_text(&mut client, &sender, &receiver_public, &[8; 32], "secret");

        assert_eq!(sent.unwrap_err().failure, Failure::Refused);
        assert!(received.join().unwrap().is_err());
    }

    #[test]
    fn refuses_a_sender_when_the_receiver_is_not_pro() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_public = receiver.public.clone();
        let received = thread::spawn(move || {
            receive_text(&mut server, &receiver, &LAN_PSK, false, |_, _| {
                panic!("a non-Pro receiver must not deliver text")
            })
        });

        let sent = send_text(&mut client, &sender, &receiver_public, &LAN_PSK, "secret");

        assert_eq!(sent.unwrap_err().failure, Failure::ReceiverProRequired);
        assert!(received.join().unwrap().is_err());
    }

    #[test]
    fn failure_codes_are_distinct() {
        let failures = [
            Failure::NoDevice,
            Failure::NoTarget,
            Failure::Unreachable,
            Failure::Refused,
            Failure::ProRequired,
            Failure::NeedsPairing,
            Failure::ReceiverProRequired,
            Failure::AccountMismatch,
            Failure::KeyMismatch,
            Failure::TooLong,
            Failure::BadCode,
            Failure::WrongCode,
            Failure::Internal,
        ];
        let codes: std::collections::HashSet<&str> =
            failures.iter().map(|failure| failure.code()).collect();
        assert_eq!(codes.len(), failures.len());
        assert!(codes.iter().all(|code| code.starts_with("lan.")));
    }

    #[test]
    fn converts_hex() {
        assert_eq!(to_hex(&[0x00, 0xab, 0xff]), "00abff");
        assert_eq!(from_hex("00abFF"), Some(vec![0x00, 0xab, 0xff]));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
        assert_eq!(from_hex("あ"), None);
    }

    #[test]
    fn reads_and_writes_hello_offer_and_want() {
        let key = [1; 32];
        let want = Hello::Want(key.to_vec(), ACCOUNT_TAG);
        assert_eq!(read_hello(hello_message(&want).as_bytes()), Some(want));
        let hello = Hello::Device(key.to_vec());
        assert_eq!(read_hello(hello_message(&hello).as_bytes()), Some(hello));
        let offer = Hello::Offer(key.to_vec());
        assert_eq!(read_hello(hello_message(&offer).as_bytes()), Some(offer));
        assert_eq!(read_hello(b"mawok3 hello 00"), None);
        assert_eq!(
            read_hello(
                b"mawok2 hello 0000000000000000000000000000000000000000000000000000000000000000"
            ),
            None
        );
    }

    #[test]
    fn makes_six_digit_codes() {
        for _ in 0..20 {
            let code = new_code().unwrap();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|digit| digit.is_ascii_digit()));
        }
    }

    #[test]
    fn offer_remaining_seconds_is_bounded_by_ttl() {
        let expires = Instant::now() + OFFER_TTL;
        assert_eq!(offer_remaining_seconds(expires), OFFER_TTL.as_secs());
        assert_eq!(offer_remaining_seconds(Instant::now()), 0);
    }

    #[test]
    fn wants_pairing_only_while_the_needs_pairing_page_is_open() {
        assert!(should_want_pairing(true, true, false, true));
        assert!(!should_want_pairing(false, true, false, true));
        assert!(!should_want_pairing(true, false, false, true));
        assert!(!should_want_pairing(true, true, true, true));
        assert!(!should_want_pairing(true, true, false, false));
    }

    #[test]
    fn wants_pairing_every_second() {
        assert_eq!(hello_interval(false, true), OFFER_HELLO_INTERVAL);
        assert_eq!(hello_interval(true, false), OFFER_HELLO_INTERVAL);
        assert_eq!(hello_interval(false, false), HELLO_INTERVAL);
    }

    #[test]
    fn pairing_offer_reports_whether_it_is_automatic() {
        let lan = Lan::new(
            PathBuf::from("unused-device-key"),
            "test".to_string(),
            Arc::new(TestHost),
        );
        *lan.offer.lock().unwrap() = Some(Offer {
            code: "123456".to_string(),
            expires: Instant::now() + OFFER_TTL,
            automatic: true,
        });

        let offer = lan.pairing_offer().unwrap();
        assert_eq!(offer.code, "123456");
        assert!(offer.automatic);
        assert!(offer.remaining_seconds <= OFFER_TTL.as_secs());
    }

    #[test]
    fn updates_a_known_device_address_from_announcements_and_handshakes() {
        let public_key = vec![4; 32];
        let old: IpAddr = "192.168.0.2".parse().unwrap();
        let announced: IpAddr = "192.168.0.3".parse().unwrap();
        let authenticated: IpAddr = "192.168.0.4".parse().unwrap();
        let mut seen = HashMap::from([(public_key.clone(), old)]);

        assert!(remember_seen_address(
            &mut seen,
            &public_key,
            announced,
            DiscoverySource::Announcement,
        ));
        assert_eq!(seen[&public_key], announced);

        let unknown = vec![5; 32];
        assert!(!remember_seen_address(
            &mut seen,
            &unknown,
            announced,
            DiscoverySource::Announcement,
        ));
        assert!(!seen.contains_key(&unknown));

        assert!(!remember_seen_address(
            &mut seen,
            &unknown,
            authenticated,
            DiscoverySource::Authenticated,
        ));
        assert_eq!(seen[&unknown], authenticated);
    }

    #[test]
    fn only_udp_announcements_observe_the_discovery_backoff() {
        let recent = Some(Instant::now());
        assert!(discovery_is_rejected(DiscoverySource::Announcement, recent));
        assert!(!discovery_is_rejected(
            DiscoverySource::Authenticated,
            recent
        ));
        assert!(!discovery_is_rejected(DiscoverySource::Announcement, None));
        assert!(!discovery_is_rejected(
            DiscoverySource::Announcement,
            Some(Instant::now() - REJECTED_DISCOVERY_TTL),
        ));
    }

    #[test]
    fn forgetting_a_device_allows_its_next_hello_to_be_probed() {
        let lan = Lan::new(
            PathBuf::from("unused-device-key"),
            "test".to_string(),
            Arc::new(TestHost),
        );
        let public_key = vec![4; 32];
        lan.seen
            .lock()
            .unwrap()
            .insert(public_key.clone(), Ipv4Addr::LOCALHOST.into());
        lan.rejected
            .lock()
            .unwrap()
            .insert(public_key.clone(), Instant::now());
        lan.discovering.lock().unwrap().insert(public_key.clone());

        lan.forget_device(&public_key);

        assert!(!lan.seen.lock().unwrap().contains_key(&public_key));
        assert!(!lan.rejected.lock().unwrap().contains_key(&public_key));
        assert!(!lan.discovering.lock().unwrap().contains(&public_key));
    }

    #[test]
    fn keeps_the_device_key() {
        /// 落ちたテストでも一時フォルダーに残さないよう、手放すときにフォルダーごと消す
        struct TempDir(PathBuf);

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        let dir =
            TempDir(std::env::temp_dir().join(format!("mawok-lan-test-{}", std::process::id())));
        let _ = fs::remove_dir_all(&dir.0);
        let path = dir.0.join(KEY_FILE_NAME);

        let created = load_or_create_key(&path).unwrap();
        let loaded = load_or_create_key(&path).unwrap();

        assert_eq!(created.public, loaded.public);
        assert_eq!(created.private, loaded.private);

        // 壊れていれば作り直し、ほかのユーザーが読めない権限で差し替える
        fs::write(&path, "broken").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let remade = load_or_create_key(&path).unwrap();
        assert_ne!(remade.public, created.public);
        assert_eq!(load_or_create_key(&path).unwrap().public, remade.public);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
