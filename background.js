/**
 * background.js — LingoFrog service worker.
 *
 * Alt+L is handled natively by Chrome via the manifest's
 * `_execute_action` command (opens or toggles the popup, no listener
 * needed) which keeps the common case out of the extension's
 * permission surface.
 *
 * Alt+P lives here so it can behave like a toggle too:
 *   popup closed          → open on the Phrases tab
 *   popup open, any tab   → hand off to the popup; the popup closes
 *                           itself if it's already on Phrases,
 *                           otherwise switches there
 *
 * "Is the popup open?" is answered by trying chrome.runtime.sendMessage
 * — if popup.js is loaded it responds, otherwise sendMessage rejects
 * with "no receiving end" and we fall back to openPopup().
 *
 * Option+Shift+L and Option+Shift+P (Alt+Shift on Windows and Linux)
 * open the link and phrase pickers from quick-insert.js in the text box
 * you're in, on any site. See runQuickInsert below.
 */

const QUICK_COMMANDS = { insert_link: 'link', insert_phrase: 'phrase' };

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (QUICK_COMMANDS[command]) {
    runQuickInsert(QUICK_COMMANDS[command], tab);
    return;
  }
  if (command !== 'open_phrases') return;

  // Hand the shortcut to the popup first. Response { ok: true } means
  // the popup handled it (switched tab or closed). Rejection means the
  // popup isn't open — fall through to openPopup with the target flag.
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'lingofrog_shortcut',
      target: 'corpus',
    });
    if (response && response.ok) return;
  } catch (e) {
    // Popup wasn't open — expected on the "opens the popup" path.
  }

  try {
    await chrome.storage.session.set({ lingofrog_open_tab: 'corpus' });
    await chrome.action.openPopup();
  } catch (e) {
    // openPopup() can reject if no window is available to host the
    // popup (e.g. no focused browser window). Nothing else to do —
    // the shortcut just no-ops in that case.
  }
});

/**
 * Opens a picker in the frame that has the keyboard focus. Pressing the
 * shortcut grants activeTab, which lets us run scripts in this tab (any
 * site) until it navigates, so LingoFrog needs no access to sites up
 * front. Gmail already has quick-insert.js from the manifest; anywhere
 * else it's injected the first time, into the focused frame only.
 *
 * Pages extensions can't run on (chrome:// pages, the Web Store, the
 * PDF viewer) make executeScript throw, and the shortcut does nothing.
 */
async function runQuickInsert(kind, tab) {
  try {
    if (!tab || tab.id == null) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tab || tab.id == null) return;

    // Which frame has the focus, and whether it has the picker already.
    const probe = () => {
      const a = document.activeElement;
      return {
        focused: document.hasFocus() && !(a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')),
        loaded: typeof globalThis.LingoFrogQuick !== 'undefined',
      };
    };
    let probes;
    try {
      probes = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: probe,
      });
    } catch (e) {
      // In case a frame we can't reach fails the whole call: the top
      // frame alone.
      probes = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probe });
    }
    const frame = probes.find((p) => p.result && p.result.focused);
    if (!frame) return;
    const target = { tabId: tab.id, frameIds: [frame.frameId] };

    if (!frame.result.loaded) {
      await chrome.scripting.executeScript({
        target,
        files: ['phrase-format.js', 'trie.js', 'quick-insert.js'],
      });
    }
    await chrome.scripting.executeScript({
      target,
      func: (k) => {
        if (globalThis.LingoFrogQuick) globalThis.LingoFrogQuick.handleCommand(k);
      },
      args: [kind],
    });
  } catch (e) {
    // A page extensions can't run on. Nothing to do.
  }
}
