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
- While history is synced, selecting “Clear history” in Settings or setting the number to 0 also clears the history on your other devices (see “[Sync settings and history](#sync-settings-and-history)”).

## Use snippets

Save text you use often, then pick it from a list to insert it.

1. Press {macos:`Cmd+K`}{windows:`Ctrl+K`}{linux:`Ctrl+K`} to open the snippet list.
2. Type to filter, then press `Enter` to pick one. It is inserted at the cursor. If you have a selection, the snippet replaces it.

Add snippets under “Snippets” in Settings. You can also save the text you are writing right away by choosing “Save the text as a snippet” at the end of the list. If you have a selection, the selection is saved. If you typed in the filter, what you typed becomes the name.

## Sync settings and history

With Pro, you can sync your settings and history across the devices on your account.

1. Sign in to Mawok under “Account” in Settings. If you don't have Pro, get it from “View Pro pricing”.
2. Select “Create password”, choose a password, enter it twice, and select “Start syncing”.
3. Sign in on your other devices too, select “Enter password”, enter the same password, and select “Join syncing”.

To change the password, select “Change” next to “Sync password” under “Account” in Settings. You don't need to enter it again on your other devices.

If you forget your password, it cannot be recovered. In Settings, under “Account”, select “Delete...” next to “Sync data” to delete the sync data, then start syncing with a new password. The data on each device is kept. On your other devices, join syncing with the new password.

To continue with text you wrote on another device, press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} to copy and close, then press `↑` in the text window on the other device to bring it up from the history. Right after copying, it may not have arrived yet. Wait a moment and show the text window again.

- Synced: settings, keyboard shortcuts, replacements, snippets, and history. Turn each kind on or off under “Account” in Settings.
- Kept per device: launch at login. The hotkey and keyboard shortcuts sync only between {macos:Macs}{windows:Windows devices}{linux:Linux devices}.
- For settings, replacements, and snippets, turn off the cloud mark to stop syncing just that item or row.

If you change the same setting on different devices, the one changed last is used. To go back to earlier settings, restore them from a backup (see “[Settings](#settings)”).

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
::: macos
- **“Couldn't read your Mawok account sign-in information” appears**: After you reinstall the app, you will be asked to allow access to the Keychain. Allow it. If that doesn't help, sign in again under “Account” in Settings.
:::
::: windows
- **“Couldn't read your Mawok account sign-in information” appears**: Sign in again under “Account” in Settings.
:::
::: linux
- **“Couldn't read your Mawok account sign-in information” appears**: Check that a service that stores passwords, such as GNOME Keyring, is running. If it is, sign in again under “Account” in Settings.
:::
- **“Couldn't read the settings, so started with the defaults” appears**: Select “Restore from backup...” under “About” in Settings to go back to your earlier settings.
- **“Couldn't save the settings” appears**: Settings you change go back when you quit. Check that there is free disk space, then restart Mawok.
- **“Couldn't reach...” appears and trying again doesn't help**: Check that you are connected to the network. If you are, the Mawok server is having problems. Try again after a while.

When reporting a problem, attach the log. It does not contain your text. Open its location from “About” in Settings.

## What is sent and privacy

- Mawok does not send usage statistics or error reports.
- It sends your text outside the app only when you sync with Pro.
- While you sync with Pro, what you sync is encrypted and stored on Mawok's server. Mawok's server cannot read it.

::: linux
## Installing and updating

- Ubuntu: Add Mawok's apt repository by following the steps on mawok.amiiby.com, then install it with `sudo apt install mawok`. Updates arrive with your other apps through “Software Updater” or `sudo apt upgrade`.
- Arch Linux: Install `mawok-bin` from the AUR with an AUR helper (such as `yay`). Update it with the same helper.
:::

## Uninstalling

::: macos
1. If you signed in to Mawok, select “Sign out” under “Account”.
2. Choose “Quit” in the menu bar menu, then move `/Applications/Mawok.app` to the Trash.
3. To also remove settings and history, delete `~/Library/Application Support/com.amiiby.mawok/` and `~/Library/Logs/com.amiiby.mawok/`.
:::

::: windows
1. If you signed in to Mawok, select “Sign out” under “Account”.
2. Uninstall Mawok from “Apps” in Windows “Settings”. Settings and history are removed too.
:::

::: linux
1. If you signed in to Mawok, select “Sign out” under “Account”. Turn off “Launch at login” under “General”.
2. Choose “Quit” in the tray menu, then run `sudo apt remove mawok` on Ubuntu or `sudo pacman -R mawok-bin` on Arch Linux. To also remove the apt repository, follow the steps on mawok.amiiby.com.
3. To also remove settings and history, delete `~/.config/com.amiiby.mawok/` and `~/.local/share/com.amiiby.mawok/`.
:::
