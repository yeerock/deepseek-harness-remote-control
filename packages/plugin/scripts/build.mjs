/** Build both halves of the plugin: host ESM bundle and browser IIFE bundle. */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'dist');
mkdirSync(outdir, { recursive: true });

const shared = {
  bundle: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
};

// Host half: ESM for the cordis loader. Node built-ins stay external; the
// plugin deliberately has no third-party runtime dependencies.
await build({
  ...shared,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outdir, 'index.js'),
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  external: ['node:*'],
  sourcemap: false,
});

// Client half: one classic script that registers itself with the DSH module
// loader. It must not contain ESM syntax: the shell evaluates it as a script.
await build({
  ...shared,
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(outdir, 'client.js'),
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  sourcemap: false,
  // Nothing is imported statically; `require("react")` is a call to the
  // factory parameter the module loader supplies, not a bundler import.
  external: ['react'],
});

console.log('[dsh-link] built dist/index.js and dist/client.js');