# Privacy Policy

_Last updated: 2026-11-23_

LingoFrog is a Chrome extension that provides autocomplete and link
suggestions inside Gmail's compose, drawn from phrases the user has
imported or saved. Its Option+Shift+L and Option+Shift+P shortcuts also
insert those links and phrases on other sites.

## What LingoFrog stores

All data LingoFrog uses lives locally on your device via Chrome's
`chrome.storage.local` API. This includes:

- Your phrase corpus (text snippets imported via the popup or saved
  via the ⌘+Shift+P shortcut).
- Link rules (trigger phrase → URL pairs).
- UTM parameter rules.
- Usage: how many times, and when you last, used each phrase and link,
  to rank suggestions and searches. Backups made with Copy All include
  it.
- Extension settings.

While you are typing in Gmail's compose, the content script reads
your in-progress text to match it against your local phrase and
link rules. This matching happens entirely on your device.

On other sites, LingoFrog runs only in a tab where you press
Option+Shift+L or Option+Shift+P (through Chrome's `activeTab`
permission). It
shows a search of your links or phrases and puts the one you choose
into the text box you're in. It doesn't read or keep the page's
text.

## What LingoFrog transmits

Nothing. The current version of LingoFrog does not send any data
off your device.

If a future version adds something that does (for example, optional
cloud sync), this policy will be updated and the change announced
on the project's GitHub repository before the new behavior ships.

## Uninstallation

Uninstalling the extension from Chrome removes all of its locally
stored data automatically.

## Children's privacy

LingoFrog is not directed at children under 13.

## Contact

Issues, questions, or concerns:
<https://github.com/afleming9796/LingoFrog/issues>
