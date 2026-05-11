/**
 * RecentTabSwitcher — MRU (Most Recently Used) tab ordering per browser window.
 *
 * Ordering: index 0 = most recently active tab in that window, index 1 = previous, ...
 * Duplicate tab IDs are never stored. Closed tabs are removed on tab removal events.
 *
 * Traversal mode: when the user is cycling through tabs (holding Alt and pressing Q/W),
 * a snapshot of the MRU list is frozen and a cursor walks through it. The live MRU list
 * is NOT reordered during traversal. When traversal ends, the final tab is recorded.
 */

(function initMruManager(global) {
  const LOG_PREFIX = "[RecentTabSwitcher]";

  /** @type {string} */
  const STORAGE_KEY = "mruByWindow";

  /**
   * @typedef {Object<number, number[]>} MruByWindow
   * Map: chrome window id -> ordered list of tab ids (MRU, newest first)
   */

  class MruManager {
    constructor() {
      /** @type {MruByWindow} */
      this.mruByWindow = {};

      /**
       * Traversal state — null when not traversing.
       * @type {{ windowId: number, snapshot: number[], cursor: number } | null}
       */
      this._traversal = null;
    }

    log(...args) {
      console.log(LOG_PREFIX, ...args);
    }

    warn(...args) {
      console.warn(LOG_PREFIX, ...args);
    }

    // ── Traversal API ────────────────────────────────────────────────

    /** @returns {boolean} */
    get isTraversing() {
      return this._traversal !== null;
    }

    /** @returns {number | undefined} */
    get traversalWindowId() {
      return this._traversal?.windowId;
    }

    /** @returns {number | undefined} The tab id the cursor currently points to. */
    get traversalCurrentTabId() {
      if (!this._traversal) return undefined;
      return this._traversal.snapshot[this._traversal.cursor];
    }

    /**
     * Begin a traversal cycle. Snapshots the current MRU list so it stays
     * stable while the user cycles. Cursor starts at index 0 (the active tab).
     * @param {number} windowId
     * @returns {boolean} true if traversal was started
     */
    startTraversal(windowId) {
      const list = this.mruByWindow[windowId];
      if (!list || list.length < 2) return false;

      this._traversal = {
        windowId,
        snapshot: [...list],
        cursor: 0,
      };
      this.log("Traversal started", { windowId, tabs: list.length });
      return true;
    }

    /**
     * Move cursor forward (toward older/less-recent tabs). Wraps around.
     * @returns {number | undefined} tab id at the new cursor position
     */
    stepForward() {
      if (!this._traversal || this._traversal.snapshot.length === 0) return undefined;
      this._traversal.cursor =
        (this._traversal.cursor + 1) % this._traversal.snapshot.length;
      return this._traversal.snapshot[this._traversal.cursor];
    }

    /**
     * Move cursor backward (toward newer/more-recent tabs). Wraps around.
     * @returns {number | undefined} tab id at the new cursor position
     */
    stepBackward() {
      if (!this._traversal || this._traversal.snapshot.length === 0) return undefined;
      const len = this._traversal.snapshot.length;
      this._traversal.cursor = (this._traversal.cursor - 1 + len) % len;
      return this._traversal.snapshot[this._traversal.cursor];
    }

    /**
     * Remove a stale tab from the traversal snapshot (e.g. it was closed).
     * Adjusts the cursor so it doesn't skip entries or go out of bounds.
     * @param {number} tabId
     */
    removeFromTraversal(tabId) {
      if (!this._traversal) return;
      const idx = this._traversal.snapshot.indexOf(tabId);
      if (idx === -1) return;

      this._traversal.snapshot.splice(idx, 1);

      if (this._traversal.snapshot.length === 0) {
        this._traversal = null;
        return;
      }

      // Adjust cursor: if removed item was before cursor, shift back.
      // If at cursor, keep position (now points to the next element).
      if (idx < this._traversal.cursor) {
        this._traversal.cursor--;
      }
      // Clamp in case cursor is now past the end
      if (this._traversal.cursor >= this._traversal.snapshot.length) {
        this._traversal.cursor = 0;
      }
    }

    /**
     * End traversal and record the final tab as the most recently used.
     * This reorders the live MRU list so the chosen tab is at index 0.
     */
    commitTraversal() {
      if (!this._traversal) return;
      const { windowId, snapshot, cursor } = this._traversal;
      const finalTabId = snapshot[cursor];
      this._traversal = null;

      if (finalTabId != null) {
        this.recordActivation(windowId, finalTabId);
        this.log("Traversal committed", { windowId, tab: finalTabId });
      }
    }

    /** End traversal without recording anything. */
    cancelTraversal() {
      this.log("Traversal cancelled");
      this._traversal = null;
    }

    // ── Core MRU logic (unchanged) ───────────────────────────────────

    /**
     * Load MRU state from session storage (survives service worker restarts).
     * @returns {Promise<void>}
     */
    async loadFromStorage() {
      try {
        const data = await chrome.storage.session.get(STORAGE_KEY);
        const raw = data[STORAGE_KEY];
        if (raw && typeof raw === "object") {
          this.mruByWindow = /** @type {MruByWindow} */ (raw);
          this.log("Restored MRU from session storage", this.summary());
        }
      } catch (err) {
        this.warn("Failed to load MRU from storage", err);
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async saveToStorage() {
      try {
        await chrome.storage.session.set({ [STORAGE_KEY]: this.mruByWindow });
      } catch (err) {
        this.warn("Failed to persist MRU", err);
      }
    }

    summary() {
      return Object.fromEntries(
        Object.entries(this.mruByWindow).map(([wid, ids]) => [wid, ids.length])
      );
    }

    /**
     * Remove a tab id from every window list (tab closed or moved).
     * @param {number} tabId
     */
    removeTabEverywhere(tabId) {
      let changed = false;
      for (const wid of Object.keys(this.mruByWindow)) {
        const before = this.mruByWindow[wid].length;
        this.mruByWindow[wid] = this.mruByWindow[wid].filter((id) => id !== tabId);
        if (this.mruByWindow[wid].length !== before) changed = true;
        if (this.mruByWindow[wid].length === 0) delete this.mruByWindow[wid];
      }
      return changed;
    }

    /**
     * When a tab becomes active in a window, move it to the MRU front for that window.
     * @param {number} windowId
     * @param {number} tabId
     */
    recordActivation(windowId, tabId) {
      const list = this.mruByWindow[windowId] ? [...this.mruByWindow[windowId]] : [];
      const without = list.filter((id) => id !== tabId);
      without.unshift(tabId);
      this.mruByWindow[windowId] = without;
    }

    /**
     * Best-effort rebuild for a window using Tab.lastAccessed (Chrome 121+ in MV3; may be undefined on older builds).
     * @param {number} windowId
     * @returns {Promise<void>}
     */
    async rebuildWindowFromBrowser(windowId) {
      try {
        const tabs = await chrome.tabs.query({ windowId });
        const sorted = [...tabs].sort((a, b) => {
          const la = a.lastAccessed ?? 0;
          const lb = b.lastAccessed ?? 0;
          if (la !== lb) return lb - la;
          return (a.index ?? 0) - (b.index ?? 0);
        });
        this.mruByWindow[windowId] = sorted.map((t) => t.id).filter((id) => typeof id === "number");
        this.log("Rebuilt MRU for window", windowId, "tabs", this.mruByWindow[windowId].length);
      } catch (err) {
        this.warn("rebuildWindowFromBrowser failed", windowId, err);
      }
    }

    /**
     * Rebuild all normal windows (startup / extension install / manual recovery).
     * @returns {Promise<void>}
     */
    async rebuildAllWindowsFromBrowser() {
      try {
        const windows = await chrome.windows.getAll({ populate: true });
        this.mruByWindow = {};
        for (const win of windows) {
          if (win.id == null || !win.tabs) continue;
          const sorted = [...win.tabs].sort((a, b) => {
            const la = a.lastAccessed ?? 0;
            const lb = b.lastAccessed ?? 0;
            if (la !== lb) return lb - la;
            return (a.index ?? 0) - (b.index ?? 0);
          });
          this.mruByWindow[win.id] = sorted.map((t) => t.id).filter((id) => typeof id === "number");
        }
        this.log("Rebuilt MRU for all windows", this.summary());
      } catch (err) {
        this.warn("rebuildAllWindowsFromBrowser failed", err);
      }
    }

    /**
     * @param {number} windowId
     * @param {number} tabId
     * @returns {number | undefined}
     */
    getMruForwardTarget(windowId, tabId) {
      const list = this.mruByWindow[windowId];
      if (!list || list.length < 2) return undefined;

      const idx = list.indexOf(tabId);
      if (idx === -1) {
        // Current tab missing (race or first run): treat as if it were newest, switch to first "other"
        return list.find((id) => id !== tabId) ?? list[1];
      }
      // Standard case: current tab should be at 0; MRU[1] is "previous" tab → Alt+Tab pair toggle.
      if (idx === 0) return list[1];

      // If user somehow isn't at index 0, still step to the next older entry after current position.
      if (idx + 1 < list.length) return list[idx + 1];
      return list[0];
    }

    /**
     * "Backward" steps further into history than forward (typically MRU[2], else last/oldest tracked).
     * @param {number} windowId
     * @param {number} tabId
     */
    getMruBackwardTarget(windowId, tabId) {
      const list = this.mruByWindow[windowId];
      if (!list || list.length < 2) return undefined;

      const idx = list.indexOf(tabId);
      if (idx === -1) {
        return list.length > 2 ? list[2] : list[list.length - 1];
      }

      if (list.length >= 3) {
        // Prefer the third slot when current is newest (classic "back two steps").
        if (idx === 0) return list[2];
        // If already deeper, go one step further; wrap to front for predictability.
        if (idx + 2 < list.length) return list[idx + 2];
        return list[0];
      }

      // Only two tabs: backward mirrors forward (toggle).
      return list[1];
    }
  }

  global.MruManager = MruManager;
})(typeof self !== "undefined" ? self : this);
