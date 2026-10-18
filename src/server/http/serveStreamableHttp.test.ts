import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  expectForeignHostRefused,
  rawHttpRequest,
} from "../../../tests/support/http/rawRequest.js";
import {
  hostHeaderAllowlist,
  McpSessionSlot,
  serveStreamableHttp,
  type StreamableHttpServer,
} from "./serveStreamableHttp.js";
import { StreamableHttpListenError } from "./streamableHttpListenError.js";

const servers: StreamableHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** An echo server whose protocol onclose hook counts as a shutdown, as rea's provider cleanup does. */
const createEchoServer = (onShutdown: () => void): McpServer => {
  const server = new McpServer({ name: "echo-fixture", version: "1" });
  server.registerTool(
    "echo",
    { description: "Echo text", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.server.onclose = onShutdown;
  return server;
};

const start = async (
  overrides: Partial<Parameters<typeof serveStreamableHttp>[0]> = {},
) => {
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line) => logs.push(line) });
  let factoryCalls = 0;
  let shutdownHooks = 0;
  const served = await serveStreamableHttp({
    host: "127.0.0.1",
    port: 0,
    createMcpServer: () => {
      factoryCalls += 1;
      return createEchoServer(() => {
        shutdownHooks += 1;
      });
    },
    logger,
    ...overrides,
  });
  servers.push(served);
  return {
    served,
    messages: () =>
      logs.map((line) => (JSON.parse(line) as { msg: string }).msg),
    entries: () =>
      logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    factoryCalls: () => factoryCalls,
    shutdownHooks: () => shutdownHooks,
  };
};

const connect = async (url: string) => {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "streamable-http-adapter", version: "1" });
  await client.connect(transport);
  return { transport, client };
};

const echo = async (client: Client, text: string): Promise<unknown> => {
  const result = await client.callTool({ name: "echo", arguments: { text } });
  return result.content;
};

/** A new client's initialize as the bridge hands it to the slot: no session id yet. */
const initializeRequest = (): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "racing-client", version: "1" },
      },
    }),
  });

it("announces the bound URL and serves one session at a time on one live instance", async () => {
  const { served, entries, messages, factoryCalls, shutdownHooks } =
    await start();
  expect(new URL(served.url).pathname).toBe("/mcp");
  expect(entries()).toContainEqual(
    expect.objectContaining({
      transport: "streamable-http",
      url: served.url,
      msg: "MCP transport listening",
    }),
  );
  const first = await connect(served.url);
  const sessionId = first.transport.sessionId;
  expect(sessionId).toEqual(expect.any(String));
  await expect(echo(first.client, "hi")).resolves.toEqual([
    { type: "text", text: "hi" },
  ]);
  // A new client's initialize replaces the open session; the earlier client is refused.
  const second = await connect(served.url);
  expect(second.transport.sessionId).toEqual(expect.any(String));
  expect(second.transport.sessionId).not.toBe(sessionId);
  await expect(echo(first.client, "stale")).rejects.toThrow();
  await expect(echo(second.client, "live")).resolves.toEqual([
    { type: "text", text: "live" },
  ]);
  await first.client.close();
  // DELETE ends the session, not the server: the instance keeps serving.
  await second.transport.terminateSession();
  expect(second.transport.sessionId).toBeUndefined();
  await second.client.close();
  const third = await connect(served.url);
  await expect(echo(third.client, "again")).resolves.toEqual([
    { type: "text", text: "again" },
  ]);
  expect(factoryCalls()).toBe(1);
  expect(shutdownHooks()).toBe(0);
  expect(
    messages().filter((msg) => msg === "MCP HTTP session opened"),
  ).toHaveLength(3);
  expect(messages()).toContain("MCP HTTP session replaced by a new client");
  // Closing the listener with a session open is the shutdown the instance's hook waits for.
  await served.close();
  expect(shutdownHooks()).toBe(1);
  await third.client.close();
});

it("keeps the instance's shutdown hook when two initialize requests race to replace an open session", async () => {
  let shutdownHooks = 0;
  const slot = new McpSessionSlot(
    createEchoServer(() => {
      shutdownHooks += 1;
    }),
    undefined,
  );
  const opened = await slot.handle(initializeRequest());
  expect(opened.status).toBe(200);
  // Both requests see the same open session and end it in lockstep.
  const raced = await Promise.all([
    slot.handle(initializeRequest()),
    slot.handle(initializeRequest()),
  ]);
  expect(raced.map((response) => response.status).sort()).toEqual([200, 400]);
  const winner = raced.find((response) => response.status === 200);
  expect(winner?.headers.get("mcp-session-id")).toEqual(expect.any(String));
  expect(shutdownHooks).toBe(0);
  // Only the slot's own close is the shutdown the instance's hook waits for.
  await slot.close();
  expect(shutdownHooks).toBe(1);
});

it("serves plain routes beside the MCP endpoint and answers unknown paths with 404", async () => {
  const { served } = await start({
    routes: [
      {
        method: "GET",
        path: "/.well-known/probe",
        handle: () => Response.json({ probe: true }),
      },
    ],
  });
  const probe = await fetch(new URL("/.well-known/probe", served.url));
  await expect(probe.json()).resolves.toEqual({ probe: true });
  const missing = await fetch(new URL("/missing", served.url));
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toMatchObject({
    error: { code: -32601 },
  });
  const wrongMethod = await fetch(new URL("/.well-known/probe", served.url), {
    method: "POST",
    body: "{}",
  });
  expect(wrongMethod.status).toBe(404);
});

it("refuses foreign Host headers on a loopback bind and frees the port on close", async () => {
  const { served } = await start();
  const url = new URL(served.url);
  await expectForeignHostRefused(url);
  await served.close();
  await served.close();
  await expect(rawHttpRequest(url)).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
});

it("reports a port that cannot be bound as a typed listen error naming the cause", async () => {
  const { served } = await start();
  const failed = serveStreamableHttp({
    host: "127.0.0.1",
    port: Number(new URL(served.url).port),
    createMcpServer: () => createEchoServer(() => undefined),
  });
  await expect(failed).rejects.toBeInstanceOf(StreamableHttpListenError);
  await expect(failed).rejects.toThrow(/EADDRINUSE/u);
});

it("keeps the SDK loopback allowlist, plus the bind's own hostname, for every loopback spelling", () => {
  const sdk = ["localhost", "127.0.0.1", "[::1]"];
  expect(hostHeaderAllowlist("127.0.0.1")).toEqual(sdk);
  expect(hostHeaderAllowlist("localhost")).toEqual(sdk);
  expect(hostHeaderAllowlist("LOCALHOST")).toEqual(sdk);
  expect(hostHeaderAllowlist("::1")).toEqual(sdk);
  expect(hostHeaderAllowlist("0:0:0:0:0:0:0:1")).toEqual(sdk);
  expect(hostHeaderAllowlist("127.0.0.2")).toEqual([...sdk, "127.0.0.2"]);
  expect(hostHeaderAllowlist("localhost.")).toEqual([...sdk, "localhost."]);
  expect(hostHeaderAllowlist("::ffff:127.0.0.1")).toEqual([
    ...sdk,
    "[::ffff:7f00:1]",
  ]);
  expect(hostHeaderAllowlist("192.0.2.10")).toBeUndefined();
  expect(hostHeaderAllowlist("0.0.0.0")).toBeUndefined();
  expect(hostHeaderAllowlist("::")).toBeUndefined();
  expect(hostHeaderAllowlist("example.com")).toBeUndefined();
  expect(hostHeaderAllowlist("not a host")).toBeUndefined();
});

it("refuses requests once the slot is closed and joins an initialize that is still arming", async () => {
  let shutdowns = 0;
  const slot = new McpSessionSlot(
    createEchoServer(() => {
      shutdowns += 1;
    }),
    undefined,
  );
  const arming = slot.handle(initializeRequest());
  await slot.close();
  expect((await arming).status).toBe(503);
  expect(shutdowns).toBe(1);
  expect((await slot.handle(initializeRequest())).status).toBe(503);
});

it("retries unfinished cleanup after a close stage fails instead of replaying the failure", async () => {
  let failures = 1;
  const { served } = await start({
    createMcpServer: () => {
      const server = createEchoServer(() => undefined);
      const original = server.close.bind(server);
      server.close = async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("provider cleanup failed");
        }
        await original();
      };
      return server;
    },
  });
  await expect(served.close()).rejects.toThrow("provider cleanup failed");
  await expect(served.close()).resolves.toBeUndefined();
  await expect(rawHttpRequest(new URL(served.url))).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
});

it("leaves a sessionless POST without the streamable headers or with a foreign Origin to refusal, keeping the session", async () => {
  const { served } = await start();
  const { client } = await connect(served.url);
  const url = new URL(served.url);
  const body = await initializeRequest().text();
  const host = `127.0.0.1:${url.port}`;
  const plain = await rawHttpRequest(url, {
    method: "POST",
    headers: {
      host,
      "content-type": "text/plain",
      accept: "application/json, text/event-stream",
    },
    body,
  });
  expect(plain.status).toBeGreaterThanOrEqual(400);
  expect(plain.status).toBeLessThan(500);
  const foreign = await rawHttpRequest(url, {
    method: "POST",
    headers: {
      host,
      origin: "http://attacker.example",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body,
  });
  expect(foreign.status).toBe(403);
  expect(await echo(client, "still here")).toEqual([
    { type: "text", text: "still here" },
  ]);
  await client.close();
});

it("announces the bound URL even when the log level hides info lines", async () => {
  const logs: string[] = [];
  const logger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
  const { served } = await start({ logger });
  expect(
    logs.map((line) => JSON.parse(line) as Record<string, unknown>),
  ).toContainEqual(
    expect.objectContaining({
      msg: "MCP transport listening",
      url: served.url,
    }),
  );
});

it("does not let a JSON-suffixed media type replace the session", async () => {
  const { served } = await start();
  const { client } = await connect(served.url);
  const url = new URL(served.url);
  const patch = await rawHttpRequest(url, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${url.port}`,
      "content-type": "application/json-patch+json",
      accept: "application/json, text/event-stream",
    },
    body: await initializeRequest().text(),
  });
  expect(patch.status).toBeGreaterThanOrEqual(400);
  expect(patch.status).toBeLessThan(500);
  expect(await echo(client, "unchanged")).toEqual([
    { type: "text", text: "unchanged" },
  ]);
  await client.close();
});

it("releases the listener when the server factory fails after the port is bound", async () => {
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line) => logs.push(line) });
  const seen: string[] = [];
  const failing = serveStreamableHttp({
    host: "127.0.0.1",
    port: 0,
    logger,
    createMcpServer: () => {
      throw new Error("provider unavailable");
    },
  });
  await expect(failing).rejects.toThrow("provider unavailable");
  for (const line of logs) seen.push((JSON.parse(line) as { msg: string }).msg);
  expect(seen).not.toContain("MCP transport listening");
});

it("classifies loopback from the bound address and lists the configured name beside it", () => {
  const sdk = ["localhost", "127.0.0.1", "[::1]"];
  expect(hostHeaderAllowlist("ip6-localhost", "::1")).toEqual([
    ...sdk,
    "ip6-localhost",
  ]);
  expect(hostHeaderAllowlist("dev.local", "127.0.0.1")).toEqual([
    ...sdk,
    "dev.local",
  ]);
  expect(hostHeaderAllowlist("0.0.0.0", "0.0.0.0")).toBeUndefined();
  expect(hostHeaderAllowlist("dev.local", "192.0.2.10")).toBeUndefined();
});

it("refuses a scoped IPv6 bind before creating anything and keeps bind failures away from onerror", async () => {
  let factoryCalls = 0;
  const onerror = (): void => {
    throw new Error("onerror must not run during startup");
  };
  await expect(
    serveStreamableHttp({
      host: "fe80::1%lo0",
      port: 0,
      onerror,
      createMcpServer: () => {
        factoryCalls += 1;
        return createEchoServer(() => undefined);
      },
    }),
  ).rejects.toBeInstanceOf(StreamableHttpListenError);
  expect(factoryCalls).toBe(0);
  const { served } = await start();
  await expect(
    serveStreamableHttp({
      host: "127.0.0.1",
      port: Number(new URL(served.url).port),
      onerror,
      createMcpServer: () => createEchoServer(() => undefined),
    }),
  ).rejects.toThrow(/EADDRINUSE/u);
});

it("leaves the instance to its owner when closeInstance is false", async () => {
  let instanceCloses = 0;
  const server = createEchoServer(() => undefined);
  const original = server.close.bind(server);
  server.close = async () => {
    instanceCloses += 1;
    await original();
  };
  const served = await serveStreamableHttp({
    host: "127.0.0.1",
    port: 0,
    closeInstance: false,
    createMcpServer: () => server,
  });
  await served.close();
  expect(instanceCloses).toBe(0);
  await server.close();
  expect(instanceCloses).toBe(1);
});

it("requires exact Accept media ranges before a sessionless POST may replace the session", async () => {
  const { served } = await start();
  const { client } = await connect(served.url);
  const url = new URL(served.url);
  const lookalike = await rawHttpRequest(url, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${url.port}`,
      "content-type": "application/json",
      accept: "application/json-patch+json, text/event-streaming",
    },
    body: await initializeRequest().text(),
  });
  expect(lookalike.status).toBeGreaterThanOrEqual(400);
  expect(lookalike.status).toBeLessThan(500);
  expect(await echo(client, "still mine")).toEqual([
    { type: "text", text: "still mine" },
  ]);
  await client.close();
});

it("keeps a session whose transport shutdown failed so the next close retries it", async () => {
  let shutdowns = 0;
  const slot = new McpSessionSlot(
    createEchoServer(() => {
      shutdowns += 1;
    }),
    undefined,
  );
  // The slot binds the transport's close when it arms, so the spy must exist before the first request.
  const close = vi
    .spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close")
    .mockImplementationOnce(() => Promise.reject(new Error("transport stuck")));
  try {
    await slot.handle(initializeRequest());
    await expect(slot.close()).rejects.toThrow("transport stuck");
    expect(shutdowns).toBe(0);
    await expect(slot.close()).resolves.toBeUndefined();
    expect(shutdowns).toBe(1);
    expect((await slot.handle(initializeRequest())).status).toBe(503);
  } finally {
    close.mockRestore();
  }
});

it("runs the instance's shutdown hook exactly once when the slot closes without a live session", async () => {
  let hooks = 0;
  const slot = new McpSessionSlot(
    createEchoServer(() => {
      hooks += 1;
    }),
    undefined,
  );
  await slot.close();
  await slot.close();
  expect(hooks).toBe(1);
  const { served, shutdownHooks } = await start();
  await served.close();
  expect(shutdownHooks()).toBe(1);
});

it("answers an oversized sessionless POST promptly instead of stalling on the probe", async () => {
  const { served } = await start();
  const { client } = await connect(served.url);
  const url = new URL(served.url);
  // The SDK refuses the body as soon as it exceeds the bound, so the upload may end in a broken pipe.
  await rawHttpRequest(url, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${url.port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"${"x".repeat(4_500_000)}"}}`,
  }).then(
    (refused) => {
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    },
    (cause: unknown) => {
      expect(["EPIPE", "ECONNRESET"]).toContain(
        (cause as { code?: string }).code,
      );
    },
  );
  expect(await echo(client, "still served")).toEqual([
    { type: "text", text: "still served" },
  ]);
  await client.close();
}, 20_000);
