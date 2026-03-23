// Reamlet extension — service worker (Manifest V3)
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const NATIVE_HOST = 'com.reamlet.chromeBridge';

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

function openInReamlet(url) {
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { url }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[Reamlet] Native messaging error:', chrome.runtime.lastError.message);
    }
  });
}

// ── PDF interception: content-type ────────────────────────────
//
// webRequest in MV3 is observation-only (no blocking mode).
// When we detect application/pdf in response headers, redirect the
// tab away immediately and forward the URL to the native host.

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!interceptEnabled) return;
    if (details.type !== 'main_frame') return;

    const contentType = (details.responseHeaders ?? []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    )?.value ?? '';

    if (!contentType.includes('application/pdf')) return;

    // Redirect the tab away before the browser renders the PDF.
    chrome.tabs.update(details.tabId, { url: 'about:blank' });
    openInReamlet(details.url);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ── PDF interception: URL pattern ─────────────────────────────
//
// Catch navigations to .pdf URLs before the request is made.
// We use webNavigation instead of declarativeNetRequest so that
// the same code path handles interception toggle at runtime.

chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (!interceptEnabled) return;
    if (details.frameId !== 0) return; // main frame only

    chrome.tabs.update(details.tabId, { url: 'about:blank' });
    openInReamlet(details.url);
  },
  { url: [{ urlMatches: '\\.pdf(\\?[^#]*)?(?:#.*)?$' }] }
);

// ── PDF interception: downloads ───────────────────────────────

chrome.downloads.onCreated.addListener((item) => {
  if (!interceptEnabled) return;
  if (!isPdfDownload(item)) return;

  chrome.downloads.cancel(item.id, () => {
    openInReamlet(item.url);
  });
});
