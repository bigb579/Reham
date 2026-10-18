import { describe, expect, it } from "vitest";

import { finishAnalysisCommand } from "./cli/finishAnalysisCommand.js";

describe("finishAnalysisCommand", () => {
  it("returns a cancelled result when the signal aborts during cleanup completion", async () => {
    const controller = new AbortController();

    const output = await finishAnalysisCommand(
      async () => ({
        ok: true,
        value: {
          operation: "identify_flutter_build",
          artifact: { path: "/fixture.apk" },
        },
      }),
      {
        close: async () => {
          controller.abort();
        },
      },
      "flutter",
      "identify_flutter_build",
      undefined,
      controller.signal,
    );

    expect(output).toMatchObject({
      code: "cancelled",
      details: {
        partial_observation: {
          operation: "identify_flutter_build",
        },
      },
    });
  });
});
