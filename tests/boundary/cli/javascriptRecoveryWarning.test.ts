import { afterEach, expect, it, vi } from "vitest";

import { reportMissingLimiterWarning } from "../../../src/cli/javascriptRecoveryCommands.js";

afterEach(() => vi.restoreAllMocks());

it("reports a missing limiter on stderr, where no log level can hide it", () => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const message =
    "darwin-arm64 (unverified host): no usable resource limiter was found, so no address-space ceiling is applied";

  reportMissingLimiterWarning({ platform: "darwin", arch: "arm64", message });

  // The CLI logger is silent by default and results own stdout: only stderr is left.
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledTimes(1);
  const line = stderr.mock.calls[0]?.[0];
  expect(typeof line).toBe("string");
  expect(String(line).endsWith("\n")).toBe(true);
  expect(JSON.parse(String(line))).toEqual({
    rea_warning: {
      code: "javascript_recovery_limiter_absent",
      platform: "darwin",
      arch: "arm64",
      environment_variable: "REA_JAVASCRIPT_PRLIMIT_COMMAND",
      message,
    },
  });
});
