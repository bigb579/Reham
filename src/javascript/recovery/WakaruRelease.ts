/** Unchanged upstream source pin; executed bytes are identified separately. */
export const WAKARU_RELEASE = {
  version: "1.14.0",
  revision: "8219bf5016a063d7fb215101a8c45d5959ec733f",
  repository: "https://github.com/pionxzh/wakaru",
} as const;

/**
 * Releases the report parser accepts. Wakaru changes `--version`, `--json`
 * and `provenance.json` only by addition within a major version
 * (https://github.com/pionxzh/wakaru/blob/v1.14.0/docs/cli.md#machine-readable-output-compatibility);
 * 1.13.0 is the first release this adapter verified.
 */
export const WAKARU_ACCEPTED_RANGE = "^1.13.0";

/** Catalog identity for the verified Wakaru release. Evidence replaces version with the observed banner. */
export const WAKARU_PROVIDER_IDENTITY = {
  id: "wakaru",
  name: "Wakaru",
  version: WAKARU_RELEASE.version,
} as const;

/** Per-operation resource bounds for the verified Linux adapter. */
export const RECOVERY_LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 128 * 1024 * 1024,
  outputEntries: 10000,
  reportBytes: 8 * 1024 * 1024,
  addressSpaceBytes: 1024 * 1024 * 1024,
  timeoutMs: 120000,
} as const;

/** The only host whose adapter behaviour is fully verified; every other host runs unverified. */
export const WAKARU_VERIFIED_HOST = { platform: "linux", arch: "x64" } as const;

/**
 * What is known about the address-space ceiling:
 * - `enforced`: the default Linux limiter (`/usr/bin/prlimit`) maps `--as`.
 * - `unknown`: a caller-supplied limiter exists but may not map `--as`.
 * - `unenforced`: no limiter is configured, so no address-space ceiling is applied.
 */
export type WakaruAddressSpaceLimit = "enforced" | "unknown" | "unenforced";

/** Host identity carried through resolution so results can disclose verification state. */
export type WakaruHost = {
  platform: string;
  arch: string;
  /** Adapter behaviour fully verified for this platform/arch pair. */
  verified: boolean;
  addressSpaceLimit: WakaruAddressSpaceLimit;
};

export const wakaruHost = (
  platform: string = process.platform,
  arch: string = process.arch,
  limiter: "configured" | "absent" = "configured",
): WakaruHost => ({
  platform,
  arch,
  verified:
    platform === WAKARU_VERIFIED_HOST.platform &&
    arch === WAKARU_VERIFIED_HOST.arch,
  addressSpaceLimit:
    limiter === "absent"
      ? "unenforced"
      : platform === "linux"
        ? "enforced"
        : "unknown",
});

/** Public limitations for transformations and extraction provenance. */
export const RECOVERY_LIMITATIONS = [
  "Recovered sources are derived artifacts; original variable names and runtime equivalence are not established.",
  "Extraction ranges refer to half-open UTF-8 byte offsets in the original input, not rewritten line positions or whole-bundle coverage.",
  "Emitted source maps are preserved as reported by the engine; their mapping accuracy is not independently established.",
  "Inspection mode may produce non-executable regions. No input or recovered application code is executed.",
] as const;

/** Rails the supervisor and the adapter enforce without any external limiter. */
const IN_PROCESS_LIMITS =
  "One worker, 120-second deadline, 64 MiB total input, 128 MiB output, 10000 output entries and 8 MiB per diagnostic/report stream";

/**
 * Resource disclosure. The 1 GiB address-space ceiling only exists where a
 * limiter can express util-linux `--as`; elsewhere it is dropped or unknown and
 * the result must say so rather than advertise a ceiling that is not enforced.
 */
export const recoveryLimitationsFor = (host: WakaruHost): readonly string[] => {
  // The host label tracks verification, not the limiter state: a fully verified
  // Linux host can land in the unenforced branch when util-linux is missing.
  const label = `${host.platform}-${host.arch} (${host.verified ? "verified adapter" : "unverified host"})`;
  const containment =
    "Resource limits are per operation, not aggregate host containment.";
  return [
    ...RECOVERY_LIMITATIONS,
    host.addressSpaceLimit === "enforced"
      ? `${label}: one worker, 1 GiB address-space ceiling, 120-second deadline, 64 MiB total input, 128 MiB output, 10000 output entries and 8 MiB per diagnostic/report stream. ${containment}`
      : host.addressSpaceLimit === "unknown"
        ? `${label}: the 1 GiB address-space ceiling is UNKNOWN — util-linux --as is mapped only by the default /usr/bin/prlimit, so a caller-supplied limiter may or may not enforce it. ${IN_PROCESS_LIMITS} still apply. ${containment}`
        : `${label}: no usable resource limiter was found, so no address-space ceiling is applied and the limiter-only rails (address space, file size, core dumps, cpu time) are absent; REA_JAVASCRIPT_PRLIMIT_COMMAND can name a prlimit-compatible wrapper to restore them. ${IN_PROCESS_LIMITS} still apply. ${containment}`,
  ];
};
