import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

it.each([
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const Make = Function.bind(null, source); Reflect.construct(Make, []); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const Make = Function.bind(null, source).bind(null); Reflect.construct(Make, []); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const Make = Function.bind(null, source); Reflect.construct.call(null, Make, []); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const Make = Function.bind(null, source); new Make(); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const args = [source]; Function(...args); new Map().get("/accounts");',
  'const args = [Function("Map.prototype.get=fetch")]; const run = Reflect.apply(Object.freeze, null, args); run(); new Map().get("/accounts");',
  'const callbacks = [Function("Map.prototype.get=fetch")]; consume.apply(null, callbacks); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const args = [source]; Function.apply(null, args); new Map().get("/accounts");',
  'const source = { toString() { return {}; }, valueOf: Function("Map.prototype.get=fetch; return 0") }; Function(source); new Map().get("/accounts");',
  'const source = { [Symbol.toPrimitive]: Function("Map.prototype.get=fetch; return 0") }; Function(source); new Map().get("/accounts");',
  'const source = {}; source.toString = Function("Map.prototype.get=fetch; return 0"); Function(source); new Map().get("/accounts");',
  'const callbacks = [Function("Map.prototype.get=fetch")]; Reflect.apply(consume, null, callbacks); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; Function(source); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; new Function(source); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; Reflect.construct(Function, [source]); new Map().get("/accounts");',
  'const run = Object.freeze(Function("Map.prototype.get=fetch")); run.call(null); new Map().get("/accounts");',
  'const Run = Object.freeze(Function("Map.prototype.get=fetch")); new Run(); new Map().get("/accounts");',
  'Object.freeze(Function("Map.prototype.get=fetch")).bind(null)(); new Map().get("/accounts");',
  'Function.constructor = () => () => {}; Function.constructor("Map.prototype.get=fetch")(); new Map().get("/accounts");',

  'const make = Function.constructor; Function.constructor = safe; make("Map.prototype.get=fetch")(); new Map().get("/accounts");',
  'Object.freeze = consume; Object.freeze(Function("Map.prototype.get=fetch")); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get=fetch"); class Holder { static bind(callback) { callback(); } } Holder.bind(run); new Map().get("/accounts");',

  'function inspect(consume, condition) { const Target = condition ? Function : consume; Target(Function("Map.prototype.get=fetch")); new Map().get("/accounts"); } inspect(run => run(), false);',
  'Function.constructor("Map.prototype.get=fetch")(); new Map().get("/accounts");',
  'const run = eval.bind(null, "Map.prototype.get=fetch"); consume(run); new Map().get("/accounts");',
  'consume(eval); new Map().get("/accounts");',
  'consume({ run: eval }); new Map().get("/accounts");',
  'consume({ run: eval.bind(null, "Map.prototype.get=fetch") }); new Map().get("/accounts");',

  'const run = Function("Map.prototype.get=fetch"); Unknown.bind(run); new Map().get("/accounts");',
  'Function.prototype.constructor("Map.prototype.get=fetch")(); new Map().get("/accounts");',

  'function expose(Unknown) { const run = Function("Map.prototype.get=fetch"); const Target = condition ? Function : Unknown; Reflect.construct(Target, [run]); new Map().get("/accounts"); }',

  'const holder = { callback: Function("Map.prototype.get=fetch"), consume: external }; holder.consume(); new Map().get("/accounts");',
  'const holder = { callback: Function("Map.prototype.get=fetch") }; external.call(holder); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get=fetch"); Reflect.construct(Unknown, [run]); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get=fetch"); const Target = condition ? Function : Unknown; Reflect.construct(Target, [run]); new Map().get("/accounts");',

  'const run = Function("Map.prototype.get=fetch"); consume(run); new Map().get("/accounts");',
  'const box = { run: Function("Map.prototype.get=fetch") }; consume(box); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get=fetch").bind(null); consume(run); new Map().get("/accounts");',
  'external.run = Function("Map.prototype.get=fetch"); patch(external); new Map().get("/accounts");',

  'const Run = Function("Map.prototype.get=fetch"); Reflect.construct(Run, []); new Map().get("/accounts");',
  'const Run = Function("Map.prototype.get=fetch").bind(null); Reflect.construct(Run, []); new Map().get("/accounts");',
  'const Run = condition ? Function : Function("Map.prototype.get=fetch"); Reflect.construct(Run, []); new Map().get("/accounts");',
  'const Run = condition ? Function("Map.prototype.get=fetch") : Function; Reflect.construct(Run, []); new Map().get("/accounts");',
  'const Run = Function("Map.prototype.get=fetch"); const construct = Reflect.construct; construct(Run, []); new Map().get("/accounts");',
  'const Run = Function("Map.prototype.get=fetch"); Reflect.construct.call(null, Run, []); new Map().get("/accounts");',

  'const run = condition ? Function : eval.bind(null); run("Map.prototype.get=fetch"); new Map().get("/accounts");',
  'const target = condition ? eval : Function; const run = Function.prototype.bind.call(target, null, "Map.prototype.get=fetch"); run(); new Map().get("/accounts");',
  'const target = condition ? Function : eval; const run = Function.prototype.bind.call(target, null, "Map.prototype.get=fetch"); run()(); new Map().get("/accounts");',

  'const run = condition ? eval.bind(null, "Map.prototype.get=fetch") : Function; run(); new Map().get("/accounts");',
  'const run = condition ? Function : eval.bind(null, "Map.prototype.get=fetch"); run(); new Map().get("/accounts");',
  'const target = condition ? eval : Function; const run = target.bind(null, "Map.prototype.get=fetch"); run(); new Map().get("/accounts");',
  'const target = condition ? Function : eval; const run = target.bind(null, "Map.prototype.get=fetch"); run()(); new Map().get("/accounts");',
  'const run = eval.bind(null, "Map.prototype.get=fetch"); run``; new Map().get("/accounts");',

  'eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'eval("Map.prototype.delete = fetch"); new Map().delete("/accounts");',
  '"use strict"; eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'function run() { eval("Map.prototype.get = fetch"); return new Map().get("/accounts"); }',
  'function patch() { eval("Map.prototype.get = fetch"); } patch(); new Map().get("/accounts");',
  'for (const item of [1, 2]) { new Map().get("/accounts"); eval("Map.prototype.get = fetch"); }',
  'const run = eval; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'let run; (run = eval)("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'let run; (run = globalThis.eval)("Map.prototype.get = fetch"); new Map().get("/accounts");',
  '(0, eval)("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'globalThis.eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'eval?.("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'let run = eval; run("Map.prototype.get = fetch"); run = () => {}; new Map().get("/accounts");',
  'let run = () => {}; run = eval; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const { eval: run } = globalThis; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'eval.call(null, "Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const run = eval.bind(null); run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'globalThis["ev" + "al"]("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const { ["eval"]: run } = globalThis; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const root = globalThis; const run = root["eval"]; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'function invoke() { run("Map.prototype.get = fetch"); } const run = eval; invoke(); new Map().get("/accounts");',
  'function getRun() { return eval; } getRun()("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'Reflect.apply(eval, null, ["Map.prototype.get = fetch"]); new Map().get("/accounts");',
  'let run; (run ??= eval)("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'let run; (run ||= eval)("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'let run = true; (run &&= eval)("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const box = {}; box.run = eval; box.run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const box = {}; const alias = box; alias.run = eval; box.run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const box = {}; box.inner = {}; box.inner.run = eval; box.inner.run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const box = {}; box.run = eval.bind(null, "Map.prototype.get = fetch"); box.run(); new Map().get("/accounts");',
  'Function("Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'new Function("Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch"); run(); new Map().get("/accounts");',
  'const make = Function; const run = make("Map.prototype.get = fetch"); run(); new Map().get("/accounts");',
  'const box = {}; box.run = Function("Map.prototype.get = fetch"); box.run(); new Map().get("/accounts");',
  'const box = { get run() { return Function("Map.prototype.get = fetch"); } }; box.run(); new Map().get("/accounts");',
  'function make() { return Function("Map.prototype.get = fetch"); } make()(); new Map().get("/accounts");',
  'Function.call(null, "Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'Function.apply(null, ["Map.prototype.get = fetch"])(); new Map().get("/accounts");',
  'Reflect.apply(Function, null, ["Map.prototype.get = fetch"])(); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch"); Reflect.apply(run, null, []); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch"); run.call(null); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch").bind(null); run(); new Map().get("/accounts");',
  'const Run = Function("Map.prototype.get = fetch"); new Run(); new Map().get("/accounts");',
  'const Make = Function.bind(null, "Map.prototype.get = fetch"); new Make()(); new Map().get("/accounts");',
  'Function.prototype.call.call(Function, null, "Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'Reflect.construct(Function, ["Map.prototype.get = fetch"])(); new Map().get("/accounts");',
  'const { Function: make } = globalThis; make("Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'const box = {}; box.make = Function; box.make("Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'let run = eval; (run ||= (() => {}))("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const run = condition ? eval : Function; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const run = condition ? Function : eval; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch"); run``; new Map().get("/accounts");',
  '(Function`Map.prototype.get = fetch`)(); new Map().get("/accounts");',
  'const run = condition ? eval[unknown] : eval; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const run = condition ? eval : eval[unknown]; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const generated = Function("Map.prototype.get = fetch"); const run = condition ? generated[unknown] : generated; run(); new Map().get("/accounts");',
  'const generated = Function("Map.prototype.get = fetch"); const run = condition ? generated : generated[unknown]; run(); new Map().get("/accounts");',
  'const run = condition ? eval.bind : Function("Map.prototype.get = fetch"); run(); new Map().get("/accounts");',
  'const run = condition ? Function("Map.prototype.get = fetch") : eval.bind; run(); new Map().get("/accounts");',
  'const run = condition ? eval : Function("Map.prototype.get = fetch"); run``; new Map().get("/accounts");',
  'const run = condition ? Function("Map.prototype.get = fetch") : eval; run``; new Map().get("/accounts");',
  'const Run = condition ? eval : Function("Map.prototype.get = fetch"); new Run(); new Map().get("/accounts");',
  'const Run = condition ? Function("Map.prototype.get = fetch") : eval; new Run(); new Map().get("/accounts");',
])(
  "keeps a Map lookup after possible opaque mutation as a candidate: %s",
  (source) => {
    expect(analyzeJavaScriptStaticSource(source).endpoints).toMatchObject([
      { kind: "network", value: "/accounts", interpretation: "candidate" },
    ]);
  },
);

it.each([
  'Function.constructor("Map.prototype.get=fetch"); new Map().get("/accounts");',
  'Function`Map.prototype.get=fetch`.bind(null); new Map().get("/accounts");',
  'class Run extends Function("Map.prototype.get=fetch") {} try { Run.call(null); } catch {} new Map().get("/accounts");',
  'class Run extends Function("Map.prototype.get=fetch") {} try { Run.apply(null, []); } catch {} new Map().get("/accounts");',
  'class Run extends Function("Map.prototype.get=fetch") {} try { Reflect.apply(Run, null, []); } catch {} new Map().get("/accounts");',
  'const make = Function.constructor; make("Map.prototype.get=fetch"); new Map().get("/accounts");',
  'const make = Function.constructor; make.call(null, "Map.prototype.get=fetch"); new Map().get("/accounts");',
  'Function.constructor.apply(null, ["Map.prototype.get=fetch"]); new Map().get("/accounts");',

  'const Function = { constructor: () => () => {} }; Function.constructor("Map.prototype.get=fetch")(); new Map().get("/accounts");',
  'function* make() {} make.constructor("Map.prototype.get=fetch")(); new Map().get("/accounts");',

  'Object.freeze(Function("Map.prototype.get=fetch")); new Map().get("/accounts");',
  'Function(Function("Map.prototype.get=fetch")); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const Make = Function.bind(null, source).bind(null); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; const Make = Function.bind(null, source); Reflect.construct(Function, [""], Make); new Map().get("/accounts");',
  'const Make = Function.bind(null, "Map.prototype.get=fetch").bind(null); Reflect.construct(Make, []); new Map().get("/accounts");',

  'const source = { unused: Function("Map.prototype.get=fetch"), toString() { return ""; } }; Function(source); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; Function.bind(null, source); new Map().get("/accounts");',
  'const source = { toString: Function("Map.prototype.get=fetch; return 0") }; Object.freeze(source); new Map().get("/accounts");',

  'Object.freeze(Function("Map.prototype.get=fetch")).bind(null); new Map().get("/accounts");',
  'const make = Object.freeze(Function); make("Map.prototype.get=fetch"); new Map().get("/accounts");',
  'const box = {}; box.run = eval.bind(null, "Map.prototype.get=fetch"); new Map().get("/accounts");',
  'const run = eval.bind(null, "Map.prototype.get=fetch"); new Map().get("/accounts"); consume(run);',

  'Function.prototype.constructor("Map.prototype.get=fetch"); new Map().get("/accounts");',

  'const run = Function("Map.prototype.get=fetch"); Reflect.construct(Function, [run]); new Map().get("/accounts");',

  'const box = {}; box.run = Function("Map.prototype.get=fetch"); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get=fetch"); new Map().get("/accounts"); consume(run);',

  'Reflect.construct(Function, ["Map.prototype.get=fetch"]); new Map().get("/accounts");',
  'const Run = Function("Map.prototype.get=fetch"); Reflect.construct(function Safe() {}, [], Run); new Map().get("/accounts");',
  'const Run = Function("Map.prototype.get=fetch"); new Map().get("/accounts"); Reflect.construct(Run, []);',

  'void Function; let run = () => run; run = run.bind(null); run(); new Map().get("/accounts");',
  'void Function; let first = () => second; let second = () => first; first = first.bind(null); second = second.bind(null); first()(); new Map().get("/accounts");',

  'new Map().get("/accounts"); eval("Map.prototype.get = fetch");',
  '(new Map().get("/accounts"), eval("Map.prototype.get = fetch"));',
  'function run(eval) { eval("Map.prototype.get = fetch"); return new Map().get("/accounts"); }',
  'const eval = () => {}; eval("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'for (const item of []) { eval("Map.prototype.get = fetch"); } new Map().get("/accounts");',
  'const run = eval; new Map().get("/accounts"); run("Map.prototype.get = fetch");',
  'function inspect(eval) { const run = eval; run("Map.prototype.get = fetch"); return new Map().get("/accounts"); }',
  'let run = eval; run = () => {}; run("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'eval.bind(null); new Map().get("/accounts");',
  'Function("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'new Function("Map.prototype.get = fetch"); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch"); new Map().get("/accounts"); run();',
  'function inspect(Function) { Function("Map.prototype.get = fetch")(); return new Map().get("/accounts"); }',
  'const Function = () => () => {}; Function("Map.prototype.get = fetch")(); new Map().get("/accounts");',
  'const run = Function("Map.prototype.get = fetch").bind(null); new Map().get("/accounts");',
  'let run = Function("Map.prototype.get = fetch"); run = () => {}; run(); new Map().get("/accounts");',
  'const box = {}; box.run = () => {}; box.run(); new Map().get("/accounts");',
  'const Function = () => Function; Function()(); new Map().get("/accounts");',
  'const first = () => second; const second = () => first; first()(); new Map().get("/accounts");',
  'const box = {}; box.run = eval; new Map().get("/accounts"); box.run("Map.prototype.get = fetch");',
  'const make = () => () => {}; Reflect.construct(make, ["Map.prototype.get = fetch"])(); new Map().get("/accounts");',
  'eval`Map.prototype.get = fetch`; new Map().get("/accounts");',
  'Function`Map.prototype.get = fetch`; new Map().get("/accounts");',
])(
  "preserves a Map proof when global code cannot execute before the lookup: %s",
  (source) => {
    expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
  },
);

it("does not grant indirect eval access to the caller's lexical bindings", () => {
  const analysis = analyzeJavaScriptSemantics(`
    export function inspect() {
      let value = 1;
      const run = eval;
      run("value = 2");
      return value;
    }
  `);
  expect(onlyCallable(analysis, "inspect").returnSites[0]?.value).toEqual({
    status: "literal",
    value: 1,
  });
});

it("preserves recovered bound argument positions in opaque callable identities", () => {
  const ir = analyzeJavaScriptSemantics(
    'const run = eval.bind(null, , "code"); run();',
  );
  expect(ir.coverage.status).toBe("partial");
  expect(ir.callSites[0]?.arguments.map(({ index }) => index)).toEqual([0, 2]);
  expect(ir.limitations.join(" ")).toMatch(/parser recovered/iu);
});

it("keeps recovered Reflect.construct target holes partial without inventing a callable", () => {
  const ir = analyzeJavaScriptSemantics(
    "void Function; Reflect.construct(, []);",
  );
  expect(ir.coverage.status).toBe("partial");
  expect(ir.callSites[0]?.arguments.map(({ index }) => index)).toEqual([1]);
  expect(ir.limitations.join(" ")).toMatch(/parser recovered/iu);
});
