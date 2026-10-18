import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

const candidateSources = {
  "escaped.mjs": `const box = {};
  box.prototype = Map.prototype;
  function patch(b) { b.prototype.get = fetch; }
  patch(box); new Map().get("/escaped");`,
  "returned.mjs": 'patch((() => Map.prototype)()); new Map().get("/returned");',
  "opaque.mjs": 'eval("Map.prototype.get = fetch"); new Map().get("/opaque");',
  "private.mjs":
    'const box = {}; box.prototype = Map.prototype; new Map().get("/private");',
  "returned-write.mjs":
    'const prototype = (() => Map.prototype)(); prototype.get = fetch; new Map().get("/returned-write");',
  "prototype.mjs":
    'Object.getPrototypeOf(new Map()).get = fetch; new Map().get("/prototype");',
  "indirect.mjs":
    'globalThis.eval("Map.prototype.get = fetch"); new Map().get("/indirect");',
  "late-link.mjs":
    'function store() { box.child.prototype = Map.prototype; } const box = {}; const inner = {}; box.child = inner; store(); patch(inner); new Map().get("/late-link");',
  "constructor.mjs":
    'new Map().constructor.prototype.get = fetch; new Map().get("/constructor");',
  "getter.mjs":
    'const holder = { get prototype() { return Map.prototype; } }; holder.prototype.get = fetch; new Map().get("/getter");',
  "assignment.mjs":
    'let run; (run = eval)("Map.prototype.get = fetch"); new Map().get("/assignment");',
  "logical-assignment.mjs":
    'let run; (run ??= eval)("Map.prototype.get = fetch"); new Map().get("/logical-assignment");',
  "method.mjs":
    'const box = { prototype() { return Map.prototype; } }; patch(box); new Map().get("/method");',
  "stored-eval.mjs":
    'const box = {}; box.run = eval; box.run("Map.prototype.get = fetch"); new Map().get("/stored-eval");',
  "generated.mjs":
    'Function("Map.prototype.get = fetch")(); new Map().get("/generated");',
  "generated-constructor.mjs":
    'const Run = Function("Map.prototype.get = fetch"); Reflect.construct(Run, []); new Map().get("/generated-constructor");',
  "generated-constructor-unused.mjs":
    'Reflect.construct(Function, ["Map.prototype.get = fetch"]); new Map().get("/generated-constructor-unused");',
  "awaited-generated.mjs":
    'const run = await Function("Map.prototype.get = fetch"); run(); new Map().get("/awaited-generated");',
  "escaped-class.mjs":
    'patch(class { static expose() { return Map.prototype; } }); new Map().get("/escaped-class");',
  "escaped-generated.mjs":
    'consume(Function("Map.prototype.get = fetch")); new Map().get("/escaped-generated");',
  "mixed-callable.mjs":
    'function inspect(consume, condition) { const Target = condition ? Function : consume; Target(Function("Map.prototype.get = fetch")); new Map().get("/mixed-callable"); } inspect(run => run(), false);',
  "inherited-factory.mjs":
    'Function.constructor("Map.prototype.get = fetch")(); new Map().get("/inherited-factory");',
  "inherited-factory-unused.mjs":
    'Function.constructor("Map.prototype.get = fetch"); new Map().get("/inherited-factory-unused");',
  "bound-eval.mjs":
    'function consume(run) { run(); } const run = eval.bind(null, "Map.prototype.get = fetch"); consume(run); new Map().get("/bound-eval");',
  "generated-superclass.mjs":
    'class Run extends Function("Map.prototype.get = fetch") {} new Run(); new Map().get("/generated-superclass");',
  "generated-class-call.mjs":
    'class Run extends Function("Map.prototype.get = fetch") {} Run.call(null); new Map().get("/generated-class-call");',
  "frozen-generated.mjs":
    'Object.freeze(Function("Map.prototype.get = fetch")); new Map().get("/frozen-generated");',
  "frozen-generated-executed.mjs":
    'const run = Object.freeze(Function("Map.prototype.get = fetch")); run(); new Map().get("/frozen-generated-executed");',
  "dynamic-apply.mjs":
    'const callbacks = [Function("Map.prototype.get = fetch")]; Reflect.apply(consume, null, callbacks); new Map().get("/dynamic-apply");',
  "factory-coercion.mjs":
    'const source = { toString: Function("Map.prototype.get = fetch; return 1") }; Function(source); new Map().get("/factory-coercion");',
  "bound-factory-coercion.mjs":
    'const source = { toString: Function("Map.prototype.get = fetch; return 1") }; const Make = Function.bind(null, source); Reflect.construct(Make, []); new Map().get("/bound-factory-coercion");',
  "arrow-superclass.mjs":
    'class Run extends Function("Map.prototype.get = fetch") { constructor() { (() => super())(); } } new Run(); new Map().get("/arrow-superclass");',
  "awaited-thenable.mjs":
    'await { then: Function("resolve", "Map.prototype.get = fetch; resolve()") }; new Map().get("/awaited-thenable");',
  "spread-constructor.mjs":
    'const callbacks = [Function("Map.prototype.get = fetch")]; Reflect.construct(function Run(fn) { fn(); }, [...callbacks]); new Map().get("/spread-constructor");',
  "mixed-destination.mjs":
    'function expose(external) { const box = condition ? {} : external; box.p = Map.prototype; } expose(holder); patch(holder); new Map().get("/mixed-destination");',
};

const candidateEndpoints = [
  "/api/items",
  "/arrow-superclass",
  "/assignment",
  "/awaited-generated",
  "/awaited-thenable",
  "/bound-eval",
  "/bound-factory-coercion",
  "/constructor",
  "/dynamic-apply",
  "/escaped",
  "/escaped-class",
  "/escaped-generated",
  "/factory-coercion",
  "/frozen-generated-executed",
  "/generated",
  "/generated-constructor",
  "/generated-superclass",
  "/getter",
  "/indirect",
  "/inherited-factory",
  "/late-link",
  "/logical-assignment",
  "/method",
  "/mixed-callable",
  "/mixed-destination",
  "/opaque",
  "/prototype",
  "/returned",
  "/returned-write",
  "/spread-constructor",
  "/stored-eval",
];

it("reports a candidate endpoint through the worker boundary in the public CLI", async () => {
  const root = await createTestTempDirectory("rea-endpoint-candidate-cli-");
  // Retain ambiguous requests while excluding type-erased collection/config reads.
  await writeFile(
    join(root, "main.ts"),
    `
    import * as vscode from "vscode";
    client.post("session");
    (client.get as any)("/api/items");
    const records = new Map([["/accounts", { name: "Alice" }]]);
    console.log(records.get("/accounts"));
    function inspect() {
      const records = new Map();
      const alias = records;
      return alias.get("/local-accounts");
    }
    fetch("/network");
    (new Headers().get as any)("content-type");
    (new URLSearchParams() as any).delete("q");
    ((vscode.workspace.getConfiguration("editor") as any).get as any)("tabSize");
    (context.globalState.get as any)("lastSession");
    const browser = window as Window;
    (browser.open as any)(method, "browser-context");
    const database = indexedDB as IDBFactory;
    (database.open as any)("fixture-db", "2");
    const cache = caches as CacheStorage;
    (cache.open as any)("fixture-cache");
  `,
  );
  for (const [name, source] of Object.entries(candidateSources))
    await writeFile(join(root, name), source);
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  expect
    .soft(
      result.graph.nodes
        .filter(({ kind }) => kind === "endpoint")
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties.value),
        )
        .sort(),
    )
    .toEqual([
      "/api/items",
      "/arrow-superclass",
      "/assignment",
      "/awaited-generated",
      "/awaited-thenable",
      "/bound-eval",
      "/bound-factory-coercion",
      "/constructor",
      "/dynamic-apply",
      "/escaped",
      "/escaped-class",
      "/escaped-generated",
      "/factory-coercion",
      "/frozen-generated-executed",
      "/generated",
      "/generated-constructor",
      "/generated-superclass",
      "/getter",
      "/indirect",
      "/inherited-factory",
      "/late-link",
      "/logical-assignment",
      "/method",
      "/mixed-callable",
      "/mixed-destination",
      "/network",
      "/opaque",
      "/prototype",
      "/returned",
      "/returned-write",
      "/spread-constructor",
      "/stored-eval",
      "session",
    ]);
  for (const value of candidateEndpoints) {
    const escaped = result.graph.nodes.find(
      ({ kind, observations }) =>
        kind === "endpoint" &&
        observations.some(({ properties }) => properties.value === value),
    );
    expect(escaped?.observations[0]).toMatchObject({
      properties: { interpretation: "candidate" },
      evidence: { state: "inferred", confidence: "low" },
    });
  }
  const request = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "endpoint" &&
      observations.some(({ properties }) => properties.value === "/network"),
  );
  expect(request?.observations[0]?.evidence).toMatchObject({
    state: "observed",
    confidence: "exact",
  });
  expect(
    result.graph.nodes
      .filter(({ kind }) => kind === "storage")
      .flatMap(({ observations }) =>
        observations.map(
          ({ properties }) =>
            `${String(properties.storage_kind)}:${String(properties.name)}`,
        ),
      )
      .sort(),
  ).toEqual(["cache-storage:fixture-cache", "indexed-db:fixture-db"]);
  const endpoint = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "endpoint" &&
      observations.some(({ properties }) => properties.value === "session"),
  );
  expect(endpoint?.observations[0]).toMatchObject({
    properties: {
      endpoint_kind: "network",
      value: "session",
      mechanism: "call:client.post",
      interpretation: "candidate",
    },
    evidence: { state: "inferred", confidence: "low" },
  });
  const edge = result.graph.edges.find(
    ({ target_node_id }) => target_node_id === endpoint?.node_id,
  );
  expect(edge?.properties).toMatchObject({ interpretation: "candidate" });
}, 20_000);

it("preserves SQLite constructor certainty through the public worker and graph", async () => {
  const root = await createTestTempDirectory("rea-storage-candidate-cli-");
  await writeFile(
    join(root, "main.mjs"),
    `
    import Known from "better-sqlite3";
    class Database { constructor(name) { this.name = name; } }
    new Database("local");
    function uncertain(Database) { return new Database("shared"); }
    { const Database = Known; new Database("shared"); }
  `,
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  const storage = result.graph.nodes.filter((node) => node.kind === "storage");
  expect(storage).toHaveLength(2);
  const candidate = storage.find(
    (node) => node.observations[0]?.properties.interpretation === "candidate",
  );
  const observed = storage.find(
    (node) => node.observations[0]?.properties.interpretation === undefined,
  );
  expect(candidate?.node_id).not.toBe(observed?.node_id);
  expect(candidate?.observations[0]).toMatchObject({
    properties: { storage_kind: "sqlite", name: "shared" },
    evidence: {
      state: "inferred",
      confidence: "low",
      limitations: expect.arrayContaining([
        expect.stringContaining("only a candidate"),
      ]),
    },
  });
  expect(observed?.observations[0]).toMatchObject({
    properties: { storage_kind: "sqlite", name: "shared" },
    evidence: { state: "observed", confidence: "exact" },
  });
  expect(
    result.graph.edges.find(
      (edge) => edge.target_node_id === candidate?.node_id,
    ),
  ).toMatchObject({
    properties: { interpretation: "candidate" },
    evidence: {
      confidence: "low",
      limitations: expect.arrayContaining([
        expect.stringContaining("only a candidate"),
      ]),
    },
  });
}, 20_000);
