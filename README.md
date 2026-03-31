# TypeLess — Chrome Extension

Like a best friend, TypeLess finishes your sentences and inserts relevant hyperlinks. Accept suggested completions with "tab". Add suggested hyperlinks with cmd + L. Only works in chrome + gmail (on browser).

## Install (Developer Mode)

1. Download this repo locally 
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select this repo
6. The TypeLess icon will appear in the puzzle-piece Extensions icon 

## Setup

1. Add your favorite phrases and links via the import tab.
2. Start typing in Gmail and suggestions will appear. You might need to refresh your screen
3. Consider exporting your phrases and links to a local txt file (also useful for bulk editing)

## How It Works

- **Type in Gmail** — after a few characters, TypeLess checks your corpus for matching phrases
- **A dropdown** shows up to relevant matches
- **Tab** accepts the top suggestion
- **↑/↓** arrows cycle through options
- **Cmd+L** accepts hyperlink suggestions

## Settings

Click the extension icon → **Settings** tab:

- **Trigger after**: how many characters before suggestions appear (default: 8)
- **Max suggestions**: number of completions shown (default: 5)
- **Min phrase length**: minimum words per stored phrase (default: 4)

## Tips

You should maintain your corpus of phrases outside of the browser extension. You may need to clear the corpus and re-import your phrases after code updates. 

Note that you can lower the trigger threshold (i.e. number of characters) for suggestions.

Phrases don't support special formatting or hyperlinks, but hyperlinks will get added based on matching link text. 

GitHub issues and PRs are welcome.

## If Developing
While developing and testing different versions, you may find yourself needing remove the extension via chrome://extensions and then add it back in, in which case you'll lose your attached corpous of phrases and links. It's best to export your phrases and links in this case and then import them back.
