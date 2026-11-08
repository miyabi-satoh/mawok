# How to use Mawok

## Getting started

From any app, you can bring up the text window, write, then copy the text and paste it into the app you came from.

::: linux
If your desktop asks to add a shortcut the first time Mawok starts, add it. On desktops that don't ask (such as GNOME on Ubuntu 24.04, or Hyprland), first assign the hotkey in your desktop's settings (see “[Assign the hotkey](#assign-the-hotkey)”).
:::

1. Press {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`}{linux:`Ctrl+Shift+Space`} to bring up the text window.
2. Type. `Enter` adds a line break.
3. Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`}. The text is copied, the text window closes, and you return to the app you came from. Paste it there.

You can also insert snippets and bring back text you copied earlier.
Mawok stays in the {macos:menu bar}{windows:system tray}{linux:tray} and starts automatically when you log in (you can turn this off under “General” in Settings).

::: linux
## Assign the hotkey

If `mawok --toggle` appears in the hotkey field under “Keyboard shortcuts” in Settings, assign a key to this command in your desktop's settings. Do the same if you canceled the shortcut your desktop asked to add.

On GNOME:

1. In “Settings”, open “Keyboard” and select “View and Customize Shortcuts”.
2. Choose “Custom Shortcuts”, then select “Add Shortcut”.
3. Enter `Mawok` for “Name” and `mawok --toggle` for “Command”.
4. Select “Set Shortcut”, press the key you want, such as `Ctrl+Shift+Space`, then select “Add”.

On Hyprland, add a key binding to your configuration file. In `hyprland.lua`, add this line:

```lua
hl.bind("CTRL + SHIFT + SPACE", hl.dsp.exec_cmd("mawok --toggle"))
```

If you use `hyprland.conf`, add this line instead:

```
bind = CTRL SHIFT, SPACE, exec, mawok --toggle
```

On other desktops, also assign a key to `mawok --toggle` in the keyboard settings. On X11 desktops, the hotkey under “Keyboard shortcuts” in Settings works as is.
:::

## Write and copy

- Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} or click “Copy” to copy the text and return to the app you came from.
- Pressing the hotkey while the text window is in front also copies and returns.
- To return without copying, press `Esc`. Your unfinished text is still there the next time you bring up the text window.
- Clicking another app also hides the window without copying, and your unfinished text remains (you can turn this off under “General” in Settings).

## Use text you copied earlier

Copied text is kept in history.

- Press `↑` at the start of the text box to show text you copied earlier. Each press goes further back; press `↓` at the end of the text box to go forward again. The “Previous” and “Next” buttons at the top do the same.
- Change how many are kept under “General” in Settings. Set it to 0 to keep no history.
- While history is synced, selecting “Clear history” in Settings or setting the number to 0 also clears the history on your other devices (see “[Change the settings folder](#change-the-settings-folder)”).

## Use snippets

Save text you use often, then pick it from a list to insert it.

1. Press {macos:`Cmd+K`}{windows:`Ctrl+K`}{linux:`Ctrl+K`} to open the snippet list.
2. Type to filter, then press `Enter` to pick one. It is inserted at the cursor. If you have a selection, the snippet replaces it.

Add snippets under “Snippets” in Settings. You can also save the text you are writing right away by choosing “Save the text as a snippet” at the end of the list. If you have a selection, the selection is saved. If you typed in the filter, what you typed becomes the name.

## Change the settings folder

Settings and history are files in the settings folder. Choose a folder in cloud storage such as iCloud Drive, OneDrive, or Dropbox as the settings folder to sync them with your other devices.

1. Under “Settings folder” in “General” in Settings, select “Change...” and choose a folder in your cloud storage.
2. Choose the same folder on your other devices. When asked whether to use the settings in that folder, select “Use settings in this folder”.

To continue with text you wrote on another device, press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} to copy and close, then press `↑` in the text window on the other device to bring it up from the history. How long it takes to arrive depends on your cloud storage.

- Synced: settings, keyboard shortcuts, replacements, snippets, and history. The hotkey and keyboard shortcuts are shared only between {macos:Macs}{windows:Windows devices}{linux:Linux devices}.
- Kept per device: launch at login and the folder you chose.
- Settings are in `settings.toml`, snippets in `snippets.toml`, and replacements in `replacements.toml`, as text files. You can also edit them in a text editor; they take effect as soon as you save. You can manage them with a dotfiles tool too.
- History is kept in the `history` folder inside the settings folder, one file per device. If you manage your dotfiles with Git, leave the `history` folder out.

If two devices change the same file at the same time, the one saved last is kept. To go back to earlier settings, restore them from a backup (see “[Settings](#settings)”).

## Keyboard shortcuts

| Action | Key |
| --- | --- |
| Bring up the text window (copy and close if it is in front) | {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`}{linux:`Ctrl+Shift+Space`} |
| Copy and close | {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} |
| Close without copying | `Esc` |
| Go back / forward in history (at the start / end of the text box) | `↑` / `↓` |
| Go back / forward in history (wherever the cursor is) | {macos:`Cmd+Option+↑` / `Cmd+Option+↓`}{windows:`Ctrl+Alt+↑` / `Ctrl+Alt+↓`}{linux:`Ctrl+Alt+↑` / `Ctrl+Alt+↓`} |
| Open the snippet list | {macos:`Cmd+K`}{windows:`Ctrl+K`}{linux:`Ctrl+K`} |
| Open Settings | {macos:`Cmd+,`}{windows:`Ctrl+,`}{linux:`Ctrl+,`} |

You can change the keys under “Keyboard shortcuts” in Settings.

## Settings

Choose “Settings…” in the {macos:menu bar}{windows:system tray}{linux:tray} menu, or press {macos:`Cmd+,`}{windows:`Ctrl+,`}{linux:`Ctrl+,`} in the text window.
You can change the hotkey, the text's appearance, and the cleanup applied when copying (such as removing trailing whitespace, unifying full-width and half-width characters, and replacements). Changes take effect immediately.
Settings you've changed from the default show a vertical line at the left edge of the row.

Settings are backed up automatically every day. To go back to earlier settings, select “Restore from backup...” under “About” in Settings, choose the date you want, then select “Restore these settings”. Select “Back up now” to keep the settings as they are now.

## If something does not work

- **The hotkey does not work**: {macos:Another}{windows:Another}{linux:If you set it in Mawok's Settings, another} app uses the same key. When this happens, ⚠ appears in the {macos:menu bar}{windows:system tray}{linux:tray} menu. Choose a different key under “Keyboard shortcuts” in Settings.
::: linux
- **The key you assigned in your desktop's settings does not work**: Another shortcut on your desktop uses the same key. Choose a different key.
- **Closing the text window doesn't take you back to the app you came from**: Your desktop decides which window comes forward after it closes. Click the app you came from, then paste.
- **Mawok's icon does not appear in the tray**: On GNOME, run `gnome-extensions enable ubuntu-appindicators@ubuntu.com` to turn on the extension that shows the tray. On Hyprland, add the tray to your bar's configuration (such as waybar).
:::
- **“Couldn't read the settings file ...” appears**: There is a mistake from editing it in a text editor. The log shows the line that can't be read. Fix it and save, and Mawok reads it again right away. If you can't fix it, delete the file, or select “Restore from backup...” under “About” in Settings to go back to your earlier settings.
- **“The settings folder ... isn't available” appears**: The drive with the folder you chose isn't connected, or the folder was deleted. Once it's connected, Mawok reads it again right away. If you deleted the folder, choose it again under “Settings folder” in “General” in Settings. If your settings files are symlinks, this also appears when the file a link points to is missing.
::: macos
- **“Mawok doesn't have permission to read ...” appears**: Your settings files are symlinks to a folder outside Mawok. Select “Allow access...” under “Settings folder” in “General” in Settings, then select “Open” in the window that appears.
:::
- **Settings changed on another device don't arrive**: Under “Settings folder” in “General” in Settings, check that both devices chose the same folder. If they did, your cloud storage hasn't synced yet. Check its status in your cloud storage app.

When reporting a problem, attach the log. It does not contain your text. Open its location from “About” in Settings.

## What is sent and privacy

- Mawok does not send usage statistics or error reports.
- Mawok does not send your text or settings anywhere. If the settings folder is in cloud storage, that cloud storage sends your settings and history.

::: linux
## Installing and updating

- Ubuntu: Add Mawok's apt repository by following the steps on mawok.amiiby.com, then install it with `sudo apt install mawok`. Updates arrive with your other apps through “Software Updater” or `sudo apt upgrade`.
- Arch Linux: Install `mawok-bin` from the AUR with an AUR helper (such as `yay`). Update it with the same helper.
:::

## Uninstalling

::: macos
1. Choose “Quit” in the menu bar menu, then move `/Applications/Mawok.app` to the Trash.
2. To also remove settings and history, delete `~/Library/Containers/com.amiiby.mawok/`. If you changed the settings folder, also delete the settings files and the `history` folder there.
:::

::: windows
1. Uninstall Mawok from “Apps” in Windows “Settings”. Settings and history are removed too.
2. If you changed the settings folder, the settings files and the `history` folder there are kept. Delete them if you don't need them.
:::

::: linux
1. Turn off “Launch at login” under “General”.
2. Choose “Quit” in the tray menu, then run `sudo apt remove mawok` on Ubuntu or `sudo pacman -R mawok-bin` on Arch Linux. To also remove the apt repository, follow the steps on mawok.amiiby.com.
3. To also remove settings and history, delete `~/.config/com.amiiby.mawok/` and `~/.local/share/com.amiiby.mawok/`. If you changed the settings folder, also delete the settings files and the `history` folder there.
:::
