#!/usr/bin/env node
// Fails if @lenterra/core grows a runtime dependency, or if its source reaches
// for something that does not exist in goja (TRD-ENG-001).
//
// The core is the one build that must run unchanged in Hermes on a 2 GB phone
// and in Nakama's embedded JS VM. A single transitive dependency reaching for a
// Node built-in breaks the server at *start*, not at compile time — which is
// the worst place to find out.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corePkg = join(root, 'packages/core/package.json');
const coreSrc = join(root, 'packages/core/src');

const failures = [];

// --- no runtime dependencies ----------------------------------------------
const pkg = JSON.parse(readFileSync(corePkg, 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length > 0) {
  failures.push(`@lenterra/core declares runtime dependencies: ${deps.join(', ')}`);
}

// --- no forbidden globals or imports --------------------------------------
const FORBIDDEN = [
  { pattern: /\bDate\.now\s*\(/, why: 'reads a clock; pass time in as a parameter' },
  { pattern: /\bnew\s+Date\s*\(/, why: 'reads a clock; pass time in as a parameter' },
  { pattern: /\bMath\.random\s*\(/, why: 'non-deterministic; use createRng(seed)' },
  { pattern: /\brequire\s*\(/, why: 'no dynamic require in a bundled goja module' },
  { pattern: /\bprocess\./, why: 'no process in goja or Hermes' },
  { pattern: /\bBuffer\b/, why: 'no Buffer in goja' },
  { pattern: /\b__dirname\b|\b__filename\b/, why: 'no module paths in goja' },
  { pattern: /from\s+['"]node:/, why: 'no Node built-ins in the shared core' },
  { pattern: /from\s+['"](fs|path|crypto|http|https|os|util)['"]/, why: 'no Node built-ins' },
  { pattern: /\bfetch\s*\(/, why: 'no I/O in the shared core' },
  { pattern: /\bconsole\./, why: 'no logging in the shared core; return values instead' },
];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!full.endsWith('.ts')) continue;

    const source = readFileSync(full, 'utf8');
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Comments explain *why* these are banned, so they mention them.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(line)) {
          failures.push(`${relative(root, full)}:${i + 1} — ${pattern.source}: ${why}`);
        }
      }
    }
  }
}

walk(coreSrc);

if (failures.length > 0) {
  console.error('@lenterra/core purity check failed:\n');
  for (const failure of failures) console.error(`  ✖ ${failure}`);
  console.error(
    '\nThe core runs in goja and Hermes. Anything above breaks one of them at runtime.',
  );
  process.exit(1);
}

console.log('@lenterra/core is dependency-free and goja-safe');
