import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { Radare2SessionManager } from "../../../src/radare2/Radare2SessionManager.js";
import type {
  ProviderProcessHandle,
  SpawnedOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";

interface InjectedControl {
  output(chunk: Buffer | string): void;
  stderr(chunk: Buffer | string): void;
  exit(code: number | null, signal?: NodeJS.Signals): void;
}

const createInjectedProcess = (
  options: {
    readonly startup?: (control: InjectedControl) => void;
    readonly onWrite?: (text: string, control: InjectedControl) => void;
  } = {},
) => {
  const written: string[] = [];
  const createProcess = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const handle = new EventEmitter() as EventEmitter &
      ProviderProcessHandle & {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
    const control: InjectedControl = {
      output: (chunk) => {
        stdout.write(chunk);
      },
      stderr: (chunk) => {
        stderr.write(chunk);
      },
      exit: (code, signal) => {
        handle.exitCode = code;
        handle.signalCode = signal ?? null;
        handle.emit("exit", code, signal);
      },
    };
    Object.assign(handle, {
      pid: 4242,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        if (handle.exitCode !== null) return false;
        handle.exitCode = null;
        handle.signalCode = "SIGTERM";
        queueMicrotask(() => handle.emit("exit", null, "SIGTERM"));
        return true;
      }),
      stdin: new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
          const text = chunk.toString("utf8");
          written.push(text);
          options.onWrite?.(text, control);
          callback();
        },
      }),
    });
    return { handle, control };
  };
  const first = createProcess();
  let issued = false;
  const spawnProcess = vi.fn(async () => {
    const spawned = issued ? createProcess() : first;
    issued = true;
    options.startup?.(spawned.control);
    return {
      process: spawned.handle,
      ownership: {} as SpawnedOwnedProviderProcess["ownership"],
      cleanup: async () =>
        ({ cleaned: true as const, signaled: false }) as const,
    };
  });
  return { spawnProcess, control: first.control, written };
};

const jsonResponder =
  (res: string, extra: Record<string, unknown> = {}) =>
  (text: string, control: InjectedControl): void => {
    const lines = text.split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      let parsed: { cmd?: unknown };
      try {
        parsed = JSON.parse(line) as { cmd?: unknown };
      } catch {
        continue;
      }
      if (typeof parsed.cmd !== "string") continue;
      control.output(
        `${JSON.stringify({ res, error: false, value: 0, code: 0, ...extra })}\0`,
      );
    }
  };

describe("Radare2SessionManager lifecycle", () => {
  it("starts a session after the first NUL frame and echoes the spawn profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-start-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const manager = new Radare2SessionManager(
      { REA_R2_COMMAND: "/selected/r2" },
      { spawnProcess },
    );

    try {
      const result = await manager.start({ path: artifact });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.session_id).toEqual(expect.any(String));
      expect(spawnProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/selected/r2",
          arguments: ["-N", "-q", "-e", "scr.color=0", "-0", artifact],
          stdin: "pipe",
        }),
      );
      control.exit(0);
      await manager.closeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes a command over the r2pipe2 protocol and maps the reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-exec-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: jsonResponder('{"functions":[]}'),
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    try {
      const started = await manager.start({ path: artifact });
      if (!started.ok) throw started.error;
      const executed = await manager.execute(started.value.session_id, "aflj");
      expect(executed.ok).toBe(true);
      if (!executed.ok) return;
      expect(executed.value.result.command).toBe("aflj");
      expect(executed.value.result.output).toBe('{"functions":[]}');
      expect(executed.value.result.command_error).toBe(false);
      expect(executed.value.result.command_code).toBe(0);
      expect(executed.value.result.command_logs).toEqual([]);
      expect(executed.value.result.completion_status).toBe("complete");
      expect(executed.value.evidence.provider.id).toBe("radare2.session");
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves plugin failure logs from an error-free reply", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: jsonResponder("", {
        logs: [
          {
            type: "WARN",
            origin: "r2ghidra",
            message: "Ghidra Decompiler Error: No function at this offset",
          },
        ],
      }),
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(
      started.value.session_id,
      "pdg @ main",
    );
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.result.output).toBe("");
    expect(executed.value.result.command_error).toBe(false);
    expect(executed.value.result.command_logs).toEqual([
      {
        type: "WARN",
        origin: "r2ghidra",
        message: "Ghidra Decompiler Error: No function at this offset",
      },
    ]);
  });
});

describe("Radare2SessionManager command handling", () => {
  it("rejects multiline commands before writing to stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-lines-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess, written } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });

    try {
      const started = await manager.start({ path: artifact });
      if (!started.ok) throw started.error;
      const executed = await manager.execute(
        started.value.session_id,
        "aflj\nq",
      );
      expect(executed.ok).toBe(false);
      if (!executed.ok) expect(executed.error._tag).toBe("AnalysisInputError");
      expect(written).toEqual([]);
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("times out a command whose reply never arrives and stops the session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-timeout-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
      onWrite: () => {
        // No reply frame: the r2pipe2 answer never arrives.
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 50 },
    );

    try {
      const started = await manager.start({ path: artifact });
      if (!started.ok) throw started.error;
      const executed = await manager.execute(started.value.session_id, "aaa");
      expect(executed.ok).toBe(false);
      if (!executed.ok) {
        expect(executed.error._tag).toBe("AnalysisTimeoutError");
        expect(
          JSON.stringify(executed.error.partialObservation ?? {}),
        ).toContain('"radare2.session"');
      }
      expect(manager.status(started.value.session_id)).toBeUndefined();
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects the ninth concurrent session with a capacity error", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = [];
    for (let index = 0; index < 8; index += 1)
      started.push(await manager.start({ path: `/tmp/f${index}` }));
    expect(started.every((result) => result.ok)).toBe(true);
    const ninth = await manager.start({ path: "/tmp/f8" });
    expect(ninth.ok).toBe(false);
    if (!ninth.ok)
      expect(ninth.error._tag).toBe("AnalysisResourceConstraintError");
  });

  it("surfaces bounded session stderr in status diagnostics", async () => {
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    control.stderr("WARN: ABI mismatch from plugin\n");
    const status = manager.status(started.value.session_id);
    expect(status?.recent_stderr).toContain("WARN: ABI mismatch");
    control.exit(0);
    await manager.close(started.value.session_id);
  });

  it("closes a session and removes it from the manager", async () => {
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    control.exit(0);
    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });

  it("retains a session whose stop cannot be verified and frees it on retry", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    let stopOutcome:
      | { status: "incomplete"; reason: string }
      | { status: "verified-cleanup" } = {
      status: "incomplete",
      reason: "injected uncertainty",
    };
    const manager = new Radare2SessionManager(
      {},
      {
        spawnProcess,
        stopProcess: async () => stopOutcome,
      },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const failed = await manager.close(started.value.session_id);
    expect(failed.ok).toBe(false);
    expect(manager.status(started.value.session_id)).toBeDefined();
    stopOutcome = { status: "verified-cleanup" };
    const retried = await manager.retryCleanupFailures();
    expect(retried.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });
});

describe("Radare2SessionManager r2pipe2 protocol failures", () => {
  it("stops the session when a r2pipe2 reply is not JSON", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        commandControl.output("not json\0");
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(started.value.session_id, "aflj");
    expect(executed.ok).toBe(false);
    if (!executed.ok)
      expect(executed.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(manager.status(started.value.session_id)).toBeUndefined();
    await manager.closeAll();
  });
});
