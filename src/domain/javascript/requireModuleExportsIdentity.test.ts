import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

describe("Module prototype ownership", () => {
  it.each([
    ["legacy parent setter", "module.__proto__.__proto__={};"],
    [
      "constructor prototype parent",
      "module.constructor.prototype.__proto__={};",
    ],
    ["captured prototype", "const proto=module.__proto__;proto.__proto__={};"],
    [
      "Object prototype mutation",
      "Object.setPrototypeOf(module.__proto__,{});",
    ],
    [
      "Reflect prototype mutation",
      "Reflect.setPrototypeOf(module.constructor.prototype,{});",
    ],
    ["Reflect parent setter", 'Reflect.set(module.__proto__,"__proto__",{});'],
    [
      "assigned parent setter",
      'Object.assign(module.__proto__,{["__proto__"]:{}});',
    ],
    ["ancestor require slot", "module.__proto__.__proto__.require=other;"],
    [
      "constructor parent",
      "Object.setPrototypeOf(module.constructor,{_load:other});",
    ],
  ])("retains the owned delegate after %s", (_name, setup) => {
    for (const load of [
      'require("electron")',
      'Q("electron")',
      'module.require("electron")',
    ]) {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${setup}new (${load}.BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    }
  });

  it.each([
    "module.__proto__={};",
    "Object.setPrototypeOf(module,{});",
    'Reflect.set(module,"__proto__",{});',
    "module.require=other;",
    "module.__proto__.require=other;",
    "module.constructor.prototype.require=other;",
    'Reflect.set(module.constructor,"_load",other);',
  ])("rejects changes to the selected delegate or its owner: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it("retains a delegate captured before its prototype parent changes", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;module.__proto__.__proto__={};new (load.call(module,"electron").BrowserWindow)({});',
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("keeps ancestor callable slots distinct from delegate helpers", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;Object.prototype.require=function(){};module.__proto__.__proto__.require.call=other;new (load.call(module,"electron").BrowserWindow)({});',
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains an earlier load before the immediate prototype changes", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}new (Q("electron").BrowserWindow)({});module.__proto__={};`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("rejects a live internal loader mutation after delegate capture", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;module.constructor._load=other;new (load.call(module,"electron").BrowserWindow)({});',
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it("rejects a live delegate helper mutation after delegate capture", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;module.constructor.prototype.require.call=other;new (load.call(module,"electron").BrowserWindow)({});',
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it("retains a helper captured before the delegate own slot changes", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;const invoke=load.call;module.constructor.prototype.require.call=other;new (Reflect.apply(invoke,load,[module,"electron"]).BrowserWindow)({});',
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it.each([
    'module.__proto__.require.call(module,"electron")',
    'module.__proto__.__proto__.require.call(module,"electron")',
    'module.__proto__.constructor.createRequire("/app.cjs")("electron")',
  ])("does not promote a prototype path to strict loader proof: %s", (load) => {
    expect(
      analyzeJavaScriptStaticSource(`new (${load}.BrowserWindow)({});`).electron
        .browser_windows,
    ).toEqual([]);
  });
});

describe("cached Module instance identity", () => {
  it.each([
    [
      "wrapper cache constructor",
      "require.cache[__filename].constructor._load=other;",
    ],
    [
      "literal cache key",
      'require.cache["/app.cjs"].constructor.prototype.require=other;',
    ],
    ["cached wrapper delegate", "require.cache[__filename].require=other;"],
    ["unknown cache key", 'Reflect.set(require.cache[key],"require",other);'],
    [
      "cache prototype",
      'Reflect.set(Object.getPrototypeOf(require.cache[key]),"require",other);',
    ],
    [
      "cache alias",
      'const cache=require.cache;const entry=cache[key];Reflect.set(entry.constructor,"_load",other);',
    ],
    [
      "Module cache",
      'const M=require("module");M._cache[__filename].constructor._load=other;',
    ],
    [
      "named Module cache",
      'require("node:module").Module._cache[key].require=other;',
    ],
    [
      "imported Module cache",
      'import M from "module";M._cache[key].constructor.prototype.require=other;',
    ],
    ["cached parent", "require.cache[key].parent.constructor._load=other;"],
    [
      "cached child",
      "require.cache[key].children[index].constructor.prototype.require=other;",
    ],
    ["unknown cache selector", "require[slot][key].constructor._load=other;"],
    [
      "copied cache entry",
      "const box={entry:require.cache[key]};const copy={...box};copy.entry.require=other;",
    ],
    [
      "saved cache entry",
      "const entry=require.cache[key];require.cache={};entry.require=other;",
    ],
    [
      "saved cache slot",
      'const cache=require.cache;require.cache={};Reflect.set(cache[key],"require",other);',
    ],
    [
      "constructor cache cycle",
      "require.cache[key].constructor.Module._cache[next].constructor.prototype.require=other;",
    ],
  ])("rejects changed shared loader state through %s", (_name, setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each([
    "require.cache[key].require.call.call=other;",
    "require.cache[key].exports.call.call=other;",
  ])("tracks cached Module callable helpers: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}new (require.call.call(require,null,"electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each([
    "const local={cache:{entry:{constructor:{prototype:{}}}}};local.cache.entry.constructor.prototype.require=other;",
    "let cache=require.cache;cache={entry:{}};cache.entry.require=other;",
    "require.cache[key].parent.require=other;",
    "require.cache[key].children[0].require=other;",
    "require.cache[key].constructor=other;",
    "require.cache[key].unrelated=other;",
    "require.cache[key]=other;",
  ])("preserves distinct cache or instance slots: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains an earlier load before a cached Module mutation", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}new (Q("electron").BrowserWindow)({});require.cache[__filename].require=other;`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains a saved delegate across a cached own-slot mutation", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;require.cache[__filename].require=other;new (load.call(module,"electron").BrowserWindow)({});',
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it.each([
    'require.cache[key].require("electron")',
    'require("module")._cache[key].require("electron")',
    'require.cache[key].constructor.createRequire("/app.cjs")("electron")',
  ])("does not grant strict loader proof to a cache entry: %s", (load) => {
    expect(
      analyzeJavaScriptStaticSource(`new (${load}.BrowserWindow)({});`).electron
        .browser_windows,
    ).toEqual([]);
  });
});

describe("related Module instance identity", () => {
  it.each([
    [
      "parent constructor",
      "module.parent.constructor.prototype.require=other;",
    ],
    [
      "parent chain",
      "module.parent.parent.constructor.prototype.require=other;",
    ],
    [
      "parent prototype",
      'Reflect.set(Object.getPrototypeOf(module.parent),"require",other);',
    ],
    [
      "captured parent",
      'const parent=module.parent;module.parent=other;Reflect.set(parent.constructor.prototype,"require",other);',
    ],
    [
      "copied parent alias",
      "const box={parent:module.parent};const copy={...box};copy.parent.constructor.prototype.require=other;",
    ],
    ["parent internal loader", "module.parent.constructor._load=other;"],
    [
      "main module parent",
      "require.main.parent.constructor.prototype.require=other;",
    ],
    ["child module", "module.children[0].constructor.prototype.require=other;"],
    [
      "unknown child module",
      'Reflect.set(module.children[index].constructor.prototype,"require",other);',
    ],
    ["unknown parent member", "module.parent[key].prototype.require=other;"],
    [
      "unknown related module",
      "module[key].constructor.prototype.require=other;",
    ],
  ])("rejects shared delegate mutation through %s", (_name, setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each([
    "module.parent.require=other;",
    'Reflect.set(module.parent,"require",other);',
    "module.parent.constructor=other;",
    "module.parent.__proto__={require:other};",
    "Object.setPrototypeOf(module.parent,{require:other});",
    'Object.defineProperty(module.parent,"__proto__",{value:{require:other}});',
    "module.parent.parent.require=other;",
    "module.children[0].require=other;",
    "const otherModule={parent:{constructor:{prototype:{}}}};otherModule.parent.constructor.prototype.require=other;",
    "const module={parent:{constructor:{prototype:{}}}};module.parent.constructor.prototype.require=other;",
  ])("preserves an unrelated instance's own mutation: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains an earlier load before a parent prototype mutation", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}new (Q("electron").BrowserWindow)({});module.parent.constructor.prototype.require=other;`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains a delegate captured before a parent prototype mutation", () => {
    expect(
      analyzeJavaScriptStaticSource(
        'const load=module.require;module.parent.constructor.prototype.require=other;new (load.call(module,"electron").BrowserWindow)({});',
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it.each([
    "module.__defineGetter__.call.call=other;",
    "module.__proto__.__defineSetter__.call.call=other;",
    "module.parent.__defineGetter__.call.call=other;",
    "module.parent.constructor.__proto__.call=other;",
    "module.parent.require.call.call=other;",
    "module.parent.exports.call.call=other;",
    "module.children[0].exports.call.call=other;",
  ])("tracks shared function helpers through parent modules: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}new (require.call.call(require,null,"electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it("retains stored aliases below equivalent shared prototype paths", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}module.constructor.prototype.box.alias=module;module.__proto__.box.alias.require=other;new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each([
    'module.parent.require("electron")',
    'require.main.parent.require("electron")',
    'module.children[0].require("electron")',
  ])(
    "does not grant strict loader proof to a possible instance: %s",
    (load) => {
      expect(
        analyzeJavaScriptStaticSource(`new (${load}.BrowserWindow)({});`)
          .electron.browser_windows,
      ).toEqual([]);
    },
  );
});

describe("shared Module storage identities", () => {
  describe.each([
    [
      "prototype to constructor",
      "module.__proto__",
      "module.constructor.prototype",
    ],
    [
      "constructor to prototype",
      "module.constructor.prototype",
      "module.__proto__",
    ],
    [
      "constructor to parent",
      "module.constructor",
      "module.parent.constructor",
    ],
    [
      "parent to constructor",
      "module.parent.constructor",
      "module.constructor",
    ],
  ])("shared stores from %s", (_name, written, read) => {
    it("follows the stored wrapper module", () => {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${written}.box=module;${read}.box.require=other;new (Q("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
    });

    it("keeps a stored local object separate", () => {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${written}.box={};${read}.box.require=other;new (Q("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toHaveLength(1);
    });
  });

  it("retains a local slot captured before its shared owner is changed", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}module.__proto__.box={};const saved=module.constructor.prototype.box;module.__proto__.box=module;saved.require=other;new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains a wrapper slot captured before its shared owner is changed", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}module.__proto__.box=module;const saved=module.constructor.prototype.box;module.__proto__.box={};saved.require=other;new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });

  it.each([
    "module.__proto__.box=unknown;module.constructor.prototype.box.require=other;",
    "function change(){module.__proto__.box=module}change();module.constructor.prototype.box.require=other;",
  ])("retains unknown or deferred stored aliases: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  });
});

describe("Node Module constructor delegate identity", () => {
  it.each([
    [
      "public constructor",
      'const M=require("module");M.prototype.require=other;',
    ],
    [
      "prefixed public constructor",
      'const M=require("node:module");M.prototype.require=other;',
    ],
    [
      "named export",
      'const {Module:M}=require("module");M.prototype.require=other;',
    ],
    [
      "nested self export",
      'const M=require("node:module").Module.Module;M.prototype.require=other;',
    ],
    ["inline constructor", 'require("module").prototype.require=other;'],
    [
      "stored constructor",
      'const box={};box.M=require("module");box.M.prototype.require=other;',
    ],
    [
      "copied prototype",
      'const M=require("module");const box={proto:M.prototype};const copy={...box};Reflect.set(copy.proto,"require",other);',
    ],
    [
      "default import",
      'import M from "node:module";M.prototype.require=other;',
    ],
    [
      "named import",
      'import {Module as M} from "module";M.prototype.require=other;',
    ],
    [
      "namespace default",
      'import * as M from "node:module";M.default.prototype.require=other;',
    ],
    [
      "namespace named export",
      'import * as M from "module";M.Module.prototype.require=other;',
    ],
    [
      "shim-loaded constructor",
      'const M=Q("module");M.prototype.require=other;',
    ],
    [
      "constructor cycle",
      'const M=require("module");M.prototype.constructor.prototype.require=other;',
    ],
    [
      "captured constructor",
      'let M=require("module");const saved=M;M=class Other{};saved.prototype.require=other;',
    ],
    [
      "unknown constructor selection",
      'const M=require("module");M[key].require=other;',
    ],
    [
      "unknown self export",
      'const M=require("module");M[key].prototype.require=other;',
    ],
    [
      "unknown namespace export",
      'import * as M from "module";M[key].prototype.require=other;',
    ],
  ])("rejects redirected loads through %s", (_name, setup) => {
    for (const loader of ["require", "Q"]) {
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
    }
  });
});

describe("Node Module constructor isolation", () => {
  it.each([
    [
      "unrelated package",
      'const M=require("other");M.prototype.require=other;',
    ],
    [
      "unrelated export",
      'const M=require("module").Other;M.prototype.require=other;',
    ],
    ["constructor property", 'const M=require("module");M.require=other;'],
    [
      "unrelated prototype property",
      'const M=require("module");M.prototype.unrelated=other;',
    ],
    [
      "replaced constructor binding",
      'let M=require("module");M=class Other{};M.prototype.require=other;',
    ],
    [
      "captured unrelated constructor",
      'let M=class Other{};const saved=M;M=require("module");saved.prototype.require=other;',
    ],
    [
      "shadowed module loader",
      'function change(require){const M=require("module");M.prototype.require=other;}',
    ],
    [
      "Object constructor beyond the Module prototype",
      "module.__proto__.__proto__.constructor._load=other;",
    ],
  ])("preserves loads beside %s", (_name, setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });

  it("retains a load before the exported prototype is changed", () => {
    expect(
      analyzeJavaScriptStaticSource(
        `${SHIM}const M=require("module");new (Q("electron").BrowserWindow)({});M.prototype.require=other;`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  });
});

it.each([
  'const M=require("module");M._load=other;',
  "module.constructor._load=other;",
  'const M=require("module");Object.assign(M,{_load:other});',
  'const M=require("module");M.prototype.constructor._load=other;',
  "Object.getPrototypeOf(module).constructor._load=other;",
  'const M=require("module");Object.assign(M.prototype.constructor,{_load:other});',
])("rejects a replaced constructor loader: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toEqual([]);
});

it("preserves earlier loads and unrelated constructor assignments", () => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}const M=require("module");Object.assign(M,{unrelated:other});new (Q("electron").BrowserWindow)({});M._load=other;`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  ["module method", 'const M=module.require("module");'],
  ["computed module method", 'const M=module["require"]("module");'],
  ["optional module method", 'const M=module.require?.("module");'],
  ["module alias", 'const m=module;const M=m.require("module");'],
  [
    "saved receiver",
    'const m=module;module=other;const M=m.require("module");',
  ],
  ["method call", 'const M=module.require.call(module,"module");'],
  ["method apply", 'const M=module.require.apply(module,["module"]);'],
  [
    "bound method",
    'const load=module.require.bind(module);const M=load("module");',
  ],
  [
    "saved method",
    'const load=module.require;const M=load.call(module,"module");',
  ],
  ["loader alias", 'const load=require;const M=load("module");'],
  [
    "named factory import",
    'import {createRequire} from "node:module";const load=createRequire(import.meta.url);const M=load("module");',
  ],
  [
    "default factory import",
    'import Mod from "node:module";const load=Mod.createRequire(import.meta.url);const M=load("module");',
  ],
  [
    "namespace factory import",
    'import * as Mod from "node:module";const load=Mod.default.createRequire(import.meta.url);const M=load("module");',
  ],
  [
    "required factory",
    'const {createRequire}=require("module");const load=createRequire("/tmp/a.cjs");const M=load("module");',
  ],
  [
    "local require factory",
    'import {createRequire} from "node:module";const require=createRequire(import.meta.url);const M=require("module");',
  ],
])("shares Module delegate identity through %s", (_name, setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}${setup}M.prototype.require=other;new (Q("electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toEqual([]);
});

it.each([
  'module.require("electron")',
  'module.require?.("electron")',
  'module.require.call(module,"electron")',
  'module.require.apply(module,["electron"])',
  'Reflect.apply(module.require,module,["electron"])',
])("recovers an intact loader invocation: %s", (load) => {
  expect(
    analyzeJavaScriptStaticSource(`new (${load}.BrowserWindow)({});`).electron
      .browser_windows,
  ).toHaveLength(1);
});

it.each([
  ["intact nested call", "", 'require.call.call(require,null,"electron")'],
  ["intact nested apply", "", 'require.call.apply(require,[null,"electron"])'],
  [
    "saved shared helper",
    "const call=require.call;Function.prototype.call=other;",
    'Reflect.apply(call,require,[null,"electron"])',
  ],
  [
    "saved nested shared helper",
    "const call=require.call.call;Function.prototype.call.call=other;",
    'Reflect.apply(call,require,[null,"electron"])',
  ],
  [
    "unrelated helper member",
    "Function.prototype.call.unrelated=other;",
    'require.call.call(require,null,"electron")',
  ],
  [
    "unrelated callable-shaped object",
    "const local={call:{call:other}};local.call.call=another;",
    'require.call.call(require,null,"electron")',
  ],
  [
    "unrelated unknown projection",
    "require.unrelated={call:{}};require.unrelated[key].call=other;",
    'require.call.call(require,null,"electron")',
  ],
  [
    "saved delegate",
    "const load=module.require.bind(module);module.require=other;",
    'load("electron")',
  ],
  [
    "saved unbound method",
    "const load=module.require;module.require=other;",
    'load.call(module,"electron")',
  ],
  ["saved receiver", "const m=module;module=other;", 'm.require("electron")'],
  [
    "saved wrapper",
    "let load=require;const saved=load;load=other;",
    'saved("electron")',
  ],
  [
    "created loader after wrapper patch",
    'const make=require("module").createRequire;const load=make("/tmp/a.cjs");module.require=other;',
    'load("electron")',
  ],
  [
    "saved invocation helper",
    "const apply=Reflect.apply;Reflect.apply=other;",
    'apply(require,null,["electron"])',
  ],
  [
    "saved factory",
    'const M=require("module");const make=M.createRequire;M.createRequire=other;const load=make("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "named ESM factory",
    'import M,{createRequire} from "node:module";M.createRequire=other;const load=createRequire(import.meta.url);',
    'load("electron")',
  ],
  [
    "unrelated own property",
    "module.require.unrelated=other;",
    'module.require("electron")',
  ],
])("preserves %s capture", (_name, setup, load) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}new (${load}.BrowserWindow)({});`)
      .electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  [
    "shadowed module",
    "const module={require:other};",
    'module.require("electron")',
  ],
  ["replaced module", "module=other;", 'module.require("electron")'],
  ["replaced method", "module.require=other;", 'module.require("electron")'],
  [
    "replaced prototype method",
    "module.constructor.prototype.require=other;",
    'module.require("electron")',
  ],
  [
    "reassigned method alias",
    "let load=module.require.bind(module);load=other;",
    'load("electron")',
  ],
  [
    "reassigned loader alias",
    "let load=require;load=other;",
    'load("electron")',
  ],
  ["wrong receiver", "", 'module.require.call({},"electron")'],
  ["detached method", "", '(0,module.require)("electron")'],
  [
    "changed internal loader",
    "const load=module.require.bind(module);module.constructor._load=other;",
    'load("electron")',
  ],
  [
    "default factory replacement",
    'import M from "node:module";M.createRequire=other;const load=M.createRequire(import.meta.url);',
    'load("electron")',
  ],
  [
    "namespace default factory replacement",
    'import * as M from "node:module";M.default.createRequire=other;const load=M.default.createRequire(import.meta.url);',
    'load("electron")',
  ],
  [
    "required factory replacement",
    'const M=require("module");M.createRequire=other;const load=M.createRequire("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "factory import-equals reassignment",
    'import M = require("module");M=other;const load=M.createRequire("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "created loader own helper",
    'const make=require("module").createRequire;const load=make("/tmp/a.cjs");load.call=other;',
    'load.call(null,"electron")',
  ],
  [
    "named factory own helper",
    'import {createRequire} from "node:module";createRequire.call=other;const load=createRequire.call(null,import.meta.url);',
    'load("electron")',
  ],
  [
    "created loader shared prototype patch",
    'const make=require("module").createRequire;const load=make("/tmp/a.cjs");module.constructor.prototype.require=other;',
    'load("electron")',
  ],
  [
    "reassigned factory module",
    'let M=require("module");M=other;const load=M.createRequire("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "fake default property",
    'const M=require("module");M.default={createRequire:other};const load=M.default.createRequire("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "missing default property",
    'const load=require("module").default.createRequire("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "replaced self export",
    'const M=require("module");M.Module={createRequire:other};const load=M.Module.createRequire("/tmp/a.cjs");',
    'load("electron")',
  ],
  [
    "unknown shared helper object",
    "require[key].call=other;",
    'Function.prototype.call.call(require,null,"electron")',
  ],
  [
    "unknown callable prototype",
    "require[key].call=other;",
    'require.call(null,"electron")',
  ],
  [
    "repeated unknown helper object",
    "require[key][next].call=other;",
    'Function.prototype.apply.call(require,null,["electron"])',
  ],
  [
    "nested call function own call",
    "Function.prototype.call.call=other;",
    'require.call.call(require,null,"electron")',
  ],
  [
    "nested apply function own call",
    "Function.prototype.apply.call=other;",
    'require.apply.call(require,null,["electron"])',
  ],
  [
    "nested call function own apply",
    "Function.prototype.call.apply=other;",
    'require.call.apply(require,[null,"electron"])',
  ],
  [
    "nested reverse helper alias",
    "require.call.call=other;",
    'Function.prototype.call.call(require,null,"electron")',
  ],
  [
    "wrapper helper prototype replacement",
    "require.__proto__={call:other};",
    'require.call(null,"electron")',
  ],
  [
    "wrapper helper prototype mutation",
    "Object.getPrototypeOf(require).call=other;",
    'require.call(null,"electron")',
  ],
  [
    "delegate helper prototype mutation",
    "Object.getPrototypeOf(module.require).call=other;",
    'module.require.call(module,"electron")',
  ],
  [
    "nested helper prototype replacement",
    "Object.setPrototypeOf(Function.prototype.call,{call:other});",
    'require.call.call(require,null,"electron")',
  ],
  ...["call", "apply", "bind"].flatMap((method) => [
    [
      `wrapper own ${method}`,
      `require.${method}=other;`,
      method === "bind"
        ? 'require.bind(null)("electron")'
        : `require.${method}(null,${method === "apply" ? '["electron"]' : '"electron"'})`,
    ],
    [
      `delegate own ${method}`,
      `module.require.${method}=other;`,
      method === "bind"
        ? 'module.require.bind(module)("electron")'
        : `module.require.${method}(module,${method === "apply" ? '["electron"]' : '"electron"'})`,
    ],
    [
      `Function prototype ${method}`,
      `Function.prototype.${method}=other;`,
      method === "bind"
        ? 'require.bind(null)("electron")'
        : `require.${method}(null,${method === "apply" ? '["electron"]' : '"electron"'})`,
    ],
    [
      `factory own ${method}`,
      `const M=require("module");M.createRequire.${method}=other;const load=${method === "bind" ? 'M.createRequire.bind(null)("/tmp/a.cjs")' : `M.createRequire.${method}(null,${method === "apply" ? '["/tmp/a.cjs"]' : '"/tmp/a.cjs"'})`};`,
      'load("electron")',
    ],
  ]),
])("does not prove a loader after %s", (_name, setup, load) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}new (${load}.BrowserWindow)({});`)
      .electron.browser_windows,
  ).toEqual([]);
});

it.each([
  ["public Module constructor", 'const value=require("module");'],
  ["Module prototype constructor", "const value=module.constructor;"],
  ["Module self export", 'const value=require("module").Module;'],
  ["Module default import", 'import value from "node:module";'],
  ["Module named import", 'import {Module as value} from "module";'],
  ["Module internal loader", 'const value=require("module")._load;'],
  ["Object constructor", "const value=Object;"],
  ["Object intrinsic", "const value=Object.defineProperty;"],
  [
    "Object prototype intrinsic",
    "const value=Object.prototype.hasOwnProperty;",
  ],
  ["Array constructor", "const value=Array;"],
  ["require resolution function", "const value=require.resolve;"],
  [
    "created loader",
    'const value=require("module").createRequire("/tmp/a.cjs");',
  ],
  ["function declaration", "function value(){}"],
  ["arrow function", "const value=()=>{};"],
  ["async function", "async function value(){}"],
  ["generator function", "function* value(){}"],
  ["async generator function", "async function* value(){}"],
  ["class constructor", "class value{}"],
  ["object method", "const object={method(){}};const value=object.method;"],
  ["class static method", "class C{static method(){}}const value=C.method;"],
  [
    "class prototype method",
    "class C{method(){}}const value=C.prototype.method;",
  ],
  ["class static field", "class C{static method=()=>{}}const value=C.method;"],
  [
    "object getter result",
    "const object={get method(){return ()=>{}}};const value=object.method;",
  ],
  [
    "class getter result",
    "class C{static get method(){return ()=>{}}}const value=C.method;",
  ],
  [
    "returned function",
    "function make(){return function(){};}const value=make();",
  ],
  ["bound function", "function f(){}const value=f.bind(null);"],
  ["bound arrow", "const value=(()=>{}).bind(null);"],
  ["bound intrinsic", "const value=Object.assign.bind(null);"],
  ["bound async function", "async function f(){}const value=f.bind(null);"],
  ["Function factory", "const value=Function();"],
  ["Function constructor", "const value=new Function();"],
  ["object literal constructor", "const value=({}).constructor;"],
  ["array literal constructor", "const value=[].constructor;"],
])("rejects a shared helper changed through %s", (_name, setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${setup}value.call.call=other;new (require.call.call(require,null,"electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toEqual([]);
});

it.each([
  ["function constructor", "require.constructor.prototype.call=other;"],
  ["helper constructor", "require.call.constructor.prototype.call=other;"],
  ["Module function prototype", 'require("module").__proto__.call=other;'],
  [
    "ordinary function prototype",
    "function f(){};Object.getPrototypeOf(f).call=other;",
  ],
  [
    "async function prototype chain",
    "async function f(){};Object.getPrototypeOf(Object.getPrototypeOf(f)).call=other;",
  ],
  [
    "generator function prototype chain",
    "function* f(){};Object.getPrototypeOf(Object.getPrototypeOf(f)).call=other;",
  ],
  [
    "derived class prototype chain",
    "class B{};class C extends B{};C.__proto__.__proto__.call=other;",
  ],
  [
    "async constructor parent",
    "async function f(){};f.constructor.__proto__.prototype.call=other;",
  ],
])("rejects an inherited helper changed through %s", (_name, setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${setup}new (require.call(null,"electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toEqual([]);
});

it.each([
  'const M=require("module");M.call=other;',
  'const M=require("module");M.prototype.call=other;',
  "Object.assign.call=other;",
  "function f(){};f.call=other;",
  "function f(){};f.prototype.call=other;",
  "function f(){};f.constructor=other;",
  "async function f(){};Object.getPrototypeOf(f).call=other;",
  "function* f(){};f.prototype.call=other;",
  "Object.getPrototypeOf(Function.prototype).call=other;",
  "class B{};class C extends B{};C.__proto__.call=other;",
  "const object={method(){}};object.method.call=other;",
  "class C{static method(){}}C.method.call=other;",
  "class C{method(){}}C.prototype.method.call=other;",
  "const object={get method(){return {call:{}}}};object.method.call.call=other;",
  "class C{static get method(){return {call:{}}}}C.method.call.call=other;",
  "class C{static method(){};static method={call:{}}}C.method.call.call=other;",
  "class C{method(){};static method={call:{}}}C.method.call.call=other;",
  "class B{static method(){}}class C extends B{static method={call:{}}}C.method.call.call=other;",
  "class C{static method={call:{}};static method(){}}C.method.call.call=other;",
  "async function f(){};const bound=f.bind(null);Object.getPrototypeOf(bound).call=other;",
  "const object={constructor:{call:{}}};object.constructor.call.call=other;",
  "const object={__proto__:{constructor:{call:{}}}};object.constructor.call.call=other;",
  "const array=[{call:{}}];array[0].call.call=other;",
  "const array=[];array.length.call.call=other;",
])("keeps unrelated own callable properties separate: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${setup}new (require.call.call(require,null,"electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});

it("retains a helper captured before a shared function property replacement", () => {
  expect(
    analyzeJavaScriptStaticSource(
      'const invoke=require.call.call;const M=require("module");M.call.call=other;new (Reflect.apply(invoke,require,[null,"electron"]).BrowserWindow)({});',
    ).electron.browser_windows,
  ).toHaveLength(1);
});
