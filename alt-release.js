/**
 * RecentTabSwitcher — content script.
 * Ends an Alt+W traversal when Alt is released, so the chosen tab is committed right away.
 */

// Guard: background.js also injects this into already-open tabs on install/reload.
if (!window.__rtsAltRelease) {
  window.__rtsAltRelease = true;

  window.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "Alt") return;
      // Background ignores this when no traversal is active.
      chrome.runtime.sendMessage({ type: "commitTraversal" }).catch(() => {});
    },
    true
  );
}
