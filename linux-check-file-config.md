# Linux check of `file-config` (6b56195)

Checked on X1 Nano (Omarchy / Hyprland, webkit2gtk-4.1 2.54.1) with the dev build (`com.amiiby.mawok.dev`). The settings window was driven over WebDriver (tauri-driver + WebKitWebDriver 2.54.2 taken from Debian's `webkitgtk-webdriver`, since Arch drops `/usr/bin` from its package); the tray was read and clicked over D-Bus (dbusmenu). Only the GTK folder picker needed the user's hands (Return/Escape/Alt+O from `wtype` don't reach it).

## Results

| Item | Result |
| --- | --- |
| 1. `just ci-app` | Pass. A first run failed 76 browser tests because Vite found `@lucide/svelte/icons/folder-sync` mid-run and reloaded (local `node_modules/.vite` cache from main). The second run passed; no code issue. |
| 2. Default folder / files | Pass. Folder `~/.config/com.amiiby.mawok.dev`; `device.json` in `~/.local/share/com.amiiby.mawok.dev`. Changing settings from the UI created `settings.toml`, `snippets.toml`, `replacements.toml`; copying from the text window created `history/<device>.json` (mode 0600). |
| 3. inotify | Pass for reload: a hand edit of `settings.toml` was picked up in ~1 s and shown in the settings window. **Fail for comments, see finding 1.** |
| 4. Symlinks | Pass. `settings.toml` → `<elsewhere>/dotfiles/x.toml`: editing the target reloads; a UI save writes to the target and the link stays a link; deleting the target shows 「⚠ 設定の置き場 …/x.toml が見つかりません。見つかるまで、変えた設定は保存されません」 in the tray (log: `went away; waiting for it`); restoring it reloads within ~5 s and the tray item goes away. |
| 5. 「変更...」/「既定に戻す」 | Pass. 「変更...」 opens the GTK folder picker (in-process GTK dialog, not the portal); choosing an empty folder moved settings.toml / snippets.toml / replacements.toml / history there and `device.json` got `settings_dir`. Hand edits there reload. 「既定に戻す」 shows 「このフォルダーには設定があります」; 「このフォルダーの設定を使う」 switched back, `settings_dir` became null, and the watcher moved back (edits in the old folder no longer reload, edits to the default's symlink target do). See findings 2 and 3. |

## Findings (app code not changed)

1. **A UI save drops the comments of the key it rewrites.** Not Linux-specific.
   - Repro: `settings.toml` with `# comment above` / `text_font_size = 20 # trailing`, then change 「文字の大きさ (px)」 in the UI. Both comments disappear; comments of other keys and of `[hotkey]` stay.
   - Cause: `set_or_remove` (`src-tauri/src/settings_files.rs:242`) calls `Table::insert(name, item)`. In toml_edit 0.25.15 (`src/table.rs:429`), inserting into an occupied entry runs `entry.key_mut().fmt()` (clears the key's decor = the comment lines above) and replaces the whole item (the value's suffix decor = the trailing comment).
   - The test `keeps_comments_unknown_items_and_the_other_os_when_writing` only covers untouched keys.
   - Possible fix: when the key exists and both old and new are values, replace the value in place keeping its decor (e.g. `item.as_value_mut()` and copy `decor()` to the new value) instead of `insert`.
2. **The folder picker is not modal, and 「変更...」 stays enabled while it is open.** Clicking 「変更...」 again opens a second picker (seen: two "Select Folder" windows). `change()` (`src/lib/components/settings-folder.svelte:25`) doesn't set `busy` while picking, and `pick_settings_dir` (`src-tauri/src/lib.rs:1724`) doesn't call `set_parent`.
3. **The picker's title is English (“Select Folder”) in the Japanese UI**; its buttons are Japanese (GTK). `src-tauri/src/lib.rs:1724` doesn't call `set_title`.

## Not checked

- The hotkey part of item 3 (`[hotkey] linux = "…"`): the dev build can't register with the desktop portal (`App info not found for 'com.amiiby.mawok.dev'`), so whether the hand-edited hotkey takes effect wasn't observable. The file was read without errors.
