import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 10_000;
/** r2pipe2 replies (`{"cmd":…}`) ship with radare2 5.9. */
const R2PIPE2_FLOOR = { major: 5, minor: 9 };

/** @internal Pure parser kept separately testable from process execution. */
export const parseRadare2Version = (output: string): string | null => {
  const match = /\bradare2\s+(\d+)\.(\d+)\.(\d+)/u.exec(output);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
};

interface VersionOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly stdout?: string;
}

/** Inspect the BYO radare2 executable for `rea doctor` without installing it. */
export const inspectRadare2Provider = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    /** @internal Test seam; production callers run the real executable. */
    readonly runVersion?: (command: string) => Promise<VersionOutcome>;
  } = {},
): Promise<DoctorProviderInspection> => {
  const command = environment.REA_R2_COMMAND ?? "radare2";
  const runVersion =
    options.runVersion ??
    (async (selected: string) => {
      try {
        const { stdout } = await execFileAsync(selected, ["-version"], {
          timeout: VERSION_TIMEOUT_MS,
          env: { ...environment },
        });
        return { ok: true, stdout };
      } catch (cause) {
        return {
          ok: false,
          code: (cause as NodeJS.ErrnoException).code ?? "runtime_failure",
        };
      }
    });
  const outcome = await runVersion(command);
  if (!outcome.ok) {
    const missing = outcome.code === "ENOENT";
    const check: DoctorProviderCheck = {
      name: "radare2-executable",
      ok: false,
      code: outcome.code ?? null,
      detail: `Unable to run ${command} -version.`,
      remediation: missing
        ? `Install radare2 (or point REA_R2_COMMAND at your executable); REA never installs it. Session tools additionally need radare2 >= ${R2PIPE2_FLOOR.major}.${R2PIPE2_FLOOR.minor}.`
        : `Inspect why ${command} -version fails, then rerun rea doctor.`,
      classification: missing ? "missing_dependency" : "runtime_failure",
    };
    return {
      id: "radare2",
      configured: environment.REA_R2_COMMAND !== undefined,
      available: false,
      providerVersion: null,
      registrationEnvironment: {},
      checks: [check],
    };
  }
  const version = parseRadare2Version(outcome.stdout ?? "");
  const floorFailure =
    version === null
      ? "The version output was not recognized; provider version remains unknown."
      : satisfiesR2Pipe2(version)
        ? null
        : `radare2 ${version} predates the r2pipe2 protocol (>= ${R2PIPE2_FLOOR.major}.${R2PIPE2_FLOOR.minor}); session tools are unavailable, one-shot commands still work.`;
  return {
    id: "radare2",
    configured: environment.REA_R2_COMMAND !== undefined,
    available: true,
    providerVersion: version,
    registrationEnvironment: {},
    checks:
      floorFailure === null
        ? []
        : [
            {
              name: "radare2-r2pipe2",
              ok: false,
              code: "version_below_r2pipe2_floor",
              detail: floorFailure,
              remediation: `Upgrade radare2 to ${R2PIPE2_FLOOR.major}.${R2PIPE2_FLOOR.minor} or newer to use start_radare2_session and radare2_command.`,
              classification: "config_drift" as const,
            },
          ],
  };
};

const satisfiesR2Pipe2 = (version: string): boolean => {
  const [major, minor] = version.split(".").map(Number);
  if (major === undefined || minor === undefined) return false;
  if (major !== R2PIPE2_FLOOR.major) return major > R2PIPE2_FLOOR.major;
  return minor >= R2PIPE2_FLOOR.minor;
};
