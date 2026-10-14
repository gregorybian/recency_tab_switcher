/**
 * RecentTabSwitcher — content script.
 * Makes Ctrl+Shift+C copy the current selection instead of opening DevTools' element picker.
 */

// Guard: background.js also injects this into already-open tabs on install/reload.
if (!window.__rtsCopyShortcut) {
  window.__rtsCopyShortcut = true;

  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      if (event.code !== "KeyC") return;

      // Capture phase + stopImmediatePropagation so page handlers can't swallow it first.
      event.preventDefault();
      event.stopImmediatePropagation();

      // execCommand (not navigator.clipboard) so selections inside <input>/<textarea> are copied too.
      document.execCommand("copy");
    },
    true
  );
}
