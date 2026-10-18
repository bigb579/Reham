import type { JavaScriptRecoveryPort } from "../application/javascript/JavaScriptRecoveryPort.js";
import { WakaruProvider } from "../javascript/recovery/WakaruProvider.js";
import type {
  WakaruLauncher,
  WakaruWarning,
} from "../javascript/recovery/WakaruCommand.js";

/** Construct optional recovery without acquiring tools, processes or workspaces. */
export const createJavaScriptRecoveryProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: WakaruLauncher,
  warning?: WakaruWarning,
): JavaScriptRecoveryPort => new WakaruProvider(environment, launcher, warning);
