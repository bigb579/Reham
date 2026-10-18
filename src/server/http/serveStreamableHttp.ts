import {
  hostHeaderValidationResponse,
  isInitializeRequest,
  localhostAllowedHostnames,
  originValidationResponse,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
  type McpServerFactory,
  type Server,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import type { Logger } from "pino";

import { toWebRequest, writeWebResponse } from "./nodeHttpBridge.js";
import { StreamableHttpListenError } from "./streamableHttpListenError.js";

/** MCP endpoint path shared by `rea mcp --http` and agent environment servers. */
export const MCP_HTTP_PATH = "/mcp";

/** One plain HTTP route served beside the MCP endpoint as web Request to Response. */
export interface StreamableHttpRoute {
  readonly method: string;
  readonly path: string;
  readonly handle: (request: Request) => Response | Promise<Response>;
}

export interface ServeStreamableHttpOptions {
  readonly host: string;
  readonly port: number;
  /** Called once; the instance serves every session in turn on a fresh transport. */
  readonly createMcpServer: McpServerFactory;
  readonly routes?: readonly StreamableHttpRoute[];
  readonly logger?: Logger;
  /** Reports listener failures after binding; request failures are logged instead. */
  readonly onerror?: (error: Error) => void;
  /** Close the server instance as the last stage of `close`; false when the factory's owner closes it. */
  readonly closeInstance?: boolean;
}

export interface StreamableHttpServer {
  /** The bound MCP endpoint URL. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** The bind host as the SDK compares Host headers: lowercase, IPv6 bracketed and canonical. */
const normalizedHostname = (host: string): string | undefined => {
  try {
    return new URL(`http://${isIPv6(host) ? `[${host}]` : host}`).hostname;
  } catch {
    return undefined;
  }
};
const isLoopbackIpv4 = (address: string): boolean =>
  isIPv4(address) && address.startsWith("127.");
/** Loopback by address class and localhost names, so no spelling of a local bind skips validation. */
const isLoopbackHostname = (hostname: string): boolean => {
  if (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".localhost.")
  )
    return true;
  if (isLoopbackIpv4(hostname)) return true;
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const inner = hostname.slice(1, -1);
  if (inner === "::1") return true;
  if (!inner.startsWith("::ffff:")) return false;
  const mapped = inner.slice("::ffff:".length);
  if (isLoopbackIpv4(mapped)) return true;
  const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(mapped);
  return hex !== null && Number.parseInt(hex[1] ?? "0", 16) >> 8 === 0x7f;
};
/** Host and Origin allowlist when the configured host or the address it bound is loopback, including both names; undefined relaxes validation. */
export const hostHeaderAllowlist = (
  host: string,
  boundAddress = host,
): string[] | undefined => {
  const names = [normalizedHostname(host), normalizedHostname(boundAddress)];
  const known = names.filter((name): name is string => name !== undefined);
  if (!known.some((name) => isLoopbackHostname(name))) return undefined;
  return [...new Set([...localhostAllowedHostnames(), ...known])];
};

const jsonError = (status: number, code: number, message: string): Response =>
  Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );

const protocolOf = (instance: McpServer | Server): Server =>
  "server" in instance ? instance.server : instance;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const NO_SHUTDOWN_HOOK = (): void => undefined;
const SHUTTING_DOWN = (): Response =>
  jsonError(503, -32000, "Server shutting down");

/** The headers the SDK requires of a streamable POST; a request without them is left to the transport's refusal. */
/** The media type proper of one header value or Accept range: no parameters, lowercase. */
const mediaType = (value: string): string =>
  (value.split(";")[0] ?? "").trim().toLowerCase();
const hasStreamablePostHeaders = (request: Request): boolean => {
  // Exact media ranges and type: `application/json-patch+json` or `text/event-streaming` do not count.
  const accepted = new Set(
    (request.headers.get("accept") ?? "").split(",").map(mediaType),
  );
  return (
    accepted.has("application/json") &&
    accepted.has("text/event-stream") &&
    mediaType(request.headers.get("content-type") ?? "") === "application/json"
  );
};

/** Only a new client's initialize travels without a session id; peek within the SDK body bound. */
const isInitializePost = async (request: Request): Promise<boolean> => {
  if (
    request.method !== "POST" ||
    request.headers.has("mcp-session-id") ||
    !hasStreamablePostHeaders(request)
  )
    return false;
  const probe = request.clone();
  try {
    const read = await readRequestBody(probe);
    if (read.tooLarge) return false;
    const body: unknown = JSON.parse(read.text);
    return Array.isArray(body)
      ? body.some((message) => isInitializeRequest(message))
      : isInitializeRequest(body);
  } catch {
    return false;
  } finally {
    // The clone is one branch of a tee; awaiting its cancel would wait for the original to drain.
    void probe.body?.cancel().catch(() => undefined);
  }
};

/** The connected transport of one session and the SDK close that ends it as a server shutdown. */
interface LiveSession {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly shutdown: () => Promise<void>;
}

/** Owns the single connected server and the transport of its current session. */
export class McpSessionSlot {
  #live: LiveSession | undefined;
  #arming: Promise<WebStandardStreamableHTTPServerTransport> | undefined;
  #closed = false;
  #hookRan = false;
  /** The instance's own close hook, captured once; it runs exactly once, when the listener closes. */
  readonly #shutdownHook: () => void;

  constructor(
    private readonly instance: McpServer | Server,
    private readonly logger: Logger | undefined,
  ) {
    const protocol = protocolOf(instance);
    const captured = protocol.onclose ?? NO_SHUTDOWN_HOOK;
    this.#shutdownHook = () => {
      if (this.#hookRan) return;
      this.#hookRan = true;
      captured();
    };
    protocol.onclose = this.#shutdownHook;
  }

  /** Route one MCP request; a new client's initialize replaces a session its predecessor left open. */
  async handle(request: Request): Promise<Response> {
    if (this.#closed) return SHUTTING_DOWN();
    const open = this.#live;
    if (
      open?.transport.sessionId !== undefined &&
      (await isInitializePost(request))
    ) {
      if (this.#closed) return SHUTTING_DOWN();
      this.logger?.info("MCP HTTP session replaced by a new client");
      await open.transport.close();
    }
    const transport = await this.#current();
    // Shutdown may have closed the slot while this request was arming it.
    if (this.#closed) return SHUTTING_DOWN();
    return transport.handleRequest(request);
  }

  /** End the live session as part of server shutdown, so the instance's onclose runs; later requests are refused. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#arming?.catch(() => undefined);
    const open = this.#live;
    // The session stays owned until its shutdown succeeds, so a retry can finish it.
    await open?.shutdown();
    if (this.#live === open) this.#live = undefined;
    // Without a live transport nothing fires the instance's hook; run it here, once.
    this.#shutdownHook();
  }

  #current(): Promise<WebStandardStreamableHTTPServerTransport> {
    if (this.#closed)
      return Promise.reject(new Error("MCP HTTP session slot is closed"));
    if (this.#live !== undefined) return Promise.resolve(this.#live.transport);
    this.#arming ??= this.#arm().finally(() => {
      this.#arming = undefined;
    });
    return this.#arming;
  }

  async #arm(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: () => this.logger?.info("MCP HTTP session opened"),
      onsessionclosed: () =>
        this.logger?.info("MCP HTTP session closed by the client"),
    });
    const shutdown = transport.close.bind(transport);
    // The SDK closes the transport on DELETE; that ends the session, not the server.
    transport.close = () => this.#endSession(transport, shutdown);
    await this.instance.connect(transport);
    this.#live = { transport, shutdown };
    return transport;
  }

  /** Close one session's transport while the instance's onclose hooks wait for close(). */
  async #endSession(
    transport: WebStandardStreamableHTTPServerTransport,
    shutdown: () => Promise<void>,
  ): Promise<void> {
    const protocol = protocolOf(this.instance);
    protocol.onclose = NO_SHUTDOWN_HOOK;
    try {
      await shutdown();
      // Only a completed shutdown releases the session; a failed one stays live for a retry.
      if (this.#live?.transport === transport) this.#live = undefined;
    } finally {
      protocol.onclose = this.#shutdownHook;
    }
  }
}

const endpointUrl = (
  address: ReturnType<ReturnType<typeof createHttpServer>["address"]>,
): string => {
  if (address === null || typeof address === "string")
    throw new TypeError("MCP HTTP listener has no TCP address");
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}${MCP_HTTP_PATH}`;
};

/** Serve one MCP server, plus plain routes, over streamable HTTP until closed. */
export const serveStreamableHttp = async (
  options: ServeStreamableHttpOptions,
): Promise<StreamableHttpServer> => {
  const { host, port, logger, routes = [], closeInstance = true } = options;
  // Scoped IPv6 literals bind but cannot be named in a URL; refuse them before anything exists.
  if (host.includes("%"))
    throw new StreamableHttpListenError(
      new Error(`scoped IPv6 bind address ${host} is not supported`),
    );
  // Loopback is classified from the address the listener binds, after it binds; the instance
  // is created after that, so a bind failure leaves nothing to clean up.
  let allowedHosts: string[] | undefined;
  let slot: McpSessionSlot | undefined;
  let origin = "";
  let stopped = false;
  const route = async (request: Request): Promise<Response> => {
    if (stopped) return jsonError(503, -32000, "Server shutting down");
    // One loopback allowlist gates Host (DNS rebinding) and Origin (browser pages); a missing Origin passes.
    const refused =
      allowedHosts === undefined
        ? undefined
        : (hostHeaderValidationResponse(request, allowedHosts) ??
          originValidationResponse(request, allowedHosts));
    if (refused !== undefined) return refused;
    const { pathname } = new URL(request.url);
    if (pathname === MCP_HTTP_PATH)
      return slot === undefined
        ? jsonError(503, -32000, "Server starting")
        : slot.handle(request);
    const match = routes.find(
      (candidate) =>
        candidate.path === pathname && candidate.method === request.method,
    );
    return match === undefined
      ? jsonError(404, -32601, `No route for ${request.method} ${pathname}`)
      : match.handle(request);
  };
  const httpServer = createHttpServer();
  const handleRequest = (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> =>
    serveNodeRequest(
      { route, origin: () => origin, logger },
      request,
      response,
    );
  const closeListener = async (): Promise<void> => {
    stopped = true;
    await closeHttpServer(httpServer);
  };
  try {
    httpServer.listen(port, host);
    await once(httpServer, "listening");
  } catch (cause: unknown) {
    throw new StreamableHttpListenError(cause);
  }
  const bound = httpServer.address();
  let url: string;
  try {
    url = endpointUrl(bound);
    origin = new URL(url).origin;
  } catch (cause: unknown) {
    await closeListener().catch(() => undefined);
    throw new StreamableHttpListenError(cause);
  }
  allowedHosts = hostHeaderAllowlist(
    host,
    bound !== null && typeof bound === "object" ? bound.address : host,
  );
  httpServer.on("request", (request, response) => {
    void handleRequest(request, response);
  });
  // Bind failures already rejected the listening wait above; only later listener errors are reported.
  httpServer.on("error", (error) => options.onerror?.(error));
  let instance: McpServer | Server;
  try {
    instance = await options.createMcpServer({ era: "legacy" });
  } catch (cause: unknown) {
    // No instance exists yet, so the listener is the only resource to release.
    await closeListener().catch(() => undefined);
    throw cause;
  }
  protocolOf(instance).onerror = (error) =>
    logger?.warn({ error: error.message }, "MCP HTTP request rejected");
  const live = new McpSessionSlot(instance, logger);
  slot = live;
  if (allowedHosts === undefined)
    logger?.warn(
      { host },
      "MCP HTTP Host header validation relaxed for a non-loopback bind",
    );
  // The URL is the only way to reach an ephemeral port, so the announcement ignores the log threshold.
  logger
    ?.child({}, { level: "info" })
    .info({ transport: "streamable-http", url }, "MCP transport listening");
  const close = stagedClose([
    closeListener,
    () => live.close(),
    ...(closeInstance ? [() => instance.close()] : []),
  ]);
  return { url, close };
};

/** Drop open connections and release the port. */
const closeHttpServer = (
  httpServer: ReturnType<typeof createHttpServer>,
): Promise<void> => {
  httpServer.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    httpServer.close((error) =>
      error === undefined ? resolve() : reject(error),
    );
  });
};

/** Translate one node:http exchange through `route`, logging a failure and answering it when headers are still open. */
const serveNodeRequest = async (
  target: {
    readonly route: (request: Request) => Promise<Response>;
    readonly origin: () => string;
    readonly logger: Logger | undefined;
  },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const { route, origin, logger } = target;
  try {
    const webResponse = await route(toWebRequest(request, response, origin()));
    await writeWebResponse(webResponse, response);
  } catch (cause: unknown) {
    // A client that left mid-stream is routine; a failure before headers is not.
    logger?.[response.headersSent ? "debug" : "warn"](
      { error: describe(cause) },
      "MCP HTTP request did not complete",
    );
    if (response.headersSent) response.destroy();
    else
      await writeWebResponse(
        jsonError(500, -32603, "Internal server error"),
        response,
      ).catch(() => undefined);
  }
};

/** Run close stages in order once each; a failed stage is retried by the next call instead of replaying its rejection. */
const stagedClose = (
  stages: readonly (() => Promise<void>)[],
): (() => Promise<void>) => {
  const done = stages.map(() => false);
  let closing: Promise<void> | undefined;
  return () => {
    if (closing !== undefined) return closing;
    const attempt = (async () => {
      for (const [index, stage] of stages.entries()) {
        if (done[index]) continue;
        await stage();
        done[index] = true;
      }
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };
};
