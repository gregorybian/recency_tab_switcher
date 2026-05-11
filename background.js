/**
 * RecentTabSwitcher — background service worker (Manifest V3).
 * Tracks per-window MRU order and handles keyboard commands.
 */

// Shared MRU implementation (service worker has no ES module imports in all Chrome versions without "type":"module")
importScripts("mru-manager.js");

const LOG_PREFIX = "[RecentTabSwitcher]";
const mru = new MruManager();

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

/**
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab | undefined>}
 */
async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return undefined;
  }
}

/**
 * Activate a tab and focus its window. Cleans stale MRU entries if the tab vanished.
 * @param {number} windowId
 * @param {number} tabId
 */
async function activateTab(windowId, tabId) {
  const tab = await safeGetTab(tabId);
  if (!tab) {
    mru.removeTabEverywhere(tabId);
    await mru.saveToStorage();
    warn("Target tab no longer exists; pruned from MRU", tabId);
    return;
  }

  try {
    if (tab.windowId != null && tab.windowId !== windowId) {
      // Tab moved; follow the real window id.
      windowId = tab.windowId;
    }
    await chrome.windows.update(windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch (err) {
    warn("activateTab failed", { windowId, tabId, err });
    mru.removeTabEverywhere(tabId);
    await mru.saveToStorage();
  }
}

/**
 * @param {'mru_forward' | 'mru_backward'} command
 */
async function handleCommand(command) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab?.id || activeTab.windowId == null) {
      warn("No active tab in last focused window");
      return;
    }

    const windowId = activeTab.windowId;
    const tabId = activeTab.id;

    const targetId =
      command === "mru_forward"
        ? mru.getMruForwardTarget(windowId, tabId)
        : mru.getMruBackwardTarget(windowId, tabId);

    if (targetId == null || targetId === tabId) {
      log("MRU switch: no alternative tab", { command, windowId, tabId });
      return;
    }

    log("MRU switch", { command, from: tabId, to: targetId });
    await activateTab(windowId, targetId);
  } catch (err) {
    warn("handleCommand error", command, err);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await mru.loadFromStorage();
    // Fresh install (or empty cache): rebuild from Tab.lastAccessed. On extension *update*, keep session MRU.
    if (details.reason === "install" || Object.keys(mru.mruByWindow).length === 0) {
      log("onInstalled — rebuilding MRU", details.reason);
      await mru.rebuildAllWindowsFromBrowser();
      await mru.saveToStorage();
    } else {
      log("onInstalled — preserved MRU from session", details.reason);
    }
  } catch (err) {
    warn("onInstalled handler error", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  log("onStartup — rebuilding MRU from browser tab metadata");
  await mru.rebuildAllWindowsFromBrowser();
  await mru.saveToStorage();
});

// Service worker wake: restore from session storage; if empty, rebuild once.
(async () => {
  await mru.loadFromStorage();
  if (Object.keys(mru.mruByWindow).length === 0) {
    log("Empty MRU after wake — rebuilding from browser");
    await mru.rebuildAllWindowsFromBrowser();
    await mru.saveToStorage();
  }
})();

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    mru.recordActivation(activeInfo.windowId, activeInfo.tabId);
    await mru.saveToStorage();
    log("onActivated", activeInfo.windowId, activeInfo.tabId);
  } catch (err) {
    warn("onActivated handler error", err);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    if (mru.removeTabEverywhere(tabId)) {
      await mru.saveToStorage();
      log("onRemoved — pruned tab", tabId);
    }
  } catch (err) {
    warn("onRemoved handler error", err);
  }
});

chrome.tabs.onDetached.addListener(async (tabId) => {
  try {
    // While moving between windows the tab is briefly not in any window; drop it from MRU until onAttached/onActivated.
    if (mru.removeTabEverywhere(tabId)) {
      await mru.saveToStorage();
      log("onDetached — pruned tab", tabId);
    }
  } catch (err) {
    warn("onDetached handler error", err);
  }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  try {
    // Put the tab on the front of the destination window; Chrome usually follows with onActivated if it is active.
    mru.recordActivation(attachInfo.newWindowId, tabId);
    await mru.saveToStorage();
    log("onAttached", tabId, attachInfo.newWindowId);
  } catch (err) {
    warn("onAttached handler error", err);
  }
});

/**
 * New tabs: Chrome fires onActivated when they become active; no extra bookkeeping required here.
 * If a tab is created in background, it won't enter MRU until activated — intentional.
 */

chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    if (mru.mruByWindow[windowId]) {
      delete mru.mruByWindow[windowId];
      await mru.saveToStorage();
      log("onRemoved window — dropped MRU list", windowId);
    }
  } catch (err) {
    warn("windows.onRemoved handler error", err);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "mru_forward") {
    // Open the popup on Alt+Q
    try {
      await handleCommand(command);
      await chrome.action.openPopup();
      log("Switched tab and opened popup via Alt+Q");
    } catch (error) {
      warn("Could not switch tab or open popup", error);
    }
  } else if (command === "mru_backward") {
    // Keep MRU backward switch for Alt+E
    void handleCommand(command);
  }
});
