import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it.each([
  'const callbacks = [Function("Map.prototype.get=fetch")]; Reflect.construct(function Run(fn) { fn(); }, [...callbacks]);',
  'const callbacks = [Function("Map.prototype.get=fetch")]; const nested = [...callbacks]; Reflect.construct(Run, [...nested]);',
  'const callbacks = [Function("Map.prototype.get=fetch")]; Reflect.construct(Run, [...unknown, ...callbacks]);',
  'const callbacks = Object.freeze([Function("Map.prototype.get=fetch")]); Reflect.construct(Run, [...callbacks]);',
  'const source = { toString: Function("Map.prototype.get=fetch;return 0") }; const args = [source]; Reflect.construct(Function, [...args]);',
  'const callbacks = [Function("Map.prototype.get=fetch")]; const values = [...unknown, ...callbacks]; consume(values[1]);',
  'const values = [...unknown, Function("Map.prototype.get=fetch")]; consume(values[0]);',
  "const values = [...unknown, {}]; values[0].prototype = Map.prototype;",
  "const values = [{}, ...unknown]; values[1].prototype = Map.prototype;",
])(
  "retains selected capabilities through array spread carriers: %s",
  (prefix) => {
    expect(
      analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
        .endpoints,
    ).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  'const callbacks = [Function("Map.prototype.get=fetch")]; const values = [...callbacks];',
  'const callbacks = [Function("Map.prototype.get=fetch")]; const values = [{}, ...callbacks]; consume(values[0]);',
  'const callbacks = [Function("Map.prototype.get=fetch")]; const values = [, ...callbacks]; consume(values[0]);',
  "const values = [{}, ...unknown]; values[0].prototype = Map.prototype;",
  'const callbacks = [Function("Map.prototype.get=fetch")]; Reflect.construct(Function, [...callbacks]);',
  'const callbacks = [Function("Map.prototype.get=fetch")]; Reflect.construct(Function, [], callbacks[0]);',
  'const args = [{ unused: Function("Map.prototype.get=fetch"), toString() { return ""; } }]; Reflect.construct(Function, [...args]);',
])("preserves unrelated and inert spread-array selections: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

it.each([
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { (() => super())(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = () => super(); const alias = start; alias(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = () => super(); const outer = () => start(); outer(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { (() => (() => super())())(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = () => super(); start.call(null); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = () => super(); start.apply(null, []); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = () => super(); Reflect.apply(start, null, []); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = Object.freeze(() => super()); start(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const first = () => second(); const second = () => { first(); super(); }; first(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { consume(() => super()); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const box = {}; box.run = () => super(); consume(box); } } new Run();',
  'await { then: Function("resolve", "Map.prototype.get=fetch; resolve()") };',
  'const thenable = { then: Function("resolve", "Map.prototype.get=fetch; resolve()") }; const alias = thenable; await alias;',
  'const thenable = {}; thenable.then = Function("resolve", "Map.prototype.get=fetch; resolve()"); await thenable;',
  'const thenable = { then: Function("resolve", "Map.prototype.get=fetch; resolve()").bind(null) }; await thenable;',
])(
  "retains implicit execution of selected source-local hooks: %s",
  (prefix) => {
    expect(
      analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
        .endpoints,
    ).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const start = () => super(); const unused = () => start(); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { (() => super())(); } }',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { (() => { const unused = () => super(); })(); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const first = () => second(); const second = () => { first(); super(); }; return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { let start = () => super(); start = () => {}; start(); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { Object.freeze(() => super()); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { (() => super()).bind(null); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const unused = () => consume(() => super()); return {}; } } new Run();',
  'const thenable = { then: Function("resolve", "Map.prototype.get=fetch; resolve()") };',
  'await Function("Map.prototype.get=fetch");',
  'await { then(resolve) { resolve(); }, unused: Function("Map.prototype.get=fetch") };',
  'new Map().get("/before"); await { then: Function("resolve", "Map.prototype.get=fetch; resolve()") };',
])("keeps unused hooks and pre-effect reads separate: %s", (prefix) => {
  const source = prefix.startsWith("new Map")
    ? prefix
    : `${prefix} new Map().get('/accounts');`;
  expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
});

it.each([
  'const run = Object.freeze(Function("Map.prototype.get=fetch")); run();',
  'const freeze = Object.freeze; const run = freeze(Function("Map.prototype.get=fetch")); run();',
  'const freeze = Object.freeze; Object.freeze = other; const run = freeze(Function("Map.prototype.get=fetch")); run();',
  'function inspect(consume, condition) { const freeze = condition ? Object.freeze : consume; const run = freeze(Function("Map.prototype.get=fetch")); run(); } inspect(run => run, false);',
  'const freeze = Object.freeze.bind(null); const run = freeze(Function("Map.prototype.get=fetch")); run();',
  'const run = Reflect.apply(Object.freeze, null, [Function("Map.prototype.get=fetch")]); run();',
  'const box = Object.freeze({ run: Function("Map.prototype.get=fetch") }); box.run();',
  "const box = Object.freeze({ prototype: Map.prototype }); patch(box);",
  "const box = Object.freeze({ prototype: Map.prototype }); box.prototype.get = fetch;",
  'const Run = Object.freeze(class extends Function("Map.prototype.get=fetch") {}); new Run();',
])("preserves the returned identity of a known freeze call: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it.each([
  'Object.freeze(Function("Map.prototype.get=fetch"));',
  'const freeze = Object.freeze; Object.freeze = consume; freeze(Function("Map.prototype.get=fetch"));',
  'const box = Object.freeze({ run: Function("Map.prototype.get=fetch") });',
  "const box = Object.freeze({ prototype: Map.prototype });",
  'const Run = Object.freeze(class extends Function("Map.prototype.get=fetch") {}); try { Run(); } catch {}',
])("keeps an unused or nonexecuting frozen value inert: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

it("does not trust a replaced freeze helper to return a private destination", () => {
  expect(
    analyzeJavaScriptStaticSource(`
    Object.freeze = externalFactory;
    const box = Object.freeze({}); box.p = Map.prototype;
    patch(holder); new Map().get('/accounts');
  `).endpoints,
  ).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it.each([
  'class Run extends Function("Map.prototype.get=fetch") {} new Run();',
  'const Base = Function("Map.prototype.get=fetch"); class Run extends Base {} const Alias = Run; new Alias();',
  'class Base extends Function("Map.prototype.get=fetch") {} class Run extends Base {} new Run();',
  'class Run extends Function("Map.prototype.get=fetch") {} Reflect.construct(Run, []);',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { super(); } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") {} const Bound = Run.bind(null); new Bound();',
])(
  "retains generated superclass execution during construction: %s",
  (prefix) => {
    expect(
      analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
        .endpoints,
    ).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  'class Run extends Function("Map.prototype.get=fetch") {}',
  'class Run extends Function("Map.prototype.get=fetch") {} try { Run(); } catch {}',
  'class Run extends Function("Map.prototype.get=fetch") {} const Bound = Run.bind(null); try { Bound(); } catch {}',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { const unused = () => super(); return {}; } } new Run();',
  'class Run extends Function("Map.prototype.get=fetch") { constructor() { super(); } }',
  'class Run extends Function {} new Run("Map.prototype.get=fetch");',
])("keeps inert or nonexecuting class constructors separate: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

it.each([
  'const run = await Function("Map.prototype.get=fetch"); run();',
  'const factory = Function; const run = await factory("Map.prototype.get=fetch"); run();',
  'const run = await (condition ? Function("Map.prototype.get=fetch") : safe); run();',
  'const run = await Function("Map.prototype.get=fetch"); consume(run);',
  "patch(class { static expose() { return Map.prototype; } });",
  "patch(class { static get expose() { return Map.prototype; } });",
  "patch(class { static expose = Map.prototype; });",
  "patch(class { static expose = () => Map.prototype; });",
  "class Holder { static expose() { return Map.prototype; } } patch(Holder);",
  "class Parent { static expose() { return Map.prototype; } } patch(class extends Parent {});",
])(
  "retains ambient identities exposed through await or class values: %s",
  (prefix) => {
    const analysis = analyzeJavaScriptStaticSource(
      `${prefix} new Map().get('/accounts');`,
    );
    expect(analysis.endpoints).toContainEqual(
      expect.objectContaining({
        value: "/accounts",
        interpretation: "candidate",
      }),
    );
  },
);

it.each([
  'const run = await Function("Map.prototype.get=fetch");',
  "const run = await (() => ({})); run();",
  "const run = await unknown; run();",
  "class Holder { static expose() { return Map.prototype; } }",
  "class Holder { static expose = Map.prototype; }",
  "patch(class { static expose() { return {}; } });",
  "patch(class { static expose = {}; });",
  "patch(class { static #expose = Map.prototype; });",
])("keeps unused or nonambient escaped values separate: %s", (prefix) => {
  expect(
    analyzeJavaScriptStaticSource(`${prefix} new Map().get('/accounts');`)
      .endpoints,
  ).toEqual([]);
});

it("does not apply later awaited generated execution to an earlier lookup", () => {
  expect(
    analyzeJavaScriptStaticSource(`
    const run = await Function('Map.prototype.get=fetch');
    new Map().get('/accounts'); run();
  `).endpoints,
  ).toEqual([]);
});

it("does not promote an awaited receiver into a proven Map identity", () => {
  const analysis = analyzeJavaScriptStaticSource(
    "const records = await new Map(); records.get('/accounts');",
  );
  expect(analysis.endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});

it("does not prove an awaited thenable's destination private", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    async function expose(external) {
      const box = await { then(resolve) { resolve(external); } };
      box.p = Map.prototype;
    }
    expose(holder); patch(holder); new Map().get('/accounts');
  `);
  expect(analysis.endpoints).toContainEqual(
    expect.objectContaining({
      value: "/accounts",
      interpretation: "candidate",
    }),
  );
});
