#!/usr/bin/env python3
# GNOME の Wayland では、ほかのアプリの窓とフォーカスを読む口 (hyprctl のようなもの) が無く、GNOME Shell の Eval も閉じている。
# アクセシビリティ (AT-SPI) からアプリごとの窓を読み、押せるボタンを押す (linux-gnome.mjs が使う)。
#   atspi.py windows                 窓の一覧 (アプリ・題・見えているか・前面か) を JSON で出す
#   atspi.py press <ボタンの名前>     見えている窓のうち、その名前のボタンを1つ押す。押せたら 0、無ければ 1 で終わる
import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

# GTK のファイル選択の窓は DIALOG でなく FILE_CHOOSER の役割で出る
WINDOW_ROLES = {Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG, Atspi.Role.FILE_CHOOSER}


def top_windows():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            count = app.get_child_count()
        except Exception:
            continue
        for j in range(count):
            try:
                win = app.get_child_at_index(j)
                if win is not None and win.get_role() in WINDOW_ROLES:
                    yield app, win
            except Exception:
                # 読んでいる間に閉じた窓は飛ばす
                continue


def find_button(node, name, depth=0):
    if depth > 30:
        return None
    try:
        if node.get_role() == Atspi.Role.BUTTON and node.get_name() == name:
            return node
        for k in range(node.get_child_count()):
            found = find_button(node.get_child_at_index(k), name, depth + 1)
            if found is not None:
                return found
    except Exception:
        return None
    return None


if sys.argv[1] == "windows":
    windows = []
    for app, win in top_windows():
        states = win.get_state_set()
        windows.append(
            {
                "app": app.get_name(),
                "title": win.get_name(),
                "showing": states.contains(Atspi.StateType.SHOWING),
                "active": states.contains(Atspi.StateType.ACTIVE),
            }
        )
    print(json.dumps(windows, ensure_ascii=False))
elif sys.argv[1] == "press":
    for _, win in top_windows():
        if not win.get_state_set().contains(Atspi.StateType.SHOWING):
            continue
        button = find_button(win, sys.argv[2])
        if button is not None:
            button.get_action_iface().do_action(0)
            sys.exit(0)
    sys.exit(1)
