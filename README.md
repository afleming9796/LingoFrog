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

1. Add your favorite phrases and links via the import tab or by highlighting them in Gmail and selecting cmd + shift + p.
2. Start typing in Gmail and suggestions will appear. You might need to refresh your screen
3. Use Cmd+L to insert hyperlinks based on matches. If you highlight a phrase, CMD+L will open a drop down of links to insert. You can also insert ad-hoc links via highlight + cmd + L and save those ad-hoc links for future use. 
4. You should occasionally export your phrases and links to a Google doc or local txt file as a backup. (Bulk import is easy). 

## How It Works

- **Type in Gmail** — after a few characters, LingoFrog checks your corpus for matching phrases
- **A dropdown** shows up to relevant matches, each with the whole phrase's word count
- **Tab** accepts the top suggestion
- **↑/↓** arrows cycle through options
- **Cmd+L** accepts hyperlink suggestions
- **Highlight + Cmd + P** to add new phrases
- **Highlight + CMD + L** brings up dropdown of your links to insert and let's you insert ad-hoc links. 

## Formatted phrases

A phrase can be more than one line, with line breaks, bulleted or numbered lists, bold, italics, and links. When you accept one in Gmail, it goes in with its formatting (Cmd+Z takes it back out), and your link rules still apply to its text.

- **In the popup** (Phrases → + or click a phrase), the phrase box edits like a Gmail reply: Enter starts a new line, an empty line separates paragraphs, `* ` or `- ` on an empty line starts a bulleted list and `1. ` a numbered one, Cmd+B and Cmd+I format, and Cmd+K adds a link. Pasting from Gmail or a Google Doc keeps that formatting and drops the rest.
- **Highlight + Cmd + Shift + P** in Gmail saves the selection's formatting too.
- **Backups:** Copy all still writes one phrase per line. A formatted phrase is written as `md: ` followed by its Markdown, with `\n` for each line break, and importing reads it back. You can write these lines yourself, e.g. `md: Next steps:\n- Send the **deck**\n- Book a demo`.

Autocomplete matches the start of a phrase's first line, as with any phrase. The Phrases tab and the Gmail suggestions show each phrase's word count, so phrases that start the same are easy to tell apart.

## Settings

Click the extension icon → **Settings** tab:

- **Trigger after**: how many characters before suggestions appear (default: 8)
- **Max suggestions**: number of completions shown (default: 5)
- **Min phrase length**: minimum words per stored phrase (default: 4)

## Tips

You should maintain your corpus of phrases outside of the browser extension. You may need to clear the corpus and re-import your phrases after code updates. 

Note that you can lower the trigger threshold (i.e. number of characters) for suggestions.

Hyperlinks get added to phrases based on matching link text, and formatted phrases can also carry links of their own (see above).

GitHub issues are welcome.

## If Developing
While developing and testing different versions, you may find yourself needing remove the extension via chrome://extensions and then add it back in, in which case you'll lose your attached corpous of phrases and links. It's best to export your phrases and links in this case and then import them back.
