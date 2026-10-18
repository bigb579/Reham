import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const LOAD =
  'new (require.call.call(require,null,"electron").BrowserWindow)({});';

it.each([
  [
    "inherited constructor",
    'Function.prototype.constructor={prototype:{call:{call(){return{BrowserWindow:class{}}}}}};new (require.constructor.prototype.call.call(require,null,"electron").BrowserWindow)({});',
  ],
  [
    "inherited toString",
    'Function.prototype.toString={call:{call(){return{BrowserWindow:class{}}}}};new (require.toString.call.call(require,null,"electron").BrowserWindow)({});',
  ],
])("does not turn a possible %s value into loader proof", (_name, source) => {
  expect(
    analyzeJavaScriptStaticSource(source).electron.browser_windows,
  ).toEqual([]);
});

it.each([
  "Math.max",
  "JSON.parse",
  "Atomics.add",
  "console.log",
  "Promise.resolve",
  "Array.prototype.map",
  "RegExp.prototype.exec",
  "Intl.Collator",
  "WebAssembly.compile",
  "external.namespace.method",
])("retains a possible shared helper selected through %s", (receiver) => {
  expect(
    analyzeJavaScriptStaticSource(`${receiver}.call.call=other;${LOAD}`)
      .electron.browser_windows,
  ).toEqual([]);
});

it.each([
  "const method=Math[key];method.call.call=other;",
  "const method=Promise[key];method.call.call=other;",
  "const method=external[first][second];method.call.call=other;",
])("retains an unknown external member as a possible callable: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows,
  ).toEqual([]);
});

it.each([
  "Math.call=other;",
  "JSON.call=other;",
  "Atomics.call=other;",
  "console.call=other;",
  "Reflect.call=other;",
  "Math.max.call=other;",
  "Promise.resolve.call=other;",
  "Array.prototype.call=other;",
  "Array.prototype.map.call=other;",
  "Function.length.call.call=other;",
  "Function.name.call.call=other;",
  "Math.PI.call.call=other;",
  "Array.prototype.length.call.call=other;",
])("preserves namespace, own-property and primitive controls: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(`${setup}${LOAD}`).electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  'require.call.call(require,null,"electron")',
  'Function.prototype.call.call(require,null,"electron")',
  'require.__proto__.call.call(require,null,"electron")',
  'Reflect.apply(require,null,["electron"])',
])("preserves existing strict helper invocation: %s", (load) => {
  expect(
    analyzeJavaScriptStaticSource(`new (${load}.BrowserWindow)({});`).electron
      .browser_windows,
  ).toHaveLength(1);
});

it("preserves a helper captured before an external callable changes it", () => {
  expect(
    analyzeJavaScriptStaticSource(
      'const invoke=require.call.call;Math.max.call.call=other;new (Reflect.apply(invoke,require,[null,"electron"]).BrowserWindow)({});',
    ).electron.browser_windows,
  ).toHaveLength(1);
});

it.each([
  "const value=module.require;",
  'const value=require("module");',
  'const value=require("module").createRequire;',
])(
  "keeps source-owned additions to a known loader value separate: %s",
  (setup) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${setup}value.extra={call:{}};value.extra[key].call=other;${LOAD}`,
      ).electron.browser_windows,
    ).toHaveLength(1);
  },
);
