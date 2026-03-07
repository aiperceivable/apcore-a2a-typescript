import type { Identity } from "apcore-js";

export interface Authenticator {
  authenticate(headers: Record<string, string>): Identity | null;
  securitySchemes(): Record<string, unknown>;
}
