#!/usr/bin/env node
/**
 * Rotate the edge owner password without touching the database by hand.
 *
 *   read -s NEW && DSHRC_NEW_PASSWORD="$NEW" node apps/edge/dist/passwd.js --data-dir ~/.dsh-rc/edge
 *
 * The password is read from the environment (never argv, never logged), hashed
 * with the same scrypt format as `/setup`, and written to the owner row.
 */
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { hashPassword } from './auth.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  const password = process.env['DSHRC_NEW_PASSWORD'] ?? '';
  if (password.length < 12 || password.length > 256) {
    process.stderr.write('dsh-rc passwd: set DSHRC_NEW_PASSWORD to 12-256 characters (use `read -s` so it is not in argv)\n');
    process.exitCode = 2;
    return;
  }
  const dataDir = resolve(argValue('--data-dir') ?? process.env['DSHRC_DATA_DIR'] ?? 'dshrc-data');
  const file = join(dataDir, 'dshrc.sqlite');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch (error) {
    process.stderr.write(`dsh-rc passwd: cannot open ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const owner = db.prepare('SELECT id FROM owner WHERE id = 1').get() as { id?: number } | undefined;
    if (owner === undefined) {
      process.stderr.write('dsh-rc passwd: this edge has no owner yet; complete /setup first\n');
      process.exitCode = 1;
      return;
    }
    const now = Date.now();
    db.prepare('UPDATE owner SET password_hash = ?, updated_at = ? WHERE id = 1').run(hashPassword(password), now);
  } catch (error) {
    process.stderr.write(`dsh-rc passwd: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
  process.stdout.write('dsh-rc passwd: owner password updated\n');
}

main();
