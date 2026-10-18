import { z } from "incur";
import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import { createJavaScriptRecoveryProvider } from "../composition/javascriptRecovery.js";
import type { WakaruWarning } from "../javascript/recovery/WakaruCommand.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/**
 * The CLI logger defaults to `silent`, so a safety diagnostic routed through it
 * would never reach a user whose recovery ran without its resource rails.
 * Report on stderr as a `rea_warning` JSON line instead: always visible, and
 * never mixed into the Evidence result on stdout.
 */
export const reportMissingLimiterWarning: WakaruWarning = (event) => {
  process.stderr.write(
    `${JSON.stringify({
      rea_warning: {
        code: "javascript_recovery_limiter_absent",
        platform: event.platform,
        arch: event.arch,
        environment_variable: "REA_JAVASCRIPT_PRLIMIT_COMMAND",
        message: event.message,
      },
    })}\n`,
  );
};

/** Share source recovery with MCP while keeping CLI spelling at this boundary. */
export const registerJavaScriptRecoveryCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new JavaScriptRecoveryService(
    createJavaScriptRecoveryProvider(
      environment,
      undefined,
      reportMissingLimiterWarning,
    ),
  );
  cli.command(CLI_COMMANDS.recoverJavaScriptSources, {
    description:
      "Recover readable JavaScript modules with source provenance and verified files",
    args: z.object({
      path: z
        .string()
        .describe("Absolute UTF-8 JavaScript input; never executed"),
      outputDirectory: z.string().describe("Absolute absent output directory"),
    }),
    options: z.object({
      additionalPath: z
        .array(z.string())
        .optional()
        .describe(
          "Related absolute UTF-8 JavaScript file; repeat for multiple chunks",
        ),
      extractionMode: z
        .enum(["structural", "heuristic", "inspection"])
        .optional()
        .describe(
          "Structural boundaries, heuristic fallback, or inspection-only regions",
        ),
      rewriteLevel: z
        .enum(["minimal", "standard", "aggressive"])
        .optional()
        .describe(
          "Upstream syntax recovery level; runtime equivalence remains unknown",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.recoverJavaScriptSources, () =>
          finishAnalysisCommand(
            () =>
              service.recover(
                {
                  path: args.path,
                  output_directory: args.outputDirectory,
                  ...(options.additionalPath === undefined
                    ? {}
                    : { additional_paths: options.additionalPath }),
                  ...(options.extractionMode === undefined
                    ? {}
                    : { extraction_mode: options.extractionMode }),
                  ...(options.rewriteLevel === undefined
                    ? {}
                    : { rewrite_level: options.rewriteLevel }),
                },
                { signal },
              ),
            service,
            "wakaru",
            "recover_javascript_sources",
            signal,
          ),
        ),
      ),
  });
};
