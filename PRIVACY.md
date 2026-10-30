# Privacy Policy

_Last updated: 2026-10-30_

LingoFrog is a Chrome extension that provides autocomplete and link
suggestions inside Gmail's compose, drawn from phrases the user has
imported or saved. Its optional Scribe side panel drafts emails with
Anthropic's Claude API, using an API key the user provides.

## What LingoFrog stores

All data LingoFrog uses lives locally on your device via Chrome's
`chrome.storage` API. This includes:

- Your phrase corpus (text snippets imported via the popup or saved
  via the ⌘+Shift+P shortcut).
- Link rules (trigger phrase → URL pairs).
- UTM parameter rules.
- Extension settings.
- Scribe styles, and your Anthropic API key if you add one. The key
  is stored only in `chrome.storage.local` on this device and is
  never synced or included in exports.
- Scribe's current context and draft, kept in `chrome.storage.session`
  so they survive closing the side panel; Chrome clears it when the
  browser restarts.

While you are typing in Gmail's compose, the content script reads
your in-progress text to match it against your local phrase and
link rules. This matching happens entirely on your device.

When you use Scribe's "Use Gmail selection" button, the side panel
reads the text you've highlighted in the active Gmail tab and adds it
to the context box. Scribe reads nothing else from the page.

## What LingoFrog transmits

Only what you send with Scribe. Autocomplete, link suggestions, and
everything else LingoFrog does stays on your device.

When you click **Write** (or **Rewrite**) in the Scribe side panel,
LingoFrog sends one request directly from your browser to Anthropic's
API (`api.anthropic.com`), authenticated with your API key. The
request contains:

- the text in the Context box,
- the style you selected (its name and instructions), and
- your saved links (trigger phrase and URL), so the draft can
  include relevant ones.

Nothing is sent before you click Write, nothing is sent if you never
add an API key, and LingoFrog sends no data to any other server.
Anthropic handles API requests under its own terms and privacy
policy: <https://www.anthropic.com/legal/privacy>.

If a future version transmits anything else (for example, optional
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
