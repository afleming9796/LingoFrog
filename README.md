# LingoFrog — Chrome Extension

Like a best friend, LingoFrog finishes your sentences and inserts relevant hyperlinks. Accept suggested completions with "tab". Add suggested hyperlinks with cmd + L. Only works in chrome + Gmail (on browser).

## Install (Developer Mode)

1. Download this repo locally 
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select this repo
6. The LingoFrog icon will appear in the puzzle-piece Extensions icon 

## Setup

1. Click the LingoFrog icon (or press Option/Alt + L) to open the side panel. Add your favorite phrases and links on its **Phrases** and **Links** tabs, or by highlighting them in Gmail and selecting cmd + shift + p.
2. Start typing in Gmail and suggestions will appear. You might need to refresh your screen
3. Use Cmd+L to insert hyperlinks based on matches. If you highlight a phrase, CMD+L will open a drop down of links to insert. You can also insert ad-hoc links via highlight + cmd + L and save those ad-hoc links for future use. 
4. You should occasionally export your phrases and links to a Google doc or local txt file as a backup. (Bulk import is easy). 

## How It Works

- **Type in Gmail** — after a few characters, LingoFrog checks your corpus for matching phrases
- **A dropdown** shows up to relevant matches
- **Tab** accepts the top suggestion
- **↑/↓** arrows cycle through options
- **Cmd+L** accepts hyperlink suggestions
- **Highlight + Cmd + P** to add new phrases
- **Highlight + CMD + L** brings up dropdown of your links to insert and let's you insert ad-hoc links. 
- **Option/Alt + L** opens or closes the LingoFrog side panel, and **Option/Alt + P** opens it on the Phrases tab

## Scribe

Scribe is an email editor that can also draft emails with Claude. It's the **Scribe** tab in the side panel, after Links and Phrases.

Write your email in the draft box, and it works like a Gmail reply:

- Your saved phrases autocomplete as you type: **Tab** accepts, **↑/↓** cycle, **Esc** closes. A phrase that contains one of your saved links goes in already linked, and its follow-up phrases come up next.
- **Cmd/Ctrl + K** (or the link button) adds or changes a link, and clicking into a link shows Go to link / Change / Remove. Enter on an empty bullet or Backspace at the start of one ends the list.
- **Cmd/Ctrl + L** opens the same link search as in a Gmail reply: highlight text, then pick one of your saved links or type a URL (a one-off URL offers to save the text and URL as a link rule). With nothing highlighted, the link's name goes in at the cursor.
- **Copy** puts the draft on your clipboard as rich text, and it pastes into Gmail in Gmail's default font (Sans Serif, Normal size). **Clear draft** at the bottom starts over (with an undo).

### Write with AI

Turn on **Write with AI** at the top of the panel to have Claude write the draft. With it off, the panel is just the editor and nothing is sent anywhere. It starts off on a new install, and on if you'd already added an API key.

1. Add your Anthropic API key (key icon next to the switch). Create one at [console.anthropic.com](https://console.anthropic.com/settings/keys). It's stored only on this device, and you pay Anthropic directly for usage.
2. Fill in **Context**: paste notes or an email thread, or highlight text in Gmail and click **Use Gmail selection**.
3. Pick one of your **Styles** (post-call follow-up, intro email, quick reply, or your own). Rules that should apply to every draft (tone, length, sign-off) go in the **General style** above them.
4. Click **Write** (or press Cmd/Ctrl + Enter in the context box). The draft streams in with formatting and links. **Clear context and draft** at the bottom starts over (with an undo).
5. Edit the draft before copying, the same way as above. Once you've changed it, **Suggest a rule from my edits** compares your version with Claude's and proposes a rule for the style that wrote it. You can reword it, then add it to that style or to your general style.

Scribe reuses your most-used saved phrases where they fit and matches their voice, and it can include your saved links. Links in drafts get your UTM rules, both in the preview and when you copy. Any link in a draft that isn't one of your saved links is listed under the draft, so check those before sending. Context is sent to Anthropic only when you click Write. See [PRIVACY.md](PRIVACY.md).

## Settings

In the side panel, click the gear for **Settings**:

- **Trigger after**: how many characters before suggestions appear (default: 8)
- **Max suggestions**: number of completions shown (default: 5)
- **Min phrase length**: minimum words per stored phrase (default: 4)

## Tips

You should maintain your corpus of phrases outside of the browser extension. You may need to clear the corpus and re-import your phrases after code updates. 

Note that you can lower the trigger threshold (i.e. number of characters) for suggestions.

Phrases don't support special formatting or hyperlinks, but hyperlinks will get added based on matching link text. 

GitHub issues are welcome.

## If Developing
The extension loads straight from this folder with no build step. The one exception is the Anthropic SDK, which is bundled into `vendor/anthropic-sdk.js`. To update it, change the version in `package.json`, then run `npm install && npm run vendor`. When packaging for the Chrome Web Store, leave out `node_modules/`, `scripts/`, and the npm files.

While developing and testing different versions, you may find yourself needing remove the extension via chrome://extensions and then add it back in, in which case you'll lose your attached corpous of phrases and links. It's best to export your phrases and links in this case and then import them back.
