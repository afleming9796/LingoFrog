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
 */

chrome.commands.onCommand.addListener(async (command) => {
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
