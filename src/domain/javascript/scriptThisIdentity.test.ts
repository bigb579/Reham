import { describe, expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';
const analyze = (source: string, path = "bundle.js") => {
  const parsed = parseJavaScriptSource(source, path);
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed);
};

it("keeps a wide receiver's primitive stores separate from its object references", () => {
  const count = 1600;
  const methods = Array.from(
    { length: count },
    (_, index) => `m${index}(){this.x${index}=${index};}`,
  ).join(",");
  const calls = Array.from(
    { length: count },
    (_, index) => `box.m${index}();`,
  ).join("");
  const source = `${SHIM}const box={${methods}};${calls}`;
  expect(analyze(`${source}${USE}`).electron.ipc).toHaveLength(1);
  expect(
    analyze(`${source}box.alias=globalThis;box.alias.Q=other;${USE}`).electron
      .ipc,
  ).toEqual([]);
});

describe("script receiver writes", () => {
  it.each([
    "this.Q=other;",
    "const root=this;root.Q=other;",
    "const {globalThis:root}=this;root.Q=other;",
    "const box={};box.root=this;box.root.Q=other;",
    "Reflect.set(this,'Q',other);",
    "Object.defineProperty(this,'Q',{value:other});",
    "Object.assign(this,{Q:other});",
    "(()=>{this.Q=other})();",
    "{this.Q=other;}",
    "({[(this.Q=other,'method')](){}});",
    "class C{[(this.Q=other,'method')](){}}",
    "class C{[(this.Q=other,'field')]=0;}",
    "class C extends (this.Q=other,Object){}",
  ])("rejects a script var replaced through %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`).electron.ipc).toEqual([]);
  });

  it.each([
    `"use strict";${SHIM}this.Q=other;${USE}`,
    `import type {X} from "types";${SHIM}this.Q=other;${USE}`,
  ])(
    "retains a possible script receiver with erased or strict syntax: %s",
    (source) => {
      expect(analyze(source, "bundle.ts").electron.ipc).toEqual([]);
    },
  );

  it("also invalidates saved export vars", () => {
    expect(
      analyze('var W=require("electron").BrowserWindow;this.W=other;new W({});')
        .electron.browser_windows,
    ).toEqual([]);
  });

  it("shares the receiver with ambient-call integrity", () => {
    expect(
      analyze('this.fetch=other;fetch("/changed");').endpoints.filter(
        ({ mechanism }) => mechanism === "call:fetch",
      ),
    ).toEqual([]);
  });
});

describe("script receiver isolation and capture", () => {
  it.each([
    "const box={set(){this.Q=other;}};box.set();",
    "const box={set(){(()=>{this.Q=other})();}};box.set();",
    "function set(){'use strict';this.Q=other;}set.call({});",
    "class C{field=(this.Q=other);}new C();",
    "class C{static field=(this.Q=other);}",
    "class C{static {this.Q=other;}}",
    "class C{field=()=>{this.Q=other;};}new C().field();",
    "class C{method(){this.Q=other;}}new C().method();",
  ])("keeps another receiver separate: %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`).electron.ipc).toMatchObject([
      { channel: "kept" },
    ]);
  });

  it.each([
    `this.Q=other;${SHIM}${USE}`,
    `${SHIM}${USE}this.Q=other;`,
    `${SHIM}this.unrelated=other;${USE}`,
    `${SHIM.replace("var Q", "let Q")}this.Q=other;${USE}`,
    `${SHIM.replace("var Q", "const Q")}this.Q=other;${USE}`,
    `${SHIM}const E=Q("electron");this.Q=other;E.ipcRenderer.send("kept");`,
  ])(
    "preserves initialization, lexical bindings, and earlier captures: %s",
    (source) => {
      expect(analyze(source).electron.ipc).toMatchObject([{ channel: "kept" }]);
    },
  );

  it.each(["bundle.cjs", "bundle.mjs", "bundle.cts", "bundle.mts"])(
    "does not make module-level this a global receiver in %s",
    (path) => {
      expect(
        analyze(
          'this&&(this.fetch=other);fetch("/kept");',
          path,
        ).endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
      ).toHaveLength(1);
    },
  );
});

describe("source-visible function receivers", () => {
  it.each([
    "function set(){this.Q=other;}set();",
    "(function(){this.Q=other;})();",
    "function set(){this.Q=other;}const run=set;run();",
    "const box={set(){this.Q=other;}};(0,box.set)();",
    "function set(){'use strict';this.Q=other;}set.call(globalThis);",
    "const box={set(){this.Q=other;}};box.set.call(globalThis);",
    "function set(){this.Q=other;}set.apply(globalThis,[]);",
    "function set(){this.Q=other;}Reflect.apply(set,globalThis,[]);",
    "function set(){this.Q=other;}const run=set.bind(globalThis);run();",
    "function set(){this.Q=other;}const run=set.bind(null);run();",
    "function set(){(()=>{this.Q=other;})();}set.call(globalThis);",
    "const root=globalThis;function set(){this.Q=other;}set.call(root);",
    "function set(){this.Q=other;}let root=globalThis;const run=set.bind(root);root={};run();",
    "function set(x=(this.Q=other)){ }set();",
    "const set=()=>{this.Q=other;};set.call({});",
    "Object.defineProperty(globalThis,'x',{get(){this.Q=other;}});globalThis.x;",
    "function set(){this.Q=other;}set.call({});const box={};box.set=set;box.set.call(globalThis);",
    "function set(){this.Q=other;}set.call({});globalThis.set=set;globalThis.set();",
    "function set(){this.Q=other;}set.call({});function maker(){return set;}maker().call(globalThis);",
    "function set(){this.Q=other;}set.call({});function run(fn){fn.call(globalThis);}run(set);",
    "function set(){'use strict';this.Q=other;}const args=[globalThis];set.call(...args);",
    "class B{constructor(){return globalThis;}}class C extends B{constructor(){super();this.Q=other;}}new C();",
    "class B{constructor(){return globalThis;}}class C extends B{field=(this.Q=other);}new C();",
    "class C{method(){this.Q=other;}}new C().method();C.prototype.method.call(globalThis);",
    "class C{method(){this.Q=other;}}new C().method();const method=C.prototype.method;method.call(globalThis);",
    "class C{method(){this.Q=other;}}new C().method();Object.getOwnPropertyDescriptor(C.prototype,'method').value.call(globalThis);",
    "const box={set(){this.Q=other;}};box.set();Object.assign(globalThis,box);globalThis.set();",
  ])("retains a possible global receiver: %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`).electron.ipc).toEqual([]);
  });

  it("follows an explicit CommonJS module receiver", () => {
    expect(
      analyze(
        `${SHIM}function set(){this.require=other;}set.call(module);${USE}`,
      ).electron.ipc,
    ).toEqual([]);
  });

  it.each([
    "function set(){'use strict';if(this)this.Q=other;}set();",
    "function set(){this.Q=other;}set.call({});",
    "function set(){this.Q=other;}set.apply({},[]);",
    "function set(){this.Q=other;}Reflect.apply(set,{},[]);",
    "function set(){this.Q=other;}const run=set.bind({});run();",
    "function set(){this.Q=other;}new set();",
    "function set(){this.Q=other;}let root={};const run=set.bind(root);root=globalThis;run();",
  ])("keeps distinct receivers separate: %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`).electron.ipc).toHaveLength(1);
  });

  it.each([
    "class C{m(@dec(this.Q=other) x){}}",
    "class C{constructor(@dec(this.Q=other) public x){}}",
    "import type {X} from 'types';function set(){this.Q=other;}set();",
  ])("retains erased-syntax receiver effects: %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`, "bundle.ts").electron.ipc).toEqual(
      [],
    );
  });

  it("uses enclosing strictness for bare calls", () => {
    expect(
      analyze(
        `'use strict';${SHIM}function set(){if(this)this.Q=other;}set();${USE}`,
      ).electron.ipc,
    ).toHaveLength(1);
  });

  it.each([
    "class O{field=(@dec(this.Q=other) class C{});}new O();",
    "class O{static field=(@dec(this.Q=other) class C{});}",
  ])("keeps a decorator in its enclosing field receiver: %s", (write) => {
    expect(
      analyze(`${SHIM}${write}${USE}`, "bundle.ts").electron.ipc,
    ).toHaveLength(1);
  });
});

describe("inherited constructor result receivers", () => {
  it.each([
    "class B{constructor(){return globalThis}}class C extends B{constructor(){super()}}class D extends C{field=(this.Q=other)}new D();",
    "class B{constructor(){return globalThis}}class C extends B{constructor(){super()}}class D extends C{constructor(){super();this.Q=other}}new D();",
    "class B{constructor(){return globalThis}}class C extends B{constructor(){return super()}}class D extends C{field=(this.Q=other)}new D();",
    "class B{constructor(){return globalThis}}class C extends B{constructor(){super();if(flag)return {}}}class D extends C{field=(this.Q=other)}new D();",
    "class B{constructor(){return globalThis}}const Base=flag?B:class{};class C extends Base{constructor(){super()}}class D extends C{field=(this.Q=other)}new D();",
  ])("retains a possible superclass object through %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`).electron.ipc).toEqual([]);
  });

  it.each([
    "class B{constructor(){return globalThis}}class C extends B{constructor(){super();return {}}}class D extends C{field=(this.Q=other)}new D();",
    "class B{constructor(){return globalThis}}class C extends B{constructor(){return {}}}class D extends C{field=(this.Q=other)}new D();",
    "class B{}class C extends B{constructor(){super()}}class D extends C{field=(this.Q=other)}new D();",
  ])("preserves a distinct constructed receiver through %s", (write) => {
    expect(analyze(`${SHIM}${write}${USE}`).electron.ipc).toHaveLength(1);
  });
});

describe("constructor replacement aliases", () => {
  const construct = (body: string) =>
    `class B{constructor(){return globalThis}}class C extends B{constructor(){${body}}}class D extends C{field=(this.Q=other)}new D();`;

  it.each([
    "const local={};return local;",
    "const local={};const alias=local;return alias;",
    "let local={};const captured=local;local=globalThis;return captured;",
    "let local=globalThis;local={};return local;",
    "const local=new class{};return local;",
  ])("preserves a definite object replacement through %s", (body) => {
    expect(
      analyze(`${SHIM}${construct(body)}${USE}`).electron.ipc,
    ).toHaveLength(1);
  });

  it.each([
    "let local={};local=globalThis;return local;",
    "let local=globalThis;const captured=local;local={};return captured;",
    "let local={};if(flag)local=globalThis;return local;",
    "const local=flag?{}:globalThis;return local;",
    "let local={};eval('local=globalThis');return local;",
    "const local=unknown;return local;",
    "const local=new class{constructor(){return globalThis}};return local;",
  ])("retains a possible global receiver through %s", (body) => {
    expect(analyze(`${SHIM}${construct(body)}${USE}`).electron.ipc).toEqual([]);
  });
});

describe("outer constructor replacement aliases", () => {
  it("refreshes a retained result query after ambient facts complete", () => {
    const parsed = parseJavaScriptSource(
      "var local={};class B{constructor(){return globalThis}}class C extends B{constructor(){super();return local}}",
      "bundle.js",
    );
    if (parsed === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    const derived = parsed.program.body[2];
    if (derived?.type !== "ClassDeclaration")
      throw new Error("Expected derived constructor");
    const results = createSemanticReturnedReferences(index.bindings);
    const inheritsGlobal = () =>
      results(derived).some(
        ({ node }) => node.type === "Identifier" && node.name === "globalThis",
      );
    expect(inheritsGlobal()).toBe(true);
    completeSemanticSteps(index.indexAmbientWritesSteps());
    expect(inheritsGlobal()).toBe(false);
  });

  it.each([
    ["var local={};", "return local;"],
    ["var local={};", "super();return local;"],
    ["var source={};const local=source;source=globalThis;", "return local;"],
    [
      "var source={};const local=source;source=globalThis;",
      "super();return local;",
    ],
  ])("preserves an outer object capture: %s %s", (declaration, body) => {
    const classes = `class B{constructor(){return globalThis}}class C extends B{constructor(){${body}}}class D extends C{field=(this.Q=other)}new D();`;
    expect(
      analyze(`${SHIM}${declaration}${classes}${USE}`).electron.ipc,
    ).toHaveLength(1);
  });

  it.each([
    "var local={};local=globalThis;",
    "var local={};globalThis.local=globalThis;",
    "var local={};if(flag)local=globalThis;",
    "var local={};(0,eval)('local=globalThis');",
  ])("retains an outer value that may change: %s", (declaration) => {
    const classes =
      "class B{constructor(){return globalThis}}class C extends B{constructor(){super();return local}}class D extends C{field=(this.Q=other)}new D();";
    expect(
      analyze(`${SHIM}${declaration}${classes}${USE}`).electron.ipc,
    ).toEqual([]);
  });
});
