// Reamlet extension — service worker (Manifest V3)
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const NATIVE_HOST = 'com.reamlet.chromebridge';

// ── State ─────────────────────────────────────────────────────

let interceptEnabled = true;

chrome.storage.local.get(['interceptEnabled'], (result) => {
  if (result.interceptEnabled !== undefined) {
    interceptEnabled = result.interceptEnabled;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if ('interceptEnabled' in changes) {
    interceptEnabled = changes.interceptEnabled.newValue;
    updateBadge();
  }
});

function updateBadge() {
  chrome.action.setBadgeText({ text: interceptEnabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#888' });
}

// ── Helpers ───────────────────────────────────────────────────

function isPdfUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith('.pdf');
  } catch {
    return false;
  }
}

function isPdfDownload(item) {
  if (item.mime === 'application/pdf') return true;
  try {
    if (item.filename && item.filename.toLowerCase().endsWith('.pdf')) return true;
  } catch { /* ignore */ }
  return isPdfUrl(item.url);
}

// Send a message to the native host and return a Promise that resolves with
// the response, or rejects on any native messaging error.
function sendToNativeHost(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { url }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Attempt to open the PDF in Reamlet.
// Returns true on success, false on any failure.
async function openInReamlet(url) {
  try {
    const response = await sendToNativeHost(url);
    if (!response?.ok) {
      console.error('[Reamlet] Host returned error:', response?.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Reamlet] Native messaging failed:', err.message);
    return false;
  }
}

// After intercepting a navigation, clean up the tab:
//   success → go back if there's history, otherwise close the tab
//   failure → navigate to the original URL so the browser handles it
async function resolveTab(tabId, originalUrl, success) {
  if (success) {
    chrome.tabs.goBack(tabId, () => {
      if (chrome.runtime.lastError) {
        // No history — tab was opened just for this PDF, close it
        chrome.tabs.remove(tabId);
      }
    });
  } else {
    // Mark this tab so the next navigation event doesn't re-intercept it
    addBypass(tabId);
    chrome.tabs.update(tabId, { url: originalUrl }, () => {
      if (chrome.runtime.lastError) {
        // Tab was already closed — clean up immediately
        bypassTabs.delete(tabId);
      }
    });
  }
}

// Tabs currently being handed back to the browser after a failed intercept.
// Consumed by onHeadersReceived (the last event in the navigation chain) so
// that both onBeforeNavigate and onHeadersReceived are covered by one flag.
const bypassTabs = new Set();

function addBypass(tabId) {
  bypassTabs.add(tabId);
  // Safety cleanup in case onHeadersReceived never fires (e.g. non-HTTP URL).
  setTimeout(() => bypassTabs.delete(tabId), 15000);
}

// ── PDF interception: content-type ────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (!interceptEnabled) return;
    if (details.type !== 'main_frame') return;
    if (bypassTabs.has(details.tabId)) {
      // Consume the flag here — this is the last event in the navigation chain.
      bypassTabs.delete(details.tabId);
      return;
    }

    const contentType = (details.responseHeaders ?? []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    )?.value ?? '';

    if (!contentType.includes('application/pdf')) return;

    const url = details.url;
    console.log('[Reamlet] Intercepted PDF via content-type:', url);

    chrome.tabs.update(details.tabId, { url: 'about:blank' });

    const ok = await openInReamlet(url);
    await resolveTab(details.tabId, url, ok);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ── PDF interception: URL pattern ─────────────────────────────

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (!interceptEnabled) return;
    if (details.frameId !== 0) return;
    if (bypassTabs.has(details.tabId)) {
      // Don't delete here — onHeadersReceived will consume the flag.
      return;
    }

    const url = details.url;
    console.log('[Reamlet] Intercepted PDF via URL pattern:', url);

    chrome.tabs.update(details.tabId, { url: 'about:blank' });

    const ok = await openInReamlet(url);
    await resolveTab(details.tabId, url, ok);
  },
  { url: [{ urlMatches: '\\.pdf(\\?[^#]*)?(?:#.*)?$' }] }
);

// ── PDF interception: downloads ───────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  if (!interceptEnabled) return;
  if (!isPdfDownload(item)) return;

  console.log('[Reamlet] Intercepted PDF download:', item.url);

  chrome.downloads.cancel(item.id);

  const ok = await openInReamlet(item.url);
  if (!ok) {
    // Fall back: open the URL in a new tab so the browser downloads it
    chrome.tabs.create({ url: item.url });
  }
});
