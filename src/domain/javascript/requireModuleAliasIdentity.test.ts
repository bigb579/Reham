import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

describe("legacy accessor descriptor mutations", () => {
  it.each([
    'module.METHOD("require",()=>other);',
    'module.__proto__.METHOD("require",()=>other);',
    'Object.prototype.METHOD.call(module,"require",()=>other);',
    'const change=Object.prototype.METHOD;change.call(module,"require",()=>other);',
    'const {METHOD:change}=Object.prototype;change.apply(module,["require",()=>other]);',
    'const change=Object.prototype.METHOD.bind(module,"require");change(()=>other);',
    'Reflect.apply(Object.prototype.METHOD,module,["require",()=>other]);',
    'const change=module.METHOD;change.call(module,"require",()=>other);',
    'const change=module.METHOD.bind(module);change("require",()=>other);',
    'Function.prototype.call.call(Object.prototype.METHOD,module,"require",()=>other);',
    'Reflect.apply(Function.prototype.bind,Object.prototype.METHOD,[module,"require"])(()=>other);',
    'Object.prototype.METHOD=other;Object.prototype.METHOD.call(module,"require",()=>other);',
    'Object.prototype.METHOD.call=other;Object.prototype.METHOD.call(module,"require",()=>other);',
    'const change=Object.prototype.METHOD;Object.prototype.METHOD=other;change.call(module,"require",()=>other);',
    "module.METHOD(key,()=>other);",
    "Object.prototype.METHOD.apply(module,args);",
  ])("rejects a changed module delegate through %s", (source) => {
    for (const method of ["__defineGetter__", "__defineSetter__"])
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${source.replaceAll("METHOD", method)}new (Q("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
  });

  it.each([
    'const local={};local.METHOD("require",()=>other);',
    'Object.prototype.METHOD.call({},"require",()=>other);',
    'const local={METHOD(){}};local.METHOD.call(module,"require",()=>other);',
    'module.METHOD("unrelated",()=>other);',
    'const change=Object.prototype.METHOD.bind(module,"require");',
  ])(
    "preserves a loader beside an unrelated descriptor operation: %s",
    (source) => {
      for (const method of ["__defineGetter__", "__defineSetter__"])
        expect(
          analyzeJavaScriptStaticSource(
            `${SHIM}${source.replaceAll("METHOD", method)}new (Q("electron").BrowserWindow)({});`,
          ).electron.browser_windows,
        ).toHaveLength(1);
    },
  );

  it.each(["__defineGetter__", "__defineSetter__"])(
    "preserves a load before a later %s descriptor mutation",
    (method) => {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}new (Q("electron").BrowserWindow)({});module.${method}("require",()=>other);`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    },
  );

  it.each(["__defineGetter__", "__defineSetter__"])(
    "preserves a saved delegate value before a %s descriptor mutation",
    (method) => {
      expect(
        analyzeJavaScriptStaticSource(
          `const saved=module.require;module.${method}("require",()=>other);new (saved.call(module,"electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    },
  );

  it.each(["__defineGetter__", "__defineSetter__"])(
    "shares %s mutation facts with Electron export identity",
    (method) => {
      for (const [key, count] of [
        ["BrowserWindow", 0],
        ["unrelated", 1],
      ] as const)
        expect(
          analyzeJavaScriptStaticSource(
            `const electron=require("electron");Object.prototype.${method}.call(electron,"${key}",()=>other);new electron.BrowserWindow({});`,
          ).electron.browser_windows,
        ).toHaveLength(count);
    },
  );
});

describe("legacy accessor mutations through cached Modules", () => {
  it.each([
    'require.cache[key].METHOD("require",()=>other);',
    'require.cache["/app.cjs"].METHOD("require",()=>other);',
    'require("module")._cache[key].METHOD("require",()=>other);',
    'module.constructor._cache[key].METHOD("require",()=>other);',
    'const entry=require.cache[key];entry.METHOD("require",()=>other);',
    'require.cache[key].constructor.prototype.METHOD("require",()=>other);',
    'const entry=require.cache[key];const change=entry.METHOD.bind(entry,"require");change(()=>other);',
    'Object.prototype.METHOD.call(require.cache[key],"require",()=>other);',
  ])("rejects a cached delegate descriptor mutation: %s", (source) => {
    for (const method of ["__defineGetter__", "__defineSetter__"])
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${source.replaceAll("METHOD", method)}new (Q("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
  });

  it.each([
    'const local={cache:{entry:{METHOD(){}}}};local.cache.entry.METHOD("require",()=>other);',
    'let cache=require.cache;cache={entry:{METHOD(){}}};cache.entry.METHOD("require",()=>other);',
    'require.cache[key].METHOD("unrelated",()=>other);',
    'require.cache.METHOD("require",()=>other);',
  ])(
    "preserves a distinct cache or local descriptor operation: %s",
    (source) => {
      for (const method of ["__defineGetter__", "__defineSetter__"])
        expect(
          analyzeJavaScriptStaticSource(
            `${SHIM}${source.replaceAll("METHOD", method)}new (Q("electron").BrowserWindow)({});`,
          ).electron.browser_windows,
        ).toHaveLength(1);
    },
  );

  it.each(["__defineGetter__", "__defineSetter__"])(
    "retains an earlier load before a cached %s descriptor mutation",
    (method) => {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}new (Q("electron").BrowserWindow)({});require.cache[key].${method}("require",()=>other);`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    },
  );
});

describe("CommonJS module delegate aliases", () => {
  it.each([
    [
      "object property",
      "const holder={target:module};holder.target.require=other;",
    ],
    ["array element", "const holder=[module];holder[0].require=other;"],
    [
      "nested property",
      "const holder={inner:{target:module}};holder.inner.target.require=other;",
    ],
    [
      "later local store",
      "const holder={};holder.target=module;holder.target.require=other;",
    ],
    [
      "copied child",
      "const holder={target:module};const copy={...holder};copy.target.require=other;",
    ],
    ["prototype member", "module.__proto__.require=other;"],
    ["constructor prototype", "module.constructor.prototype.require=other;"],
    [
      "prototype constructor cycle",
      "Object.getPrototypeOf(module).constructor.prototype.require=other;",
    ],
    [
      "repeated constructor prototype cycles",
      "module.constructor.prototype.constructor.prototype.require=other;",
    ],
    [
      "reflective constructor prototype alias",
      "const proto=module.constructor.prototype;Reflect.set(proto,'require',other);",
    ],
    [
      "constructor prototype in container",
      "const holder={proto:module.constructor.prototype};holder.proto.require=other;",
    ],
    [
      "prototype alias",
      "const proto=Object.getPrototypeOf(module);proto.require=other;",
    ],
    [
      "reflective prototype alias",
      "const proto=Reflect.getPrototypeOf(module);Reflect.set(proto,'require',other);",
    ],
    [
      "prototype defineProperty",
      "Object.defineProperty(Object.getPrototypeOf(module),'require',{value:other});",
    ],
    [
      "prototype in container",
      "const holder={proto:Object.getPrototypeOf(module)};holder.proto.require=other;",
    ],
    [
      "assigned prototype delegate",
      "const proto=Object.getPrototypeOf(module);Object.assign(proto,{require:other});",
    ],
    [
      "dynamic container delegate",
      "const holder={target:module};holder.target[key]=other;",
    ],
    [
      "default after source replacement",
      "const source={x:{}};source.x=undefined;const {x:target=module}=source;target.require=other;",
    ],
    [
      "nested store after reference copy",
      "const holder={target:{}};const copy={...holder};holder.target.inner=module;copy.target.inner.require=other;",
    ],
    [
      "nested store after getter capture",
      "const holder={};const box={get target(){return holder;}};const saved=box.target;holder.mod=module;saved.mod.require=other;",
    ],
  ])("rejects replacement through %s", (_name, setup) => {
    for (const loader of ["require", "Q"]) {
      const result = analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`,
      );
      expect(result.electron.browser_windows).toEqual([]);
    }
  });

  it.each([
    [
      "unrelated container",
      "const holder={target:{}};holder.target.require=other;",
    ],
    ["fresh copied module", "const holder={...module};holder.require=other;"],
    [
      "unrelated prototype",
      "const proto=Object.getPrototypeOf({});proto.require=other;",
    ],
    [
      "unrelated constructor prototype",
      "class Other{};Other.prototype.require=other;",
    ],
    [
      "unrelated constructor prototype property",
      "module.constructor.prototype.unrelated=other;",
    ],
    [
      "unrelated prototype property",
      "const proto=Object.getPrototypeOf(module);Object.assign(proto,{unrelated:other});",
    ],
    [
      "unused object default",
      "const {x:target=module}={x:{}};target.require=other;",
    ],
    [
      "unused array default",
      "const [target=module]=[{}];target.require=other;",
    ],
    [
      "captured non-module property",
      "const holder={target:{}};const saved=holder.target;holder.target=module;saved.require=other;",
    ],
    [
      "copied non-module property",
      "const holder={target:{}};const copy={...holder};holder.target=module;copy.target.require=other;",
    ],
    [
      "rest-copied non-module property",
      "const holder={target:{}};const {...copy}=holder;holder.target=module;copy.target.require=other;",
    ],
    [
      "inactive default store",
      "const holder={};({x:holder.target=module}={x:{}});holder.target.require=other;",
    ],
  ])("preserves the loader beside %s", (_name, setup) => {
    for (const loader of ["require", "Q"]) {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    }
  });

  it("retains loads before a prototype replacement", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}new (Q("electron").BrowserWindow)({});module.__proto__.require=other;`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });
});

describe("CommonJS constructor path normalization", () => {
  it.each([
    {
      name: "unrelated constructor property",
      source:
        "module.constructor.unrelated={};module.constructor.unrelated.require=other;",
      paths: [
        ["commonjs-module", "constructor", "unrelated"],
        ["commonjs-module", "constructor", "unrelated", "require"],
      ],
    },
    {
      name: "constructor beneath an unrelated module property",
      source:
        "module.unrelated={constructor:class Other{}};module.unrelated.constructor.prototype.require=other;",
      paths: [
        ["commonjs-module", "unrelated"],
        ["commonjs-module", "unrelated", "constructor", "prototype", "require"],
      ],
    },
  ])("preserves the nominal path for $name", ({ source, paths }) => {
    // Replaced module properties remain conservative aliases in loader analysis;
    // the path owner must nevertheless keep unrelated properties out of cycles.
    const parsed = parseJavaScriptSource(source, "app.cjs");
    if (parsed === null) throw new Error("Expected parsed source");
    const state = completeSemanticSteps(
      indexJavaScriptBindingsSteps(parsed.program),
    );
    expect(state.ambientWriteEffects.map(({ path }) => path)).toEqual(paths);
  });
});

describe("ambient destructuring default selection", () => {
  it.each([
    ["present object slot", "const {x:target=globalThis}={x:{}};", 1],
    ["present array slot", "const [target=globalThis]=[{}];", 1],
    ["present null slot", "const {x:target=globalThis}={x:null};", 1],
    [
      "unknown getter slot",
      "const {x:target=globalThis}={get x(){return input}};",
      0,
    ],
    [
      "legacy prototype slot",
      "const {__proto__:target=globalThis}={__proto__:null};",
      0,
    ],
    [
      "changed nested source slot",
      "const source={x:{}};source.x=undefined;const {x:target=globalThis}={x:source.x};",
      0,
    ],
    ["missing slot", "const {x:target=globalThis}={};", 0],
    ["undefined slot", "const {x:target=globalThis}={x:undefined};", 0],
    ["unknown slot", "const {x:target=globalThis}=input;", 0],
    [
      "changed source slot",
      "const source={x:{}};source.x=undefined;const {x:target=globalThis}=source;",
      0,
    ],
    [
      "captured local slot",
      "const holder={target:{}};const target=holder.target;holder.target=globalThis;",
      1,
    ],
    [
      "captured ambient slot",
      "const holder={target:globalThis};const target=holder.target;holder.target={};",
      0,
    ],
  ] as const)(
    "tracks only possible references for %s",
    (_name, setup, count) => {
      const result = analyzeJavaScriptStaticSource(
        `${setup}target.fetch=other;fetch('/local');`,
      );
      expect(
        result.endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
      ).toHaveLength(count);
    },
  );
});

it("tracks a later store into a getter-returned ambient container", () => {
  const result = analyzeJavaScriptStaticSource(
    "const holder={};const box={get target(){return holder;}};const saved=box.target;holder.g=globalThis;saved.g.fetch=other;fetch('/local');",
  );
  expect(
    result.endpoints.filter(({ mechanism }) => mechanism === "call:fetch"),
  ).toEqual([]);
});
