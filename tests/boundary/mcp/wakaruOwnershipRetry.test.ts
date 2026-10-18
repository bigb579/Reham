import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

/**
 * The Windows native authority clears a retryable self-test failure on its next
 * query, so a transient failure observed while the server is built must not keep
 * JavaScript recovery hidden for the rest of the process.
 */
const ownership = vi.hoisted(() => ({ available: false }));

vi.mock("../../../src/process/ProviderProcessOwnership.js", () => ({
  providerProcessOwnershipAvailable: () => ownership.available,
}));

it("re-reads process-ownership readiness on every availability query", async () => {
  const session = createTestBinarySession(createCacheProvider([]));
  const server = createServer(
    { kind: "session", session },
    {
      environment: { REA_WAKARU_COMMAND: "/opt/wakaru/bin/wakaru" },
      logger: silentLogger,
    },
  );
  const client = new Client({ name: "wakaru-ownership-retry", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const readRecovery = async () => {
    const reply = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    const result = toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
    return expandToolAvailability(result.tool_availability).find(
      (tool) => tool.name === "recover_javascript_sources",
    );
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(await readRecovery()).toMatchObject({
      available: false,
      reason: "provider_missing",
    });
    ownership.available = true;
    expect(await readRecovery()).toMatchObject({
      available: true,
      reason: "available",
    });
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
