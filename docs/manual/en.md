# How to use Mawok

## Getting started

Mawok is a place to write text before you send it to a terminal or another app.
When voice input cannot type directly into an app, or when it is easy to forget whether the IME is on, write it in Mawok first and then paste it.

1. Press {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`} to bring up the text window.
2. Type. Enter adds a line break.
3. Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} to copy and close the text window, then paste it in the app you returned to.

You can also insert snippets and rewrite the text with AI or commands.
Mawok stays in the {macos:menu bar}{windows:system tray} and starts automatically when you log in (you can turn this off under "General" in Settings).

## Write and copy

- Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} or click "Copy" to copy the text and return to the previous app. The hotkey does the same when the text window is in front.
- To return without copying, press `Esc`. Your unfinished text remains there the next time you bring up the window.
- Clicking another app also hides the window without copying (you can turn this off under "General" in Settings).

## Use text you copied earlier

Copied text is kept in history.

- Press `↑` at the start of the text box or `↓` at its end to show the previous or next text.
- Change how many are kept under "General" in Settings. Set it to 0 to keep no history.
- While history is synced, selecting "Clear history" in Settings or setting the number to 0 also clears the history on your other devices (see "Sync settings and history").

## Use snippets

Save text you use often, and instructions that send the text to AI or a command, then pick them from a list.

1. Press {macos:`Cmd+K`}{windows:`Ctrl+K`} to open the snippet list.
2. Type to filter, then press Enter to pick one.

- An ordinary snippet is inserted at the cursor.
- A one-line snippet that starts with `@ai` or `@sh` sends the text to that addressee (see the next section, "Write an addressee and run"). A selection is used if you have one; otherwise, all of the text is used. The result appears in the text box. Press {macos:`Cmd+Z`}{windows:`Ctrl+Z`} to undo it.

At first, "Translate to English" (`@ai`) and "Sort lines" (`@sh sort`) are included. Translating requires AI service setup (see "Use AI").

Add snippets under "Snippets" in Settings. You can also save the text you are writing from "Save the text as a snippet" at the end of the list.

## Write an addressee and run

Write an addressee on the first line of the text, then press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} or select the "Run" button. When the first line is an addressee, the key runs it instead of copying. The lines below the first are what the addressee receives.

| First line | What it does |
| --- | --- |
| `@ai instruction` | Asks AI (an AI action) and replaces the text with the result. For example: `@ai Rewrite this politely` |
| `@sh command` | Runs the command and replaces the text with the result. For example: `@sh sort` |

- Type `@` at the start of the first line to see addressee suggestions. Press `Tab` or `Enter` to enter one.
- The text you ran stays in the history, so you can bring it back and edit it.
- A command receives the lines below the first on standard input and returns its standard output as the result.{macos:}{windows: On Windows, commands run in cmd.}
::: macos
- If a command is not found, write its full path.
:::

Commands run in your home folder. The folder button at the bottom left shows the current folder. To run commands in another folder, select the button and choose a folder. Folders you have used appear in the button menu so you can choose them again. Choose "Back to Home Folder" in the menu to go back.

From the keyboard, press {macos:`Cmd+D`}{windows:`Ctrl+D`}, type the path, and press `Enter`.

- A relative path starts from the current folder.
- Type the start of a folder name and press `Tab` to complete it. If several folders match, they appear below the box. Press `Tab` again to go through them. Press `Enter` to choose the selected folder, then press `Enter` again to move there.
- While you type, the rest of the path appears dimmed when only one folder matches. Press `→` or `Tab` to accept it.
- The title bar shows the folder.
- Clear the box and press `Enter` to go back to your home folder. Quitting Mawok also goes back to it.

## Use AI

1. Under "AI" in Settings, choose a service under "AI service".
2. If you choose Mawok, select "Sign in" under "Account" in Settings, sign in on the page that opens, then click "Link this device". For another service, enter its API key.
3. Under "AI" in Settings, read the explanation of what is sent, then select "Agree".

When you choose Mawok, you do not need an API key. What you use is deducted from your account credit. Select "Buy credits" under "Account" in Settings to open the purchase page in your browser.

## Add a device

To sync settings and history (see the next section, "Sync settings and history") between your own devices, connect them to the same network and add them.

1. On both devices, open "Devices" in Settings.
2. On one device, select "Show verification code".
3. On the other device, enter that verification code and select "Connect".

From the third device onward, show a verification code on a device you have already added, and enter it on the new device.

Devices you have added appear automatically under "Added devices" in "Devices" in Settings when they are on the same network. To disconnect all other devices, select "Disconnect" next to "Disconnect all devices" under "Devices" in Settings, then add the devices you still use again.

{macos:If asked to allow access to the local network, allow it.}{windows:If asked to allow access through the firewall, allow it.}

## Sync settings and history

With Pro, your settings and history stay the same across the devices on your account.

1. Sign in to Mawok under "Account" in Settings. With Pro, syncing starts.
2. To use another device too, sign in on that device, then add it by following the steps in "Add a device". If you have already added it, syncing starts when you sign in.

The device you added receives the same settings and history.

To continue with text you wrote on another device, press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} to copy and close, then press `↑` in the text window on the other device to bring it up from the history. Right after copying, it may not have arrived yet. Wait a few seconds and show the text window again.

- Synced: settings, keyboard shortcuts, replacements, snippets, and history. Turn each kind on or off under "Account" in Settings.
- Kept per device: launch at login and API keys for AI services. The hotkey and keyboard shortcuts sync only between {macos:Macs}{windows:Windows devices}.
- For settings, replacements, and snippets, turn off the cloud mark to stop syncing just that item or row. To stop syncing a whole kind, turn it off.

If you change the same setting on different devices, "Choose Which to Use..." appears under "Account" in Settings. Select it, choose "This device" or "Other device" for each item, then select "Apply Selected Settings". You can also open it from "Choose Which Settings to Use…" in the {macos:menu bar}{windows:system tray} menu.

To go back to settings from before sync changed them, select "Restore settings from before a sync..." under "Account" in Settings. Choose the date you want, then select "Restore these settings".

## Keyboard shortcuts

| Action | Key |
| --- | --- |
| Bring up the text window (copy and close if it is in front) | {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`} |
| Copy and close (run when the first line is `@ai` or `@sh`) | {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} |
| Close without copying | `Esc` |
| Show text you copied earlier (↑ at the start of the text box, ↓ at the end) | `↑` / `↓` |
| Previous / next in history (wherever the cursor is) | {macos:`Cmd+Option+↑` / `Cmd+Option+↓`}{windows:`Ctrl+Alt+↑` / `Ctrl+Alt+↓`} |
| Open the snippet list | {macos:`Cmd+K`}{windows:`Ctrl+K`} |
| Go to folder | {macos:`Cmd+D`}{windows:`Ctrl+D`} |
| Cancel a run (while it is running) | `Esc` |
| Open Settings | {macos:`Cmd+,`}{windows:`Ctrl+,`} |

You can change the keys under "Keyboard" in Settings.

## Settings

Choose "Settings…" in the {macos:menu bar}{windows:system tray} menu, or press {macos:`Cmd+,`}{windows:`Ctrl+,`} in the text window.
You can change the hotkey, the text's appearance, and the cleanup applied when copying (such as removing trailing whitespace, unifying full-width and half-width characters, and replacements). Changes take effect immediately.
Settings you've changed from the default show a vertical line at the left edge of the row.

## If something does not work

- **The hotkey does not work**: Another app uses the same key. ⚠ appears in the {macos:menu bar}{windows:system tray} menu. Choose a different key under "Keyboard" in Settings.
- **Cannot add a device**: Check that Mawok is running on the other device and that both devices are on the same network.{macos: Also check that Mawok is enabled in System Settings > Privacy & Security > Local Network.}{windows:}
::: macos
- **"Couldn't read the API key" appears**: After you reinstall the app, you will be asked to allow access to the Keychain. Allow it.
:::

When reporting a problem, attach the log. It does not contain your text. Open its location from "About" in Settings.

## What is sent and privacy

- Mawok does not send usage statistics or error reports.
- It sends your text outside the app only when you run an AI action with `@ai` (to the AI service you chose) or sync with Pro.
- While you sync with Pro, what you sync is encrypted and stored on Mawok's server. Mawok's server cannot read it.
- Before you choose an AI service and select "Agree", the screen explains how the service handles what you send, including whether it uses it for training and how long it retains it.

## Settings file

Settings are saved in `config.toml`. Open its location from "About" in Settings.
Changes you make directly take effect after you restart the app. The file contains only values that differ from the defaults.

| Item                             | Default                          | Description                                                              |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `hotkey`                         | `"CommandOrControl+Shift+Space"` | Hotkey that brings up the text window; empty for none                    |
| `autostart`                      | `true`                           | Launch at login                                                          |
| `sync_settings`                  | `true`                           | With Pro, sync settings with your other devices                          |
| `sync_keys`                      | `true`                           | With Pro, sync keyboard shortcuts with your other devices                |
| `sync_replacements`              | `true`                           | With Pro, sync replacements with your other devices                      |
| `sync_snippets`                  | `true`                           | With Pro, sync snippets with your other devices                          |
| `sync_history`                   | `true`                           | With Pro, sync history with your other devices                           |
| `sync_excluded_settings`         | `[]`                             | Setting-file item names to exclude from settings sync                    |
| `language`                       | `"system"`                       | Language (`"system"`, `"ja"`, `"en"`)                                    |
| `theme`                          | `"system"`                       | Theme (`"system"`, `"light"`, `"dark"`)                                  |
| `text_window_always_on_top`      | `true`                           | Keep the text window on top                                              |
| `hide_text_window_on_blur`       | `true`                           | Hide the text window when you switch apps                                |
| `show_text_window_buttons`       | `true`                           | Show buttons in the text window                                          |
| `text_history_size`              | `50`                             | History size (0 to 100)                                                  |
| `trim_trailing_whitespace`       | `true`                           | Remove trailing whitespace when copying                                  |
| `punctuation_style`              | `"keep"`                         | Unify punctuation (`"keep"`, `"kutouten"`, `"comma"`)                    |
| `alphabet_width`                 | `"keep"`                         | Unify the width of letters (`"keep"`, `"full"`, `"half"`)                |
| `digit_width`                    | `"keep"`                         | Unify the width of digits (`"keep"`, `"full"`, `"half"`)                 |
| `space_width`                    | `"keep"`                         | Unify the width of spaces (`"keep"`, `"full"`, `"half"`)                 |
| `symbol_width`                   | `"keep"`                         | Unify the width of symbols (`"keep"`, `"full"`, `"half"`)                |
| `katakana_width`                 | `"keep"`                         | Make half-width katakana full-width (`"keep"`, `"full"`)                 |
| `exclude_from_clipboard_history` | `true`                           | Keep out of clipboard history                                            |
| `text_font_family`               | `""`                             | Text font (CSS font-family; empty uses the OS default)                   |
| `text_font_size`                 | `16`                             | Text font size (10 to 32)                                                |
| `text_color_light`               | `""`                             | Text color (light; `#rrggbb`; empty uses the default)                    |
| `text_color_dark`                | `""`                             | Text color (dark; `#rrggbb`; empty uses the default)                     |
| `input_guidance`                 | None                             | Input hint. If omitted, the default hint; an empty string shows none     |
| `[text_window_keys]`             | The default keys in "Keyboard shortcuts" | Keys in the text window, per action, such as `copy` and `history_older`. An empty string means unassigned |
| `[[replacements]]`               | None                             | One replacement entry (`from`, `to`, `enabled`)                          |
| `[[snippets]]`                   | Default snippets for the display language | One snippet (`name`, `body`, `output` [`"replace"`, `"insert"`, `"none"`], `encoding` [`"utf-8"`, `"shift_jis"`, and so on], `enabled`) |
| `[[devices]]`                    | None                             | Devices you have added                                                    |
| `ai_service`                     | `"none"`                         | AI service used for AI actions (`@ai`) (`"none"`, `"mawok"`, `"gemini"`, `"anthropic"`, `"openai"`) |
| `ai_consent`                     | None                             | AI services whose notice about what is sent and how it is handled you accepted |
| `[ai_models]`                    | Default model for each AI service | AI model, per AI service (`gemini = "…"`, `anthropic = "…"`, and so on)  |

## Uninstalling

::: macos
1. Under "AI" in Settings, choose "Remove" if you entered an API key. Under "Account", choose "Sign out" if you signed in to Mawok.
2. Choose "Quit" in the menu bar menu, then move `/Applications/Mawok.app` to the Trash.
3. To also remove settings and history, delete `~/Library/Application Support/com.amiiby.mawok/` and `~/Library/Logs/com.amiiby.mawok/`.
:::

::: windows
1. Under "AI" in Settings, choose "Remove" if you entered an API key. Under "Account", choose "Sign out" if you signed in to Mawok.
2. Uninstall Mawok from "Apps" in Windows "Settings". The Microsoft Store version also removes settings and history.
:::
