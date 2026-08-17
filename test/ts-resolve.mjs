/**
 * Let the contract tests import the module sources directly.
 *
 * `modules/src/**` is written for the TypeScript compiler and rollup, both of
 * which resolve `from '../lib/errors'` without an extension. Node's ESM
 * resolver does not, so importing a handler under `node --test` fails at the
 * first relative import — which is why, until now, no test reached any of them.
 *
 * The alternatives were worse. Rewriting every import to carry `.ts` would put
 * the build's needs into the source for the sake of the tests; testing the
 * rolled-up bundle instead would test one concatenated file with no way to
 * import a single handler. A resolve hook keeps the source as the compiler
 * wants it and costs one flag.
 *
 * Only bare relative specifiers are touched, and only when the `.ts` file
 * actually exists — anything else falls through to the default resolver, so a
 * genuinely missing module still fails as a missing module.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      const parent = context.parentURL;
      if (parent && parent.endsWith('.ts')) {
        const candidate = new URL(`${specifier}.ts`, parent);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
