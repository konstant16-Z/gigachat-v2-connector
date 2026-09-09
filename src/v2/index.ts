/**
 * GigaCodeConnector (V2) — entry point.
 * Export surface matches the production bundle exactly.
 */
import plugin from "./plugin.js";

export { plugin as default };

export { BUILTIN_CA_BUNDLE, getHttpsAgent, sanitizeError, shouldVerifySsl } from "./net.js";
export { GigaCodeAuthManager, authManager } from "./auth.js";
export { getToolAlias, getOriginalToolName } from "./toolRegistry.js";
export { gigaHosts, isGigaProvider, registerGigaEndpoint } from "./hosts.js";
export { resolveGigaConnection } from "./plugin.js";
export { translateOpenAiToGigaChat } from "./translator.js";
export {
  translateGigaChatToOpenAi,
  translateStreamChunk,
  translateJsonResponse,
  translateStreamingResponse,
  validateMessagePayload
} from "./response.js";