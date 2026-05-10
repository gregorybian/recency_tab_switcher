# RecentTabSwitcher

A **Google Chrome extension (Manifest V3)** that switches tabs using a **most-recently-used (MRU)** order, similar to how **Alt+Tab** cycles recent windows on Windows.

Chrome’s built-in **Ctrl+Tab** advances tabs in **left-to-right tab-strip order**. This extension adds **separate shortcuts** (see below) that jump to **the tab you used immediately before the current one**, which produces the familiar “toggle the last two tabs” behavior, plus a second shortcut that steps **deeper** into MRU history.

## What it does

- Maintains a **per-window** MRU stack of tab IDs.
- Whenever the **active tab changes**, that tab moves to the **front** of the MRU list for that window.
- **Forward** command: activate **MRU[1]** — the **previously used** tab (when you are already at MRU[0]). This matches the example:

  - MRU after visiting A → C → D → B is `[B, D, C, A]`.
  - From **B**, forward goes to **D**; after activation the MRU becomes `[D, B, C, A]`, and forward again returns to **B**.

- **Backward** command: prefer **MRU[2]** (third-most-recent) when the current tab is newest and at least three tabs exist; otherwise it falls back sensibly (with only two tabs it mirrors forward).

State is kept **in memory** and mirrored to **`chrome.storage.session`** so a **suspended service worker** can resume without losing MRU. After a **full browser restart** or if storage is empty, MRU is **rebuilt** using each tab’s **`lastAccessed`** timestamp when available, with **tab index** as a fallback.

## Why Chrome’s default tab switching is different

Chrome intentionally maps **Ctrl+Tab** to **linear tab-strip order** (with optional “recent” ordering behind flags in some versions). That behavior is part of the **browser UI**, not the page, and is not designed to be overridden by extensions.

## Can extensions truly override Ctrl+Tab?

**Mostly no, not reliably.**

- Extensions can declare **keyboard shortcuts** with the **`commands` API**, and Chrome lets users bind many combinations in **`chrome://extensions/shortcuts`**.
- However, **Chrome reserves** a set of **browser-level shortcuts** (including many tab/window navigations). **Ctrl+Tab** is tightly bound to Chrome’s **built-in tab switching**. Even if you assign **Ctrl+Tab** to an extension command in the shortcuts UI, Chrome may **ignore it**, **conflict**, or give **unpredictable** results depending on OS, focus, version, and policy.
- Extensions **cannot** intercept **every** keystroke globally the way a native app with a low-level keyboard hook can. There is **no supported API** for “take over Ctrl+Tab everywhere in Chrome.”

### Workarounds

1. **Use alternate shortcuts** (this extension’s default): e.g. **Alt+Q** / **Alt+E** on Windows/Linux, **Command+E** / **Alt+E** on macOS for the two commands (defaults are set in `manifest.json`; you can change them in the shortcuts page).
2. **User remapping in `chrome://extensions/shortcuts`**: try binding **Ctrl+Tab** to **`mru_forward`**; if Chrome accepts it on your system, it may work — but **do not depend on this** for production assumptions.
3. **OS-level remapping** (e.g. tools that remap keys outside Chrome) can forward a **non-reserved** combo to a **different** combo that triggers the extension — still fragile but sometimes practical.
4. **Full system-level interception** of **Ctrl+Tab** (including outside Chrome) requires **native code** (accessibility APIs, keyboard hooks, driver-level tools) or a **native host** — **not** a normal extension alone.

### Would Native Messaging help?

**Native Messaging** lets an extension talk to a **trusted local process**. It does **not** grant the extension new powers to **capture Ctrl+Tab inside Chrome’s UI**. You’d still need a **separate native component** that uses **OS APIs** to remap keys or drive Chrome — far beyond a typical extension and a significant install/support burden.

## Installation (load unpacked)

1. Clone or copy this folder to your machine.
2. Open Chrome and go to **`chrome://extensions`**.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the **`recency_tab_switch`** directory (the folder containing `manifest.json`).

## Configure keyboard shortcuts

1. Open **`chrome://extensions/shortcuts`**.
2. Find **RecentTabSwitcher**.
3. Set shortcuts for:
   - **MRU: switch to the previously used tab…** → maps to command id **`mru_forward`**
   - **MRU: step deeper into MRU history…** → **`mru_backward`**

You can try assigning **Ctrl+Tab** / **Ctrl+Shift+Tab** here; if Chrome blocks or ignores them, use the defaults or pick other keys.

## Permissions

| Permission | Why it’s needed |
|------------|------------------|
| **`tabs`** | Query tabs, read `windowId` / `lastAccessed`, and **activate** a tab + **focus** its window. |
| **`storage`** | Persist MRU in **`chrome.storage.session`** across **service worker** suspensions (not required for every operation, but avoids losing MRU on idle). |

No host permissions, no remote code, no popup — minimal surface area.

## How the MRU algorithm works (per window)

1. **On tab activation** (`tabs.onActivated`): remove the tab id if present, then **prepend** it → it becomes **MRU[0]**.
2. **On tab close** (`tabs.onRemoved`): remove that id from **every** window list (defensive).
3. **On tab move** (`tabs.onDetached` / `tabs.onAttached`): remove on detach; on attach, **prepend** in the **destination** window (Chrome usually sends **activation** afterward if that tab is active).
4. **On window close** (`windows.onRemoved`): delete that window’s MRU list.
5. **Forward command** (`mru_forward`): from the active tab id, activate **`getMruForwardTarget`** — typically **MRU[1]** when the active tab is already MRU[0].
6. **Backward command** (`mru_backward`): activate **`getMruBackwardTarget`** — typically **MRU[2]** when possible.

## Debugging

Open **`chrome://extensions` → RecentTabSwitcher → Service worker → Inspect** and watch the console. Logs are prefixed with **`[RecentTabSwitcher]`**.

## Edge cases (behavior summary)

| Scenario | Behavior |
|----------|----------|
| **Closed tabs** | Removed from MRU on `tabs.onRemoved`. |
| **New tabs** | Enter MRU when **activated** (normal Chrome behavior). |
| **Multiple windows** | **Separate MRU list per `windowId`**. Commands use the **last focused** window’s active tab. |
| **Pinned tabs** | Treated like normal tabs. |
| **Incognito** | Works only if you enable **“Allow in Incognito”** for the extension. Chrome isolates incognito; you must opt in. |
| **Discarded / frozen tabs** | Tab id remains valid; activation wakes the tab like a normal click. |
| **Startup / session restore** | `runtime.onStartup` rebuilds MRU from **`lastAccessed`** (and index fallback). |
| **Extension reload** | MRU is reloaded from **`chrome.storage.session`** when possible; if empty, it **rebuilds** from the browser. |

## Known limitations

- **Ctrl+Tab** may **not** be reliably bound to extension commands; defaults use **other** shortcuts.
- **MRU accuracy** after a crash or if **`lastAccessed`** is missing depends on **fallback ordering** (tab index).
- No **UI** for history preview (like a full Alt+Tab grid) — only **instant** switching.
- Very rapid window/tab churn could theoretically race; the code is defensive but not formally modeled.

## Future improvements

- Optional **popup** showing MRU list with fuzzy search.
- **chrome.tabGroups** awareness (group-local MRU optional).
- **Session** export/import for debugging.
- **Telemetry-free** self-test page under `chrome-extension://` for contributors.

## Files

- `manifest.json` — MV3 manifest, `commands`, permissions.
- `background.js` — service worker: events, commands, activation.
- `mru-manager.js` — MRU data structure, persistence, target selection.
- `icons/` — placeholder PNGs; replace with your branding if you like.

## License

Use and modify freely for personal or commercial projects; no warranty implied.
