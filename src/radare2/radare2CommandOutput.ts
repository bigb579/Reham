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

const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  aflj: ["name", "addr", "size"],
  izzj: ["string", "addr", "length"],
};

/**
 * Reduce a known listing command's parsed output to the fields agents
 * consume most. The full parsed value stays in `parsed`; this is an
 * additive token-saving view, never a replacement.
 */
export const projectRadare2Summary = (
  command: string,
  parsed: JsonValue,
): JsonValue[] | undefined => {
  const fields = SUMMARY_FIELDS[command.trim()];
  if (fields === undefined || !Array.isArray(parsed)) return undefined;
  return parsed.map((entry): JsonValue => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return entry;
    const source = entry as Record<string, unknown>;
    return Object.fromEntries(
      fields
        .filter((field) => source[field] !== undefined)
        .map((field) => [field, source[field] as JsonValue]),
    ) as { [key: string]: JsonValue };
  });
};

/**
 * Build the delivery-only evidence views (`parsed`, and `summary` for known
 * listings) from one command's effective output. These fields must be part
 * of the Evidence at construction time: evidence identifiers are
 * content-addressed, so attaching them later would invalidate the record.
 */
export const projectRadare2DeliveryViews = (
  command: string,
  output: string,
): {
  readonly parsed?: JsonValue;
  readonly summary?: ReadonlyArray<JsonValue>;
} => {
  const projection = projectRadare2JsonOutput(output);
  if (projection === undefined) return {};
  const summary = projectRadare2Summary(command, projection.parsed);
  return {
    parsed: projection.parsed,
    ...(summary === undefined ? {} : { summary }),
  };
};
