//! 同じ LAN の組み合わせた自分の機器へ、下書きを送る（docs/lan.md「同じ LAN の自分の機器へ送る」）。
//! 相手は UDP のブロードキャストの名乗りで見つける。mDNS は、無線の端末どうしのマルチキャストを中継しないアクセスポイントで届かないため使わない。
//! 組み合わせは、片方に出す 6 桁のコードから SPAKE2 で鍵を作り、それを事前共有鍵にした Noise の XXpsk2 で互いの公開鍵を覚える。
//! コードをそのまま鍵にしないのは、やり取りを盗み見た相手に総当たりで当てられるため。
//! 送るのは Noise の IK で、覚えた公開鍵の相手とだけつながる

use std::{
    collections::HashMap,
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
const HELLO: &str = "mawok1";
/// 名乗りの間隔。コードを出している間は、相手がすぐ見つけられるよう短くする
const HELLO_INTERVAL: Duration = Duration::from_secs(3);
const OFFER_HELLO_INTERVAL: Duration = Duration::from_secs(1);
/// 止めるように言われたかを見る間隔
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// コードを出してから使えなくなるまで
const OFFER_TTL: Duration = Duration::from_secs(120);

/// コードが使えなくなるまでの残り秒。画面の表示用で、切り上げる（出した直後に 120 と出すため）
fn offer_remaining_seconds(expires: Instant) -> u64 {
    let remaining = expires.saturating_duration_since(Instant::now());
    remaining.as_millis().div_ceil(1000) as u64
}

/// コードを入れてから、コードを出している相手の名乗りを待つ時間。
/// 初めて待ち受けるときに出る OS の許可のダイアログ（Windows のファイアウォール、macOS のローカルネットワーク）を押す間に切れないよう、長めにとる
const JOIN_WAIT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
/// 1回に送れる下書きの大きさ（UTF-8 のバイト数）
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const PAIR_PATTERN: &str = "Noise_XXpsk2_25519_ChaChaPoly_BLAKE2s";
const SEND_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
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

type Result<T> = std::result::Result<T, String>;

/// 組み合わせと送信の失敗の種類。画面は符号から、何をすればよいかの案内を出す（src/lib/lan-errors.ts）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 組み合わせた機器がない
    NoDevice,
    /// 組み合わせた機器はあるが、送信先に選んだ機器がない
    NoTarget,
    /// 相手とつながらない（場所が分からない、つなげない、コードを出している相手が見つからない）。
    /// 原因はネットワークや OS しだいで、どれでも確かめる所は同じなので分けない
    Unreachable,
    /// つながったが、相手が受け取らなかった（相手で組み合わせを解いた、途中で切れたなど）
    Refused,
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
    /// 組み合わせた機器の公開鍵
    fn paired_keys(&self) -> Vec<Vec<u8>>;
    /// 組み合わせが済んだ。相手を覚える。覚えられなければ（設定を保存できないなど）false
    fn on_paired(&self, peer: Peer, address: IpAddr) -> bool;
    /// 出していたコードが使われて、もう使えなくなった（組み合わせの成否は問わない）
    fn on_pairing_code_ended(&self);
    /// 組み合わせた機器から下書きが届いた。そのときまだ組み合わせてあって受け入れたら true。
    /// 解除と食い違わないよう、組み合わせたままかの確かめと受け入れは、設定を押さえたまま行う
    fn on_received(&self, from: &[u8], text: String) -> bool;
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

/// この機器の鍵を読む。まだないか、中身が壊れていれば作って書き出す。作り直すと、組み合わせた相手とはつながらなくなる
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

/// コードを出した側の組み合わせ
fn pair_as_offerer(
    stream: &mut (impl Read + Write),
    code: &str,
    key: &DeviceKey,
    name: &str,
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
    remote_peer(&noise, &remote_name)
}

/// コードを入れた側の組み合わせ
fn pair_as_joiner(
    stream: &mut (impl Read + Write),
    code: &str,
    key: &DeviceKey,
    name: &str,
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
    remote_peer(&noise, &remote_name)
}

/// 送る側の握手（Noise の IK）。覚えた公開鍵の相手でなければ、ここで失敗する
fn handshake_as_sender(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    remote_public: &[u8],
) -> Result<TransportState> {
    let mut noise = builder(SEND_PATTERN)?
        .local_private_key(&key.private)
        .and_then(|builder| builder.remote_public_key(remote_public))
        .and_then(Builder::build_initiator)
        .map_err(|error| format!("handshake: {error}"))?;
    handshake_write(&mut noise, &[], stream)?;
    handshake_read(&mut noise, stream)?;
    noise
        .into_transport_mode()
        .map_err(|error| format!("handshake: {error}"))
}

/// 受ける側の握手。組み合わせた相手でなければ、握手を終える前に切る。相手の公開鍵も返す
fn handshake_as_receiver(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    is_paired: impl Fn(&[u8]) -> bool,
) -> Result<(TransportState, Vec<u8>)> {
    let mut noise = builder(SEND_PATTERN)?
        .local_private_key(&key.private)
        .and_then(Builder::build_responder)
        .map_err(|error| format!("handshake: {error}"))?;
    handshake_read(&mut noise, stream)?;
    let remote = noise
        .get_remote_static()
        .ok_or("handshake: no remote key")?
        .to_vec();
    if !is_paired(&remote) {
        return Err("not a paired device".to_string());
    }
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
    text: &str,
) -> Result<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("the draft is too long to send".to_string());
    }
    let mut transport = handshake_as_sender(stream, key, remote_public)?;
    // 1通に入りきらない分は分けて送り、空の1通で終わりを伝える
    for chunk in text.as_bytes().chunks(NOISE_MAX - TAG_LEN) {
        transport_write(&mut transport, chunk, stream)?;
    }
    transport_write(&mut transport, &[], stream)?;
    if transport_read(&mut transport, stream)? != ACK {
        return Err("unexpected reply".to_string());
    }
    Ok(())
}

/// 下書きを受け取る。組み合わせた相手でなければ、中身を受け取る前に切る。
/// 受け取り終えたら `deliver` に渡し、受け入れられた（true）ときだけ相手に受け取れたと返す。送ってきた相手の公開鍵を返す
fn receive_text(
    stream: &mut (impl Read + Write),
    key: &DeviceKey,
    is_paired: impl Fn(&[u8]) -> bool,
    deliver: impl FnOnce(&[u8], String) -> bool,
) -> Result<Vec<u8>> {
    let (mut transport, remote) = handshake_as_receiver(stream, key, is_paired)?;
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
    // 受け取っている間に組み合わせを解いていたら、渡した先が受け入れないので、返事をせずに切る。解除した相手の下書きを差し込まない
    if !deliver(&remote, text) {
        return Err("the device was unpaired while receiving".to_string());
    }
    transport_write(&mut transport, ACK, stream)?;
    Ok(remote)
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
}

/// 待ち受けと名乗り。組み合わせた機器があるか、組み合わせの途中のときだけ動かし、使わない人には OS の許可を求めない
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
    /// 組み合わせた機器を、名乗りや受け取りで最後に見た場所（公開鍵ごと）
    seen: Mutex<HashMap<Vec<u8>, IpAddr>>,
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
            seen: Mutex::new(HashMap::new()),
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

    fn needed(&self) -> bool {
        self.offering()
            || self.pairing.load(Ordering::Relaxed)
            || !self.host.paired_keys().is_empty()
    }

    /// 要るなら動かし、要らなくなったら止める。組み合わせた機器が変わったら呼ぶ。動いているかを返す
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
                // コードを取り出すと、組み合わせた機器がまだなければ一瞬待ち受けが要らなくなる。
                // やり取りの間に止めてしまわないよう、取り出す前に立てる
                self.pairing.store(true, Ordering::Relaxed);
                let result = self.accept_pairing(stream, ip, &key);
                self.pairing.store(false, Ordering::Relaxed);
                // 組み合わせられなかったら、ほかに要るものがなければ止める
                self.refresh();
                result
            }
            KIND_SEND => {
                // 組み合わせた相手かは、握手のときと、受け取り終えて渡すときの2回、そのときの設定で確かめる
                let from = receive_text(
                    stream,
                    &key,
                    |remote| self.is_paired(remote),
                    |remote, text| self.host.on_received(remote, text),
                )?;
                info!("lan: received a draft");
                self.seen.lock().unwrap().insert(from, ip);
                Ok(())
            }
            KIND_PING => {
                // 握手が通れば、動いていて組み合わせた本人だと相手に分かる。送る下書きはないので、ここで切る
                let (_, from) =
                    handshake_as_receiver(stream, &key, |remote| self.is_paired(remote))?;
                self.seen.lock().unwrap().insert(from, ip);
                Ok(())
            }
            other => Err(format!("unknown request {other}")),
        }
    }

    /// 組み合わせた機器の公開鍵か。そのときの設定で確かめる
    fn is_paired(&self, key: &[u8]) -> bool {
        self.host.paired_keys().iter().any(|paired| paired == key)
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
        let peer = pair_as_offerer(stream, &offer.code, key, &self.name)?;
        info!("lan: paired");
        if !self.host.on_paired(peer, ip) {
            return Err("couldn't remember the paired device".into());
        }
        Ok(())
    }

    fn send_hellos(self: Arc<Self>, socket: UdpSocket, public_hex: &str, stop: &AtomicBool) {
        let mut last: Option<Instant> = None;
        let mut warned = false;
        while !stop.load(Ordering::Relaxed) {
            if !self.needed() {
                // 組み合わせを解いた、コードが切れたなど。止める印が立つので、次の周で抜ける
                self.refresh();
                continue;
            }
            let offering = self.offering();
            let interval = if offering {
                OFFER_HELLO_INTERVAL
            } else {
                HELLO_INTERVAL
            };
            let due = last.is_none_or(|at| at.elapsed() >= interval);
            // コードを入れて探しているだけのときは、名乗る必要がない
            if due && (offering || !self.host.paired_keys().is_empty()) {
                let kind = if offering { "pair" } else { "hello" };
                let message = format!("{HELLO} {kind} {public_hex}");
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

    fn on_hello(&self, datagram: &[u8], ip: IpAddr, own: &[u8]) {
        let text = String::from_utf8_lossy(datagram);
        let mut parts = text.split_whitespace();
        let (Some(HELLO), Some(kind), Some(Some(key))) =
            (parts.next(), parts.next(), parts.next().map(from_hex))
        else {
            return;
        };
        if key == own {
            return;
        }
        match kind {
            "pair" => *self.offer_seen.lock().unwrap() = Some(ip),
            // 知らない相手のアドレスは覚えない
            "hello" if self.is_paired(&key) => {
                self.seen.lock().unwrap().insert(key, ip);
            }
            _ => {}
        }
    }

    /// コードを出して、相手が入れるのを待つ。コードと画面表示用の残り秒を返す
    pub fn start_pairing(self: &Arc<Self>) -> std::result::Result<(String, u64), LanError> {
        let code = new_code().fail_as(Failure::Internal)?;
        let expires = Instant::now() + OFFER_TTL;
        *self.offer.lock().unwrap() = Some(Offer {
            code: code.clone(),
            expires,
        });
        // 待ち受けを始められなければ、相手はつなげないので、コードを出さない
        if !self.refresh() {
            *self.offer.lock().unwrap() = None;
            return Err(LanError::new(Failure::Internal, "couldn't start listening"));
        }
        let remaining_seconds = offer_remaining_seconds(expires);
        Ok((code, remaining_seconds))
    }

    pub fn cancel_pairing(self: &Arc<Self>) {
        *self.offer.lock().unwrap() = None;
        self.refresh();
    }

    /// 相手に出ているコードを入れて組み合わせる。コードを出している相手を名乗りで探すので、終わるまで数秒かかる
    pub fn join_pairing(self: &Arc<Self>, code: &str) -> std::result::Result<(), LanError> {
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
        let result = self
            .find_offer()
            .fail_as(Failure::Unreachable)
            .and_then(|ip| {
                let mut stream = connect_for(ip, KIND_PAIR)?;
                // つながった後の失敗は、コードが違う（鍵が合わずに握手が通らない）か、相手でコードが使えなくなっている
                pair_as_joiner(&mut stream, &code, &key, &self.name)
                    .fail_as(Failure::WrongCode)
                    .map(|peer| (peer, ip))
            });
        match result {
            Ok((peer, ip)) => {
                info!("lan: paired");
                let remembered = self.host.on_paired(peer, ip);
                // 覚えた機器で待ち受けが要るようになってから下ろす。先に下ろすと、一瞬要らないとみなして止めてしまう
                self.pairing.store(false, Ordering::Relaxed);
                if remembered {
                    Ok(())
                } else {
                    // 覚えられなければ送れも受け取れもしないので、組み合わせられたとは返さない
                    self.refresh();
                    Err(LanError::new(
                        Failure::Internal,
                        "couldn't remember the paired device",
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

    /// 組み合わせた機器へ下書きを送る。名乗りで見た場所がなければ、覚えていた場所へ送る。送れた場所を返す
    pub fn send(
        &self,
        remote_public: &[u8],
        saved: Option<IpAddr>,
        text: &str,
    ) -> std::result::Result<IpAddr, LanError> {
        // 送れない長さなら、相手につなぐ前にやめる
        if text.len() > MAX_TEXT_BYTES {
            return Err(LanError::new(
                Failure::TooLong,
                "the draft is too long to send",
            ));
        }
        let key = self.key().fail_as(Failure::Internal)?;
        let ip = self.locate(remote_public, saved)?;
        let mut stream = connect_for(ip, KIND_SEND)?;
        // つながった後に切られたのは、相手が受け取らなかったとみなす（相手で組み合わせを解いた、途中で切れたなど）
        send_text(&mut stream, &key, remote_public, text).fail_as(Failure::Refused)?;
        Ok(ip)
    }

    /// 組み合わせた機器が動いていて、つながるかを確かめる（握手まで）。つながった場所を返す。
    /// 握手が通らなかったとき（相手で組み合わせを解いたなど）も、送れないので、つながらないとみなす
    pub fn probe(
        &self,
        remote_public: &[u8],
        saved: Option<IpAddr>,
    ) -> std::result::Result<IpAddr, LanError> {
        let key = self.key().fail_as(Failure::Internal)?;
        let ip = self.locate(remote_public, saved)?;
        let mut stream = connect_for(ip, KIND_PING)?;
        handshake_as_sender(&mut stream, &key, remote_public).fail_as(Failure::Unreachable)?;
        Ok(ip)
    }

    /// 組み合わせた機器の場所。名乗りで見た場所がなければ、覚えていた場所
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
                    "the paired device hasn't been found on the network",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let offered =
            thread::spawn(move || pair_as_offerer(&mut server, "123456", &offerer_key, "Mac"));

        let joined = pair_as_joiner(&mut client, "123456", &joiner, "desk-pc").unwrap();

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
        let offered =
            thread::spawn(move || pair_as_offerer(&mut server, "123456", &offerer, "Mac"));

        let joined = pair_as_joiner(&mut client, "654321", &joiner, "desk-pc");
        // 実際の接続と同じく、失敗したら切る
        drop(client);

        assert!(joined.is_err());
        assert!(offered.join().unwrap().is_err());
    }

    #[test]
    fn sends_a_draft_to_the_paired_device() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let sender_public = sender.public.clone();
        let receiver_key = receiver.clone();
        let received = thread::spawn(move || {
            let mut delivered = None;
            let from = receive_text(
                &mut server,
                &receiver_key,
                |remote| remote == sender_public,
                |_, text| {
                    delivered = Some(text);
                    true
                },
            );
            (from, delivered)
        });
        // 1通に入りきらない長さでも、分けて送って元に戻る
        let text = format!("{}\n末尾", "あ".repeat(30_000));

        send_text(&mut client, &sender, &receiver.public, &text).unwrap();

        let (from, delivered) = received.join().unwrap();
        assert_eq!(from.unwrap(), sender.public);
        assert_eq!(delivered, Some(text));
    }

    #[test]
    fn answers_a_ping_only_from_a_paired_device() {
        let (sender, receiver, stranger) = (
            generate_key().unwrap(),
            generate_key().unwrap(),
            generate_key().unwrap(),
        );
        let sender_public = sender.public.clone();

        // 組み合わせた相手なら、握手が通る
        let (mut client, mut server) = connected();
        let receiver_key = receiver.clone();
        let paired_public = sender_public.clone();
        let answered = thread::spawn(move || {
            handshake_as_receiver(&mut server, &receiver_key, |remote| remote == paired_public)
                .map(|(_, remote)| remote)
        });
        assert!(handshake_as_sender(&mut client, &sender, &receiver.public).is_ok());
        assert_eq!(answered.join().unwrap().unwrap(), sender_public);

        // 組み合わせていない相手とは、握手が通らない
        let (mut client, mut server) = connected();
        let receiver_key = receiver.clone();
        let refused = thread::spawn(move || {
            handshake_as_receiver(&mut server, &receiver_key, |remote| remote == sender_public)
                .map(|_| ())
        });
        assert!(handshake_as_sender(&mut client, &stranger, &receiver.public).is_err());
        assert!(refused.join().unwrap().is_err());
    }

    #[test]
    fn refuses_a_device_that_is_not_paired() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_public = receiver.public.clone();
        let received =
            thread::spawn(move || receive_text(&mut server, &receiver, |_| false, |_, _| true));

        let sent = send_text(&mut client, &sender, &receiver_public, "secret");

        assert!(sent.is_err());
        assert!(received.join().unwrap().is_err());
    }

    #[test]
    fn refuses_a_device_unpaired_while_receiving() {
        let (sender, receiver) = (generate_key().unwrap(), generate_key().unwrap());
        let (mut client, mut server) = connected();
        let receiver_public = receiver.public.clone();
        let deliveries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&deliveries);
        // 握手のときは組み合わせてあり、受け取り終えて渡すときには解除されていて受け入れられない
        let received = thread::spawn(move || {
            receive_text(
                &mut server,
                &receiver,
                |_| true,
                |_, _| {
                    counted.fetch_add(1, Ordering::Relaxed);
                    false
                },
            )
        });

        let sent = send_text(&mut client, &sender, &receiver_public, "secret");

        // 受け入れられなければ、相手には受け取れたと返さない
        assert!(sent.is_err());
        assert!(received.join().unwrap().is_err());
        assert_eq!(deliveries.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn failure_codes_are_distinct() {
        let failures = [
            Failure::NoDevice,
            Failure::NoTarget,
            Failure::Unreachable,
            Failure::Refused,
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
