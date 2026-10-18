import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execution = vi.hoisted(() => ({ failure: undefined as unknown }));

vi.mock(
  "../../../src/javascript/recovery/WakaruCommand.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/javascript/recovery/WakaruCommand.js")
      >();
    return {
      ...actual,
      resolveWakaruCommand: async () => ({
        command: "/unused/wakaru",
        limiter: "/unused/prlimit",
        sha256: "a".repeat(64),
        bytes: 1,
      }),
    };
  },
);

vi.mock(
  "../../../src/javascript/recovery/WakaruExecution.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/javascript/recovery/WakaruExecution.js")
      >();
    return {
      ...actual,
      prepareWakaruExecution: async () => {
        throw execution.failure;
      },
    };
  },
);

import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { WakaruCleanupFailure } from "../../../src/javascript/recovery/WakaruCommand.js";
import { WakaruProvider } from "../../../src/javascript/recovery/WakaruProvider.js";
import type { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";

it("reveals the interrupted timeout after an incomplete process stop is retried", async () => {
  const root = await createTestTempDirectory("rea-wakaru-process-");
  const sourcePath = join(root, "source.js");
  const output = join(root, "output");
  await writeFile(sourcePath, "module.exports = 42;");
  // The supervisor that could not stop its process keeps the ownership facts
  // and succeeds on the retry issued by close().
  const supervisor = {
    launch: { ownership: { runId: "wakaru-run" } },
    stop: async () => ({ status: "verified-cleanup" as const }),
  } as unknown as ProviderProcessSupervisor;
  execution.failure = new WakaruCleanupFailure(
    supervisor,
    "wakaru-run",
    root,
    "The owned process group could not be proven stopped.",
    new AnalysisTimeoutError("recover_javascript_sources", 120_000),
    { exitCode: null, signal: null } as unknown as ReturnType<
      ProviderProcessSupervisor["snapshot"]
    >,
  );
  const provider = new WakaruProvider({});
  try {
    const result = await provider.recover({
      path: sourcePath,
      output_directory: output,
      extraction_mode: "structural",
      rewrite_level: "standard",
    });
    if (result.ok) throw new Error("Expected process cleanup failure");
    expect(result.error).toBeInstanceOf(ProviderCleanupError);
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    expect(result.error.cleanupResources).toContain("wakaru-run");
    // The wrapper's cause is the interrupted timeout: releasing the retained
    // resources must reveal it rather than a generic execution failure.
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(result.error).code).toBe("provider_timeout");
    expect(result.error.cleanupResources).toStrictEqual([]);
  } finally {
    execution.failure = undefined;
    await provider.close().catch(() => undefined);
  }
});
