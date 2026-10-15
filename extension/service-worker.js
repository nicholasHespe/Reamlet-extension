// Reamlet extension — service worker (Manifest V3)
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const NATIVE_HOST = 'com.reamlet.chromebridge';

// ── State ─────────────────────────────────────────────────────

let interceptEnabled = true;
let disabledDomains  = new Set();

// When false, PDFs are only opened in Reamlet if they can be fetched without
// the browser's cookies/session; anything that needs sign-in is left for the
// browser to open normally.
let authPdfsEnabled = true;

// Block all interception during browser startup/session restore.
// Set to true once the browser has had time to finish restoring tabs.
// chrome.storage.session persists across service-worker restarts within a
// session, so mid-session restarts of the worker re-enable immediately.
let startupComplete = false;

const startupLoaded = chrome.storage.session.get('startupComplete').then((result) => {
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
    syncInterceptRule();
  }, 5000);
});

// Extension install/update — no session restore, enable immediately.
chrome.runtime.onInstalled.addListener((details) => {
  startupComplete = true;
  chrome.storage.session.set({ startupComplete: true });
  console.log('[Reamlet] onInstalled (' + details.reason + ') — interception enabled immediately');
  syncInterceptRule();
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

const settingsLoaded = chrome.storage.local.get(['interceptEnabled', 'disabledDomains', 'authPdfsEnabled']).then((result) => {
  if (result.interceptEnabled !== undefined) {
    interceptEnabled = result.interceptEnabled;
  }
  if (Array.isArray(result.disabledDomains)) {
    disabledDomains = new Set(result.disabledDomains);
  }
  authPdfsEnabled = result.authPdfsEnabled !== false;
  updateBadge();
});

// Session rules outlive a service-worker restart, so bring them in line with
// the settings each time the worker starts.
Promise.all([startupLoaded, settingsLoaded]).then(() => {
  removeStaleBypassRules();
  syncInterceptRule();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('interceptEnabled' in changes) {
    interceptEnabled = changes.interceptEnabled.newValue;
    updateBadge();
    syncInterceptRule();
  }
  if ('disabledDomains' in changes) {
    disabledDomains = new Set(changes.disabledDomains.newValue ?? []);
    console.log('[Reamlet] Site settings updated. Disabled domains:', [...disabledDomains]);
    syncInterceptRule();
  }
  if ('authPdfsEnabled' in changes) {
    authPdfsEnabled = changes.authPdfsEnabled.newValue !== false;
    console.log('[Reamlet] PDFs that need sign-in:', authPdfsEnabled ? 'opened in Reamlet' : 'left to the browser');
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

// The name to save a PDF under: the server's Content-Disposition filename
// (filename* first, then filename), else the last segment of the URL. Made
// safe as a Windows filename and always ending in .pdf.
function pdfFileName(contentDisposition, url) {
  const cd = contentDisposition ?? '';
  let name = '';
  const encoded = /filename\*\s*=\s*[\w-]+'[^']*'([^;]+)/i.exec(cd);
  if (encoded) {
    try { name = decodeURIComponent(encoded[1].trim()); } catch { /* malformed */ }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(cd);
    if (plain) name = (plain[1]?.replace(/\\(.)/g, '$1') ?? plain[2]).trim();
  }
  if (!name) {
    let segment = '';
    try { segment = new URL(url).pathname.split('/').pop(); } catch { /* ignore */ }
    try { name = decodeURIComponent(segment); } catch { name = segment; }
  }
  name = name.split(/[\\/]/).pop()
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = '_' + name;
  if (!name.toLowerCase().endsWith('.pdf')) name = (name || 'download') + '.pdf';
  if (name.length > 200) name = name.slice(0, 196) + '.pdf';
  return name;
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
const FETCH_MAX_BYTES = 750 * 1024;

// Fetch a PDF with fetch() and pass the raw bytes to the native host, which
// writes them to %TEMP%\ReamletDownloads. No download dialog is involved.
//
// credentials: 'include' uses the browser's session cookies (SharePoint,
// Gmail, intranets); 'omit' fetches the URL as an anonymous client would.
// pending: a fetch() of this URL already in flight, used instead of
// starting a new one.
//
// Resolves to { status, filename }. filename is the PDF's own name (see
// pdfFileName), or null if no response was received. status is one of:
//   'opened'      — sent to Reamlet
//   'unavailable' — the URL did not return a PDF with these credentials
//                   (e.g. 401/403 or a redirect to a sign-in page)
//   'too-large'   — a PDF, but too big for a native message
//   'host-error'  — the native host could not open it
async function fetchIntoReamlet(url, background, credentials, pending = null) {
  console.log('[Reamlet] fetch() (credentials: ' + credentials + (pending ? ', prefetched' : '') + '):', url);
  let res;
  try {
    res = await (pending ?? fetch(url, { credentials }));
  } catch (err) {
    console.error('[Reamlet] fetch() error:', err.message);
    return { status: 'unavailable', filename: null };
  }
  const filename = pdfFileName(res.headers.get('content-disposition'), res.url || url);
  if (!res.ok) {
    console.error('[Reamlet] fetch() returned status:', res.status);
    return { status: 'unavailable', filename };
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/pdf')) {
    console.error('[Reamlet] fetch() got unexpected content-type:', contentType);
    return { status: 'unavailable', filename };
  }
  const declaredLength = Number(res.headers.get('content-length'));
  if (declaredLength > FETCH_MAX_BYTES) {
    console.warn('[Reamlet] PDF too large for fetch path:', declaredLength, 'bytes');
    res.body?.cancel().catch(() => {});
    return { status: 'too-large', filename };
  }

  try {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > FETCH_MAX_BYTES) {
      console.warn('[Reamlet] PDF too large for fetch path:', buf.byteLength, 'bytes');
      return { status: 'too-large', filename };
    }
    // Encode to base64 without spread (avoids stack overflow on large arrays)
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    console.log('[Reamlet] fetch() got', buf.byteLength, 'bytes (' + filename + ') — sending to native host');
    const response = await sendToNativeHost({ bytes: base64, filename, background });
    if (!response?.ok) {
      console.error('[Reamlet] Host returned error for bytes message:', response?.error);
      return { status: 'host-error', filename };
    }
    return { status: 'opened', filename };
  } catch (err) {
    console.error('[Reamlet] fetch() path error:', err.message);
    return { status: 'host-error', filename };
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

// Download a PDF and open it in Reamlet. Returns false if the browser should
// open it instead. prefetch: an in-flight fetch of url (see onBeforeNavigate).
// First tries fetch() — no download dialog, handles session auth via cookies.
// Falls back to chrome.downloads.download() when fetch fails (e.g. PDF > 750 KB).
//
// With authPdfsEnabled off, the fetch is made without cookies. A PDF that
// can't be fetched that way needs the user's session, so it is left to the
// browser rather than downloaded with that session.
async function downloadViaChrome(url, background = false, prefetch = null) {
  const credentials = prefetch?.credentials ?? (authPdfsEnabled ? 'include' : 'omit');
  const { status: result, filename: serverName } = await fetchIntoReamlet(url, background, credentials, prefetch?.response);
  if (result === 'opened') return true;
  if (result === 'unavailable' && !authPdfsEnabled) {
    console.log('[Reamlet] PDF needs sign-in and those are disabled — leaving it to the browser:', url);
    return false;
  }

  // fetch() failed — fall back to chrome.downloads.download().
  // May show Save As dialog if Chrome's "Ask where to save" is enabled.
  console.log('[Reamlet] fetch() failed (' + result + '), falling back to chrome.downloads.download()');
  return new Promise((resolve) => {
    reamletDownloadUrls.add(url);

    const filename = `${STAGING_FOLDER}/${serverName ?? pdfFileName(null, url)}`;
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
              resolve(fetchIntoReamlet(url, background, credentials).then((r) => r.status === 'opened'));
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

// ── Interception rule ─────────────────────────────────────────
//
// webRequest and webNavigation listeners cannot block in MV3, so reacting to
// them always lets the browser start showing the PDF first. Instead, a
// declarativeNetRequest session rule marks every main-frame PDF response as
// an attachment. Chrome applies it in the network stack before anything is
// rendered, so the navigation turns into a download: the tab stays on the
// page it was on, and a tab opened just for the PDF is closed by Chrome.
// downloads.onCreated below then cancels that download and opens the PDF in
// Reamlet.
//
// Session rules are cleared when the browser restarts and the rule is only
// added once startup has completed, so restored tabs are never intercepted.
// PDFs opened from a disabled site are excluded here by initiator; a PDF
// with no initiator (typed URL, bookmark) is checked in handlePdfNavigation.
const INTERCEPT_RULE_ID = 1;

async function syncInterceptRule() {
  const addRules = [];
  if (startupComplete && interceptEnabled) {
    const condition = {
      resourceTypes: ['main_frame'],
      responseHeaders: [{ header: 'content-type', values: ['application/pdf*'] }],
    };
    if (disabledDomains.size > 0) condition.excludedInitiatorDomains = [...disabledDomains];
    addRules.push({
      id: INTERCEPT_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'content-disposition', operation: 'set', value: 'attachment' }],
      },
      condition,
    });
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [INTERCEPT_RULE_ID], addRules });
    console.log('[Reamlet] Interception rule', addRules.length ? 'active' : 'removed');
  } catch (err) {
    console.error('[Reamlet] Failed to update interception rule:', err.message);
  }
}

// ── PDF navigations ───────────────────────────────────────────
//
// onHeadersReceived fires a few ms before the download the rule creates, and
// is the only event that knows which tab the navigation belonged to. Record
// it so onCreated can tell a converted navigation from an ordinary download,
// and knows where to open the PDF if Reamlet can't.
const pdfNavigations = new Map(); // response URL → { url, initiator, tab }
const NAVIGATION_TTL_MS = 10000;

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const contentType = (details.responseHeaders ?? []).find(
      (h) => h.name.toLowerCase() === 'content-type'
    )?.value ?? '';
    if (!contentType.toLowerCase().includes('application/pdf')) return;

    console.log('[Reamlet] PDF navigation:', details.url, '| tab:', details.tabId, '| initiator:', details.initiator);
    const nav = {
      url: details.url,
      initiator: details.initiator ?? null,
      // Read now: a tab opened just for the PDF is closed once it becomes a download.
      tab: chrome.tabs.get(details.tabId).catch(() => null),
    };
    pdfNavigations.set(nav.url, nav);
    setTimeout(() => {
      if (pdfNavigations.get(nav.url) === nav) pdfNavigations.delete(nav.url);
    }, NAVIGATION_TTL_MS);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// For .pdf links, start fetching as soon as the navigation begins instead of
// waiting for the browser's own response, so opening in Reamlet is no slower
// than before. Used by handlePdfNavigation if the navigation does become a
// PDF download; otherwise it simply expires.
const prefetches = new Map(); // URL → { response, credentials }
const PREFETCH_TTL_MS = 30000;

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (!startupComplete || !interceptEnabled || details.frameId !== 0) return;
    const url = stripHash(details.url);
    if (prefetches.has(url) || bypassUrls.has(url)) return;

    // For new tabs (url is empty), the opener tab is the browsing context.
    // For same-tab navigations, use this tab's last committed URL from session storage.
    const tab = await chrome.tabs.get(details.tabId).catch(() => null);
    const contextTabId = (tab?.url === '' && tab?.openerTabId != null)
      ? tab.openerTabId
      : details.tabId;
    if (isDomainDisabled(url, await getTabContextUrl(contextTabId))) return;

    const credentials = authPdfsEnabled ? 'include' : 'omit';
    const controller = new AbortController();
    const response = fetch(url, { credentials, signal: controller.signal });
    response.catch(() => {}); // handled by whoever takes the prefetch
    const entry = { response, credentials };
    prefetches.set(url, entry);
    console.log('[Reamlet] Prefetching', url);
    setTimeout(() => {
      if (prefetches.get(url) !== entry) return; // taken, or replaced
      prefetches.delete(url);
      controller.abort();
    }, PREFETCH_TTL_MS);
  },
  { url: [{ urlMatches: '\\.pdf(\\?[^#]*)?(?:#.*)?$' }] }
);

// Whether the interception rule applied to a navigation, i.e. its initiator
// is not excluded. Mirrors excludedInitiatorDomains, which also covers
// subdomains of each listed domain.
function ruleApplied(nav) {
  const host = nav.initiator ? getHostname(nav.initiator) : null;
  return !host || ![...disabledDomains].some((d) => host === d || host.endsWith('.' + d));
}

function takePrefetch(url) {
  const entry = prefetches.get(url) ?? null;
  prefetches.delete(url);
  return entry;
}

function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

// Open a PDF whose navigation the rule turned into a (now cancelled) download.
// requestUrl is the URL the navigation started with; nav.url is where it
// ended up after any redirects.
async function handlePdfNavigation(nav, requestUrl) {
  const tab = await nav.tab;
  if (!nav.initiator && isDomainDisabled(nav.url)) {
    console.log('[Reamlet] Domain disabled, opening in browser:', nav.url);
    openInBrowser(nav.url, tab);
    return;
  }

  const background = tab ? !tab.active : false;
  const prefetch = takePrefetch(requestUrl);
  const ok = await downloadViaChrome(prefetch ? requestUrl : nav.url, background, prefetch);
  if (!ok) openInBrowser(nav.url, tab);
}

// ── Opening in the browser instead ────────────────────────────
//
// When Reamlet can't take a PDF (or shouldn't: disabled site, sign-in PDFs
// turned off), navigate the tab it came from to the PDF — or a new tab in its
// place if Chrome closed a tab opened just for the PDF — with a per-tab rule
// that exempts that navigation from the interception rule.
const BYPASS_RULE_ID_BASE = 1000;
const BYPASS_TIMEOUT_MS = 15000;
let nextBypassRuleId = BYPASS_RULE_ID_BASE;
const bypassTabs = new Map(); // tabId → { ruleId, timer }

// URLs being opened in the browser. If one still ends up as a download (the
// server itself sends it as an attachment), that download is left alone.
const bypassUrls = new Set();

async function openInBrowser(url, tab) {
  console.log('[Reamlet] Opening in browser:', url);
  bypassUrls.add(url);
  setTimeout(() => bypassUrls.delete(url), BYPASS_TIMEOUT_MS);

  let tabId = tab ? (await chrome.tabs.get(tab.id).catch(() => null))?.id : undefined;
  if (tabId === undefined) {
    const props = { url: 'about:blank', active: tab?.active ?? true };
    const created = await chrome.tabs.create({ ...props, windowId: tab?.windowId, index: tab?.index })
      .catch(() => chrome.tabs.create(props))
      .catch(() => null);
    if (!created) return;
    tabId = created.id;
  }

  await addBypassRule(tabId);
  chrome.tabs.update(tabId, { url }).catch(() => removeBypassRule(tabId));
}

async function addBypassRule(tabId) {
  removeBypassRule(tabId);
  const ruleId = nextBypassRuleId++;
  const timer = setTimeout(() => removeBypassRule(tabId), BYPASS_TIMEOUT_MS);
  bypassTabs.set(tabId, { ruleId, timer });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 2,
      action: { type: 'allow' },
      condition: { tabIds: [tabId], resourceTypes: ['main_frame'] },
    }],
  }).catch((err) => console.error('[Reamlet] Failed to add bypass rule:', err.message));
}

function removeBypassRule(tabId) {
  const bypass = bypassTabs.get(tabId);
  if (!bypass) return;
  clearTimeout(bypass.timer);
  bypassTabs.delete(tabId);
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [bypass.ruleId] }).catch(() => {});
}

// Bypass rules left behind by a previous instance of this service worker.
async function removeStaleBypassRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const stale = rules.filter((r) => r.id >= BYPASS_RULE_ID_BASE).map((r) => r.id);
    if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
  } catch (err) {
    console.error('[Reamlet] Failed to remove stale bypass rules:', err.message);
  }
}

// The bypass lasts for one navigation: it ends when that navigation commits,
// or fails without committing (e.g. it became a download).
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && details.url !== 'about:blank') removeBypassRule(details.tabId);
});
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0 && details.url !== 'about:blank') removeBypassRule(details.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => removeBypassRule(tabId));

// ── PDF interception: downloads ───────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  if (reamletDownloadUrls.has(item.url)) { console.log('[Reamlet] onCreated: own download, skipping', item.url); return; }
  if (bypassUrls.has(item.finalUrl) || bypassUrls.has(item.url)) { console.log('[Reamlet] onCreated: being opened in browser, skipping', item.url); return; }
  if (!startupComplete) { console.log('[Reamlet] onCreated: startup not complete, skipping', item.url); return; }
  if (!interceptEnabled) return;

  // A PDF navigation turned into a download by the interception rule.
  const nav = pdfNavigations.get(item.finalUrl) ?? pdfNavigations.get(item.url);
  if (nav && ruleApplied(nav)) {
    pdfNavigations.delete(nav.url);
    console.log('[Reamlet] Intercepted PDF navigation:', item.url);
    // Cancel straight away, before Chrome gets as far as a Save As prompt, and
    // drop it from the download list; the PDF is fetched separately.
    chrome.downloads.cancel(item.id)
      .then(() => chrome.downloads.erase({ id: item.id }))
      .catch(() => {});
    await handlePdfNavigation(nav, stripHash(item.url));
    return;
  }

  // Any other download.
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
