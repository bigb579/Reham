import type { WindowsNativeReadiness } from "./WindowsAuthority.js";
import { inspectWindowsNativeReadiness } from "./WindowsAuthority.js";

/**
 * Whether this host can launch an owned provider process at all. Windows routes
 * every owned launch through `WindowsOwnedProcess`, which requires the packaged
 * x64 native authority: a non-x64 Windows host, or one whose artifact is
 * missing or unproven, fails before the provider binary starts. Availability
 * that ignores this advertises a tool that can never run. Other platforms are
 * gated by their own documented prerequisites instead of this predicate.
 */
export const providerProcessOwnershipAvailable = (
  platform: NodeJS.Platform = process.platform,
  readiness: () => Pick<WindowsNativeReadiness, "available"> = () =>
    inspectWindowsNativeReadiness(platform),
): boolean => platform !== "win32" || readiness().available;
