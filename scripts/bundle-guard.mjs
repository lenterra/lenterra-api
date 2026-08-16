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

/**
 * Blank out comments and string literals, preserving line structure.
 *
 * The bundle keeps source comments, and those comments discuss the very things
 * this guard bans — "no Buffer in goja", "the 200ms setTimeout recursion".
 * Matching on raw text would flag the documentation explaining why the code is
 * safe. String literals are blanked for the same reason: an error message
 * naming `require` is not a call to it.
 */
function stripNonCode(input) {
  let out = '';
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && input[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\') { out += '  '; i += 2; continue; }
        out += input[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

const code = stripNonCode(source);
const lines = code.split('\n');
const rawLines = source.split('\n');

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
    if (lines[i].includes(name)) {
      hits.push({ line: i + 1, name, why, text: (rawLines[i] ?? '').trim().slice(0, 120) });
    }
  }
}

// InitModule must be reachable as a global, or Nakama loads the file and finds
// nothing to register.
if (!/InitModule/.test(code)) {
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
