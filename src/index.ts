export const VERSION = "0.3.0";

// Public API: serve
export { serve, asyncServe } from "./serve.js";

// Client
export { A2AClient } from "./client/index.js";

// Auth
export type { Authenticator, ClaimMapping } from "./auth/index.js";
export { JWTAuthenticator } from "./auth/index.js";
export { createAuthMiddleware } from "./auth/index.js";
export { authIdentityStore, getAuthIdentity } from "./auth/index.js";

// Adapters
export { AgentCardBuilder } from "./adapters/index.js";
export { SkillMapper } from "./adapters/index.js";
export { SchemaConverter } from "./adapters/index.js";
export { ErrorMapper } from "./adapters/index.js";
export { PartConverter } from "./adapters/index.js";

// Server
export { A2AServerFactory } from "./server/index.js";
export { ApCoreAgentExecutor } from "./server/index.js";
