import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyBinding } from "./javascriptSemanticAnalysis.fixture.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';

const provenanceOf = (source: string, path = "bundle.cjs") => {
  const parsed = parseJavaScriptSource(source, path);
  expect(parsed).not.toBeNull();
  return onlyBinding(analyzeParsedJavaScriptSemantics(parsed!), "loaded")
    .provenance;
};

describe("opaque effects on host module delegates", () => {
  it("rejects shim provenance when eval shadows only the shim name", () => {
    expect(
      provenanceOf(
        `${SHIM}function patch(Q){eval('module.require=()=>({})')}patch(null);const loaded=Q("electron");`,
      ).origins,
    ).toEqual([]);
  });

  it.each([
    ["direct wrapper", "", 'require("electron")'],
    ["saved wrapper", "const saved=require;", 'saved("electron")'],
    ["module method", "", 'module.require("electron")'],
    [
      "saved module method",
      "const saved=module.require;",
      'saved.call(module,"electron")',
    ],
    [
      "bound module method",
      "const saved=module.require.bind(module);",
      'saved("electron")',
    ],
    [
      "created loader",
      'const saved=require("node:module").createRequire("/tmp/opaque.cjs");',
      'saved("electron")',
    ],
  ])(
    "rejects %s provenance when eval can mutate the shared constructor loader",
    (_name, setup, load) => {
      expect(
        provenanceOf(
          `${setup}function patch(require,saved){eval('module.constructor._load=()=>({})')}patch(null,null);const loaded=${load};`,
        ).origins,
      ).toEqual([]);
    },
  );

  it("retains delegate uncertainty inside strict direct eval", () => {
    expect(
      provenanceOf(
        `${SHIM}function patch(Q){"use strict";eval('module.require=()=>({})')}patch(null);const loaded=Q("electron");`,
      ).origins,
    ).toEqual([]);
  });

  it("retains uncertainty through a visible alias of a shadowed module", () => {
    expect(
      provenanceOf(
        `${SHIM}const host=module;function patch(Q,module,require){eval('host.require=()=>({})')}patch(null,{},null);const loaded=Q("electron");`,
      ).origins,
    ).toEqual([]);
  });

  it.each([
    ["object contents", "const box={host:module};", "box.host.require"],
    ["array contents", "const box=[module];", "box[0].require"],
    ["later object store", "const box={};box.host=module;", "box.host.require"],
    [
      "captured module constructor",
      "const Module=module.constructor;",
      "Module._load",
    ],
    [
      "required Module export",
      'const Module=require("node:module");',
      "Module._load",
    ],
    [
      "named Module import",
      'import {Module} from "node:module";',
      "Module._load",
    ],
  ])(
    "rejects provenance when eval can reach shared delegates through %s",
    (_name, setup, target) => {
      expect(
        provenanceOf(
          `${SHIM}${setup}function patch(Q,module,require){eval('${target}=()=>({})')}patch(null,{},null);const loaded=Q("electron");`,
        ).origins,
      ).toEqual([]);
    },
  );
});

describe("opaque module delegate isolation", () => {
  it.each([
    "const box={host:{}};",
    "const box=[{}];",
    "const box={exports:module.exports};",
    "const Module=class {};",
    'const Module=require("unrelated-package");',
  ])("preserves provenance beside unrelated visible contents: %s", (setup) => {
    expect(
      provenanceOf(
        `${SHIM}${setup}function patch(Q,module,require){eval('module.require=other')}patch(null,{},null);const loaded=Q("electron");`,
      ),
    ).toMatchObject({
      status: "module",
      origins: [{ specifier: "electron" }],
    });
  });

  it.each([
    [
      "shadowed module and require",
      'function patch(Q,module,require){eval("module.require=other")}patch(null,{},null);',
    ],
    [
      "shadowed eval",
      'function patch(Q,eval){eval("module.require=other")}patch(null,()=>{});',
    ],
    [
      "indirect eval",
      'function patch(Q){(0,eval)("globalThis.unrelated=1")}patch(null);',
    ],
  ])("preserves wrapper provenance beside %s", (_name, effect) => {
    expect(
      provenanceOf(`${SHIM}${effect}const loaded=Q("electron");`),
    ).toMatchObject({
      status: "module",
      origins: [{ specifier: "electron" }],
    });
  });

  it("retains a loader call before top-level opaque effects", () => {
    expect(
      provenanceOf(
        `${SHIM}const loaded=Q("electron");eval("module.require=other");`,
      ),
    ).toMatchObject({
      status: "module",
      origins: [{ specifier: "electron" }],
    });
  });

  it.each([
    [
      "saved module method",
      "const saved=module.require;",
      'saved.call(module,"electron")',
    ],
    [
      "bound module method",
      "const saved=module.require.bind(module);",
      'saved("electron")',
    ],
    [
      "created loader",
      'const saved=require("node:module").createRequire("/tmp/opaque.cjs");',
      'saved("electron")',
    ],
  ])(
    "preserves %s captured before an explicit wrapper-instance replacement",
    (_name, setup, load) => {
      expect(
        provenanceOf(`${setup}module.require=other;const loaded=${load};`),
      ).toMatchObject({
        status: "module",
        origins: [{ specifier: "electron" }],
      });
    },
  );

  it.each(["bundle.js", "bundle.cjs"])(
    "keeps the broader Electron eval guard in %s",
    (path) => {
      const source = `${SHIM}function patch(Q){eval('module.require=()=>({})')}patch(null);Q('electron').ipcRenderer.send('x');new (Q('electron').BrowserWindow)({});`;
      const parsed = parseJavaScriptSource(source, path);
      expect(parsed).not.toBeNull();
      const { electron } = analyzeParsedJavaScriptStaticSource(source, parsed!);
      expect(electron.ipc).toEqual([]);
      expect(electron.browser_windows).toEqual([]);
    },
  );
});
