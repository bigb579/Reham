import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "../../process/DarwinProcessRunTokenReader.js";
import {
  resolveWakaruCommand,
  runWakaruCommand,
  WakaruPreparationCleanupFailure,
  type WakaruLauncher,
} from "./WakaruCommand.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

it("names the Wakaru configuration requirement when it is not configured", async () => {
  const refusal: unknown = await resolveWakaruCommand({}).catch(
    (cause: unknown) => cause,
  );

  if (!(refusal instanceof AnalysisCapabilityUnavailableError))
    throw new Error("Expected a capability refusal");
  expect(refusal.reason).toContain("REA_WAKARU_COMMAND");
  expect(projectAnalysisError(refusal)).toMatchObject({
    code: "capability_unavailable",
    message: refusal.reason,
    remediation: { action: refusal.reason },
  });
});

it("rejects an exhausted shared execution budget before launching the next command", async () => {
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() - 1,
      launcher: async () => {
        throw new Error("An expired budget must not launch");
      },
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisTimeoutError",
    operation: "recover_javascript_sources",
  });
});

it("preserves caller cancellation before acquiring an expired execution budget", async () => {
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() - 1,
      signal: AbortSignal.abort(),
      launcher: async () => {
        throw new Error("A cancelled request must not launch");
      },
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
});

const commandFixture = (
  emit: (producer: ReturnType<typeof createProducer>) => void,
) => {
  const producer = createProducer();
  const launcher: WakaruLauncher = async (options) => {
    setImmediate(() => emit(producer));
    return {
      process: producer,
      ownership: {
        runId: options.runId,
        leaderPid: 12345,
        processGroupId: 12345,
        expectedParentPid: process.pid,
      },
      cleanup: async () => ({ cleaned: true, signaled: false }),
    };
  };
  return {
    producer,
    context: {
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() + 5_000,
      launcher,
    },
  };
};

it("launches the command unwrapped when no limiter is configured", async () => {
  const { context } = commandFixture((producer) => {
    producer.stdout.write("wakaru 1.14.0\n");
    setImmediate(() => {
      producer.stdout.end();
      producer.stderr.end();
      producer.emit("close", 0, null);
    });
  });
  const launches: { command: string; arguments: readonly string[] }[] = [];
  const launch = context.launcher;
  if (launch === undefined) throw new Error("Expected a fixture launcher");

  await expect(
    runWakaruCommand({
      ...context,
      limiter: undefined,
      launcher: async (options) => {
        launches.push({
          command: options.command,
          arguments: options.arguments,
        });
        return launch(options);
      },
    }),
  ).resolves.toMatchObject({ exit_code: 0, resource_limiter: null });
  // No prlimit wrapper: the configured binary is the direct argv[0].
  expect(launches).toEqual([
    { command: "/selected/wakaru", arguments: ["--version"] },
  ]);
});

const createProducer = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });

it("retains stdout and stderr delivered after launcher exit", async () => {
  const { context } = commandFixture((producer) => {
    producer.stdout.write("first");
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stdout.end("last");
      producer.stderr.end("diagnostic");
      producer.emit("close", 0, null);
    });
  });
  await expect(runWakaruCommand(context)).resolves.toMatchObject({
    exit_code: 0,
    signal: null,
    stdout: "firstlast",
    stderr: "diagnostic",
  });
});

it("checks the diagnostic byte limit against output delivered after exit", async () => {
  const { context } = commandFixture((producer) => {
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stderr.end(Buffer.alloc(RECOVERY_LIMITS.reportBytes + 1, 97));
      producer.stdout.end();
      producer.emit("close", 0, null);
    });
  });
  await expect(runWakaruCommand(context)).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "recover_javascript_sources",
  });
});

it("enforces the shared deadline while exited output streams remain open", async () => {
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
  });
  try {
    await expect(
      runWakaruCommand({ ...context, deadline: performance.now() + 50 }),
    ).rejects.toMatchObject({
      _tag: "AnalysisTimeoutError",
      operation: "recover_javascript_sources",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("bounds a slow launch preparation by the shared deadline", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  await expect(
    runWakaruCommand({
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() + 50,
      launcher: async (options) => {
        seen.push(options.signal);
        const signal = options.signal;
        if (signal === undefined)
          throw new Error("A bounded launch must receive a signal");
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        throw new Error("An aborted preparation must not launch");
      },
    }),
  ).rejects.toMatchObject({
    _tag: "AnalysisTimeoutError",
    operation: "recover_javascript_sources",
  });
  // The launch is bounded by the deadline, not only by caller cancellation.
  expect(seen[0]?.aborted).toBe(true);
});

it("does not run a command whose launch consumed the shared deadline", async () => {
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
  });
  const launch = context.launcher;
  if (launch === undefined) throw new Error("Expected a fixture launcher");
  try {
    await expect(
      runWakaruCommand({
        ...context,
        deadline: performance.now() + 10,
        launcher: async (options) => {
          // A launcher that ignores the bounded signal still must not run.
          await new Promise((resolve) => setTimeout(resolve, 60));
          return launch(options);
        },
      }),
    ).rejects.toMatchObject({
      _tag: "AnalysisTimeoutError",
      operation: "recover_javascript_sources",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("honors cancellation while waiting for output after exit", async () => {
  const controller = new AbortController();
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
    setImmediate(() => controller.abort());
  });
  try {
    await expect(
      runWakaruCommand({ ...context, signal: controller.signal }),
    ).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("keeps helper cleanup ownership when launch preparation expires with a residual root", async () => {
  const helperRoot = "/tmp/rea-process-token-residual";
  const cleanupFailure = new ProviderCleanupError(
    "process-ownership",
    [helperRoot],
    {
      reason:
        "The Darwin ownership helper root remains owned until removal succeeds.",
    },
    { operation: "prepare_owned_process" },
  );
  let closed = 0;
  const close = async () => {
    closed += 1;
  };
  const preparation = new DarwinProcessOwnershipInspectionError(
    "Darwin process ownership helper preparation failed",
    { cleanupFailure, cleanupOwner: { close } },
  );
  const failure: unknown = await runWakaruCommand({
    command: "/selected/wakaru",
    limiter: "/usr/bin/prlimit",
    arguments: ["--version"],
    cwd: "/tmp/unused",
    environment: {},
    deadline: performance.now() + 10,
    launcher: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      throw preparation;
    },
  }).catch((cause: unknown) => cause);

  if (!(failure instanceof WakaruPreparationCleanupFailure))
    throw new Error("Expected preparation cleanup ownership to be retained");
  expect(failure.cleanupResources).toEqual([helperRoot]);
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.cleanupOwner.close).toBe(close);
  // The timeout stays the typed primary; cleanup uncertainty is what surfaces.
  expect(failure.cleanupPrimary).toBeInstanceOf(AnalysisTimeoutError);
  expect(projectAnalysisError(failure).code).toBe("cleanup_incomplete");
  expect(closed).toBe(0);
});

it("keeps helper cleanup ownership when cancellation races a residual root", async () => {
  const helperRoot = "/tmp/rea-process-token-residual";
  const cleanupFailure = new ProviderCleanupError(
    "process-ownership",
    [helperRoot],
    {
      reason:
        "The Darwin ownership helper root remains owned until removal succeeds.",
    },
    { operation: "prepare_owned_process" },
  );
  let closed = 0;
  const close = async () => {
    closed += 1;
  };
  const preparation = new DarwinProcessOwnershipInspectionError(
    "Darwin process ownership helper preparation was cancelled",
    { cleanupFailure, cleanupOwner: { close } },
  );
  const controller = new AbortController();
  const failure: unknown = await runWakaruCommand({
    command: "/selected/wakaru",
    limiter: "/usr/bin/prlimit",
    arguments: ["--version"],
    cwd: "/tmp/unused",
    environment: {},
    deadline: performance.now() + 60_000,
    signal: controller.signal,
    launcher: async () => {
      controller.abort();
      throw preparation;
    },
  }).catch((cause: unknown) => cause);

  if (!(failure instanceof WakaruPreparationCleanupFailure))
    throw new Error("Expected preparation cleanup ownership to be retained");
  // Cancellation must not report a clean exit while the helper root remains.
  expect(failure.cleanupResources).toEqual([helperRoot]);
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.cleanupOwner.close).toBe(close);
  expect(failure.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(closed).toBe(0);
});
