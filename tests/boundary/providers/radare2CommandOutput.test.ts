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

describe("projectRadare2Summary", () => {
  it("reduces aflj entries to name, addr, and size", async () => {
    const { projectRadare2Summary } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    const parsed = [
      {
        name: "main",
        addr: 4294984340,
        size: 16,
        signature: "int main(int argc, char **argv)",
        nbbs: 12,
      },
    ];
    expect(projectRadare2Summary("aflj", parsed)).toEqual([
      { name: "main", addr: 4294984340, size: 16 },
    ]);
  });

  it("reduces izzj entries to string, addr, and length", async () => {
    const { projectRadare2Summary } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    expect(
      projectRadare2Summary("izzj", [
        { addr: 4096, string: "/lib/ld.so", length: 10, section: ".rodata" },
      ]),
    ).toEqual([{ addr: 4096, string: "/lib/ld.so", length: 10 }]);
  });

  it("returns undefined for other commands and non-array output", async () => {
    const { projectRadare2Summary } =
      await import("../../../src/radare2/radare2CommandOutput.js");
    expect(projectRadare2Summary("pdg @ main", { code: 1 })).toBeUndefined();
    expect(projectRadare2Summary("aflj", { not: "array" })).toBeUndefined();
  });
});
