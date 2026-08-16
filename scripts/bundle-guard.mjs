#!/usr/bin/env node
// Greps the built Nakama module bundle for anything goja cannot execute.
//
// A transitive dependency reaching for a Node built-in is the single most
// common way a Nakama TypeScript build breaks, and it breaks at server start
// rather than at compile time. Catching it here turns a 3am "why won't the
// server boot" into a failed CI job.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'modules/build/index.js');

if (!existsSync(bundle)) {
  console.error(`bundle not found at ${bundle} — run "npm run build:modules" first`);
  process.exit(1);
}

const source = readFileSync(bundle, 'utf8');
const lines = source.split('\n');

const BANNED = [
  { name: 'require(', why: 'no module loader in goja' },
  { name: 'process.', why: 'no process object in goja' },
  { name: 'Buffer', why: 'no Buffer in goja' },
  { name: '__dirname', why: 'no module paths in goja' },
  { name: 'globalThis.fetch', why: 'use nk.httpRequest instead' },
  { name: 'setTimeout', why: 'goja runs synchronously; there is no event loop' },
  { name: 'setInterval', why: 'goja runs synchronously; there is no event loop' },
  { name: 'Promise', why: 'the runtime is synchronous; every nk call blocks' },
  { name: 'async ', why: 'the runtime is synchronous' },
  { name: 'await ', why: 'the runtime is synchronous' },
];

const hits = [];
for (let i = 0; i < lines.length; i++) {
  for (const { name, why } of BANNED) {
    if (lines[i].includes(name)) hits.push({ line: i + 1, name, why, text: lines[i].trim().slice(0, 120) });
  }
}

// InitModule must be reachable as a global, or Nakama loads the file and finds
// nothing to register.
if (!/InitModule/.test(source)) {
  console.error('✖ the bundle does not define InitModule; Nakama would load it and register nothing');
  process.exit(1);
}

if (hits.length > 0) {
  console.error(`bundle guard failed — ${hits.length} occurrence(s) goja cannot run:\n`);
  for (const hit of hits.slice(0, 40)) {
    console.error(`  ✖ ${bundle.split('/').slice(-2).join('/')}:${hit.line} "${hit.name}" — ${hit.why}`);
    console.error(`      ${hit.text}`);
  }
  if (hits.length > 40) console.error(`  … and ${hits.length - 40} more`);
  process.exit(1);
}

const kb = Math.round(source.length / 1024);
console.log(`bundle is goja-safe (${kb} KB, InitModule present)`);
