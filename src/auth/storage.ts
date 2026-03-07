import { AsyncLocalStorage } from "node:async_hooks";
import type { Identity } from "apcore-js";

export const authIdentityStore = new AsyncLocalStorage<Identity | null>();

export function getAuthIdentity(): Identity | null {
  return authIdentityStore.getStore() ?? null;
}
