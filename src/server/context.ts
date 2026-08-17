import type { Request } from "express";
import { ServerCallContext, UnauthenticatedUser } from "@a2a-js/sdk/server";
import type { User } from "@a2a-js/sdk/server";
import type { Identity } from "apcore-js";
import { getAuthIdentity } from "../auth/storage.js";

/**
 * Adapts an apcore `Identity` to a2a-js's `User` interface.
 *
 * `userName` is the identity id, which is what a2a-js's `resolveUserScope` uses
 * as the owner key -- the same principal the executor puts on the apcore
 * `Context`, so governance and task scoping name the same caller.
 */
export class IdentityUser implements User {
  constructor(private readonly identity: Identity) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.identity.id;
  }
}

/**
 * `UserBuilder` that carries the authenticated principal into the
 * `ServerCallContext`.
 *
 * a2a-js scopes every task-addressed operation by an *owner* resolved from that
 * context: `InMemoryTaskStore` and `InMemoryPushNotificationStore` both bucket
 * by `ownerResolver(context)`, whose default `resolveUserScope` returns
 * `context.user?.userName`, and `DefaultRequestHandler` loads the task from
 * that context-scoped store before `getTask`, `cancelTask`, `listTasks` and all
 * four push-notification-config methods.
 *
 * That machinery was inert here because the handlers were mounted with
 * `UserBuilder.noAuthentication`: every request built a context with
 * `UnauthenticatedUser`, so every caller shared one owner bucket. `tasks/list`
 * returned every caller's tasks including their full stdout, any principal
 * could read or cancel another's task by id, and any principal could point
 * another's terminal `statusUpdate` at a webhook of its choosing or delete the
 * owner's push config. Only the unguessability of a UUIDv4 task id stood in the
 * way.
 *
 * Callers with no `Identity` fall back to `UnauthenticatedUser` -- a single
 * shared owner bucket. That covers both "no authenticator configured" and "an
 * authenticator configured with `requireAuth: false` that did not authenticate
 * this request". Single-tenant deployments are therefore unaffected; a
 * permissive-mode deployment gets scoping only between authenticated callers.
 *
 * The identity is read from the `AsyncLocalStorage` that `createAuthMiddleware`
 * enters before `next()`, so it is in scope for every downstream handler. The
 * `req` argument is unused for that reason.
 */
export function identityUserBuilder(_req: Request): Promise<User> {
  const identity = getAuthIdentity();
  return Promise.resolve(identity ? new IdentityUser(identity) : new UnauthenticatedUser());
}

/**
 * A `ServerCallContext` for the shared unauthenticated owner bucket.
 *
 * Used by in-process call sites that have no HTTP request to build from (the
 * `/health` store probe). Explicit so those sites cannot accidentally read an
 * authenticated principal's tasks.
 */
export function anonymousContext(): ServerCallContext {
  return new ServerCallContext({ user: new UnauthenticatedUser() });
}
