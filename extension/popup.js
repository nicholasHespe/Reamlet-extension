// Reamlet extension — popup script
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const globalToggle = document.getElementById('globalToggle');
const domainSection = document.getElementById('domainSection');
const domainLabel   = document.getElementById('domainLabel');
const domainToggle  = document.getElementById('domainToggle');
const status        = document.getElementById('status');

let currentHostname = null;
let globalEnabled   = true;
let disabledDomains = [];

// Get the active tab's hostname
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  try {
    const url = tab?.url ?? '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      currentHostname = new URL(url).hostname;
    }
  } catch { /* ignore */ }

  chrome.storage.local.get(['interceptEnabled', 'disabledDomains'], (result) => {
    globalEnabled   = result.interceptEnabled !== false;
    disabledDomains = result.disabledDomains ?? [];
    render();
  });
});

globalToggle.addEventListener('change', () => {
  globalEnabled = globalToggle.checked;
  chrome.storage.local.set({ interceptEnabled: globalEnabled });
  render();
});

domainToggle.addEventListener('change', () => {
  if (!currentHostname) return;
  if (domainToggle.checked) {
    disabledDomains = disabledDomains.filter(d => d !== currentHostname);
  } else {
    if (!disabledDomains.includes(currentHostname)) {
      disabledDomains = [...disabledDomains, currentHostname];
    }
  }
  chrome.storage.local.set({ disabledDomains });
  render();
});

function render() {
  globalToggle.checked = globalEnabled;

  if (currentHostname) {
    domainSection.style.display = '';
    domainLabel.textContent = currentHostname;
    const domainEnabled = !disabledDomains.includes(currentHostname);
    domainToggle.checked  = domainEnabled;
    domainToggle.disabled = !globalEnabled;
  }

  if (!globalEnabled) {
    status.textContent = 'Interception paused — PDFs open normally.';
  } else if (currentHostname && disabledDomains.includes(currentHostname)) {
    status.textContent = 'PDFs on ' + currentHostname + ' open normally.';
  } else {
    status.textContent = 'PDFs will open in Reamlet.';
  }
}
