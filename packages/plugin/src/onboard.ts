/**
 * One-paragraph onboarding prompt for another DeepSeek Harness computer.
 *
 * The prompt is deliberately self-contained: it carries the public edge URL and
 * the pinned version, but never a password, device secret, invite token or DSH
 * token. The host owner still approves the new device, which is the security
 * boundary that makes a copy-paste prompt safe.
 */

export const REPO_URL = 'https://github.com/yeerock/deepseek-harness-remote-control';
export const REPO_TAG = 'v0.4.1';
export const PLUGIN_VERSION = '0.4.7';

export interface JoinPromptOptions {
  /** Public edge origin; loopback URLs are rejected by the caller. */
  publicUrl: string;
  /** Plugin version pinned into the prompt. */
  version?: string;
  /** Repository URL; tests may override, production uses the constant. */
  repoUrl?: string;
  tag?: string;
}

/** True for localhost/loopback origins, where a prompt cannot help another machine. */
export function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.');
  } catch {
    return true;
  }
}

/** Raw GitHub URL of a setup script, pinned to a release tag. */
export function installScriptUrl(file: 'install.sh' | 'install.ps1', tag: string, repoUrl = REPO_URL): string {
  const path = new URL(repoUrl).pathname.replace(/^\/+|\/+$/g, '');
  return `https://raw.githubusercontent.com/${path}/${tag}/scripts/${file}`;
}

/**
 * Build the copy-paste prompt: one command per OS. The scripts do every step
 * (Node 24, git or download, build, install, connect, restart) and are safe to
 * re-run, so the agent's only job is to run one line and retry on failure.
 */
export function buildJoinPrompt(options: JoinPromptOptions): string {
  const tag = options.tag ?? REPO_TAG;
  const version = options.version ?? PLUGIN_VERSION;
  // The origin of a parsed URL has no quotes, spaces or shell metacharacters.
  const edge = new URL(options.publicUrl).origin;
  const sh = installScriptUrl('install.sh', tag, options.repoUrl);
  const ps1 = installScriptUrl('install.ps1', tag, options.repoUrl);
  return [
    `Install DSH RC ${version} on this computer and connect it to ${edge}, by yourself with no questions to me.`,
    `Windows, in PowerShell: \`$env:DSHRC_EDGE='${edge}'; $env:DSHRC_TAG='${tag}'; irm ${ps1} | iex\``,
    `macOS or Linux: \`curl -fsSL ${sh} | sh -s -- '${edge}' ${tag}\``,
    'The command installs everything needed and restarts DeepSeek Harness at the end; that is expected.',
    'If it fails, read the error, fix the cause (network, permissions, a missing tool) and run it again until it prints DONE; if it says ACTION NEEDED, stop and tell me.',
    'Never ask for or share a password or secret.',
  ].join(' ');
}
