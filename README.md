# Auto Background — SillyTavern Extension

Automatically detects scene/location changes in your chat and triggers background image generation via the **Image Generation** extension.

---

## Features

- **Scene change detection** — after each AI message, a lightweight LLM call checks whether the characters physically moved to a new location.
- **Auto-generate on chat open** — optionally generates a background when a new chat starts, with a configurable delay.
- **Cooldown control** — prevents rapid repeated generation by enforcing a minimum interval between triggers.
- **Silent mode** — the generated image message is removed from the chat history after the background is applied, so other extensions are unaffected.
- **Configurable detection prompt** — the scene-change prompt is fully editable in the settings panel, with a one-click reset to the default.
- **Manual trigger** — a "Generate now" button lets you request a background at any time, bypassing detection.
- **Test button** — runs the detection prompt against a sample text so you can verify your prompt works before enabling auto-mode.
- **Toastr notifications** — optional pop-up notifications for generation events.

---

## Requirements

| Requirement | Notes |
|---|---|
| **SillyTavern** | Latest release recommended |
| **Image Generation extension** | Must be installed and configured with a working background generation command |

---

## Installation

### Via SillyTavern Extension Installer (recommended)

1. Open SillyTavern → **Extensions** → **Install extension**.
2. Paste the URL of this repository and confirm.

### Manual

1. Clone or download this repository.
2. Copy the folder into `SillyTavern/public/scripts/extensions/third-party/`.
3. Restart (or reload) SillyTavern.

---

## Configuration

Open **Extensions → Auto Background** in the SillyTavern sidebar.

| Setting | Default | Description |
|---|---|---|
| Enable auto background generation | Off | Master switch. When disabled, no scene checks or generations are triggered. |
| Generate background when opening a chat | On | Generates a background when a brand-new chat (1 message) is opened. |
| Delay before start generation | 3 s | How long to wait after a chat opens before triggering the start background. |
| Show notifications | On | Displays toastr pop-ups for scene changes and generation events. |
| Silent mode | Off | Removes the generated image message from chat history after the background is applied. |
| Cooldown between generations | 120 s | Minimum time between consecutive background generations. |
| Min messages before scene checks | 4 | Scene detection is skipped until the chat reaches this many messages. |
| Scene change detection prompt | (built-in) | The prompt sent to the LLM to decide whether a location change occurred. Use `{{text}}` as the placeholder for the message being analysed. |

---

## How It Works

```
New AI message received
        │
        ▼
Cooldown elapsed? ──No──► Skip
        │ Yes
        ▼
Send detection prompt to LLM
        │
   Answer = YES?
  ┌─────┴──────┐
  No           Yes
  │             │
Skip     Trigger Image Generation
              │
         Silent mode?
        ┌────┴────┐
        No       Yes
        │         │
   Done     Remove BG message
             from chat + DOM
```

The extension hooks into SillyTavern's `MESSAGE_RECEIVED` and `CHAT_CHANGED` events. Background generation is triggered by finding and clicking the Image Generation extension's background button, or by executing `/sd type=background` (and similar slash commands) as a fallback.

---

## Silent Mode Details

When **Silent mode** is enabled, a polling interval watches `ctx.chat` for the newly added background image message. Once found, the message is:

1. Removed from the DOM (`#chat .mes[mesid=N]`).
2. Spliced out of the `ctx.chat` array.
3. All remaining `mesid` attributes in the DOM are re-indexed.
4. The chat is saved immediately so the removal is persisted.

If the chat changes before the message appears (e.g. the user navigates away), the intercept is cancelled automatically.

---

## Default Detection Prompt

```
Task: Determine if the characters moved to a completely DIFFERENT physical location based ONLY on the text below.
Ignore mere conversations about places, time of day changes, or weather. Look for actual physical movement (e.g., entered a new building, traveled to a new city, teleported).

Text to analyze:
"{{text}}"

Did the physical location change? Answer with EXACTLY one word: YES or NO.
```

You can customise this in the settings panel. Click **Reset prompt** to restore the default.

---

## Troubleshooting

**No background is generated**
- Make sure the Image Generation extension is installed and has a working background generation command.
- Check the browser console for `[AutoBG]` log lines.
- Use the **Test detection** button to verify the LLM connection works.

**Silent mode leaves phantom messages**
- The guard timer cancels the intercept after 360 seconds if nothing is detected. If generation takes longer than expected, disable silent mode.

**Scene detection fires too often**
- Increase the **Cooldown** slider.
- Increase **Min messages** so detection starts later in a conversation.
- Edit the detection prompt to be more strict.

---

## License

MIT — see [LICENSE](LICENSE) for details.
