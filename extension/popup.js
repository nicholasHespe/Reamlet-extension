// Reamlet extension — popup script
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const toggle = document.getElementById('toggle');
const status = document.getElementById('status');

chrome.storage.local.get(['interceptEnabled'], (result) => {
  const enabled = result.interceptEnabled !== false; // default on
  toggle.checked = enabled;
  updateStatus(enabled);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ interceptEnabled: enabled });
  updateStatus(enabled);
});

function updateStatus(enabled) {
  status.textContent = enabled
    ? 'PDFs will open in Reamlet.'
    : 'Interception paused — PDFs open normally.';
}
