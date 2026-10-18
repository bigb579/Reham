import { expect, it } from "vitest";
import * as t from "@babel/types";

import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const CONSUMER = 'Q("electron").ipcRenderer.send("kept");';

const ipcAfter = (setup: string) => {
  const source = `${SHIM}const noop=()=>{};${setup}${CONSUMER}`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron.ipc;
};

it.each([
  [
    "an object slot",
    'const box={run:noop};box.run=eval;box.run=noop;box.run("Q=other");',
  ],
  [
    "an array slot",
    'const box=[noop];box[0]=eval;box[0]=noop;(0,box[0])("Q=other");',
  ],
  [
    "a captured container alias",
    'const box={run:noop};const alias=box;box.run=eval;alias.run=noop;box.run("Q=other");',
  ],
  [
    "an earlier conditional store",
    'const box={run:noop};if(flag)box.run=eval;box.run=noop;box.run("Q=other");',
  ],
  [
    "a slot cleared with a primitive",
    'const box={run:noop};box.run=eval;box.run=null;box.run?.("Q=other");',
  ],
  [
    "a slot in one sequence expression",
    'const box={run:noop};(box.run=eval,box.run=noop,box.run("Q=other"));',
  ],
  [
    "an ambient-reference slot",
    "const box={};box.target=globalThis;box.target={};box.target.Q=other;",
  ],
  [
    "an initially empty array slot",
    'const box=[];box[0]=eval;box[0]=noop;(0,box[0])("Q=other");',
  ],
  [
    "a slot captured before a later container escape",
    'const box={run:noop};box.run=eval;box.run=noop;const run=box.run;consume(box);run("Q=other");',
  ],
  [
    "a reference stored in an ordinary data property",
    'const box={run:noop};box.run=eval;const target={box:null};target.box=box;box.run=noop;box.run("Q=other");',
  ],
  [
    "an unchanged script var alias",
    'const box={run:noop};var alias=box;box.run=eval;alias.run=noop;(0,box.run)("Q=other");',
  ],
  [
    "a script var alias read before a later global rebind",
    'const box={run:noop};var alias=box;box.run=eval;alias.run=noop;globalThis.alias={};(0,box.run)("Q=other");',
  ],
  [
    "a captured script var alias before its global rebind",
    'const box={run:noop};var alias=box;const saved=alias;box.run=eval;globalThis.alias={};saved.run=noop;(0,box.run)("Q=other");',
  ],
])("selects the latest definite write to %s", (_name, setup) => {
  expect(ipcAfter(setup)).toMatchObject([{ channel: "kept" }]);
});

it.each([
  [
    "a conditional replacement",
    'const box={run:noop};box.run=eval;if(flag)box.run=noop;box.run("Q=other");',
  ],
  [
    "a short-circuit replacement",
    'const box={run:noop};box.run=eval;box.run&&=noop;box.run("Q=other");',
  ],
  [
    "an unknown property replacement",
    'const box={run:noop};box.run=eval;box[key]=noop;box.run("Q=other");',
  ],
  [
    "a captured eval alias",
    'const box={run:noop};box.run=eval;const run=box.run;box.run=noop;run("Q=other");',
  ],
  [
    "a deferred eval store",
    'const box={run:noop};function set(){box.run=eval;}box.run=noop;set();box.run("Q=other");',
  ],
  [
    "a deferred read",
    'const box={run:noop};box.run=eval;function run(){box.run("Q=other");}run();box.run=noop;',
  ],
  [
    "a different stored slot",
    'const box={run:noop};box.run=eval;box.other=noop;box.run("Q=other");',
  ],
  [
    "a receiver that may select another fresh object",
    'const box={run:noop};box.run=eval;const target=flag?box:{};target.run=noop;box.run("Q=other");',
  ],
  [
    "a receiver that may select an unknown value",
    'const box={run:noop};box.run=eval;const target=flag?box:input;target.run=noop;box.run("Q=other");',
  ],
  [
    "a frozen object",
    'const box={run:noop};box.run=eval;Object.freeze(box);box.run=noop;box.run("Q=other");',
  ],
  [
    "a readonly property descriptor",
    'const box={run:noop};box.run=eval;Object.defineProperty(box,"run",{writable:false});box.run=noop;box.run("Q=other");',
  ],
  [
    "an unknown receiver escape",
    'const box={run:noop};box.run=eval;consume(box);box.run=noop;box.run("Q=other");',
  ],
  [
    "an escape through an inline container",
    'const box={run:noop};box.run=eval;consume({box});box.run=noop;box.run("Q=other");',
  ],
  [
    "an escape through a stored container member",
    'const box={run:noop};box.run=eval;const holder={};holder.box=box;consume(holder);box.run=noop;box.run("Q=other");',
  ],
  [
    "a store into an unknown receiver",
    'const box={run:noop};box.run=eval;unknown.box=box;box.run=noop;box.run("Q=other");',
  ],
  [
    "an escape in an unknown activation order",
    'const box={run:noop};box.run=eval;function freeze(){Object.freeze(box);}freeze();box.run=noop;box.run("Q=other");',
  ],
  [
    "an own setter that can retain its previous value",
    'let value;const box={get run(){return value},set run(v){if(v===eval)value=v}};box.run=eval;box.run=noop;box.run("Q=other");',
  ],
  [
    "a custom literal prototype",
    'let value;const proto={get run(){return value},set run(v){if(v===eval)value=v}};const box={__proto__:proto};box.run=eval;box.run=noop;box.run("Q=other");',
  ],
  [
    "a deleted slot on a replaced prototype",
    'const box={run:noop};box.run=eval;delete box.run;box.__proto__={get run(){return eval},set run(v){}};box.run=noop;box.run("Q=other");',
  ],
  [
    "an inherited accessor on the ordinary object prototype",
    'Object.defineProperty(Object.prototype,"run",{get(){return eval},set(v){}});const box={};box.run=eval;box.run=noop;box.run("Q=other");',
  ],
  [
    "a reference passed to an own setter",
    'const box={run:noop};box.run=eval;const target={set box(value){Object.freeze(value)}};target.box=box;box.run=noop;box.run("Q=other");',
  ],
  [
    "a reference passed to a custom prototype setter",
    'const box={run:noop};box.run=eval;const target={__proto__:{set box(value){Object.freeze(value)}}};target.box=box;box.run=noop;box.run("Q=other");',
  ],
  [
    "a receiver that may be returned by external code",
    'const box={run:noop};box.run=eval;const target=flag?{}:external();target.box=box;box.run=noop;box.run("Q=other");',
  ],
  [
    "a store receiver reached by a subsequently discovered setter escape",
    'const box={run:noop};box.run=eval;const target={box:null};const sink={set value(value){Object.defineProperty(value,"box",{set(item){Object.freeze(item)}})}};target.box=(sink.value=target,box);box.run=noop;box.run("Q=other");',
  ],
  [
    "a script var receiver rebound through its global property",
    'const box={run:noop};var alias=box;box.run=eval;globalThis.alias={};alias.run=noop;(0,box.run)("Q=other");',
  ],
  [
    "a script var receiver rebound through a captured global object",
    'const box={run:noop};var alias=box;const host=globalThis;box.run=eval;host.alias={};alias.run=noop;(0,box.run)("Q=other");',
  ],
])("retains possible eval from %s", (_name, setup) => {
  expect(ipcAfter(setup)).toEqual([]);
});

it("keeps effects through an ambient reference captured before its slot changes", () => {
  expect(
    ipcAfter(
      "const box={};box.target=globalThis;const target=box.target;box.target={};target.Q=other;",
    ),
  ).toEqual([]);
});

it("exports a stored ambient escape when no receiver supports replacement proofs", () => {
  const parsed = parseJavaScriptSource(
    "const target=flag?{}:external();target.value=module;",
    "bundle.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  expect(state.ambientEscapes.covers(["commonjs-module", "require"])).toBe(
    true,
  );
});

it.each([
  {
    name: "an indirect eval before the lexical capture",
    source:
      'let root={};(0,eval)("root=globalThis");const captured=root;captured;',
    fresh: false,
  },
  {
    name: "an indirect eval after the lexical capture",
    source:
      'let root={};const captured=root;(0,eval)("root=globalThis");captured;',
    fresh: true,
  },
  {
    name: "an indirect eval with unknown activation order",
    source:
      'let root={};replace();const captured=root;function replace(){(0,eval)("root=globalThis")}captured;',
    fresh: false,
  },
])("preserves freshness timing for $name", ({ source, fresh }) => {
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const read = parsed.program.body.at(-1);
  if (!t.isExpressionStatement(read)) throw new Error("Expected captured read");
  expect(
    createSemanticModuleInterop(state).isFreshObject(read.expression),
  ).toBe(fresh);
});
