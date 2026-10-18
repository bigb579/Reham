import { describe, expect, it } from "vitest";

import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';
const analyzeSource = (source: string) => {
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed);
};
const analyze = (body: string) =>
  analyzeSource(`${SHIM}${body}${USE}`).electron.ipc;

describe("destructuring default callable targets", () => {
  it.each([
    "function fallback(){this.Q=other;}const {set=fallback}={set:()=>{}};set();",
    "const fallback=function(){this.Q=other;};const {set=fallback}={set:()=>{}};set();",
    "const {set=function(){this.Q=other;}}={set:function(){}};set();",
    "function fallback(){this.Q=other;}const {set=(fallback(),()=>{})}={set:()=>{}};set();",
    "function fallback(){this.Q=other;}const {box:{set=(fallback(),()=>{})}={set:()=>{}}}={box:{set:()=>{}}};set();",
    "function fallback(){this.Q=other;}const {set=fallback}={set:()=>{}};consume(set);",
    "function fallback(){this.Q=other;}const {box={set:fallback}}={box:{}};consume(box);",
    "function fallback(){this.Q=other;}fallback.call({});const {set=fallback}={set:()=>{}};set();",
    "function fallback(){return globalThis;}const {get=fallback}={get:()=>({})};get().Q=other;",
  ])("excludes a fallback callable when its source is defined: %s", (body) => {
    expect(analyze(body)).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "function fallback(){this.Q=other;}const {set=fallback}={};set();",
    "function fallback(){this.Q=other;}const {set=fallback}=source;set();",
    "function fallback(){this.Q=other;}const {set=fallback}={get set(){return undefined}};set();",
    "function fallback(){this.Q=other;}const {trigger,set=fallback}={get trigger(){this.set=undefined},set:()=>{}};set();",
    "function fallback(){this.Q=other;}const {box:saved,trigger=(saved.set=undefined),box:{set=fallback}}={box:{set:()=>{}}};set();",
    "function fallback(){this.Q=other;}const {box:saved,[(saved.set=undefined,'trigger')]:trigger,box:{set=fallback}}={box:{set:()=>{}}};set();",
    "function fallback(){this.Q=other;}const {box:{set=(fallback(),()=>{})}={set:()=>{}}}={box:{}};set();",
    "function fallback(){this.Q=other;}Array.prototype[Symbol.iterator]=function*(){yield undefined};const [set=fallback]=[()=>{}];set();",
    "function fallback(){this.Q=other;}const {set=fallback}={set:function(){this.Q=other;}};set();",
    "function fallback(){this.Q=other;}const {set=fallback}={set:()=>{}};set();fallback();",
    "function fallback(){this.Q=other;}const {set=fallback}={set:()=>{}};set();consume(fallback);",
    "function fallback(){this.Q=other;}const {set=fallback}={set:()=>{}};set();const alias=fallback;consume(alias);",
    "function fallback(){this.Q=other;}const {set=fallback}={set:()=>{}};set();const box={run:fallback};consume(box);",
    "function fallback(){this.Q=other;}const source={set:()=>{}};consume(source);const {set=fallback}=source;set();",
    "function fallback(){this.Q=other;}",
  ])("retains possible defaults and independent escapes: %s", (body) => {
    expect(analyze(body)).toEqual([]);
  });

  it.each([
    "export function fallback(){this.fetch=other;}const {set=fallback}={set:()=>{}};",
    "export const fallback=function(){this.fetch=other;};const {set=fallback}={set:()=>{}};",
    "export class C{set(){this.fetch=other;}}const {set=C.prototype.set}={set:()=>{}};",
  ])(
    "retains exported callable uses beside an inactive default: %s",
    (body) => {
      expect(
        analyzeSource(`${body}fetch('/kept');`).endpoints.filter(
          ({ mechanism }) => mechanism === "call:fetch",
        ),
      ).toEqual([]);
    },
  );
});
