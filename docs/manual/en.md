# How to use Mawok

## Getting started

Mawok is a place to write text before you send it to a terminal or another app.
When voice input cannot type directly into an app, or when it is easy to forget whether the IME is on, write it in Mawok first and then paste it.

1. Press {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`} to bring up the text window.
2. Type. Enter adds a line break.
3. Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} to copy and hide the text window, then paste it in the app you returned to.

You can also insert snippets, rewrite the text with commands or AI (actions), and send text to your other devices.
Mawok stays in the {macos:menu bar}{windows:system tray} and starts automatically when you log in (you can turn this off under "General" in Settings).

## Write and copy

- Press {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} or click "Copy" to copy the text and return to the previous app. The hotkey does the same when the text window is in front.
- To return without copying, press `Esc`. Your unfinished text remains there the next time you bring up the window.
- Clicking another app also hides the window without copying (you can turn this off under "General" in Settings).

## Use text you copied earlier

Copied text is kept in history.

- Press `↑` at the start of the text box or `↓` at its end to show the previous or next text.
- Change how many are kept under "General" in Settings. Set it to 0 to keep no history.

## Use snippets

1. Press {macos:`Cmd+J`}{windows:`Ctrl+J`} to open the snippet list.
2. Type to filter, then press Enter to insert one.

Add snippets under "Snippets" in Settings. You can also save the text you are writing from "Save the text as a snippet" at the end of the list.

## Use actions

Actions rewrite the text with commands or AI.

1. Press {macos:`Cmd+K`}{windows:`Ctrl+K`} to open the action list.
2. Choose an action. If you have a selection, it is used; otherwise, all of the text is used.
3. The result appears in the text box. Press {macos:`Cmd+Z`}{windows:`Ctrl+Z`} to undo it.

At first, "Translate to English" and "Sort lines" are included. Translating requires AI service setup (see the next section, "Use AI").

Add actions under "Actions" in Settings.

- A command receives the text on standard input and returns its standard output as the result. To pass the text as an argument, write `{{t}}`. For example: `sort`
- Start a line with `@ai` to make the rest an instruction to AI. For example: `@ai Rewrite this politely`
::: macos
- If a command is not found, write its full path.
:::

Commands run in your home folder. The folder button at the bottom left shows the current folder. To run commands in another folder, select the button, then choose a recent folder or "Choose Folder...".

From the keyboard, press {macos:`Cmd+D`}{windows:`Ctrl+D`}, type the path, and press `Enter`.

- A relative path starts from the current folder.
- Type the start of a folder name and press `Tab` to complete it. If several folders match, they appear below the box. Press `Tab` again to go through them. Press `Enter` to choose the selected folder, then press `Enter` again to move there.
- While you type, the rest of the path appears dimmed when only one folder matches. Press `→` or `Tab` to accept it.
- The title bar shows the folder.
- Clear the box and press `Enter` to go back to your home folder. Quitting Mawok also goes back to it.

## Use AI

1. Under "Actions" in Settings, choose a service under "AI service".
2. If you choose Mawok, select "Sign in", sign in on the page that opens, then click "Link this PC". For another service, enter its API key.
3. Read the explanation of what is sent, then select "Got it".

When you choose Mawok, you do not need an API key. What you use is deducted from your account credit. Select "Buy more" on the same screen to open the purchase page in your browser.

## Send to other devices

You can send text to Mawok on another device you own on the same network.

Pair the devices once first.

1. On one device, select "Show a code" under "Devices" in Settings.
2. On the other device, enter the code and select "Pair".

{macos:If asked to allow access to the local network, allow it.}{windows:If asked to allow access through the firewall, allow it.}

To send, press {macos:`Cmd+Shift+Enter`}{windows:`Ctrl+Shift+Enter`} in the text window or click "Send".
If the text box on the other device is empty, the text goes in as it is; if it has unfinished text, you can choose whether to insert it.

## Keyboard shortcuts

| Action | Key |
| --- | --- |
| Bring up the text window (copy and hide if it is in front) | {macos:`Cmd+Shift+Space`}{windows:`Ctrl+Shift+Space`} |
| Copy and hide | {macos:`Cmd+Enter`}{windows:`Ctrl+Enter`} |
| Hide without copying | `Esc` |
| Show text you copied earlier (↑ at the start of the text box, ↓ at the end) | `↑` / `↓` |
| Previous / next in history (wherever the cursor is) | {macos:`Cmd+Option+↑` / `Cmd+Option+↓`}{windows:`Ctrl+Alt+↑` / `Ctrl+Alt+↓`} |
| Open the snippet list and insert one | {macos:`Cmd+J`}{windows:`Ctrl+J`} |
| Open the action list and run one | {macos:`Cmd+K`}{windows:`Ctrl+K`} |
| Change the folder commands run in | {macos:`Cmd+D`}{windows:`Ctrl+D`} |
| Cancel an action (while it is running) | `Esc` |
| Send to paired devices | {macos:`Cmd+Shift+Enter`}{windows:`Ctrl+Shift+Enter`} |
| Choose destinations | {macos:`Cmd+L`}{windows:`Ctrl+L`} |
| Insert / discard received text | {macos:`Cmd+I` / `Cmd+Shift+Backspace`}{windows:`Ctrl+I` / `Ctrl+Shift+Backspace`} |
| Open Settings | {macos:`Cmd+,`}{windows:`Ctrl+,`} |

You can change the keys under "Keyboard" in Settings.

## Settings

Choose "Settings…" in the {macos:menu bar}{windows:system tray} menu, or press {macos:`Cmd+,`}{windows:`Ctrl+,`} in the text window.
You can change the hotkey, the text's appearance, and the cleanup applied when copying (such as removing trailing whitespace, unifying full-width and half-width characters, and replacements). Changes take effect immediately.

## If something does not work

- **The hotkey does not work**: Another app uses the same key. ⚠ appears in the {macos:menu bar}{windows:system tray} menu. Choose a different key under "Keyboard" in Settings.
- **Cannot connect to another device**: Check that Mawok is running on the other device and that both devices are on the same network.{macos: Also check that Mawok is enabled in System Settings > Privacy & Security > Local Network.}{windows:}
::: macos
- **"Couldn't read the API key" appears**: After you reinstall the app, you will be asked to allow access to the Keychain. Allow it.
:::

When reporting a problem, attach the log. It does not contain your text. Open its location from "About" in Settings.

## What is sent and privacy

- Mawok does not send usage statistics or error reports.
- It sends your text outside the app only when you run an AI action (to the AI service you chose) or send it to another device (to your paired device).
- Before you choose an AI service and select "Got it", the screen explains how the service handles what you send, including whether it uses it for training and how long it retains it.

## Settings file

Settings are saved in `config.toml`. Open its location from "About" in Settings.
Changes you make directly take effect after you restart the app. The file contains only values that differ from the defaults.

| Item                             | Default                          | Description                                                              |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `hotkey`                         | `"CommandOrControl+Shift+Space"` | Hotkey that brings up the text window; empty for none                    |
| `autostart`                      | `true`                           | Launch at login                                                          |
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
| `[[snippets]]`                   | None                             | One snippet (`name`, `body`)                                             |
| `[[paired_devices]]`             | None                             | Paired devices (pair them under "Devices" in Settings)                   |
| `ai_service`                     | `"none"`                         | AI service used for AI actions (`"none"`, `"mawok"`, `"gemini"`, `"anthropic"`, `"openai"`) |
| `ai_consent`                     | None                             | AI services whose notice about what is sent and how it is handled you accepted |
| `[ai_models]`                    | Default model for each AI service | AI model, per AI service (`gemini = "…"`, `anthropic = "…"`, and so on)  |
| `[[actions]]`                    | Default actions for the display language | One action (`name`, `command`, `output` [`"replace"`, `"insert"`, `"none"`], `encoding` [`"utf-8"`, `"shift_jis"`, and so on], `enabled`) |

## Uninstalling

::: macos
1. Under "Actions" in Settings, choose "Remove" if you entered an API key, or "Sign out" if you signed in to Mawok.
2. Choose "Quit" in the menu bar menu, then move `/Applications/Mawok.app` to the Trash.
3. To also remove settings and history, delete `~/Library/Application Support/com.amiiby.mawok/` and `~/Library/Logs/com.amiiby.mawok/`.
:::

::: windows
1. Under "Actions" in Settings, choose "Remove" if you entered an API key, or "Sign out" if you signed in to Mawok.
2. Uninstall Mawok from "Apps" in Windows "Settings". The Microsoft Store version also removes settings and history.
:::
