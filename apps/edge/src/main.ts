#!/usr/bin/env node
/**
 * CLI entry point for the DSH Link edge.
 *
 * Startup prints three machine-readable plain-text lines (independent of the
 * JSON logger so `--log-level silent` still leaves them):
 *
 *   DSH Link edge listening on http://127.0.0.1:<port>
 *   DSH Link setup code: <one-time code>        (first run only)
 *   DSH Link setup url: <origin>/setup          (first run only)
 */
import process from 'node:process';
import { HelpRequested, USAGE, loadConfig } from './config.js';
import { createEdgeServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig({ argv: process.argv.slice(2) });
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(USAGE);
      return;
    }
    process.stderr.write(`dsh-link edge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Run with --help for usage.\n');
    process.exitCode = 1;
    return;
  }

  const edge = createEdgeServer({ config });
  const bound = await edge.listen();

  process.stdout.write(`DSH Link edge listening on ${bound.url}\n`);
  if (config.publicUrl !== '') process.stdout.write(`DSH Link public url: ${config.publicUrl}\n`);
  if (edge.setupComplete) {
    process.stdout.write(`DSH Link owner configured; sign in at ${edge.origin}/login\n`);
  } else if (edge.setupCode !== undefined) {
    process.stdout.write(`DSH Link setup code: ${edge.setupCode}\n`);
    process.stdout.write(`DSH Link setup url: ${edge.origin}/setup\n`);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`DSH Link edge stopping (${signal})\n`);
    void edge.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`dsh-link edge failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});