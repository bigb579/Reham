import { describe, expect, it } from "vitest";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const windows = (source: string) =>
  analyzeJavaScriptStaticSource(source).electron.browser_windows;

describe("saved Electron exports", () => {
  it.each([
    'const {BrowserWindow:W}=require("electron");',
    'const E=require("electron");const W=E.BrowserWindow;',
    'const E=require("electron");const {BrowserWindow:W}=E;',
    'const W=require("electron").BrowserWindow;',
  ])("preserves a constructor captured before indirect eval: %s", (capture) => {
    expect(windows(`${capture}(0,eval)("void 0");new W({});`)).toHaveLength(1);
  });

  it("preserves an alias of an already captured constructor after eval", () => {
    expect(
      windows(
        'const {BrowserWindow:original}=require("electron");(0,eval)("void 0");const W=original;new W({});',
      ),
    ).toHaveLength(1);
  });

  it("preserves a constructor across a later namespace replacement", () => {
    expect(
      windows(
        'const E=require("electron");const W=E.BrowserWindow;E.BrowserWindow=other;new W({});',
      ),
    ).toHaveLength(1);
  });

  it("preserves a constructor captured through esbuild's saved loader", () => {
    expect(
      windows(`
        var load=(fallback=>typeof require!=="undefined"?require:fallback)(
          function(){if(typeof require!=="undefined")return require.apply(this,arguments);throw Error("Dynamic require");}
        );
        const {BrowserWindow:W}=load("electron");
        (0,eval)("void 0");new W({});
      `),
    ).toHaveLength(1);
  });

  it.each([
    'const E=require("electron");(0,eval)("void 0");new E.BrowserWindow({});',
    'const E=require("electron");(0,eval)("void 0");const W=E.BrowserWindow;new W({});',
    'let {BrowserWindow:W}=require("electron");eval("W=other");new W({});',
    'const E=require("electron");eval("E.BrowserWindow=other");function use(){const W=E.BrowserWindow;new W({});}use();',
    'const E=require("electron");E.BrowserWindow=other;const W=E.BrowserWindow;new W({});',
  ])("keeps changed or uncertain export reads unresolved: %s", (source) => {
    expect(windows(source)).toEqual([]);
  });
});

describe("saved Electron exports in global bindings", () => {
  it.each(["var", "let"])(
    "rejects a top-level %s constructor rebound by indirect eval",
    (kind) => {
      expect(
        windows(
          `${kind} W=require("electron").BrowserWindow;(0,eval)("W=other");new W({});`,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    'var W=require("electron").BrowserWindow;globalThis.W=other;new W({});',
    'var original=require("electron").BrowserWindow;globalThis.original=other;const W=original;new W({});',
  ])(
    "rejects a global property replacement before capture or use: %s",
    (source) => {
      expect(windows(source)).toEqual([]);
    },
  );

  it.each(["let", "const"])(
    "keeps a lexical %s constructor separate from global properties",
    (kind) => {
      expect(
        windows(
          `${kind} W=require("electron").BrowserWindow;globalThis.W=other;new W({});`,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["bundle.cjs", "bundle.mjs"])(
    "keeps mutable captures local in %s",
    (path) => {
      for (const kind of ["var", "let"]) {
        const source = `${kind} W=require("electron").BrowserWindow;(0,eval)("W=other");new W({});`;
        const parsed = parseJavaScriptSource(source, path);
        expect(parsed).not.toBeNull();
        expect(
          analyzeParsedJavaScriptStaticSource(source, parsed!).electron
            .browser_windows,
        ).toHaveLength(1);
      }
    },
  );

  it.each(["globalThis.original=other;", '(0,eval)("original=other");'])(
    "preserves a constructor copied before its global binding is replaced: %s",
    (write) => {
      expect(
        windows(
          `var original=require("electron").BrowserWindow;const W=original;${write}new W({});`,
        ),
      ).toHaveLength(1);
    },
  );
});

describe("saved Electron objects and wrapped calls", () => {
  it.each([
    'const E=require("electron");const send=E.ipcRenderer.send;E.ipcRenderer.send=other;',
    'const E=require("electron");const send=E.ipcRenderer.send;(0,eval)("void 0");',
    'const E=require("electron/main");const send=E.ipcRenderer.send;E.ipcRenderer.send=other;',
    'const E=require("electron");const R=E.ipcRenderer;E.ipcRenderer=other;const send=R.send;',
  ])("retains a captured method passed to a wrapper: %s", (setup) => {
    const result = analyzeJavaScriptStaticSource(
      `${setup}const invoke=(channel,fn)=>fn(channel);invoke("saved",send);`,
    );
    expect(result.electron.ipc).toContainEqual(
      expect.objectContaining({ channel: "saved" }),
    );
  });

  it.each([
    'const E=require("electron");const R=E.ipcRenderer;E.ipcRenderer.send=other;',
    'const E=require("electron/main");const R=E.ipcRenderer;E.ipcRenderer.send=other;',
    'const E=require("electron");const R=E.ipcRenderer;(0,eval)("void 0");',
  ])("does not freeze children of a saved object: %s", (setup) => {
    expect(
      analyzeJavaScriptStaticSource(`${setup}R.send("changed");`).electron.ipc,
    ).toEqual([]);
  });

  it("rejects a mutable saved method changed by direct eval before a wrapper call", () => {
    expect(
      analyzeJavaScriptStaticSource(`
        let {send}=require("electron").ipcRenderer;
        eval("send=other");
        const invoke=(channel,fn)=>fn(channel);invoke("changed",send);
      `).electron.ipc,
    ).toEqual([]);
  });

  it.each(["var", "let"])(
    "rejects a global %s method changed by indirect eval before a wrapper call",
    (kind) => {
      expect(
        analyzeJavaScriptStaticSource(`
          ${kind} {send}=require("electron").ipcRenderer;
          (0,eval)("send=other");
          const invoke=(channel,fn)=>fn(channel);invoke("changed",send);
        `).electron.ipc,
      ).toEqual([]);
    },
  );
});
