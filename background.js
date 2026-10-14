/**
 * RecentTabSwitcher — background service worker (Manifest V3).
 * Tracks per-window MRU order and handles keyboard commands.
 *
 * Alt+Q  → simple 2-tab toggle (no traversal, no popup, race-condition-free)
 * Alt+W  → full MRU traversal with popup (freezes the MRU list, walks a cursor)
 */

importScripts("mru-manager.js");

const LOG_PREFIX = "[RecentTabSwitcher]";
const mru = new MruManager();

/**
 * Set of tab IDs we expect onActivated to fire for during traversal.
 * Using a Set (not a single ID) handles rapid Alt+W presses where multiple
 * activations may be in flight concurrently.
 */
const pendingTraversalActivations = new Set();

/** Timeout handle for auto-committing traversal after inactivity. */
let traversalTimeout = null;

/** How long (ms) to wait after the last traversal step before auto-committing. */
const TRAVERSAL_TIMEOUT_MS = 5000;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

// ── Helpers ──────────────────────────────────────────────────────────

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
 * @returns {Promise<boolean>}
 */
async function activateTab(windowId, tabId) {
  const tab = await safeGetTab(tabId);
  if (!tab) {
    mru.removeTabEverywhere(tabId);
    await mru.saveToStorage();
    warn("Target tab no longer exists; pruned from MRU", tabId);
    return false;
  }

  try {
    if (tab.windowId != null && tab.windowId !== windowId) {
      windowId = tab.windowId;
    }
    await chrome.windows.update(windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (err) {
    warn("activateTab failed", { windowId, tabId, err });
    mru.removeTabEverywhere(tabId);
    await mru.saveToStorage();
    return false;
  }
}

// ── Alt+Q: Simple 2-tab toggle ──────────────────────────────────────
//
// No traversal state, no popup, no onActivated suppression.
// Chrome's onActivated fires naturally and records the switch.

async function handleSimpleToggle() {
  // If a traversal is active (user was doing Alt+W), commit it first.
  if (mru.isTraversing) {
    await commitTraversalNow();
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!activeTab?.id || activeTab.windowId == null) {
    warn("No active tab in last focused window");
    return;
  }

  const targetId = mru.getMruForwardTarget(activeTab.windowId, activeTab.id);
  if (targetId == null || targetId === activeTab.id) {
    log("No alternative tab for toggle");
    return;
  }

  log("Simple toggle", { from: activeTab.id, to: targetId });
  await activateTab(activeTab.windowId, targetId);
  // onActivated will fire naturally and call recordActivation — no suppression.
}

// ── Alt+W: Full MRU traversal ───────────────────────────────────────

function resetTraversalTimeout() {
  if (traversalTimeout) clearTimeout(traversalTimeout);
  traversalTimeout = setTimeout(async () => {
    if (mru.isTraversing) {
      mru.commitTraversal();
      await mru.saveToStorage();
      log("Traversal auto-committed via timeout");
    }
    pendingTraversalActivations.clear();
    traversalTimeout = null;
  }, TRAVERSAL_TIMEOUT_MS);
}

function clearTraversalTimer() {
  if (traversalTimeout) {
    clearTimeout(traversalTimeout);
    traversalTimeout = null;
  }
}

/**
 * Find the next valid (still-existing) tab in the MRU traversal.
 * Skips over stale tabs and removes them from the snapshot + MRU.
 * @returns {Promise<number | null>}
 */
async function getValidTraversalTarget() {
  if (!mru.isTraversing || !mru._traversal) return null;
  const maxAttempts = mru._traversal.snapshot.length;

  for (let i = 0; i < maxAttempts; i++) {
    const targetId = mru.stepForward();
    if (targetId == null) return null;

    const tab = await safeGetTab(targetId);
    if (tab) return targetId;

    // Stale tab — remove from traversal snapshot and live MRU
    mru.removeFromTraversal(targetId);
    mru.removeTabEverywhere(targetId);

    if (!mru.isTraversing) return null;
  }

  return null;
}

/**
 * Handle a single traversal step (Alt+W press).
 */
async function handleTraversalStep() {
  // If already traversing, just step forward
  if (mru.isTraversing) {
    const targetId = await getValidTraversalTarget();
    if (targetId == null) {
      mru.cancelTraversal();
      clearTraversalTimer();
      pendingTraversalActivations.clear();
      return;
    }

    pendingTraversalActivations.add(targetId);
    resetTraversalTimeout();
    await activateTab(mru.traversalWindowId, targetId);
    return;
  }

  // Starting a new traversal
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!activeTab?.id || activeTab.windowId == null) {
    warn("No active tab in last focused window");
    return;
  }

  if (!mru.startTraversal(activeTab.windowId)) {
    log("Cannot start traversal (< 2 tabs in window)");
    return;
  }

  const targetId = await getValidTraversalTarget();
  if (targetId == null) {
    mru.cancelTraversal();
    return;
  }

  pendingTraversalActivations.add(targetId);
  resetTraversalTimeout();
  await activateTab(activeTab.windowId, targetId);
}

/**
 * Explicitly end traversal (called from popup via message or timeout).
 */
async function commitTraversalNow() {
  if (!mru.isTraversing) return;
  mru.commitTraversal();
  await mru.saveToStorage();
  clearTraversalTimer();
  pendingTraversalActivations.clear();
  log("Traversal committed");
}

// ── Lifecycle & MRU bookkeeping ─────────────────────────────────────

// Service worker wake: restore from session storage; if empty, rebuild once.
// Every listener awaits this: the event that woke the worker (e.g. Ctrl+T's onActivated) is
// dispatched before the load resolves, and the load would otherwise clobber what it recorded.
const ready = (async () => {
  await mru.loadFromStorage();
  if (Object.keys(mru.mruByWindow).length === 0) {
    log("Empty MRU after wake — rebuilding from browser");
    await mru.rebuildAllWindowsFromBrowser();
    await mru.saveToStorage();
  }
  // If we were mid-traversal when the worker died, abandon it.
  if (mru.isTraversing) {
    mru.cancelTraversal();
  }
})();

chrome.runtime.onInstalled.addListener(async (details) => {
  // Manifest content scripts only reach pages loaded after install/reload, so inject into open tabs too.
  for (const tab of await chrome.tabs.query({})) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["copy-shortcut.js"] })
      .catch(() => {}); // chrome://, Web Store, etc. reject injection
  }

  try {
    await ready;
    if (details.reason === "install" || Object.keys(mru.mruByWindow).length === 0) {
      log("onInstalled — rebuilding MRU", details.reason);
      await mru.rebuildAllWindowsFromBrowser();
      await mru.saveToStorage();
    } else {
      log("onInstalled — preserved MRU from session", details.reason);
    }

    // Chrome drops suggested_key on conflict and extensions can't assign shortcuts, so prompt the user.
    const unbound = (await chrome.commands.getAll()).filter((c) => c.name.startsWith("mru_") && !c.shortcut);
    if (unbound.length) {
      warn("Shortcuts not bound — opening shortcuts page", unbound.map((c) => c.name));
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  } catch (err) {
    warn("onInstalled handler error", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  log("onStartup — rebuilding MRU from browser tab metadata");
  await mru.rebuildAllWindowsFromBrowser();
  await mru.saveToStorage();
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    await ready;
    if (mru.isTraversing) {
      if (pendingTraversalActivations.has(activeInfo.tabId)) {
        // Expected activation from our traversal — suppress MRU reordering.
        pendingTraversalActivations.delete(activeInfo.tabId);
        log("onActivated suppressed (traversal)", activeInfo.tabId);
        return;
      }
      // User clicked a different tab manually — end traversal, then record.
      log("Traversal interrupted by manual tab switch to", activeInfo.tabId);
      mru.commitTraversal();
      clearTraversalTimer();
      pendingTraversalActivations.clear();
      // Fall through to record the manually activated tab.
    }

    mru.recordActivation(activeInfo.windowId, activeInfo.tabId);
    await mru.saveToStorage();
    log("onActivated", activeInfo.windowId, activeInfo.tabId);
  } catch (err) {
    warn("onActivated handler error", err);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await ready;
    if (mru.isTraversing) {
      mru.removeFromTraversal(tabId);
      if (!mru.isTraversing) {
        clearTraversalTimer();
        pendingTraversalActivations.clear();
      }
    }
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
    await ready;
    if (mru.isTraversing) {
      mru.removeFromTraversal(tabId);
    }
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
    await ready;
    mru.recordActivation(attachInfo.newWindowId, tabId);
    await mru.saveToStorage();
    log("onAttached", tabId, attachInfo.newWindowId);
  } catch (err) {
    warn("onAttached handler error", err);
  }
});

// Active new tabs are recorded by onActivated; background ones (Ctrl+click) need recording here.
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    await ready;
    if (tab.active || tab.id == null || tab.windowId == null) return;
    mru.recordBackgroundTab(tab.windowId, tab.id);
    await mru.saveToStorage();
    log("onCreated (background)", tab.windowId, tab.id);
  } catch (err) {
    warn("onCreated handler error", err);
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    await ready;
    if (mru.isTraversing && mru.traversalWindowId === windowId) {
      mru.cancelTraversal();
      clearTraversalTimer();
      pendingTraversalActivations.clear();
    }
    if (mru.mruByWindow[windowId]) {
      delete mru.mruByWindow[windowId];
      await mru.saveToStorage();
      log("onRemoved window — dropped MRU list", windowId);
    }
  } catch (err) {
    warn("windows.onRemoved handler error", err);
  }
});

// ── Commands ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  await ready;
  if (command === "mru_forward") {
    // Alt+Q: simple 2-tab toggle — no popup, no traversal
    try {
      await handleSimpleToggle();
      log("Alt+Q toggle complete");
    } catch (error) {
      warn("mru_forward error", error);
    }
  } else if (command === "mru_backward") {
    // Alt+W: full MRU traversal with popup
    try {
      await handleTraversalStep();
      try {
        await chrome.action.openPopup();
      } catch {
        // Popup may already be open (Chrome closes & reopens it)
      }
      log("Alt+W traversal step + popup");
    } catch (error) {
      warn("mru_backward error", error);
    }
  }
});

// ── Messages from popup ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "commitTraversal") {
    ready.then(commitTraversalNow).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});
