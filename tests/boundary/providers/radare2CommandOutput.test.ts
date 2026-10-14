import { describe, expect, it } from "vitest";

import { projectRadare2JsonOutput } from "../../../src/radare2/radare2CommandOutput.js";

describe("projectRadare2JsonOutput", () => {
  it("projects valid JSON objects", () => {
    expect(projectRadare2JsonOutput('{"functions":[{"name":"main"}]}')).toEqual(
      { parsed: { functions: [{ name: "main" }] } },
    );
  });

  it("projects arrays and bare scalars", () => {
    expect(projectRadare2JsonOutput("[1,2,3]")).toEqual({
      parsed: [1, 2, 3],
    });
    expect(projectRadare2JsonOutput("42\n")).toEqual({ parsed: 42 });
  });

  it("returns undefined for invalid JSON, prose, and empty output", () => {
    expect(projectRadare2JsonOutput("not json")).toBeUndefined();
    expect(projectRadare2JsonOutput("{unterminated")).toBeUndefined();
    expect(projectRadare2JsonOutput("")).toBeUndefined();
    expect(projectRadare2JsonOutput("   \n  ")).toBeUndefined();
  });
});
