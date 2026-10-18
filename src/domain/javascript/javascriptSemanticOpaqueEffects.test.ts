import { describe, expect, it } from "vitest";

import { semanticAmbientWriteMayMatch } from "./javascriptSemanticOpaqueEffects.js";
import { SemanticPropertyPathCoverage } from "./javascriptSemanticPropertyPaths.js";
import type { JavaScriptSemanticMemberEffect } from "./javascriptSemanticState.js";

const factsFor = (paths: JavaScriptSemanticMemberEffect["path"][]) => ({
  ambientWrites: new SemanticPropertyPathCoverage(),
  ambientWriteEffects: paths.map((path) => ({ path, node: undefined })),
  complete: true,
});

describe("shared ambient mutation candidates", () => {
  it("preserves exact, selected, wildcard, and short prefixes", () => {
    const paths: JavaScriptSemanticMemberEffect["path"][] = [
      [],
      [null],
      ["callable-value"],
      ["callable-value", "first", "call"],
      ["callable-value", "other", "call"],
      ["callable-value", null, "call"],
      ["callable-value", { excludedKeys: ["other"] }, "call"],
      [{ excludedKeys: ["global"] }, "first", "call"],
      ["callable-value", "first", "call", "extra"],
      ["global", "first", "call"],
    ];
    const facts = factsFor(paths);
    const selected: number[] = [];
    expect(
      semanticAmbientWriteMayMatch(
        facts,
        ["callable-value", "first", "call"],
        (effect) => {
          selected.push(paths.indexOf(effect.path));
          return false;
        },
      ),
    ).toBe(false);
    expect(selected.sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3, 5, 6, 7,
    ]);
    expect(
      semanticAmbientWriteMayMatch(
        factsFor([["global", 12, "call"]]),
        ["global", "12", "call"],
        () => true,
      ),
    ).toBe(true);
  });

  it("includes effects appended after an earlier query", () => {
    const facts = factsFor([]);
    const path = ["callable-value", "first", "call"];
    expect(semanticAmbientWriteMayMatch(facts, path, () => true)).toBe(false);
    facts.ambientWriteEffects.push({ path, node: undefined });
    expect(semanticAmbientWriteMayMatch(facts, path, () => true)).toBe(true);
    facts.ambientWriteEffects.push({ path: [null], node: undefined });
    expect(
      semanticAmbientWriteMayMatch(facts, ["global", "other"], () => true),
    ).toBe(true);
  });

  it("keeps snapshots separate and preserves the caller's effect proof", () => {
    const path = ["callable-value", "first", "call"];
    const written = factsFor([path]);
    expect(semanticAmbientWriteMayMatch(written, path, () => false)).toBe(
      false,
    );
    expect(semanticAmbientWriteMayMatch(written, path, () => true)).toBe(true);
    expect(semanticAmbientWriteMayMatch(factsFor([]), path, () => true)).toBe(
      false,
    );
  });
});
