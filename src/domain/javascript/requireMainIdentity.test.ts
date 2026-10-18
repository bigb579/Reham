import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

it.each([
  "require.main.constructor._load=other;",
  "const main=require.main;main.constructor._load=other;",
  "const {main}=require;main.constructor._load=other;",
  "const main=require.main;if(main)main.constructor._load=other;",
  "require.main.__proto__.constructor._load=other;",
  "require.main.constructor.prototype.require=other;",
  "Object.getPrototypeOf(require.main).require=other;",
  "const owner=require.main.constructor;owner._load=other;",
  "const box={main:require.main};box.main.constructor._load=other;",
  "const main=require[key];main.constructor._load=other;",
])(
  "rejects shared Module changes through a possible main instance: %s",
  (setup) => {
    for (const loader of ["require", "Q"])
      expect(
        analyzeJavaScriptStaticSource(
          `${SHIM}${setup}new (${loader}("electron").BrowserWindow)({});`,
        ).electron.browser_windows,
      ).toEqual([]);
  },
);

it.each([
  "require.main._load=other;",
  "require.main.require=other;",
  "require.main.constructor=other;",
  "require.main.call={};require.main.call.call=other;",
  "require.main.extra={constructor:{}};require.main.extra.constructor._load=other;",
  "const fake={main:{constructor:{}}};fake.main.constructor._load=other;",
  "function change(require){require.main.constructor._load=other;}change({main:{constructor:{}}});",
])("keeps instance-owned and shadowed main values separate: %s", (setup) => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}${setup}new (Q("electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});

it.each(["require.main.require", "require.main.constructor"])(
  "retains shared helper writes through a main-instance callable: %s",
  (value) => {
    expect(
      analyzeJavaScriptStaticSource(
        `${value}.call.call=other;new (require.call.call(require,null,"electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  },
);

it("retains an earlier load before the main constructor is changed", () => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}new (Q("electron").BrowserWindow)({});require.main.constructor._load=other;`,
    ).electron.browser_windows,
  ).toHaveLength(1);
});

it("preserves a captured main instance after the main slot is replaced", () => {
  expect(
    analyzeJavaScriptStaticSource(
      `${SHIM}const main=require.main;require.main={};main.constructor._load=other;new (Q("electron").BrowserWindow)({});`,
    ).electron.browser_windows,
  ).toEqual([]);
});

it.each(["require.main.require", "require.main.require.bind(require.main)"])(
  "does not prove a loader from a possibly absent main instance: %s",
  (load) => {
    expect(
      analyzeJavaScriptStaticSource(
        `const load=${load};new (load("electron").BrowserWindow)({});`,
      ).electron.browser_windows,
    ).toEqual([]);
  },
);
