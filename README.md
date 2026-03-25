# GhostType — Chrome Extension

A local autocomplete engine that learns from your own writing. No AI, no cloud — just your words, suggested back to you inline as you type.

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this `ghosttype-ext` folder
5. The GhostType icon (⌨) will appear in your toolbar

## Setup

1. Click the GhostType icon in the toolbar
2. Paste your writing into the text area (emails, chat logs, documents — anything you've written)
3. Or drag-and-drop `.txt` files into the file drop area
4. Click **Import Text**
5. Done — start typing in Gmail and suggestions will appear

## How It Works

- **Type in Gmail** (or any supported site) — after a few characters, GhostType checks your corpus for matching phrases
- **Gray ghost text** appears inline showing the top completion
- **A dropdown** shows up to 5 matches ranked by frequency
- **Tab** accepts the top suggestion
- **↑/↓** arrows cycle through options
- **Esc** dismisses suggestions

## Supported Sites

- Gmail (mail.google.com)
- Google Docs (docs.google.com)
- LinkedIn (linkedin.com)
- Slack (app.slack.com)

To add more sites, edit the `matches` array in `manifest.json`.

## Settings

Click the extension icon → **Settings** tab:

- **Trigger after**: how many characters before suggestions appear (default: 8)
- **Max suggestions**: number of completions shown (default: 5)
- **Min phrase length**: minimum words per stored phrase (default: 4)

## Privacy

Everything stays in your browser's local storage (`chrome.storage.local`). No data is ever sent to any server. No network requests are made.

## Tips

- **Import lots of text** — the more you feed it, the better the suggestions
- **Re-import periodically** — paste recent emails or messages to keep suggestions current
- **Lower the trigger threshold** if you want suggestions to appear sooner (Settings → Trigger after → 5)
- **The corpus persists** across browser restarts — import once, use forever
