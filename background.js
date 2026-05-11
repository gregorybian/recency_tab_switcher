/**
 * RecentTabSwitcher — background service worker (Manifest V3).
 * Tracks per-window MRU order and handles keyboard commands.
 *
 * Traversal mode: when the user holds Alt and presses Q/W repeatedly,
 * we walk through the full MRU list without reordering it. The list is
 * committed (reordered) only when traversal ends.
 */

// Shared MRU implementation (service worker has no ES module imports in all Chrome versions without "type":"module")
importScripts("mru-manager.js");

const LOG_PREFIX = "[RecentTabSwitcher]";
const mru = new MruManager();

/** Tab id we expect Chrome's onActivated to fire for (traversal-triggered). */
let expectedTraversalTabId = null;

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

// ── Traversal ────────────────────────────────────────────────────────

function resetTraversalTimeout() {
  if (traversalTimeout) clearTimeout(traversalTimeout);
  traversalTimeout = setTimeout(async () => {
    if (mru.isTraversing) {
      mru.commitTraversal();
      await mru.saveToStorage();
      log("Traversal auto-committed via timeout");
    }
    expectedTraversalTabId = null;
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
 * Find the next valid (still-existing) tab in the given direction.
 * Skips over stale tabs and removes them from the snapshot + MRU.
 * @param {'forward' | 'backward'} direction
 * @returns {Promise<number | null>}
 */
async function getValidTraversalTarget(direction) {
  if (!mru.isTraversing || !mru._traversal) return null;
  const maxAttempts = mru._traversal.snapshot.length;

  for (let i = 0; i < maxAttempts; i++) {
    const targetId =
      direction === "forward" ? mru.stepForward() : mru.stepBackward();
    if (targetId == null) return null;

    const tab = await safeGetTab(targetId);
    if (tab) return targetId;

    // Stale tab — remove from traversal snapshot and live MRU
    mru.removeFromTraversal(targetId);
    mru.removeTabEverywhere(targetId);

    if (!mru.isTraversing) return null; // all tabs gone
    // After removal, cursor already points at the next element;
    // read it directly instead of stepping again.
    const next = mru.traversalCurrentTabId;
    if (next == null) return null;
    const nextTab = await safeGetTab(next);
    if (nextTab) return next;
    // That one is stale too — loop continues
    mru.removeFromTraversal(next);
    mru.removeTabEverywhere(next);
    if (!mru.isTraversing) return null;
  }

  return null;
}

/**
 * Handle a single traversal step (Alt+Q or Alt+W).
 * @param {'forward' | 'backward'} direction
 */
async function handleTraversalStep(direction) {
  // If already traversing in the same window, just step
  if (mru.isTraversing) {
    const targetId = await getValidTraversalTarget(direction);
    if (targetId == null) {
      mru.cancelTraversal();
      clearTraversalTimer();
      expectedTraversalTabId = null;
      return;
    }

    expectedTraversalTabId = targetId;
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

  const targetId = await getValidTraversalTarget(direction);
  if (targetId == null) {
    mru.cancelTraversal();
    return;
  }

  expectedTraversalTabId = targetId;
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
  expectedTraversalTabId = null;
  log("Traversal committed explicitly");
}

// ── Lifecycle & MRU bookkeeping ─────────────────────────────────────

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
  // If we were mid-traversal when the worker died, abandon it (state is lost).
  if (mru.isTraversing) {
    mru.cancelTraversal();
  }
})();

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    if (mru.isTraversing) {
      if (activeInfo.tabId === expectedTraversalTabId) {
        // Expected activation from our traversal step — suppress reordering.
        log("onActivated suppressed (traversal)", activeInfo.tabId);
        return;
      }
      // User clicked a different tab manually — end traversal and record.
      log("Traversal interrupted by manual tab switch to", activeInfo.tabId);
      mru.commitTraversal();
      clearTraversalTimer();
      expectedTraversalTabId = null;
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
    // Remove from traversal snapshot if active
    if (mru.isTraversing) {
      mru.removeFromTraversal(tabId);
      if (!mru.isTraversing) {
        // All tabs in snapshot gone
        clearTraversalTimer();
        expectedTraversalTabId = null;
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
    // While moving between windows the tab is briefly not in any window; drop it from MRU until onAttached/onActivated.
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
    // If traversing in the removed window, cancel
    if (mru.isTraversing && mru.traversalWindowId === windowId) {
      mru.cancelTraversal();
      clearTraversalTimer();
      expectedTraversalTabId = null;
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
  if (command === "mru_forward") {
    try {
      await handleTraversalStep("forward");
      await chrome.action.openPopup();
      log("Traversal step forward + popup");
    } catch (error) {
      warn("mru_forward error", error);
    }
  } else if (command === "mru_backward") {
    try {
      await handleTraversalStep("backward");
      await chrome.action.openPopup();
      log("Traversal step backward + popup");
    } catch (error) {
      warn("mru_backward error", error);
    }
  }
});

// ── Messages from popup ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "commitTraversal") {
    commitTraversalNow().then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});
