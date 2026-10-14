import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { Radare2SessionManager } from "../radare2/Radare2SessionManager.js";
import { projectRadare2JsonOutput } from "../radare2/radare2CommandOutput.js";
import { evidenceSchema } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  runOwnedCleanupWithExternalMutationAdmission,
  runWithExternalMutationAdmission,
  type ExternalMutationAdmission,
} from "./externalMutationAdmission.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

const asObject = (
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};

export type Radare2SessionToolManager = Pick<
  Radare2SessionManager,
  "start" | "execute" | "status" | "close" | "retryCleanupFailures"
>;

/** Register persistent Radare2 analysis session operations on the REA MCP server. */
export const registerRadare2SessionTools = (
  server: McpServer,
  manager: Radare2SessionToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  session?: ExternalMutationAdmission,
): void => {
  const start = toolContract("start_radare2_session");
  const command = toolContract("radare2_command");
  const status = toolContract("radare2_session_status");
  const close = toolContract("close_radare2_session");
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        start.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, start.name, () =>
            manager.start({ path: input.path }, context.mcpReq.signal),
          ),
        undefined,
        () => manager.retryCleanupFailures(),
        (value) => ({ session_id: value.session_id }),
      );
      return result.ok
        ? delivery.toCallToolResult({ ok: true, value: result.value }, start)
        : delivery.toCallToolResult(result, start);
    },
  );
  server.registerTool(
    command.name,
    toolRegistrationOptions(command),
    async (input, context: ServerContext) => {
      const result = await runWithExternalMutationAdmission(
        session,
        command.name,
        context.mcpReq.signal,
        () =>
          logToolExecution(logger, command.name, () =>
            manager.execute(
              input.session_id,
              input.command,
              context.mcpReq.signal,
            ),
          ),
        (value) => value.evidence,
        () => manager.retryCleanupFailures(),
      );
      if (!result.ok) {
        const partial = evidenceSchema.safeParse(
          result.error.partialObservation,
        );
        if (partial.success) {
          const recorded = recordEvidence?.(partial.data);
          if (recorded !== undefined)
            return delivery.toRecordedPartialErrorToolResult(
              result.error,
              partial.data.evidence_id,
              recorded,
              command.returnsTargetContent,
            );
        }
        return delivery.toCallToolResult(result, command);
      }
      const projection = projectRadare2JsonOutput(result.value.result.output);
      const observed = result.value.result;
      const commandResult = {
        command: observed.command,
        output: observed.output,
        output_truncated: observed.output_truncated,
        ...(observed.output_invalid_utf8
          ? { output_invalid_utf8: true as const }
          : {}),
        completion_status: observed.completion_status,
        command_error: observed.command_error,
        command_code: observed.command_code,
        command_logs: observed.command_logs.map((log) => ({
          type: log.type,
          message: log.message,
          ...(log.origin === undefined ? {} : { origin: log.origin }),
        })),
        ...(projection === undefined ? {} : { parsed: projection.parsed }),
      };
      const evidence = result.value.evidence;
      return delivery.toEvidenceToolResult(
        {
          ...evidence,
          raw_result: { ...asObject(evidence.raw_result), ...commandResult },
          normalized_result: {
            ...asObject(evidence.normalized_result),
            ...commandResult,
          },
        },
        command,
        recordEvidence?.(evidence),
      );
    },
  );
  server.registerTool(
    status.name,
    toolRegistrationOptions(status),
    async (input) => {
      const result = manager.status(input.session_id);
      if (result === undefined)
        return delivery.toCallToolResult(
          { ok: false, error: new AnalysisInputError(status.name) },
          status,
        );
      return delivery.toCallToolResult(
        {
          ok: true,
          value: { ...result, recent_output: [...result.recent_output] },
        },
        status,
      );
    },
  );
  server.registerTool(
    close.name,
    toolRegistrationOptions(close),
    async (input, context: ServerContext) => {
      const result = await runOwnedCleanupWithExternalMutationAdmission(
        session,
        close.name,
        context.mcpReq.signal,
        input.session_id,
        () =>
          logToolExecution(logger, close.name, () =>
            manager.close(input.session_id),
          ),
      );
      return result.ok
        ? delivery.toCallToolResult({ ok: true, value: result.value }, close)
        : delivery.toCallToolResult(result, close);
    },
  );
};
