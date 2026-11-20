# LingoFrog — Chrome Extension

Like a best friend, LingoFrog finishes your sentences and inserts relevant hyperlinks. Accept suggested completions with "tab". Add suggested hyperlinks with cmd + L. Autocomplete works in Chrome + Gmail (on browser), and option + shift + L and option + shift + P insert your links and phrases in any text box (see [Insert links and phrases anywhere](#insert-links-and-phrases-anywhere)).

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
4. Every so often, back everything up to a Google doc or local txt file (see [Backup and restore](#backup-and-restore)).

## How It Works

- **Type in Gmail** — after a few characters, LingoFrog checks your corpus for matching phrases
- **A dropdown** shows up to relevant matches, each with the whole phrase's word count
- **Tab** accepts the top suggestion
- **↑/↓** arrows cycle through options
- **Cmd+L** accepts hyperlink suggestions
- **Highlight + Cmd + P** to add new phrases
- **Highlight + CMD + L** brings up dropdown of your links to insert and let's you insert ad-hoc links. 
- **Option + Shift + L** / **Option + Shift + P** search your links or phrases and insert one, on any site (below)

## Insert links and phrases anywhere

Two shortcuts open a search of your links or phrases in the text box you're in, in Gmail or on any other site:

- **Option + Shift + L** inserts a link. In a rich text box (Gmail and most web apps) it's clickable, with the URL as its text, or the highlighted text if you've highlighted some. A plain text box gets the bare URL. Your UTM rules are added if **Include UTM parameters when copying or inserting links** is on in Settings, the same setting the popup's copy button uses. You can also paste or type a URL into the search to insert it.
- **Option + Shift + P** inserts a phrase, with its formatting if it has any. In a rich text box, your link rules link any text in it that matches, as autocomplete does in Gmail (when **Auto-link hyperlinks** is on), with UTM rules following the same setting as Option + Shift + L. The search matches tags too. For linked text other than a URL, save a phrase with a link in it, or a link rule for that text.

Outside Gmail, what you pick goes in like a paste, so each site handles it the way it handles any paste.

In Gmail, highlighted text works as before: Option + Shift + P (or Cmd + Shift + P) offers to save it as a phrase, and Option + Shift + L links it, like Cmd + L.

On Windows and Linux, use Alt instead of Option. To check or change the shortcuts, go to `chrome://extensions/shortcuts`. Chrome gives each shortcut to only one extension, so if one does nothing, another extension may already have it. Outside Gmail, LingoFrog only runs in a tab when you press one of these shortcuts. It can't run on Chrome's own pages or the Chrome Web Store, or in a text box inside another site's embedded frame.

## Formatted phrases

A phrase can be more than one line, with line breaks, bulleted or numbered lists, bold, italics, and links. When you accept one in Gmail, it goes in with its formatting (Cmd+Z takes it back out), and your link rules still apply to its text.

- **In the popup** (Phrases → + or click a phrase), the phrase box edits like a Gmail reply: Enter starts a new line, an empty line separates paragraphs, `* ` or `- ` on an empty line starts a bulleted list and `1. ` a numbered one, Cmd+B and Cmd+I format, and Cmd+K adds a link. Pasting from Gmail or a Google Doc keeps that formatting and drops the rest.
- **Highlight + Cmd + Shift + P** in Gmail saves the selection's formatting too.
- **Backups:** Copy all still writes one phrase per line. A formatted phrase is written as `md: ` followed by its Markdown, with `\n` for each line break, and importing reads it back. You can write these lines yourself, e.g. `md: Next steps:\n- Send the **deck**\n- Book a demo`.

Autocomplete matches the start of a phrase's first line, as with any phrase. The Phrases tab and the Gmail suggestions show each phrase's word count, so phrases that start the same are easy to tell apart.

## Tags

A phrase can have one tag of up to 4 characters, like `frog`. Add it under **Optional** when you add or edit a phrase. The tag shows next to the phrase in the Phrases tab and in the Gmail suggestions, and searching the Phrases tab matches tags too. Backups include tags, in a `# Tags` section with one `phrase -> tag` line each (a formatted phrase's line breaks written as `\n`), and restoring a backup puts them back.

## Backup and restore

Settings → **Copy All to Clipboard** copies everything: links, phrases, UTM rules, Bops and tags, each under a `# Section` header. Keep it in a doc or a text file.

To restore, go to Settings → **Import from backup** and paste the whole thing under **All**. Everything comes back at once, added to what you already have. Nothing is deleted, and phrases you already have keep their place in your suggestions. Pasting a full backup into one of the other import types restores all of it too, rather than turning its headers into phrases.

The other import types are for adding a batch of one kind, like a list of phrases from a doc or links a teammate shares.

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
While developing and testing different versions, you may find yourself needing remove the extension via chrome://extensions and then add it back in, in which case you'll lose your attached corpous of phrases and links. It's best to copy a backup first and restore it afterwards (see [Backup and restore](#backup-and-restore)).
