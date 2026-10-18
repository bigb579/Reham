import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaScriptRecoveryPort } from "../../application/javascript/JavaScriptRecoveryPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  javascriptRecoveryResultSchema,
  type JavaScriptRecoveryInput,
} from "../../domain/javascript/javascriptRecovery.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  checkRecoveryCancellation,
  checkRecoveryDeadline,
  recoveryFailureMessage,
  recoveryInputFailure,
  snapshotRecoveryInputs,
} from "./RecoveryFiles.js";
import {
  resolveWakaruCommand,
  type WakaruLauncher,
  type WakaruWarning,
  WakaruCleanupFailure,
  WakaruPreparationCleanupFailure,
} from "./WakaruCommand.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import { prepareWakaruExecution } from "./WakaruExecution.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";

/** Cleanup work a failed recovery still owns and retries through `close()`. */
interface RetainedWakaruCleanup {
  root: string | undefined;
  process: ProviderProcessSupervisor | undefined;
  tree: SafeOutputTree | undefined;
  /** Failed launch preparation still owning its helper root. */
  preparation: WakaruPreparationCleanupFailure | undefined;
  /** Caller-facing cleanup error resolved once this work completes. */
  failure: ProviderCleanupError | undefined;
}

/** Resources this retained state still owns; released children drop out. */
const retainedResources = (
  pending: RetainedWakaruCleanup,
): readonly string[] => [
  ...(pending.preparation?.cleanupResources ?? []),
  ...(pending.process === undefined
    ? []
    : [pending.process.launch.ownership?.runId ?? "wakaru-worker"]),
  ...(pending.tree === undefined ? [] : [pending.tree.outputRoot]),
  ...(pending.root === undefined ? [] : [pending.root]),
];

/** Serialized recovery adapter retaining failed process, workspace and publication cleanup. */
export class WakaruProvider implements JavaScriptRecoveryPort {
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup: RetainedWakaruCleanup | undefined;

  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: WakaruLauncher,
    /** Destination for host-capability warnings; absent means silence. */
    readonly warning?: WakaruWarning,
  ) {}

  /** Recover selected scripts using validated reports and verified output bytes. */
  recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(
          new ProviderCleanupError(
            "wakaru",
            [],
            { reason: "Provider is closing" },
            { operation: OPERATION },
          ),
        ),
      );
    const operation = this.#tail.then(() =>
      this.#closing
        ? err(
            new ProviderCleanupError(
              "wakaru",
              [],
              { reason: "Provider is closing" },
              { operation: OPERATION },
            ),
          )
        : this.#recover(input, options),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    let root: string | undefined;
    let tree: SafeOutputTree | undefined;
    let failed: { readonly cause: unknown } | undefined;
    let execution: AnalysisExecution | undefined;
    const deadline = performance.now() + RECOVERY_LIMITS.timeoutMs;
    try {
      checkRecoveryCancellation(options?.signal);
      const engine = await resolveWakaruCommand(this.environment, {
        ...(this.warning === undefined ? {} : { warn: this.warning }),
      });
      root = await mkdtemp(join(tmpdir(), "rea-wakaru-"));
      const inputs = join(root, "inputs");
      const staging = join(root, "modules");
      await mkdir(inputs, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const sources = await snapshotRecoveryInputs(
        [input.path, ...(input.additional_paths ?? [])],
        inputs,
        options?.signal,
      );
      try {
        tree = await SafeOutputTree.create(input.output_directory);
      } catch (cause: unknown) {
        if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
        throw recoveryInputFailure(
          "output_directory",
          `Cannot create new recovery directory ${input.output_directory}: ${recoveryFailureMessage(cause)}`,
          cause,
        );
      }
      execution = await prepareWakaruExecution({
        root,
        tree,
        input,
        sources,
        engine,
        environment: this.environment,
        launcher: this.launcher,
        options,
        deadline,
      });
      checkRecoveryDeadline(deadline, options?.signal);
      await rm(root, { recursive: true, force: true });
      root = undefined;
      checkRecoveryDeadline(deadline, options?.signal);
      await tree.commit(options?.signal);
    } catch (cause: unknown) {
      failed = { cause };
    }
    if (failed !== undefined) {
      const failure =
        failed.cause instanceof ArtifactReaderFailure &&
        failed.cause.reason === "cancelled"
          ? new AnalysisCancelledError(OPERATION, { cause: failed.cause })
          : failed.cause;
      const residuals: string[] = [];
      const cleanupFailures: { resource: string; reason: string }[] = [];
      const cleanupOwner =
        failure instanceof WakaruCleanupFailure
          ? failure.cleanupOwner
          : undefined;
      const preparation =
        failure instanceof WakaruPreparationCleanupFailure
          ? failure
          : undefined;
      if (preparation !== undefined)
        for (const resource of preparation.cleanupResources)
          if (!residuals.includes(resource)) residuals.push(resource);
      let failedTree: SafeOutputTree | undefined;
      try {
        await tree?.rollback();
      } catch (cause: unknown) {
        if (tree !== undefined) {
          failedTree = tree;
          residuals.push(tree.outputRoot);
          cleanupFailures.push({
            resource: tree.outputRoot,
            reason: recoveryFailureMessage(cause),
          });
        }
      }
      if (cleanupOwner !== undefined)
        residuals.push(cleanupOwner.launch.ownership?.runId ?? "wakaru-worker");
      if (root !== undefined && cleanupOwner === undefined) {
        const failedRoot = root;
        try {
          await rm(failedRoot, { recursive: true, force: true });
          root = undefined;
        } catch (cause: unknown) {
          residuals.push(failedRoot);
          cleanupFailures.push({
            resource: failedRoot,
            reason: recoveryFailureMessage(cause),
          });
        }
      }
      const pending =
        cleanupOwner !== undefined ||
        preparation !== undefined ||
        failedTree !== undefined ||
        root !== undefined
          ? {
              root,
              process: cleanupOwner,
              tree: failedTree,
              preparation,
              failure: undefined as ProviderCleanupError | undefined,
            }
          : undefined;
      if (pending !== undefined) {
        this.#pendingCleanup = pending;
        if (root !== undefined) residuals.push(root);
        root = undefined;
      }
      if (residuals.length > 0) {
        // Confirmed cleanup must reveal the typed primary for ordinary
        // workspace failures too, not only failures that already retained one.
        const cleanupPrimary =
          failure instanceof AnalysisError
            ? (failure.cleanupPrimary ??
              (failure.cleanupIncomplete
                ? // A cleanup wrapper keeps the typed failure it interrupted as
                  // its cause; releasing the resources must reveal that
                  // primary, not a generic execution failure.
                  failure.cause instanceof AnalysisError &&
                  !failure.cause.cleanupIncomplete
                  ? failure.cause
                  : undefined
                : failure))
            : undefined;
        const cleanupFailure = new ProviderCleanupError(
          "wakaru",
          residuals,
          {
            ...(failure instanceof WakaruCleanupFailure
              ? failure.diagnostics
              : {}),
            previous_error:
              failure instanceof WakaruCleanupFailure
                ? (failure.diagnostics?.previous_error ?? null)
                : recoveryFailureMessage(failure),
            cleanup_failures: cleanupFailures,
          },
          {
            operation: OPERATION,
            cause: failure,
            ...(cleanupPrimary === undefined ? {} : { cleanupPrimary }),
            ...(tree?.published && execution !== undefined
              ? {
                  partialObservation: {
                    kind: "javascript-recovery" as const,
                    result: javascriptRecoveryResultSchema.parse(
                      execution.result,
                    ),
                  },
                }
              : {}),
          },
        );
        if (pending !== undefined)
          // Attribution follows the live retained children: a path released by
          // a later retry must stop appearing in the caller-facing resources.
          pending.failure = cleanupFailure.bindCleanupResourceOwner({
            get cleanupResources() {
              return retainedResources(pending);
            },
          });
        return err(cleanupFailure);
      }
      if (tree?.published === true && execution !== undefined)
        return ok(execution);
      return err(
        failure instanceof AnalysisError
          ? failure
          : new ProviderAdapterError("wakaru", OPERATION, {
              cause: failure,
              diagnostics: { reason: recoveryFailureMessage(failure) },
            }),
      );
    }
    return execution === undefined
      ? err(
          new AnalysisOutputError(OPERATION, "Recovery returned no execution"),
        )
      : ok(execution);
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        const failure = await this.#retire();
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  async #retire(): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    // A retry error stays live until the whole retained set is released: one
    // child's success must not resolve an error covering mixed cleanup.
    const retained = (
      failure: ProviderCleanupError,
      dependencies: readonly AnalysisError[] = [],
    ): ProviderCleanupError =>
      failure.bindCleanupDependencies([
        ...dependencies,
        ...(pending.failure === undefined ? [] : [pending.failure]),
      ]);
    // A retry error replaces the retained aggregate's cleanup failure, so it
    // keeps that aggregate's typed primary for its own eventual resolution.
    const primary = pending.failure?.cleanupPrimary;
    const primaryOption =
      primary === undefined ? {} : { cleanupPrimary: primary };
    if (pending.preparation !== undefined) {
      const preparation = pending.preparation;
      try {
        await preparation.cleanupOwner.close();
      } catch (cause: unknown) {
        // The helper root is still owned; report it instead of a clean close.
        void cause;
      }
      if (preparation.preparation.cleanupFailure?.cleanupIncomplete === true) {
        // This retry still owns the helper root: resolve it with the owner's
        // next success instead of leaving a released path reported as live.
        const retryFailure = new ProviderCleanupError(
          "wakaru",
          [...preparation.cleanupResources],
          {
            reason: recoveryFailureMessage(
              preparation.preparation.cleanupFailure,
            ),
          },
          {
            operation: OPERATION,
            cause: preparation,
            ...(preparation.cleanupPrimary === undefined
              ? {}
              : { cleanupPrimary: preparation.cleanupPrimary }),
          },
        );
        return retained(retryFailure, [preparation]);
      }
      preparation.resolveCleanup();
      pending.preparation = undefined;
    }
    if (pending.process !== undefined) {
      const stopped = await pending.process.stop();
      if (stopped.status === "incomplete")
        return retained(
          new ProviderCleanupError(
            "wakaru",
            [
              pending.process.launch.ownership?.runId ?? "wakaru-worker",
              ...(pending.root === undefined ? [] : [pending.root]),
            ],
            { reason: stopped.reason },
            { operation: OPERATION, ...primaryOption },
          ),
        );
      pending.process = undefined;
    }
    if (pending.tree !== undefined) {
      const tree = pending.tree;
      try {
        await tree.rollback();
        pending.tree = undefined;
      } catch (cause: unknown) {
        return retained(
          new ProviderCleanupError(
            "wakaru",
            [tree.outputRoot],
            { reason: recoveryFailureMessage(cause) },
            { operation: OPERATION, cause, ...primaryOption },
          ),
        );
      }
    }
    if (pending.root !== undefined) {
      const root = pending.root;
      try {
        await rm(root, { recursive: true, force: true });
        pending.root = undefined;
      } catch (cause: unknown) {
        return retained(
          new ProviderCleanupError(
            "wakaru",
            [root],
            { reason: recoveryFailureMessage(cause) },
            { operation: OPERATION, cause, ...primaryOption },
          ),
        );
      }
    }
    this.#pendingCleanup = undefined;
    // Every retained resource confirmed release; reveal the reported primary.
    pending.failure?.resolveCleanup();
    return undefined;
  }
}
