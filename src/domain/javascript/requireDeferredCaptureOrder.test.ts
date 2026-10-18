import { expect, it } from "vitest";

import { analyzeParsedJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const children = (source: string) => {
  const parsed = parseJavaScriptSource(source, "entry.cjs");
  expect(parsed).not.toBeNull();
  return analyzeParsedJavaScriptSemantics(parsed!).childProcessSpawns;
};

const LOAD = 'const {spawn}=require("node:child_process");';
const USE = 'spawn("target",[],{stdio:"inherit"});';
const PATCH = 'function patch(){eval("module.require=other")}';

it("retains all five child-process captures in the exposed stdio fixture", () => {
  const found = children(`
    const {spawn,exec}=require("node:child_process");
    var mode=null; Function("mode='inherit'")();
    spawn("Function-global",[],{stdio:mode});
    var frameMode=null; frames.frameMode='inherit';
    spawn("frames-global",[],{stdio:frameMode});
    function mapped(mode){mode=null;arguments[0]='inherit';spawn("mapped-arguments",[],{stdio:mode})}
    function exposed(options){let done=()=>{};eval("done=options");exec("eval-callback",done)}
    function shadowed(undefined){spawn("shadowed-undefined",[],{stdio:"inherit",...undefined})}
  `);
  expect(found.map(({ command }) => command)).toEqual([
    "Function-global",
    "frames-global",
    "mapped-arguments",
    "eval-callback",
    "shadowed-undefined",
  ]);
  expect(found.every(({ stdioMode }) => stdioMode === "dynamic")).toBe(true);
});

it.each([
  `${LOAD}${PATCH}${USE}`,
  `${PATCH}${LOAD}patch();${USE}`,
  `${PATCH}const unused=0;${LOAD}patch();${USE}`,
  `const saved=require;${PATCH}const {spawn}=saved("node:child_process");patch();${USE}`,
  `${LOAD}function patch(){module.require=other}patch();${USE}`,
  `${LOAD}eval("module.require=other");${USE}`,
])("keeps a loader capture before possible deferred effects: %s", (source) => {
  expect(children(source).map(({ command }) => command)).toEqual(["target"]);
});

it.each([
  `patch();${LOAD}${PATCH}${USE}`,
  `${PATCH}external(patch);${LOAD}${USE}`,
  `${PATCH}const box={get value(){patch()}};box.value;${LOAD}${USE}`,
  `${PATCH}const {value}={get value(){patch()}};${LOAD}${USE}`,
  `${PATCH}class C{static{patch()}}${LOAD}${USE}`,
  `${PATCH}const unknown=foreign;${LOAD}${USE}`,
  PATCH + "const value=`${patch()}`;" + LOAD + USE,
  `${PATCH}module.exports.patch=patch;${LOAD}${USE}`,
  `${PATCH}const {spawn}=require((patch(),"node:child_process"));${USE}`,
  `${PATCH}function load(){${LOAD}${USE}}load();patch();load();`,
  `eval("module.require=other");${LOAD}${USE}`,
])(
  "retains uncertainty across earlier or repeated activation: %s",
  (source) => {
    expect(children(source)).toEqual([]);
  },
);
