export const VERSION = "0.7.0";

// Public API: serve
export { serve, asyncServe } from "./serve.js";

// Client
export { A2AClient } from "./client/index.js";
export {
  A2AClientError,
  A2AConnectionError,
  A2ADiscoveryError,
  A2AServerError,
  AccessDeniedError,
  ApprovalDeniedError,
  ApprovalTimeoutError,
  GovernanceRefusedError,
  TaskNotCancelableError,
  TaskNotFoundError,
} from "./client/index.js";

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

// OpenAPI backend (feature F-12) — turn an OpenAPI 3.0/3.1 document into a
// populated apcore Registry, which `serve` accepts like any other.
export {
  buildOpenapiBackendFromConfig,
  openapiBackend,
  // Deprecated: apcore-toolkit >= 0.13 emits IDs in apcore's alphabet; kept
  // exported until a later minor release removes it.
  projectModuleId,
  resolveSpecLocation,
  synthesizeDescription,
  MODULE_ID_SEGMENT,
  WRITE_METHODS,
} from "./openapi-backend.js";
export type {
  GovernanceStateLike,
  OpenapiBackendLogger,
  OpenapiBackendOptions,
} from "./openapi-backend.js";
