/**
 * Popup script — displays all tabs and allows switching between them
 */

let selectMode = false;

async function populateTabs() {
  const tabListContainer = document.getElementById('tabList');
  const tabCountEl = document.getElementById('tabCount');

  try {
    // Query all tabs across all windows
    const allTabs = await chrome.tabs.query({});

    if (allTabs.length === 0) {
      tabListContainer.innerHTML =
        '<div class="empty-state">No tabs open</div>';
      tabCountEl.textContent = '';
      return;
    }

    // Get the currently active tab for highlighting
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    const activeTabId = activeTab?.id;

    // Group tabs by window
    const tabsByWindow = {};
    allTabs.forEach((tab) => {
      const windowId = tab.windowId;
      if (!tabsByWindow[windowId]) {
        tabsByWindow[windowId] = [];
      }
      tabsByWindow[windowId].push(tab);
    });

    // Build HTML
    let html = '';
    Object.keys(tabsByWindow).forEach((windowId) => {
      const tabs = tabsByWindow[windowId];
      tabs.forEach((tab) => {
        const isActive = tab.id === activeTabId;
        const faviconUrl = tab.favIconUrl || '';
        const title = tab.title || 'Untitled';
        const url = new URL(tab.url).hostname || tab.url;

        html += `
          <div class="tab-item ${isActive ? 'active' : ''}" data-tab-id="${tab.id}" data-window-id="${tab.windowId}">
            <input type="checkbox" class="tab-checkbox" data-tab-id="${tab.id}" />
            <div class="tab-favicon" ${faviconUrl ? `style="background-image: url('${faviconUrl}')"` : ''}></div>
            <div class="tab-info">
              <div class="tab-title">${escapeHtml(title)}</div>
              <div class="tab-url">${escapeHtml(url)}</div>
            </div>
            ${Object.keys(tabsByWindow).length > 1 ? `<div class="tab-window-label">Window ${windowId}</div>` : ''}
            <div class="tab-close" data-close-tab-id="${tab.id}" title="Close tab">&times;</div>
          </div>
        `;
      });
    });

    tabListContainer.innerHTML = html;
    tabCountEl.textContent = `${allTabs.length} tab${allTabs.length !== 1 ? 's' : ''} open`;

    // Add click handlers for tab items
    document.querySelectorAll('.tab-item').forEach((element) => {
      element.addEventListener('click', (e) => {
        if (selectMode) {
          // In select mode, toggle the checkbox
          const checkbox = element.querySelector('.tab-checkbox');
          checkbox.checked = !checkbox.checked;
          element.classList.toggle('selected', checkbox.checked);
          updateSelectedCount();
        } else {
          const tabId = parseInt(element.dataset.tabId, 10);
          const windowId = parseInt(element.dataset.windowId, 10);
          switchToTab(tabId, windowId);
        }
      });
    });

    // Prevent checkbox clicks from double-toggling
    document.querySelectorAll('.tab-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabItem = checkbox.closest('.tab-item');
        tabItem.classList.toggle('selected', checkbox.checked);
        updateSelectedCount();
      });
    });

    // Add click handlers for closing tabs
    document.querySelectorAll('.tab-close').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tabId = parseInt(btn.dataset.closeTabId, 10);
        closeTab(tabId);
      });
    });
  } catch (error) {
    console.error('Error populating tabs:', error);
    tabListContainer.innerHTML =
      '<div class="empty-state">Error loading tabs</div>';
  }
}

/**
 * Update the selected count display and button state
 */
function updateSelectedCount() {
  const checked = document.querySelectorAll('.tab-checkbox:checked');
  const countEl = document.getElementById('selectedCount');
  const closeBtn = document.getElementById('closeSelectedBtn');
  const selectAllBtn = document.getElementById('selectAllBtn');
  const total = document.querySelectorAll('.tab-checkbox').length;

  countEl.textContent = `${checked.length} selected`;
  closeBtn.disabled = checked.length === 0;
  selectAllBtn.textContent = checked.length === total ? 'Deselect All' : 'Select All';
}

/**
 * Toggle select mode on/off
 */
function toggleSelectMode() {
  selectMode = !selectMode;
  document.body.classList.toggle('select-mode', selectMode);
  document.getElementById('selectBtn').classList.toggle('active', selectMode);
  document.getElementById('selectBtn').textContent = selectMode ? 'Cancel' : 'Select';

  if (!selectMode) {
    // Clear all selections when exiting select mode
    document.querySelectorAll('.tab-checkbox').forEach((cb) => {
      cb.checked = false;
    });
    document.querySelectorAll('.tab-item.selected').forEach((el) => {
      el.classList.remove('selected');
    });
    updateSelectedCount();
  }
}

/**
 * Switch to a specific tab
 */
async function switchToTab(tabId, windowId) {
  try {
    // Focus the window
    await chrome.windows.update(windowId, { focused: true });
    // Activate the tab
    await chrome.tabs.update(tabId, { active: true });
    // Close popup
    window.close();
  } catch (error) {
    console.error('Error switching to tab:', error);
  }
}

/**
 * Close a specific tab
 */
async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    console.error('Error closing tab:', error);
  }
}

/**
 * Close all selected tabs
 */
async function closeSelectedTabs() {
  const checked = document.querySelectorAll('.tab-checkbox:checked');
  const tabIds = Array.from(checked).map((cb) => parseInt(cb.dataset.tabId, 10));

  if (tabIds.length === 0) return;

  try {
    await chrome.tabs.remove(tabIds);
  } catch (error) {
    console.error('Error closing selected tabs:', error);
  }
}

/**
 * Toggle select all / deselect all
 */
function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('.tab-checkbox');
  const allChecked = document.querySelectorAll('.tab-checkbox:checked').length === checkboxes.length;

  checkboxes.forEach((cb) => {
    cb.checked = !allChecked;
    cb.closest('.tab-item').classList.toggle('selected', !allChecked);
  });
  updateSelectedCount();
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Populate tabs when popup opens
populateTabs();

// Close popup when Alt key is released (Alt+Tab-like behavior)
document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') {
    window.close();
  }
});

// Wire up header buttons
document.getElementById('selectBtn').addEventListener('click', toggleSelectMode);
document.getElementById('selectAllBtn').addEventListener('click', toggleSelectAll);
document.getElementById('closeSelectedBtn').addEventListener('click', closeSelectedTabs);

// Listen for tab changes and refresh the list
chrome.tabs.onActivated.addListener(() => {
  populateTabs();
});

chrome.tabs.onUpdated.addListener(() => {
  populateTabs();
});

chrome.tabs.onCreated.addListener(() => {
  populateTabs();
});

chrome.tabs.onRemoved.addListener(() => {
  populateTabs();
});
