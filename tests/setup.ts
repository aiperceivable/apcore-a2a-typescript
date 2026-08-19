import { Server as TLSServer } from "node:tls";
import supertest from "supertest";

/**
 * Route supertest at the loopback address its own server actually listens on.
 *
 * supertest starts a server with `listen(0)` — no host — which binds the
 * wildcard address, and then hardcodes `http://127.0.0.1:<port>` as the URL.
 * A wildcard bind may share a port with an existing IPv4-loopback-specific
 * bind, and desktop apps (VS Code helpers, Ollama, ...) hold dozens of
 * ephemeral ports on 127.0.0.1. When the kernel hands out such a port, the
 * more specific binding wins and the request is delivered to that foreign
 * process, which answers 404 for our routes — a flaky failure that looks like
 * a missing route.
 *
 * Binding to a host instead would fix it at the source, but `listen(0, host)`
 * resolves the host through dns.lookup and therefore binds asynchronously,
 * leaving `address()` null for supertest's synchronous URL construction.
 * Connecting over the server's own address family avoids the collision without
 * that race: an IPv4-loopback bind cannot capture a request to [::1].
 */
const Test = (supertest as unknown as { Test: { prototype: Record<string, unknown> } }).Test;

Test.prototype.serverAddress = function serverAddress(
  this: { _server?: unknown },
  app: { address(): { port: number; family: string | number } | null; listen(port: number): unknown },
  path: string,
) {
  if (!app.address()) this._server = app.listen(0);

  const addr = app.address();
  if (!addr) throw new Error("supertest: server is not listening");

  const isIPv6 = addr.family === "IPv6" || addr.family === 6;
  const host = isIPv6 ? "[::1]" : "127.0.0.1";
  const protocol = app instanceof TLSServer ? "https" : "http";

  return `${protocol}://${host}:${addr.port}${path}`;
};
