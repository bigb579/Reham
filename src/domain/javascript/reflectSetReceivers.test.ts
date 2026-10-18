import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const windowsAfter = (setup: string, loader = "Q") =>
  analyzeJavaScriptStaticSource(
    `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`,
  ).electron.browser_windows;

it.each([
  'Reflect.set(module,"require",other,{});',
  'const receiver={};Reflect.set(module,"require",other,receiver);',
  'var receiver={};Reflect.set(module,"require",other,receiver);',
  'const ambient=globalThis;let receiver={};Reflect.set(module,"require",other,receiver);',
  'const host=module;const receiver={};Reflect.set(host,"require",other,receiver);',
  'const set=Reflect.set;set(module,"require",other,{});',
  'const set=Reflect.set.bind(Reflect,module,"require",other);set({});',
  'Reflect.set.call(Reflect,module,"require",other,{});',
  'Reflect.apply(Reflect.set,Reflect,[module,"require",other,{}]);',
  'Reflect.set(module,"require",other,null);',
  'Reflect.set(require("module"),"_load",other,{});',
  'Reflect.set(require("electron"),"BrowserWindow",other,{});',
])(
  "preserves a loader when Reflect.set writes a distinct receiver: %s",
  (setup) => {
    expect(windowsAfter(setup)).toHaveLength(1);
    expect(windowsAfter(setup, "require")).toHaveLength(1);
  },
);

it.each([
  'Reflect.set(module,"require",other);',
  'Reflect.set(module,"require",other,module);',
  'const receiver=module;Reflect.set(module,"require",other,receiver);',
  'Reflect.set({},"require",other,module);',
  'Reflect.set(module,"require",other,unknownReceiver);',
  'Reflect.set(module,"require",other,flag?{}:module);',
  'var receiver={};globalThis.receiver=module;Reflect.set(module,"require",other,receiver);',
  'Reflect.set(require("module"),"_load",other);',
])(
  "retains module writes through possibly matching Reflect.set receivers: %s",
  (setup) => {
    expect(windowsAfter(setup)).toEqual([]);
  },
);

it("preserves shared helpers when only a fresh receiver gets an own property", () => {
  expect(
    analyzeJavaScriptStaticSource(
      'Reflect.set(Function.prototype,"call",other,{});new (require.call(null,"electron").BrowserWindow)({});',
    ).electron.browser_windows,
  ).toHaveLength(1);
});
