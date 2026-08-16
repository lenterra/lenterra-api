// Bundles the runtime modules into the single file Nakama loads.
//
// The output must be plain ES5 with no module system: goja has no loader, so a
// stray `require(` is a server that will not start. scripts/bundle-guard.mjs
// checks the artifact after this runs, because "the build succeeded" and "the
// server can execute it" are different claims.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  input: 'src/index.ts',
  output: {
    file: 'build/index.js',
    format: 'iife',
    // Nakama calls a global InitModule. An IIFE that assigns it is the only
    // shape the runtime can find.
    name: 'lenterra',
    banner: '"use strict";',
    // Without this the IIFE keeps InitModule private and Nakama registers
    // nothing.
    footer: 'var InitModule = lenterra.InitModule;',
    sourcemap: false,
  },
  plugins: [
    nodeResolve({
      browser: false,
      preferBuiltins: false,
      extensions: ['.ts', '.js'],
    }),
    commonjs(),
    typescript({
      tsconfig: resolve(here, 'tsconfig.json'),
      noEmitOnError: true,
      noEmit: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      outputToFilesystem: false,
    }),
    babel({
      babelHelpers: 'bundled',
      extensions: ['.ts', '.js'],
      presets: [['@babel/preset-env', { targets: { ie: '11' }, modules: false }]],
    }),
  ],
  // A Node built-in reaching the bundle is the most common way this build
  // breaks, and it breaks at server start rather than here. Fail loudly.
  onwarn(warning, warn) {
    if (warning.code === 'MISSING_NODE_BUILTINS' || warning.code === 'UNRESOLVED_IMPORT') {
      throw new Error(`${warning.code}: ${warning.message}`);
    }
    if (warning.code === 'CIRCULAR_DEPENDENCY') {
      throw new Error(`circular dependency: ${warning.message}`);
    }
    warn(warning);
  },
};
