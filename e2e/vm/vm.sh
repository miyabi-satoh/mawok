#!/usr/bin/env bash
# Linux の確認 (just linux-check-vm) を回す VM を作る・起動する・止める。e2e/README.md「Linux の確認」
#
#   vm.sh <名前> create            Ubuntu・Arch の cloud image から作る (初回だけ。cloud-init で入れ終えると止まる)
#   vm.sh <名前> start [--headless] 起動する (既定は画面つき。--headless は画面なしで裏で動かす)
#   vm.sh <名前> stop              電源を切る
#   vm.sh <名前> ssh [コマンド]     ssh でつなぐ (ユーザーとパスワードは mawok)
#   vm.sh <名前> port              ssh のポートを出す
#
# 名前: ubuntu-2404 (GNOME 46)・ubuntu-2604 (GNOME 50)・arch-hyprland (Hyprland)。
# ディスクは $MAWOK_VM_DIR/<名前> (既定は ~/VMs) に置く。リポジトリの外に置くのは、大きく、git に入れないため
set -euo pipefail

NAME=${1:?"VM の名前 (ubuntu-2404・ubuntu-2604・arch-hyprland)"}
ACTION=${2:?"create・start・stop・ssh・port"}
shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="${MAWOK_VM_DIR:-$HOME/VMs}/$NAME"
MEM=${MEM:-4G}
CPUS=${CPUS:-4}

# 画面なしで起動するときの画面と GPU。Hyprland は 3D 描画が要るので、その VM は virgl を egl-headless で使う
HEADLESS_DISPLAY="-display none -device virtio-vga"
case "$NAME" in
ubuntu-2404)
	SSH_PORT=2222 HTTP_PORT=8622 USER_DATA=user-data-ubuntu.yaml
	IMAGE=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
	;;
ubuntu-2604)
	SSH_PORT=2223 HTTP_PORT=8623 USER_DATA=user-data-ubuntu.yaml
	IMAGE=https://cloud-images.ubuntu.com/resolute/current/resolute-server-cloudimg-amd64.img
	;;
arch-hyprland)
	SSH_PORT=2224 HTTP_PORT=8624 USER_DATA=user-data-arch-hyprland.yaml
	IMAGE=https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2
	HEADLESS_DISPLAY="-display egl-headless -device virtio-vga-gl"
	;;
*)
	echo "知らない VM です: $NAME" >&2
	exit 2
	;;
esac

SSH=(ssh -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -p "$SSH_PORT" mawok@localhost)

running() {
	[[ -f "$VM_DIR/qemu.pid" ]] && kill -0 "$(cat "$VM_DIR/qemu.pid")" 2>/dev/null
}

qemu_base() {
	qemu-system-x86_64 \
		-machine q35,accel=kvm -cpu host -smp "$CPUS" -m "$MEM" \
		-drive file="$VM_DIR/disk.qcow2",if=virtio,format=qcow2 \
		-nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:"$SSH_PORT"-:22 \
		-device virtio-tablet-pci -device virtio-keyboard-pci \
		-qmp unix:"$VM_DIR/qmp.sock",server=on,wait=off \
		-name "$NAME" "$@"
}

# 公開されている SHA256 と比べて、cloud image を落とす
download_image() {
	local sums
	case "$IMAGE" in
	*ubuntu.com*) sums="$(dirname "$IMAGE")/SHA256SUMS" ;;
	*) sums="$IMAGE.SHA256" ;;
	esac
	curl -fSL -o "$VM_DIR/base.img" "$IMAGE"
	local expected
	expected=$(curl -fsSL "$sums" | grep -E "[ *]$(basename "$IMAGE")\$|^[0-9a-f]{64}\$" | head -1 | awk '{print $1}')
	echo "$expected  $VM_DIR/base.img" | sha256sum -c
}

create() {
	if [[ -e "$VM_DIR/disk.qcow2" ]]; then
		echo "$VM_DIR/disk.qcow2 があります。作り直すなら先に消してください。" >&2
		exit 1
	fi
	local driver
	driver=$(command -v tauri-driver) || {
		echo "tauri-driver がありません (cargo install tauri-driver --locked)。VM に写して使います" >&2
		exit 1
	}
	# 前の回の配り口が残っていると、新しい配り口が起動できず、cloud-init が設定を受け取れないまま進む
	if (exec 3<>"/dev/tcp/127.0.0.1/$HTTP_PORT") 2>/dev/null; then
		echo "ポート $HTTP_PORT が使われています。前の回の python3 -m http.server が残っていれば止めてください" >&2
		exit 1
	fi
	mkdir -p "$VM_DIR"
	[[ -f "$VM_DIR/base.img" ]] || download_image
	qemu-img create -f qcow2 -F qcow2 -b "$VM_DIR/base.img" "$VM_DIR/disk.qcow2" 40G
	local seed="$VM_DIR/seed"
	mkdir -p "$seed"
	printf 'instance-id: %s\nlocal-hostname: %s\n' "$NAME-$(date +%s)" "$NAME" >"$seed/meta-data"
	sed -e "s|@SSH_KEY@|$(cat ~/.ssh/id_ed25519.pub)|" -e "s|@HTTP_PORT@|$HTTP_PORT|g" "$HERE/$USER_DATA" >"$seed/user-data"
	: >"$seed/vendor-data"
	# tauri-driver は配る版が無く、Aero で cargo install したものを写す (cloud-init が HTTP で取りに来る)
	cp "$driver" "$seed/tauri-driver"
	# cloud-init の NoCloud を HTTP で渡す (seed の ISO を作る道具が無くても済むため)。ゲストからはホストが 10.0.2.2 に見える
	python3 -m http.server --bind 127.0.0.1 --directory "$seed" "$HTTP_PORT" >"$VM_DIR/seed-http.log" 2>&1 &
	HTTP_PID=$!
	trap 'kill "$HTTP_PID" 2>/dev/null || true' EXIT
	# 入れ終えると cloud-init が電源を切るので、qemu が終わるまで待つ。入れる間は 3D 描画が要らないので GPU を使わない
	# (egl-headless は電源を切るときに qemu が落ちることがある)
	qemu_base -display none -device virtio-vga \
		-smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:$HTTP_PORT/" \
		-serial file:"$VM_DIR/create-console.log"
	# 設定の手順が最後まで通ると MAWOK_VM_READY を出す (user-data の runcmd)。設定を受け取れなかったときや、
	# 途中で失敗したときは出ない
	if ! grep -aq 'MAWOK_VM_READY' "$VM_DIR/create-console.log"; then
		echo "設定の手順が最後まで通りませんでした。$VM_DIR/create-console.log を見てください" >&2
		exit 1
	fi
	echo "作り終えました。vm.sh $NAME start で起動します"
}

start() {
	if running; then
		echo "$NAME は動いています"
		return
	fi
	rm -f "$VM_DIR/egl-headless"
	if [[ "${1:-}" == "--headless" ]]; then
		[[ "$HEADLESS_DISPLAY" == *egl-headless* ]] && touch "$VM_DIR/egl-headless"
		# shellcheck disable=SC2086
		qemu_base $HEADLESS_DISPLAY -daemonize -pidfile "$VM_DIR/qemu.pid"
	else
		qemu_base -display gtk,gl=on -device virtio-vga-gl -pidfile "$VM_DIR/qemu.pid" &
	fi
	# ssh が通り、ログインしたセッションが立つまで待つ
	for _ in $(seq 1 60); do
		if "${SSH[@]}" 'test -S /run/user/1000/bus' </dev/null 2>/dev/null; then
			echo "$NAME を起動しました (ssh -p $SSH_PORT mawok@localhost)"
			return
		fi
		sleep 3
	done
	echo "$NAME にログインしたセッションが立ちません" >&2
	exit 1
}

stop() {
	running || return 0
	if [[ -f "$VM_DIR/egl-headless" ]]; then
		# egl-headless の qemu は、終わるときの後始末で手元の Mesa の中で落ちる (コアダンプと通知が出る)。中の OS を停止
		# (halt) させてディスクを書き終えたら、qemu を後始末なしで終わらせる
		"${SSH[@]}" 'sudo systemctl halt' </dev/null 2>/dev/null || true
		for _ in $(seq 1 30); do
			"${SSH[@]}" true </dev/null 2>/dev/null || break
			sleep 2
		done
		sleep 5
		kill -KILL "$(cat "$VM_DIR/qemu.pid")" 2>/dev/null || true
		rm -f "$VM_DIR/egl-headless"
		return 0
	fi
	"${SSH[@]}" 'sudo poweroff' </dev/null 2>/dev/null || true
	for _ in $(seq 1 30); do
		running || return 0
		sleep 2
	done
	kill "$(cat "$VM_DIR/qemu.pid")"
}

case "$ACTION" in
create) create ;;
start) start "$@" ;;
stop) stop ;;
ssh) exec "${SSH[@]}" "$@" ;;
port) echo "$SSH_PORT" ;;
*)
	echo "知らない操作です: $ACTION" >&2
	exit 2
	;;
esac
