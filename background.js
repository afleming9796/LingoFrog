/**
 * background.js — LingoFrog service worker.
 *
 * LingoFrog lives in Chrome's side panel (panel.html); there's no
 * popup. The toolbar icon toggles the panel, and so does Alt+L, which
 * is the manifest's `_execute_action` command: Chrome runs it as an
 * icon click, so it needs no listener here.
 *
 * Alt+P opens the panel on the Phrases tab. sidePanel.open() only works
 * inside the shortcut's user gesture, so it's called first, before
 * anything async. The tab to show goes through session storage, where
 * manage.js picks it up whether the panel was already open or is just
 * opening.
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open_phrases' || !tab) return;
  // A no-op if the panel is already open.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.storage.session.set({
    lingofrog_open_tab: { tab: 'corpus', windowId: tab.windowId, at: Date.now() },
  });
});
