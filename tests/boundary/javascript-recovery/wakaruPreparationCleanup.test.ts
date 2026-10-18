import { writeFile } from "node:fs/promises";
import type { PathLike, RmOptions } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const preparation = vi.hoisted(() => ({ failure: undefined as unknown }));

const fsControl = vi.hoisted(() => ({
  workspaceRoots: [] as string[],
  failRootRemoval: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const created = await actual.mkdtemp(prefix);
      fsControl.workspaceRoots.push(created);
      return created;
    },
    rm: async (path: PathLike, options?: RmOptions): Promise<void> => {
      if (
        fsControl.failRootRemoval > 0 &&
        fsControl.workspaceRoots.at(-1) === String(path)
      ) {
        fsControl.failRootRemoval -= 1;
        throw new Error("injected workspace removal failure");
      }
      return actual.rm(path, options);
    },
  };
});

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
        throw preparation.failure;
      },
    };
  },
);

import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { WakaruPreparationCleanupFailure } from "../../../src/javascript/recovery/WakaruCommand.js";
import { WakaruProvider } from "../../../src/javascript/recovery/WakaruProvider.js";
import { DarwinProcessOwnershipInspectionError } from "../../../src/process/DarwinProcessRunTokenReader.js";

it.skipIf(process.platform === "win32")(
  "retains a failed preparation's helper root until close retries it",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-preparation-");
    const sourcePath = join(root, "source.js");
    const output = join(root, "output");
    await writeFile(sourcePath, "module.exports = 42;");
    const helperRoot = join(root, "rea-process-token-residual");
    let removable = false;
    let attempts = 0;
    const cleanupFailure = new ProviderCleanupError(
      "process-ownership",
      [helperRoot],
      {
        reason:
          "The Darwin ownership helper root remains owned until removal succeeds.",
      },
      { operation: "prepare_owned_process" },
    );
    const cleanupOwner = {
      close: async () => {
        attempts += 1;
        if (!removable) throw cleanupFailure;
        cleanupFailure.resolveCleanup();
      },
    };
    preparation.failure = new WakaruPreparationCleanupFailure(
      cleanupOwner,
      new DarwinProcessOwnershipInspectionError(
        "Darwin process ownership helper preparation failed",
        { cleanupFailure, cleanupOwner },
      ),
      new AnalysisTimeoutError("recover_javascript_sources", 120_000),
    );
    const provider = new WakaruProvider({});
    try {
      const result = await provider.recover({
        path: sourcePath,
        output_directory: output,
        extraction_mode: "structural",
        rewrite_level: "standard",
      });
      if (result.ok) throw new Error("Expected preparation cleanup failure");
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      expect(result.error.cleanupResources).toContain(helperRoot);
      // A close that cannot remove the helper root must not report success.
      const retryFailure = await provider.close().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(retryFailure).toBeInstanceOf(ProviderCleanupError);
      if (!(retryFailure instanceof ProviderCleanupError))
        throw new Error("Expected retry cleanup failure");
      expect(projectAnalysisError(retryFailure).code).toBe(
        "cleanup_incomplete",
      );
      expect(retryFailure.cleanupResources).toContain(helperRoot);
      expect(attempts).toBe(1);
      removable = true;
      await provider.close();
      expect(attempts).toBe(2);
      // A confirmed retry must reveal the retained primary, not stale cleanup,
      // on both the original failure and the failure returned by the retry.
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error).code).toBe("provider_timeout");
      expect(retryFailure.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(retryFailure).code).toBe("provider_timeout");
      expect(retryFailure.cleanupResources).toStrictEqual([]);
    } finally {
      preparation.failure = undefined;
      await provider.close().catch(() => undefined);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a mixed retry error live until the workspace is released",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-mixed-");
    const sourcePath = join(root, "source.js");
    const output = join(root, "output");
    await writeFile(sourcePath, "module.exports = 42;");
    const helperRoot = join(root, "rea-process-token-residual");
    let removable = false;
    const cleanupFailure = new ProviderCleanupError(
      "process-ownership",
      [helperRoot],
      {
        reason:
          "The Darwin ownership helper root remains owned until removal succeeds.",
      },
      { operation: "prepare_owned_process" },
    );
    const cleanupOwner = {
      close: async () => {
        if (!removable) throw cleanupFailure;
        cleanupFailure.resolveCleanup();
      },
    };
    preparation.failure = new WakaruPreparationCleanupFailure(
      cleanupOwner,
      new DarwinProcessOwnershipInspectionError(
        "Darwin process ownership helper preparation failed",
        { cleanupFailure, cleanupOwner },
      ),
      new AnalysisTimeoutError("recover_javascript_sources", 120_000),
    );
    const provider = new WakaruProvider({});
    try {
      // Fail the workspace removal on the first attempt and on the retry that
      // follows the helper root's release, so both owners stay live at once.
      fsControl.failRootRemoval = 2;
      const result = await provider.recover({
        path: sourcePath,
        output_directory: output,
        extraction_mode: "structural",
        rewrite_level: "standard",
      });
      if (result.ok) throw new Error("Expected preparation cleanup failure");
      const workspaceRoot = fsControl.workspaceRoots.at(-1);
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      expect(result.error.cleanupResources).toContain(helperRoot);
      expect(result.error.cleanupResources).toContain(workspaceRoot);
      const retryFailure = await provider.close().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      if (!(retryFailure instanceof ProviderCleanupError))
        throw new Error("Expected retry cleanup failure");
      // The retry error covers the whole retained set, not only the helper.
      expect(retryFailure.cleanupResources).toContain(workspaceRoot);
      removable = true;
      const releasedHelper = await provider.close().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      if (!(releasedHelper instanceof ProviderCleanupError))
        throw new Error("Expected retry cleanup failure");
      // The helper root is released now, so this retry must attribute only the
      // workspace it still owns.
      expect(releasedHelper.cleanupResources).toContain(workspaceRoot);
      expect(releasedHelper.cleanupResources).not.toContain(helperRoot);
      // Releasing the helper root alone must not resolve an error that still
      // owns the workspace.
      expect(retryFailure.cleanupIncomplete).toBe(true);
      expect(projectAnalysisError(retryFailure).code).toBe(
        "cleanup_incomplete",
      );
      await provider.close();
      expect(retryFailure.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(retryFailure).code).toBe("provider_timeout");
      expect(retryFailure.cleanupResources).toStrictEqual([]);
      // The retry that failed on the workspace keeps the same primary.
      expect(releasedHelper.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(releasedHelper).code).toBe(
        "provider_timeout",
      );
    } finally {
      fsControl.failRootRemoval = 0;
      preparation.failure = undefined;
      await provider.close().catch(() => undefined);
    }
  },
);
