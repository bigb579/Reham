import { resolve } from "node:path";

import type { Radare2Input } from "../domain/reverseEngineering.js";

export const RADARE2_PROVIDER_IDENTITY = {
  id: "radare2",
  name: "Radare2",
  version: null,
} as const;

/** Build a one-shot radare2 command while retaining plugin availability. */
export const radare2Command = (input: Radare2Input): readonly string[] => [
  "-N",
  "-q",
  "-e",
  "scr.color=0",
  "-c",
  input.command,
  resolve(input.path),
];
