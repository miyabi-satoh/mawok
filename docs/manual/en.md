# How to use Mawok

## Getting started

From any app, you can bring up the text window, write, then copy the text and paste it into the app you came from.

::: linux
If your desktop asks to add a shortcut the first time Mawok starts, add it. On desktops that don't ask (such as GNOME on Ubuntu 24.04, or Hyprland), first assign the hotkey in your desktop's settings (see “[Assign the hotkey](#assign-the-hotkey)”).
:::

1. Press {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`}{linux:`Ctrl+Shift+Space`} to bring up the text window.
2. Type. `Enter` adds a line break.
3. Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`}. The text is copied, the text window closes, and you return to the app you came from. Paste it there.

You can also insert snippets and rewrite the text with AI or commands.
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
- Pressing the hotkey while the text window is in front also copies and returns. It copies even when the first line is `@ai` or `@sh`, without running it.
- To return without copying, press `Esc`. Your unfinished text is still there the next time you bring up the text window.
- Clicking another app also hides the window without copying, and your unfinished text remains (you can turn this off under “General” in Settings).

## Use text you copied earlier

Copied text is kept in history.

- Press `↑` at the start of the text box to show text you copied earlier. Each press goes further back; press `↓` at the end of the text box to go forward again. The “Previous” and “Next” buttons at the top do the same.
- Change how many are kept under “General” in Settings. Set it to 0 to keep no history.
- While history is synced, selecting “Clear history” in Settings or setting the number to 0 also clears the history on your other devices (see “[Sync settings and history](#sync-settings-and-history)”).

## Use snippets

Save text you use often, and instructions that rewrite the text with AI or a command, then pick them from a list.

1. Press {macos:`Cmd+K`}{windows:`Ctrl+K`}{linux:`Ctrl+K`} to open the snippet list.
2. Type to filter, then press `Enter` to pick one.

- An ordinary snippet is inserted at the cursor.
- A one-line snippet that starts with `@ai` or `@sh` runs the text with that addressee (see the next section, “[Write an addressee and run](#write-an-addressee-and-run)”). A selection is used if you have one; otherwise, all of the text is used. The result replaces the text. Press {macos:`Cmd+Z`}{windows:`Ctrl+Z`}{linux:`Ctrl+Z`} to undo it. Under “Snippets” in Settings, set each snippet's “Output” to “Replace”, “Insert”, or “Don't show”.

At first, “Proofread” (`@ai`) and “Sort lines” (`@sh sort`) are included. “Proofread” fixes spelling and grammar mistakes. It requires AI service setup (see “[Use AI](#use-ai)”).

Add snippets under “Snippets” in Settings. You can also save the text you are writing right away by choosing “Save the text as a snippet” at the end of the list. If you have a selection, the selection is saved. If you typed in the filter, what you typed becomes the name.

## Write an addressee and run

Write an addressee on the first line of the text, then press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} or select the “Run” button to run it instead of copying. The lines below the first are what the addressee receives.

| First line | What it does |
| --- | --- |
| `@ai instruction` | Asks AI (an AI action) and replaces the text with the result. For example: `@ai Rewrite this politely` |
| `@sh command` | Runs the command and replaces the text with the result. For example: {macos:`@sh sort`}{windows:`@sh dir`}{linux:`@sh sort`} |

- Type `@` at the start of the first line to see addressee suggestions. Press `Tab` or `Enter` to choose one.
- On an `@sh` line, type the start of a file or folder name and press `Tab` to complete it. If several match, they appear below the first line. Press `Tab` again to go through them.
- The text from before the run stays in the history, so you can bring it back and try again.
- How AI replies depends on the AI service and model. If you get a preamble or explanation you don’t want, describe the form you want in the instruction too, such as `@ai Translate into Japanese. Only the translation`.
- The command receives the lines below the first, and its output becomes the result.{macos:}{windows: Commands run in cmd.}{linux:}
::: macos
- If a command is not found, write its full path.
:::
::: linux
- If a command is not found, write its full path.
:::
::: windows
- Commands that come with Windows (such as `sort` and `findstr`) garble Japanese text when you run them from the first line. Save the command as a snippet, and set that snippet's “Text encoding” to “Shift_JIS” under “Snippets” in Settings. The built-in “Sort lines” snippet is already set up this way.
:::

Commands run in your home folder. The folder button at the bottom left shows the current folder. To run commands in another folder, select the button and choose a folder. Folders you have used appear in the button menu so you can choose them again. To go back to your home folder, choose “Back to home folder” in the menu.

To move from the keyboard, press {macos:`Cmd+D`}{windows:`Ctrl+D`}{linux:`Ctrl+D`}, type the path, and press `Enter`.

- A relative path starts from the current folder.
- Type the start of a folder name and press `Tab` to complete it. If several folders match, they appear below the box. Press `Tab` again to go through them. Press `Enter` to choose the selected folder, then press `Enter` again to move there.
- While you type, the rest of the path appears dimmed when only one folder matches. Press `→` or `Tab` to accept it.
- The title bar shows the folder you moved to.
- Clear the box and press `Enter` to go back to your home folder. Quitting Mawok also goes back to it.

## Use AI

1. Under “AI” in Settings, choose a service under “AI service”.
2. If you chose Mawok, select “Sign in” under “Account” in Settings, sign in on the page that opens, then click “Link this device”. For another service, enter that service's API key.
3. Read the explanation of what is sent that appears under “AI” in Settings, then select “Agree”.

When you choose Mawok, you do not need an API key. What you use is deducted from your account credit. Select “Buy credits” under “AI” in Settings to open the purchase page in your browser.

To use a service compatible with OpenAI (such as DeepSeek, OpenRouter, or Ollama), choose “OpenAI” under “AI service”, then change “Base URL” to that service's API URL and enter that service's API key and “Model”. For a service that needs no key (such as Ollama on your computer), still enter something as the API key.

## Sync settings and history

With Pro, you can sync your settings and history across the devices on your account.

1. Sign in to Mawok under “Account” in Settings. If you don't have Pro, get it from “View Pro pricing”.
2. Select “Create password”, choose a password, enter it twice, and select “Start syncing”.
3. Sign in on your other devices too, select “Enter password”, enter the same password, and select “Join syncing”.

To change the password, select “Change” next to “Sync password” under “Account” in Settings. You don't need to enter it again on your other devices.

If you forget your password, it cannot be recovered. In Settings, under “Account”, select “Delete...” next to “Sync data” to delete the sync data, then start syncing with a new password. The data on each device is kept. On your other devices, join syncing with the new password.

To continue with text you wrote on another device, press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} to copy and close, then press `↑` in the text window on the other device to bring it up from the history. Right after copying, it may not have arrived yet. Wait a moment and show the text window again.

- Synced: settings, keyboard shortcuts, replacements, snippets, and history. Turn each kind on or off under “Account” in Settings.
- Kept per device: launch at login and API keys for AI services. The hotkey and keyboard shortcuts sync only between {macos:Macs}{windows:Windows devices}{linux:Linux devices}.
- For settings, replacements, and snippets, turn off the cloud mark to stop syncing just that item or row.

If you change the same setting on different devices, the one changed last is used. To go back to earlier settings, restore them from a backup (see “[Settings](#settings)”).

## Keyboard shortcuts

| Action | Key |
| --- | --- |
| Bring up the text window (copy and close if it is in front) | {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`}{linux:`Ctrl+Shift+Space`} |
| Copy and close (run when the first line is `@ai` or `@sh`) | {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`}{linux:`Ctrl+Enter`} |
| Close without copying | `Esc` |
| Go back / forward in history (at the start / end of the text box) | `↑` / `↓` |
| Go back / forward in history (wherever the cursor is) | {macos:`Cmd+Option+↑` / `Cmd+Option+↓`}{windows:`Ctrl+Alt+↑` / `Ctrl+Alt+↓`}{linux:`Ctrl+Alt+↑` / `Ctrl+Alt+↓`} |
| Open the snippet list | {macos:`Cmd+K`}{windows:`Ctrl+K`}{linux:`Ctrl+K`} |
| Go to folder | {macos:`Cmd+D`}{windows:`Ctrl+D`}{linux:`Ctrl+D`} |
| Cancel a run (while it is running) | `Esc` |
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
- **“Couldn't read the API key” appears**: After you reinstall the app, you will be asked to allow access to the Keychain. Allow it. If that doesn't help, enter the key again under “AI” in Settings.
:::
::: windows
- **“Couldn't read the API key” appears**: Enter the key again under “AI” in Settings.
:::
::: linux
- **“Couldn't read the API key” appears**: Check that a service that stores passwords, such as GNOME Keyring, is running. If it is, enter the key again under “AI” in Settings.
:::
- **“Couldn't read the settings, so started with the defaults” appears**: Select “Restore from backup...” under “About” in Settings to go back to your earlier settings.
- **“Couldn't save the settings” appears**: Settings you change go back when you quit. Check that there is free disk space, then restart Mawok.
- **“Couldn't connect...”, “Couldn't reach...”, or “...didn't respond in time” appears and trying again doesn't help**: Check that you are connected to the network. If you are, the Mawok server or the AI service is having problems. Try again after a while.
- **“Your Mawok account has no credit left” appears**: Select “Buy credits” under “AI” in Settings to add more.
- **“The AI service's spending or credit limit was reached” appears**: Trying again won't help. Check the balance and limits in your AI service account.
- **“Couldn't find the current folder” appears**: The folder was moved or deleted. Use “Go to folder” to choose a folder again.
::: macos
- **“The command wasn't found” appears**: Write the command with its full path.
:::
::: linux
- **“The command wasn't found” appears**: Write the command with its full path.
:::

When reporting a problem, attach the log. It does not contain your text. Open its location from “About” in Settings.

## What is sent and privacy

- Mawok does not send usage statistics or error reports.
- It sends your text outside the app only when you run an AI action with `@ai` (to the AI service you chose) or sync with Pro.
- While you sync with Pro, what you sync is encrypted and stored on Mawok's server. Mawok's server cannot read it.
- Before you choose an AI service and select “Agree”, the screen explains how the service handles what you send, including whether it uses it for training and how long it retains it.

::: linux
## Installing and updating

- Ubuntu: Add Mawok's apt repository by following the steps on mawok.amiiby.com, then install it with `sudo apt install mawok`. Updates arrive with your other apps through “Software Updater” or `sudo apt upgrade`.
- Arch Linux: Install `mawok-bin` from the AUR with an AUR helper (such as `yay`). Update it with the same helper.
:::

## Uninstalling

::: macos
1. If you entered API keys, under “AI” in Settings, choose each service you entered a key for under “AI service” and select “Remove”. If you signed in to Mawok, select “Sign out” under “Account”.
2. Choose “Quit” in the menu bar menu, then move `/Applications/Mawok.app` to the Trash.
3. To also remove settings and history, delete `~/Library/Application Support/com.amiiby.mawok/` and `~/Library/Logs/com.amiiby.mawok/`.
:::

::: windows
1. If you entered API keys, under “AI” in Settings, choose each service you entered a key for under “AI service” and select “Remove”. If you signed in to Mawok, select “Sign out” under “Account”.
2. Uninstall Mawok from “Apps” in Windows “Settings”. Settings and history are removed too.
:::

::: linux
1. If you entered API keys, under “AI” in Settings, choose each service you entered a key for under “AI service” and select “Remove”. If you signed in to Mawok, select “Sign out” under “Account”. Turn off “Launch at login” under “General”.
2. Choose “Quit” in the tray menu, then run `sudo apt remove mawok` on Ubuntu or `sudo pacman -R mawok-bin` on Arch Linux. To also remove the apt repository, follow the steps on mawok.amiiby.com.
3. To also remove settings and history, delete `~/.config/com.amiiby.mawok/` and `~/.local/share/com.amiiby.mawok/`.
:::
