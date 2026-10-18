import { expect, it } from "vitest";
import {
  RECOVERY_LIMITATIONS,
  recoveryLimitationsFor,
  wakaruHost,
} from "../../../src/javascript/recovery/WakaruRelease.js";

it("keeps every shared caveat on every host", () => {
  for (const host of [
    wakaruHost("linux", "x64"),
    wakaruHost("linux", "arm64"),
    wakaruHost("darwin", "arm64"),
  ]) {
    const limitations = recoveryLimitationsFor(host);
    expect(limitations).toHaveLength(RECOVERY_LIMITATIONS.length + 1);
    for (const caveat of RECOVERY_LIMITATIONS)
      expect(limitations).toContain(caveat);
  }
});

it("advertises the ceiling where the limiter can enforce it", () => {
  const limits = recoveryLimitationsFor(wakaruHost("linux", "x64")).at(-1);
  expect(limits).toContain("linux-x64 (verified adapter)");
  expect(limits).toContain("1 GiB address-space ceiling");
  expect(limits).not.toContain("NOT enforced");
});

it("still advertises the ceiling on an unverified Linux host", () => {
  const limits = recoveryLimitationsFor(wakaruHost("linux", "arm64")).at(-1);
  expect(limits).toContain("linux-arm64 (unverified host)");
  expect(limits).toContain("1 GiB address-space ceiling");
  expect(limits).not.toContain("NOT enforced");
});

it("reports the ceiling as unknown where only a caller wrapper exists", () => {
  const limits = recoveryLimitationsFor(wakaruHost("darwin", "arm64")).at(-1);
  expect(limits).toContain("darwin-arm64 (unverified host)");
  expect(limits).toContain("UNKNOWN");
  expect(limits).toContain("util-linux --as");
  // A wrapper may map --as, so neither "enforced" nor a flat denial is honest.
  expect(limits).not.toContain("1 GiB address-space ceiling,");
});

it("reports an absent limiter as an unenforced ceiling, not an unknown one", () => {
  const limits = recoveryLimitationsFor(
    wakaruHost("darwin", "arm64", "absent"),
  ).at(-1);
  expect(limits).toContain("darwin-arm64 (unverified host)");
  expect(limits).toContain("no address-space ceiling is applied");
  expect(limits).toContain("REA_JAVASCRIPT_PRLIMIT_COMMAND");
  expect(limits).not.toContain("UNKNOWN");
  // The in-process rails survive the missing limiter and must stay disclosed.
  expect(limits).toContain("120-second deadline");
});

it("keeps the verified label when a verified host has no limiter", () => {
  const limits = recoveryLimitationsFor(
    wakaruHost("linux", "x64", "absent"),
  ).at(-1);
  expect(limits).toContain("linux-x64 (verified adapter)");
  expect(limits).toContain("no address-space ceiling is applied");
  expect(limits).not.toContain("UNKNOWN");
  expect(limits).toContain("120-second deadline");
});

it("marks only linux x64 as verified and only Linux as --as known", () => {
  expect(wakaruHost("linux", "x64")).toMatchObject({
    verified: true,
    addressSpaceLimit: "enforced",
  });
  expect(wakaruHost("linux", "arm64")).toMatchObject({
    verified: false,
    addressSpaceLimit: "enforced",
  });
  expect(wakaruHost("darwin", "arm64")).toMatchObject({
    verified: false,
    addressSpaceLimit: "unknown",
  });
  expect(wakaruHost("darwin", "arm64", "absent")).toMatchObject({
    verified: false,
    addressSpaceLimit: "unenforced",
  });
  expect(wakaruHost("linux", "x64", "absent")).toMatchObject({
    verified: true,
    addressSpaceLimit: "unenforced",
  });
});
