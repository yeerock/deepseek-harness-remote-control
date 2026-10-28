/**
 * DSH host plugin entry.
 *
 * The loader imports this module and reads `name`, `inject`, `Config`, and
 * `apply`. It is bundled with esbuild to `dist/index.js` so the profile never
 * needs a build step or a dependency tree for the host half.
 */

export { apply, createPluginLogger, inject, name } from './host.js';
export type { DshLinkServiceApi } from './host.js';
export { Config, DEFAULT_CONFIG, normalizeConfig, resolveDeviceName, resolveDshHome, resolveStateDir } from './config.js';
export type { PluginConfig, PluginLogLevel } from './config.js';
export { AgentSupervisor, interpretAgentLine, parseAgentStatus, targetFromSpec } from './agent-supervisor.js';
export type { SupervisorLogger } from './agent-supervisor.js';
export { AGENT_STATES, LOCALE_NAMESPACE, RPC_CHANNEL, SERVICE_NAME } from './contract.js';
export type { AgentState, AgentStatus, DshLinkStatus, RpcEndpoint, RpcReply } from './contract.js';