import type { JsonValue } from "../domain/jsonValue.js";

/**
 * Parse trimmed command output as JSON for a lenient projection.
 *
 * The raw output stays authoritative; this returns `undefined` whenever the
 * output is not valid JSON (empty output, prose, or a command without a `j`
 * suffix) so callers can fall back to the raw text.
 */
export const projectRadare2JsonOutput = (
  output: string,
): { readonly parsed: JsonValue } | undefined => {
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return { parsed: JSON.parse(trimmed) as JsonValue };
  } catch {
    return undefined;
  }
};
