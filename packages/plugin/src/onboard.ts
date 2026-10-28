/**
 * One-paragraph onboarding prompt for another DeepSeek Harness computer.
 *
 * The prompt is deliberately self-contained: it carries the public edge URL and
 * the pinned version, but never a password, device secret, invite token or DSH
 * token. The host owner still approves the new device, which is the security
 * boundary that makes a copy-paste prompt safe.
 */

export const REPO_URL = 'https://github.com/yeerock/deepseek-harness-remote-control';
export const REPO_TAG = 'v0.2.0';
export const PLUGIN_VERSION = '0.2.0';

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
    `You are on a DeepSeek Harness desktop. Pair this Harness as a DSH RC ${version} host on the existing edge at ${edge}, using this computer's hostname as its device name, end to end, without asking for the owner password or any secret.`,
    `(1) If ~/dsh-rc does not exist, run: git clone --branch ${tag} ${repo} ~/dsh-rc ; otherwise run: cd ~/dsh-rc && git fetch --tags && git checkout ${tag}.`,
    `(2) Run: ~/dsh-rc/scripts/join-edge.sh "${edge}" "$(hostname)" . That script installs DSH RC into the profile this Harness instance uses, points its agent at the edge, and prints the restart step.`,
    `(3) Ask me to restart DeepSeek Harness; after the restart confirm that ~/.dsh/rc/status.json reaches state "online" and report its deviceId.`,
    `(4) Stop and wait: I will approve this Harness as a device in Remote Control or the edge dashboard. Do not enable sharing, do not request or share the owner password, do not use a guest invite link, and do not modify other profile entries. Report every command you ran and any error.`,
  ].join(' ');
}