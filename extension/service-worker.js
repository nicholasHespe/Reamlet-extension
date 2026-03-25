// Reamlet extension — service worker (Manifest V3)
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const NATIVE_HOST = 'com.reamlet.chromebridge';

// ── State ─────────────────────────────────────────────────────

let interceptEnabled = true;
let disabledDomains  = new Set();

// Block all interception during browser startup/session restore.
// Set to true once the browser has had time to finish restoring tabs.
// chrome.storage.session persists across service-worker restarts within a
// session, so mid-session restarts of the worker re-enable immediately.
let startupComplete = false;

chrome.storage.session.get('startupComplete', (result) => {
  if (result.startupComplete) {
    startupComplete = true;
    console.log('[Reamlet] startupComplete restored from session (mid-session worker restart)');
  }
});

// Fresh browser start — wait 5 s for session restore to settle.
chrome.runtime.onStartup.addListener(() => {
  console.log('[Reamlet] onStartup — waiting 5 s for session restore');
  setTimeout(() => {
    startupComplete = true;
    chrome.storage.session.set({ startupComplete: true });
    console.log('[Reamlet] Startup complete — interception enabled');
  }, 5000);
});

// Extension install/update — no session restore, enable immediately.
chrome.runtime.onInstalled.addListener((details) => {
  startupComplete = true;
  chrome.storage.session.set({ startupComplete: true });
  console.log('[Reamlet] onInstalled (' + details.reason + ') — interception enabled immediately');
});

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
  console.log('[Reamlet] openInReamlet — sending to native host:', filePath, '| background:', background);
  try {
    const response = await sendToNativeHost({ url: filePath, background });
    console.log('[Reamlet] Native host response:', JSON.stringify(response));
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

// Native messaging has a 1 MB message limit. Base64 adds ~33% overhead,
// so cap raw PDF size at 750 KB to stay safely under the limit.
const FETCH_FALLBACK_MAX_BYTES = 750 * 1024;

// Fallback for cases where chrome.downloads fails (e.g. Content-Disposition: inline).
// Fetches the URL directly using browser credentials, then passes the raw bytes
// to the native host which writes them to %TEMP%\ReamletDownloads.
async function tryFetchFallback(url, background = false) {
  console.log('[Reamlet] Trying fetch() fallback for:', url);
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      console.error('[Reamlet] fetch() returned status:', res.status);
      return false;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/pdf')) {
      console.error('[Reamlet] fetch() got unexpected content-type:', contentType);
      return false;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > FETCH_FALLBACK_MAX_BYTES) {
      console.warn('[Reamlet] PDF too large for fetch fallback:', buf.byteLength, 'bytes — falling back to browser');
      return false;
    }
    // Encode to base64 without spread (avoids stack overflow on large arrays)
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    console.log('[Reamlet] fetch() got', buf.byteLength, 'bytes — sending to native host');
    const response = await sendToNativeHost({ bytes: base64, background });
    if (!response?.ok) {
      console.error('[Reamlet] Host returned error for bytes message:', response?.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Reamlet] fetch() fallback error:', err.message);
    return false;
  }
}

// URLs of downloads we initiated ourselves — prevents re-interception by onCreated.
const reamletDownloadUrls = new Set();

// Maps URLs of our in-flight downloads to their desired staging filename.
// Read by onDeterminingFilename to silently route the file to the staging folder.
const reamletDownloadFilenames = new Map();

// Suppress the Save As dialog for our own downloads by calling suggest() with
// the staging path. For all other downloads, return without calling suggest so
// Chrome's default behavior is preserved.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = reamletDownloadFilenames.get(item.url);
  console.log('[Reamlet] onDeterminingFilename:', item.url, '| inMap:', !!filename);
  if (filename) {
    suggest({ filename, conflictAction: 'uniquify' });
  }
});

// Download a PDF and open it in Reamlet.
// First tries fetch() — no download dialog, handles session auth via cookies.
// Falls back to chrome.downloads.download() when fetch fails (e.g. PDF > 750 KB).
async function downloadViaChrome(url, background = false) {
  const fetchOk = await tryFetchFallback(url, background);
  if (fetchOk) return true;

  // fetch() failed — fall back to chrome.downloads.download().
  // May show Save As dialog if Chrome's "Ask where to save" is enabled.
  console.log('[Reamlet] fetch() failed, falling back to chrome.downloads.download()');
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
    reamletDownloadFilenames.set(url, filename);

    console.log('[Reamlet] downloadViaChrome starting — filename:', filename);

    chrome.downloads.download(
      { url, saveAs: false, filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reamletDownloadUrls.delete(url);
          reamletDownloadFilenames.delete(url);
          console.error('[Reamlet] chrome.downloads.download failed:', chrome.runtime.lastError?.message);
          resolve(false);
          return;
        }

        console.log('[Reamlet] Download started — id:', downloadId, 'filename:', filename);

        const onChange = (delta) => {
          if (delta.id !== downloadId) return;

          if (delta.state) {
            console.log('[Reamlet] Download', downloadId, 'state →', delta.state.current);
          }
          if (delta.error) {
            console.error('[Reamlet] Download', downloadId, 'error →', delta.error.current);
          }

          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChange);
            reamletDownloadUrls.delete(url);
            reamletDownloadFilenames.delete(url);
            chrome.downloads.search({ id: downloadId }, async ([item]) => {
              if (!item?.filename) {
                console.error('[Reamlet] Download', downloadId, 'complete but filename missing');
                resolve(false);
                return;
              }
              console.log('[Reamlet] Download complete — path:', item.filename, '| mime:', item.mime, '| size:', item.fileSize);
              const ok = await openInReamlet(item.filename, background);
              console.log('[Reamlet] openInReamlet result:', ok);
              // Erase from Chrome's download history — the native host moves
              // the file to %TEMP%\ReamletDownloads so no removeFile needed here.
              chrome.downloads.erase({ id: downloadId });
              resolve(ok);
            });
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChange);
            reamletDownloadUrls.delete(url);
            reamletDownloadFilenames.delete(url);
            const reason = delta.error?.current ?? 'unknown';
            console.error('[Reamlet] Download', downloadId, 'interrupted — error:', reason);
            if (reason === 'SERVER_BAD_CONTENT') {
              console.log('[Reamlet] SERVER_BAD_CONTENT likely caused by Content-Disposition: inline — trying fetch fallback');
              resolve(tryFetchFallback(url, background));
            } else {
              resolve(false);
            }
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
    if (!startupComplete) { console.log('[Reamlet] onHeadersReceived: startup not complete, skipping', details.url); return; }
    if (!interceptEnabled) return;
    if (details.type !== 'main_frame') return;
    if (bypassTabs.has(details.tabId)) {
      // Consume the flag here — this is the last event in the navigation chain.
      console.log('[Reamlet] onHeadersReceived: bypass tab, skipping', details.url);
      bypassTabs.delete(details.tabId);
      return;
    }

    const contentType = (details.responseHeaders ?? []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    )?.value ?? '';

    console.log('[Reamlet] onHeadersReceived:', details.url, '| content-type:', contentType);

    if (!contentType.includes('application/pdf')) return;

    const url = details.url;
    if (isDomainDisabled(url, details.initiator)) { console.log('[Reamlet] onHeadersReceived: domain disabled, skipping', url); return; }

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
    if (!startupComplete) { console.log('[Reamlet] onBeforeNavigate: startup not complete, skipping', details.url); return; }
    if (!interceptEnabled) return;
    if (details.frameId !== 0) { console.log('[Reamlet] onBeforeNavigate: sub-frame (id=' + details.frameId + '), skipping', details.url); return; }
    if (bypassTabs.has(details.tabId)) {
      // Don't delete here — onHeadersReceived will consume the flag.
      console.log('[Reamlet] onBeforeNavigate: bypass tab, skipping', details.url);
      return;
    }

    console.log('[Reamlet] onBeforeNavigate: PDF URL matched, frameId=0, tabId=' + details.tabId, details.url);

    const url = details.url;
    const tab = await chrome.tabs.get(details.tabId).catch(() => null);

    // For new tabs (url is empty), the opener tab is the browsing context.
    // For same-tab navigations, use this tab's last committed URL from session storage.
    const contextTabId = (tab?.url === '' && tab?.openerTabId != null)
      ? tab.openerTabId
      : details.tabId;
    const contextUrl = await getTabContextUrl(contextTabId);
    if (isDomainDisabled(url, contextUrl)) { console.log('[Reamlet] onBeforeNavigate: domain disabled, skipping', url); return; }

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
  if (!startupComplete) { console.log('[Reamlet] onCreated: startup not complete, skipping', item.url); return; }
  if (reamletDownloadUrls.has(item.url)) { console.log('[Reamlet] onCreated: own download, skipping', item.url); return; }
  if (!interceptEnabled) return;
  console.log('[Reamlet] onCreated:', item.url, '| mime:', item.mime, '| filename:', item.filename);
  if (!isPdfDownload(item)) { console.log('[Reamlet] onCreated: not a PDF, skipping'); return; }
  if (isDomainDisabled(item.url, item.referrer)) { console.log('[Reamlet] onCreated: domain disabled, skipping'); return; }

  console.log('[Reamlet] Intercepted PDF download:', item.url);

  const ok = await openInReamlet(item.url);
  if (ok) {
    chrome.downloads.cancel(item.id);
  }
  // If !ok, the existing download proceeds normally — no new tab, no loop
});
