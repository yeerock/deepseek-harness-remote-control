/**
 * One-paragraph onboarding prompt for another DeepSeek Harness computer.
 *
 * The prompt is deliberately self-contained: it carries the public edge URL and
 * the pinned version, but never a password, device secret, invite token or DSH
 * token. The host owner still approves the new device, which is the security
 * boundary that makes a copy-paste prompt safe.
 */

export const REPO_URL = 'https://github.com/yeerock/deepseek-harness-remote-control';
export const REPO_TAG = 'v0.3.5';
export const PLUGIN_VERSION = '0.3.5';

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

/**
 * Build the copy-paste prompt. One paragraph by design: agents receive it as a
 * single instruction and can still parse the numbered steps.
 */
export function buildJoinPrompt(options: JoinPromptOptions): string {
  const repo = (options.repoUrl ?? REPO_URL).replace(/\/+$/, '');
  const tag = options.tag ?? REPO_TAG;
  const version = options.version ?? PLUGIN_VERSION;
  const edge = options.publicUrl.replace(/\/+$/, '');
  return [
    `You are on a DeepSeek Harness desktop. Install or update DSH RC ${version} and join the edge at ${edge} as this Harness, fully autonomously with zero human action.`,
    `(1) Ensure a Node 24 runtime: use \`node\` if its major is at least 24; otherwise use the Node runtime bundled with DeepSeek Harness; if neither exists, download the official Node 24 LTS portable build for this OS into ~/.dsh-rc/node and use it.`,
    `(2) Get the source: if ~/dsh-rc is a git checkout, run \`cd ~/dsh-rc && git fetch --tags --force && git checkout -f ${tag}\`; if ~/dsh-rc exists but is not a git checkout, move it to ~/dsh-rc.bak-<timestamp>; then run \`git clone --branch ${tag} ${repo} ~/dsh-rc\`; if git is unavailable, download and extract ${repo}/archive/refs/tags/${tag}.tar.gz to ~/dsh-rc.`,
    `(3) Run \`node ~/dsh-rc/scripts/join-edge.mjs "${edge}"\` (the installer uses this computer's hostname; add \`--profile <name>\` only if auto-detection is wrong). It updates and builds, installs the plugin into the running profile, writes the patch, links the package, and schedules the DeepSeek Harness restart itself.`,
    `(4) Do not ask me to restart, approve, log in, or confirm; the installer exits after scheduling the restart and the edge auto-approves this Harness. Do not enable sharing, request or share the owner password or any secret, and do not modify other profile entries. If a step fails, retry once using the fallback path above, then report the exact error and stop.`,
  ].join(' ');
}