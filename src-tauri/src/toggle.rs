//! Linux の `mawok --toggle`。Wayland ではアプリがホットキーを奪えないので、デスクトップのキー設定からこのコマンドを呼んでもらう
//! （docs/platform.md「Linux のホットキー」）。2つ目のプロセスは、動いている Mawok に知らせてすぐ終わる

/// テキストウィンドウを出す・隠す引数。ホットキーを押したのと同じ動きにする
pub const TOGGLE_ARG: &str = "--toggle";
/// 呼んだデスクトップから受け取った、窓を前に出すための印を渡す引数。
/// Wayland では、印の無い窓は前に出られず、フォーカスも入らない（GNOME は「準備ができました」の知らせを出すだけ）
const ACTIVATION_TOKEN_ARG: &str = "--activation-token=";
/// 動いている Mawok は、受け取ったらすぐ返す（出す処理はメインスレッドへ回す）ので、返事が無ければ固まっている
const METHOD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// 引数に `--toggle` があるか
pub fn requested(args: &[String]) -> bool {
    args.iter().any(|arg| arg == TOGGLE_ARG)
}

/// 引数で渡された、窓を前に出すための印
pub fn activation_token(args: &[String]) -> Option<&str> {
    args.iter()
        .find_map(|arg| arg.strip_prefix(ACTIVATION_TOKEN_ARG))
        .filter(|token| !token.is_empty())
}

/// 単一起動のプラグインが、動いている Mawok に引数を渡すときの D-Bus の名前とパス（tauri-plugin-single-instance の linux.rs と同じ作り方）
fn single_instance_address(identifier: &str) -> (String, String) {
    let name = format!("{identifier}.SingleInstance");
    let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
    (name, path)
}

/// `--toggle` で起動されたとき、動いている Mawok に知らせる。知らせたら true を返し、呼んだ側はそのまま終わる。
/// 単一起動のプラグインに任せると、GTK と WebView の準備を待ってから知らせるので、キーを押してから窓が出るまでが遅れる
pub fn forward_to_running(identifier: &str) -> bool {
    let mut args: Vec<String> = std::env::args().collect();
    if !requested(&args) {
        return false;
    }
    // X11 のデスクトップは DESKTOP_STARTUP_ID で渡す
    if let Some(token) = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|token| !token.is_empty()))
    {
        args.push(format!("{ACTIVATION_TOKEN_ARG}{token}"));
    }
    let (name, path) = single_instance_address(identifier);
    // 動いている Mawok が固まっていても、キーを押すたびに呼ばれたプロセスが長く残らないよう、すぐに諦める
    let Ok(connection) = zbus::blocking::connection::Builder::session()
        .map(|builder| builder.method_timeout(METHOD_TIMEOUT))
        .and_then(|builder| builder.build())
    else {
        return false;
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    match connection.call_method(
        Some(name.as_str()),
        path.as_str(),
        Some("org.SingleInstance.DBus"),
        "ExecuteCallback",
        &(args, cwd.to_string_lossy().as_ref()),
    ) {
        Ok(_) => true,
        // 名前を持つプロセスが無い。動いていないので、起動して出す
        Err(zbus::Error::MethodError(error, _, _))
            if matches!(
                error.as_str(),
                "org.freedesktop.DBus.Error.ServiceUnknown"
                    | "org.freedesktop.DBus.Error.NameHasNoOwner"
            ) =>
        {
            false
        }
        // 動いているのに返事が無い・失敗した。ここで起動を続けると、単一起動のプラグインがもう一度知らせて、2回切り替わる
        Err(error) => {
            eprintln!("couldn't reach the running Mawok: {error}");
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn toggle_is_requested_only_by_its_own_argument() {
        assert!(requested(&args(&["mawok", "--toggle"])));
        assert!(!requested(&args(&["mawok"])));
        assert!(!requested(&args(&["mawok", "--toggled"])));
    }

    #[test]
    fn an_activation_token_is_read_from_its_argument() {
        assert_eq!(
            activation_token(&args(&["mawok", "--toggle", "--activation-token=abc"])),
            Some("abc")
        );
        assert_eq!(
            activation_token(&args(&["mawok", "--activation-token="])),
            None
        );
        assert_eq!(activation_token(&args(&["mawok", "--toggle"])), None);
    }

    #[test]
    fn the_address_matches_the_single_instance_plugin() {
        assert_eq!(
            single_instance_address("com.amiiby.mawok.dev"),
            (
                "com.amiiby.mawok.dev.SingleInstance".to_string(),
                "/com/amiiby/mawok/dev/SingleInstance".to_string()
            )
        );
    }
}
