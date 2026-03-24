// Reamlet extension — service worker (Manifest V3)
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const NATIVE_HOST = 'com.reamlet.chromebridge';

// ── State ─────────────────────────────────────────────────────

let interceptEnabled = true;
let disabledDomains  = new Set();

// Track the last committed URL for each tab in session storage so we can
// identify the browsing context even during mid-navigation (when tab.url is empty).
// chrome.storage.session persists across service worker restarts.
chrome.tabs.query({}, (tabs) => {
  const items = {};
  for (const tab of tabs) {
    if (tab.id != null && tab.url && getHostname(tab.url)) {
      items[`tabUrl_${tab.id}`] = tab.url;
    }
  }
  if (Object.keys(items).length > 0) chrome.storage.session.set(items);
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (getHostname(details.url)) {
    chrome.storage.session.set({ [`tabUrl_${details.tabId}`]: details.url });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tabUrl_${tabId}`);
});

function getTabContextUrl(tabId) {
  return new Promise((resolve) => {
    chrome.storage.session.get(`tabUrl_${tabId}`, (result) => {
      resolve(result[`tabUrl_${tabId}`] ?? null);
    });
  });
}

chrome.storage.local.get(['interceptEnabled', 'disabledDomains'], (result) => {
  if (result.interceptEnabled !== undefined) {
    interceptEnabled = result.interceptEnabled;
  }
  if (Array.isArray(result.disabledDomains)) {
    disabledDomains = new Set(result.disabledDomains);
  }
  updateBadge();
});

chrome.storage.onChanged.addListener((changes) => {
  if ('interceptEnabled' in changes) {
    interceptEnabled = changes.interceptEnabled.newValue;
    updateBadge();
  }
  if ('disabledDomains' in changes) {
    disabledDomains = new Set(changes.disabledDomains.newValue ?? []);
    console.log('[Reamlet] Site settings updated. Disabled domains:', [...disabledDomains]);
  }
});

function updateBadge() {
  chrome.action.setBadgeText({ text: interceptEnabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#888' });
}

// ── Helpers ───────────────────────────────────────────────────

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Returns the hostname to check against disabledDomains.
// Prefers the browsing context (the page the user was on) over the PDF's own
// domain, so that toggling a site controls all PDFs clicked from that site,
// regardless of where the PDF file is actually hosted.
function getContextHostname(pdfUrl, contextUrl) {
  try {
    const pdfHost = new URL(pdfUrl).hostname;
    if (contextUrl) {
      const ctx = new URL(contextUrl).hostname;
      if (ctx && ctx !== pdfHost) return ctx;
    }
  } catch { /* ignore */ }
  return getHostname(pdfUrl);
}

function isDomainDisabled(pdfUrl, contextUrl = null) {
  const hostname = getContextHostname(pdfUrl, contextUrl);
  return hostname ? disabledDomains.has(hostname) : false;
}

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
function sendToNativeHost(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Attempt to open a local file path in Reamlet via the native host.
// Returns true on success, false on any failure.
async function openInReamlet(filePath, background = false) {
  try {
    const response = await sendToNativeHost({ url: filePath, background });
    if (!response?.ok) {
      console.error('[Reamlet] Host returned error:', response?.error, response?.checked ?? '');
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Reamlet] Native messaging failed:', err.message);
    return false;
  }
}

// URLs of downloads we initiated ourselves — prevents re-interception by onCreated.
const reamletDownloadUrls = new Set();

// Download a PDF using Chrome (which carries browser session cookies/auth),
// wait for completion, pass the local file path to Reamlet, then clean up.
// Returns true if Reamlet was successfully launched with the file.
function downloadViaChrome(url, background = false) {
  return new Promise((resolve) => {
    reamletDownloadUrls.add(url);

    let filename;
    try {
      const base = new URL(url).pathname.split('/').pop() || 'download';
      const name = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
      filename = `${STAGING_FOLDER}/${name}`;
    } catch {
      filename = `${STAGING_FOLDER}/download.pdf`;
    }

    chrome.downloads.download(
      { url, saveAs: false, filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reamletDownloadUrls.delete(url);
          console.error('[Reamlet] chrome.downloads.download failed:', chrome.runtime.lastError?.message);
          resolve(false);
          return;
        }

        const onChange = (delta) => {
          if (delta.id !== downloadId) return;

          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChange);
            reamletDownloadUrls.delete(url);
            chrome.downloads.search({ id: downloadId }, async ([item]) => {
              if (!item?.filename) { resolve(false); return; }
              const ok = await openInReamlet(item.filename, background);
              // Erase from Chrome's download history — the native host moves
              // the file to %TEMP%\ReamletDownloads so no removeFile needed here.
              chrome.downloads.erase({ id: downloadId });
              resolve(ok);
            });
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChange);
            reamletDownloadUrls.delete(url);
            resolve(false);
          }
        };

        chrome.downloads.onChanged.addListener(onChange);
      }
    );
  });
}

// Staging folder name within the user's Downloads directory.
// The native host moves files from here to %TEMP%\ReamletDownloads.
const STAGING_FOLDER = 'Reamlet';

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
    if (isDomainDisabled(url, details.initiator)) return;

    console.log('[Reamlet] Intercepted PDF via content-type:', url);

    const tab = await chrome.tabs.get(details.tabId).catch(() => null);
    const background = tab ? !tab.active : false;

    chrome.tabs.update(details.tabId, { url: 'about:blank' });

    const ok = await downloadViaChrome(url, background);
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
    const tab = await chrome.tabs.get(details.tabId).catch(() => null);

    // For new tabs (url is empty), the opener tab is the browsing context.
    // For same-tab navigations, use this tab's last committed URL from session storage.
    const contextTabId = (tab?.url === '' && tab?.openerTabId != null)
      ? tab.openerTabId
      : details.tabId;
    const contextUrl = await getTabContextUrl(contextTabId);
    if (isDomainDisabled(url, contextUrl)) return;

    console.log('[Reamlet] Intercepted PDF via URL pattern:', url);

    const background = tab ? !tab.active : false;

    chrome.tabs.update(details.tabId, { url: 'about:blank' });

    const ok = await downloadViaChrome(url, background);
    await resolveTab(details.tabId, url, ok);
  },
  { url: [{ urlMatches: '\\.pdf(\\?[^#]*)?(?:#.*)?$' }] }
);

// ── PDF interception: downloads ───────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  if (reamletDownloadUrls.has(item.url)) return; // Our own download — skip
  if (!interceptEnabled) return;
  if (!isPdfDownload(item)) return;
  if (isDomainDisabled(item.url, item.referrer)) return;

  console.log('[Reamlet] Intercepted PDF download:', item.url);

  // Cancel the browser download and re-trigger via downloadViaChrome so the
  // file path (not the URL) is passed to Reamlet — this handles auth correctly
  // because Chrome re-fetches the URL with its full session cookies.
  chrome.downloads.cancel(item.id);

  const ok = await downloadViaChrome(item.url);
  if (!ok) {
    // Fall back: open the URL in a new tab so the browser downloads it
    chrome.tabs.create({ url: item.url });
  }
});
