export type { Authenticator } from "./types.js";
export { JWTAuthenticator, type ClaimMapping } from "./jwt.js";
export { createAuthMiddleware } from "./middleware.js";
export { authIdentityStore, getAuthIdentity } from "./storage.js";
