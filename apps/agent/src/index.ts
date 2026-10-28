/**
 * Public API of the DSH Link agent.
 *
 * ```ts
 * const agent = await startAgent({
 *   edgeUrl: 'https://link.example.com',
 *   dshUrlFile: '/run/dsh-link/dsh-url.json',
 *   stateDir: '/home/me/.dsh-link/agent',
 *   onStatus: (status) => console.log(status),
 * });
 * await agent.waitForOnline(30_000);
 * ...
 * await agent.stop();
 * ```
 */
export type { AgentHandle, AgentOptions, AgentState, AgentStatus } from './types.js';
export { startAgent } from './runtime.js';