import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

// Generated from CommonJS Electron calls with esbuild 0.28.2, bundle=true,
// platform=node, format=esm, minify=true, external=["electron"]. Kept as inert
// source so the regression does not depend on future bundler output changes.
const bundle = `var t=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(o,r)=>(typeof require<"u"?require:o)[r]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var n=t("electron");new n.BrowserWindow({webPreferences:{nodeIntegration:!0,contextIsolation:!1}});n.ipcMain.handle("get-version",()=>"1.0.0");`;

cliTest(
  "recovers esbuild Electron windows and IPC through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-require-shim-");
    await writeFixtureFiles(root, {
      "package.json": JSON.stringify({
        name: "shim-fixture",
        main: "main.cjs",
      }),
      "main.cjs": `"use strict";(()=>{${bundle}})();`,
    });
    const connection = await connectLocalToolsMcp();
    for (const surface of ["CLI", "stdio MCP"] as const) {
      const result = await analyzeJavaScriptDirectory(
        surface,
        cli,
        root,
        connection.call,
      );
      expect(result.statistics).toMatchObject({
        parsed_javascript_files: 1,
        parse_failures: 0,
      });
      expect(result.summary).toMatchObject({
        browser_windows: 1,
        explicit_web_preferences: 2,
        ipc: { operations: 1, main_handlers: 1 },
      });
      const observations = result.graph.nodes.flatMap(
        ({ observations }) => observations,
      );
      expect(observations).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ channel: "get-version" }),
        }),
      );
    }
  },
);

cliTest(
  "distinguishes static class receiver writes from owned helpers through CLI and MCP",
  async ({ cli }) => {
    const load =
      'new (require.call.call(require,null,"electron").BrowserWindow)({});';
    const connection = await connectLocalToolsMcp();
    for (const [setup, windows] of [
      ["class C{static{this.call.call=other}}", 0],
      ["class C{static{this.call=other}}", 1],
    ] as const) {
      const root = await createTestTempDirectory(
        "rea-electron-class-receiver-",
      );
      await writeFixtureFiles(root, {
        "package.json": JSON.stringify({
          name: "class-fixture",
          main: "main.cjs",
        }),
        "main.cjs": `${setup}${load}`,
      });
      for (const surface of ["CLI", "stdio MCP"] as const) {
        const result = await analyzeJavaScriptDirectory(
          surface,
          cli,
          root,
          connection.call,
        );
        expect(result.statistics).toMatchObject({
          parsed_javascript_files: 1,
          parse_failures: 0,
        });
        expect(result.summary.browser_windows, `${surface}: ${setup}`).toBe(
          windows,
        );
      }
    }
  },
);
