# GhostType — Chrome Extension

Like a best friend, ghost-type finishes your sentences and inserts relevant hyperlinks. Accept suggested completions with "tab". Add suggested hyperlinks with cmd/ctrl + L. Only works in chrome + gmail (on browser). 

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this `ghosttype-ext` folder
5. The GhostType icon (⌨) will appear in your toolbar

## Setup

1. Create a file with your phrases you'd like to auto complete. 
1. Click the GhostType icon in the toolbar
2. Paste the content of your text file or drag-and-drop `.txt` files into the file drop area
4. Click **Import Text**
5. Done — start typing in Gmail and suggestions will appear
6. You might need to refresh your screen 

## How It Works

- **Type in Gmail** — after a few characters, GhostType checks your corpus for matching phrases
- **Gray ghost text** appears inline showing the top completion
- **A dropdown** shows up to relevant matches
- **Tab** accepts the top suggestion
- **↑/↓** arrows cycle through options
- **Esc** dismisses suggestions
- **Cmd+L** accepts hyperlink suggestions 

## Settings

Click the extension icon → **Settings** tab:

- **Trigger after**: how many characters before suggestions appear (default: 8)
- **Max suggestions**: number of completions shown (default: 5)
- **Min phrase length**: minimum words per stored phrase (default: 4)

## Tips

You should maintain your corpus of phrases outside of the browser extension. You may need to clear the corpus and re-import your phrases after code updates. Note that you can lower the trigger threshold (i.e. number of characters) for suggestions. 

Phrases don't support special formatting or hyperlinks, but hyperlinks will get added based matching phrases in the links tab.

GitHub issues and PRs are welcome. 

## If Developing 
While developing and testing different versions, you may find yourself needing remove the extension via chrome://extensions and then add it back in, in which case you'll lose your attached corpous of phrases and links. It's best to export your phrases and links in this case and then import them back. 
