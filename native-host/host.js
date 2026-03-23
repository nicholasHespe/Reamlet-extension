// Reamlet native messaging host
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Chrome native messaging protocol:
//   stdin/stdout framing — 4-byte little-endian uint32 length prefix + UTF-8 JSON body.
//
// Build into a standalone exe (no Node.js runtime required for the end user):
//   pnpm install && pnpm run build
//
// The resulting dist/reamlet-native-host.exe is registered via register-host.bat.

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

// ── Native messaging framing ──────────────────────────────────

const chunks = [];
let expectedLength = null;

process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  processInput();
});

process.stdin.on('end', () => process.exit(0));

function processInput() {
  const buf = Buffer.concat(chunks);

  if (expectedLength === null) {
    if (buf.length < 4) return;
    expectedLength = buf.readUInt32LE(0);
    chunks.length = 0;
    chunks.push(buf.slice(4));
    processInput();
    return;
  }

  if (buf.length < expectedLength) return;

  const msgJson = buf.slice(0, expectedLength).toString('utf8');
  chunks.length = 0;
  chunks.push(buf.slice(expectedLength));
  expectedLength = null;

  try {
    handleMessage(JSON.parse(msgJson));
  } catch {
    reply({ ok: false, error: 'parse error' });
  }

  // Process any remaining buffered data.
  processInput();
}

function reply(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len  = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(len);
  process.stdout.write(json);
}

// ── Locate Reamlet.exe ────────────────────────────────────────

function findReamlet() {
  const localAppData = process.env.LOCALAPPDATA ?? '';

  const candidates = [
    // NSIS installer default
    path.join(localAppData, 'Programs', 'Reamlet', 'Reamlet.exe'),
    // Portable: host exe lives next to Reamlet.exe
    path.join(path.dirname(process.execPath), 'Reamlet.exe'),
    // Dev build (running host.js directly with node)
    path.join(__dirname, '..', '..', 'Reamlet', 'dist', 'win-unpacked', 'Reamlet.exe'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Message handler ───────────────────────────────────────────

function handleMessage(msg) {
  const { url } = msg;
  if (!url || typeof url !== 'string') {
    reply({ ok: false, error: 'missing url' });
    return;
  }

  const reamletPath = findReamlet();
  if (!reamletPath) {
    reply({ ok: false, error: 'Reamlet.exe not found' });
    return;
  }

  const child = spawn(reamletPath, [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  reply({ ok: true });
}
