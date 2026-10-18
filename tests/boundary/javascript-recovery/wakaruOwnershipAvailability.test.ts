import { expect, it } from "vitest";
import { providerProcessOwnershipAvailable } from "../../../src/process/ProviderProcessOwnership.js";

const readiness =
  (available: boolean) => (): { readonly available: boolean } => ({
    available,
  });

it("requires the Windows native authority before owned launches", () => {
  expect(providerProcessOwnershipAvailable("win32", readiness(true))).toBe(
    true,
  );
  expect(providerProcessOwnershipAvailable("win32", readiness(false))).toBe(
    false,
  );
});

it("does not consult the Windows authority elsewhere", () => {
  const unreachable = (): never => {
    throw new Error("the Windows native authority is not applicable here");
  };
  for (const platform of ["linux", "darwin", "freebsd"] as const)
    expect(providerProcessOwnershipAvailable(platform, unreachable)).toBe(true);
});
