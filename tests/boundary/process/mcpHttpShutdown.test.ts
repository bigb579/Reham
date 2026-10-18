import { once } from "node:events";
import { describe, expect } from "vitest";

import { MCP_SHUTDOWN_FAILED } from "../../../src/main/messages.js";
import { rawHttpRequest } from "../../support/http/rawRequest.js";
import { startMcpHttpProcess } from "../../support/mcp/streamableHttpProcess.js";
import { processTest } from "../../support/process/processFixture.js";

const SHUTDOWN_TIMEOUT_MS = 90_000;

const shutdownSignals: readonly (readonly [NodeJS.Signals, number])[] =
  process.platform === "win32"
    ? [["SIGINT", 130]]
    : [
        ["SIGTERM", 143],
        ["SIGINT", 130],
      ];

describe("rea mcp --http shutdown", () => {
  for (const [signal, status] of shutdownSignals)
    processTest(
      `releases the listener and exits ${String(status)} on ${signal}`,
      async ({ processes }) => {
        const started = await startMcpHttpProcess(processes);
        // The live transport refuses a GET that does not accept an event stream.
        const before = await rawHttpRequest(started.url);
        expect(before.status).toBe(406);
        started.child.kill(signal);
        const [code, signalCode] = await once(started.child, "close");
        expect(code).toBe(status);
        expect(signalCode).toBeNull();
        expect(started.stderr()).not.toContain(MCP_SHUTDOWN_FAILED);
        await expect(rawHttpRequest(started.url)).rejects.toMatchObject({
          code: "ECONNREFUSED",
        });
      },
      SHUTDOWN_TIMEOUT_MS,
    );
});
