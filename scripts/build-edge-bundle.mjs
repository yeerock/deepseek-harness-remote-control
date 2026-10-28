/**
 * Build a self-contained edge binary bundle.
 *
 * Why: a macOS launchd agent cannot read a checkout under ~/Documents (TCC),
 * and a production host should not need the repo. The CJS bundle includes ws
 * and the workspace packages; only Node built-ins stay external.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, 'build', 'edge', 'main.cjs');
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(root, 'apps/edge/src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node22'],
  outfile,
  external: ['node:*'],
  legalComments: 'none',
  logLevel: 'warning',
});

console.log(`[dsh-rc] edge bundle -> ${outfile}`);