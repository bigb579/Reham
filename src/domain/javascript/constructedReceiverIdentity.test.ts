import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { createSemanticReceiverReferences } from "./javascriptSemanticReceiverReferences.js";
import {
  createSemanticCallableTargets,
  createSemanticFunctionValueCapture,
} from "./javascriptSemanticReturnedReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';
const analyze = (setup: string) => {
  const source = `${SHIM}${setup}${USE}`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron.ipc;
};

describe("private class-member receivers", () => {
  it.each([
    "class C{static #set(){this.Q=other}static run(){C.#set()}};C.run();",
    "class C{#set(){this.Q=other}run(){this.#set()}};new C().run();",
    "class C{static #set=function(){this.Q=other};static run(){C.#set()}};C.run();",
    "class C{#set=function(){this.Q=other};run(){this.#set()}};new C().run();",
    "class C{static get #value(){this.Q=other}static run(){void C.#value}};C.run();",
    "class C{get #value(){this.Q=other}run(){void this.#value}};new C().run();",
    "class C{static set #value(v){this.Q=other}static run(){C.#value=0}};C.run();",
    "class C{set #value(v){this.Q=other}run(){this.#value=0}};new C().run();",
    "class C{get #value(){this.Q=other;return 0}set #value(v){this.Q=other}run(){this.#value++}};new C().run();",
    "class C{#set(){this.Q=other}run(){this.#set()}};const c=new C();c.run();consume(c);",
    "class C{#set=function(){this.Q=other};run(){this.#set()}};const c=new C();c.run();consume(c);",
    "class C{static #set(){this.Q=other}static set(){}static run(){C.#set();C.set.call(globalThis)}};C.run();",
    "class C{static #set(){this.Q=other}static run(){C.#set();C[key]?.call(globalThis)}};C.run();",
    "class B{#set(){this.Q=other}run(){this.#set()}}class C extends B{#set(){}run(){super.run();this.#set.call(globalThis)}};new C().run();",
    "class B{static #set(){this.Q=other}static run(){B.#set()}}class C{static #set(){}static run(){C.#set.call(globalThis)}};B.run();C.run();",
    "class C{static #set(){this.Q=other}static run(){class Inner{static run(){C.#set()}}Inner.run()}};C.run();",
    "var B=class{};class C extends B{#set(){this.Q=other}run(){this.#set()}};new C().run();",
    "class B{constructor(){return {}}}class C extends B{#set(){this.Q=other}run(){this.#set()}};new C().run();",
  ])("keeps a private member's receiver separate: %s", (setup) => {
    expect(analyze(setup)).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "class C{static #set(){this.Q=other}static run(){C.#set();C.#set.call(globalThis)}};C.run();",
    "class C{#set(){this.Q=other}run(){this.#set();this.#set.call(globalThis)}};new C().run();",
    "class C{static #set=function(){this.Q=other};static run(){C.#set();consume(C.#set)}};C.run();",
    "class C{#set=function(){this.Q=other};run(){this.#set();return this.#set}};consume(new C().run());",
    "class C{static get #set(){return function(){this.Q=other}}static run(){return C.#set}};C.run().call(globalThis);",
    "class C{get #set(){return function(){this.Q=other}}run(){return this.#set}};new C().run().call(globalThis);",
    "class B{constructor(){return globalThis}}class C extends B{#set(){this.Q=other}run(){this.#set()}static run(c){c.#set()}};C.run(new C());",
    "class B{constructor(){return globalThis}}class C extends B{#set=function(){this.Q=other};static run(c){c.#set()}};C.run(new C());",
    "class B{constructor(){return globalThis}}class C extends B{get #value(){this.Q=other}static run(c){void c.#value}};C.run(new C());",
    "class B{constructor(){return globalThis}}class C extends B{set #value(v){this.Q=other}static run(c){c.#value=0}};C.run(new C());",
    "class C extends external{#set(){this.Q=other}run(){this.#set()}};new C().run();",
    "class B{constructor(){return external()}}class C extends B{#set(){this.Q=other}run(){this.#set()}};new C().run();",
    "class C extends external{get #value(){this.Q=other}run(){void this.#value}};new C().run();",
    "class C extends external{set #value(v){this.Q=other}run(){this.#value=0}};new C().run();",
    "var B=class{};globalThis.B=external;class C extends B{#set(){this.Q=other}run(){this.#set()}};new C().run();",
    "class C{@dec #set(){this.Q=other}run(){this.#set()}};new C().run();",
    "class C{@dec #set=function(){this.Q=other};run(){this.#set()}};new C().run();",
  ])("retains global or escaped private-member receivers: %s", (setup) => {
    expect(analyze(setup)).toEqual([]);
  });
});

describe("auto-accessor AST targets", () => {
  // The production parser does not enable decoratorAutoAccessors. These tests
  // cover the existing Babel AST contract without expanding source support.
  it.each([
    ["accessor run=function base(){}", "run(){}", "derived"],
    ["run=function base(){}", "run(){}", "base"],
    ["run=function base(){}", "accessor run=function derived(){}", "base"],
    ["accessor run=function base(){}", "", "base"],
    ["accessor run=function base(){};set run(value){}", "", "base"],
  ])("selects the effective descriptor: %s / %s", (base, derived, owner) => {
    const parsed = parse(
      `class B{${base}}class C extends B{${derived}}new C().run();`,
      { plugins: ["decoratorAutoAccessors"] },
    );
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    const declaration = parsed.program.body[owner === "base" ? 0 : 1];
    const member =
      declaration?.type === "ClassDeclaration"
        ? declaration.body.body[0]
        : undefined;
    const expected =
      member?.type === "ClassMethod"
        ? member
        : member?.type === "ClassProperty" ||
            member?.type === "ClassAccessorProperty"
          ? member.value
          : undefined;
    const statement = parsed.program.body.at(-1);
    const call =
      statement?.type === "ExpressionStatement"
        ? statement.expression
        : undefined;
    if (expected == null || call?.type !== "CallExpression")
      throw new Error("Expected class member and invocation");
    expect(createSemanticCallableTargets(index.bindings)(call.callee)).toEqual([
      expected,
    ]);
  });
});

describe("stored class-field receivers", () => {
  it.each([
    "class C{set=function(){this.Q=other}};new C().set();",
    "class C{set=function change(){this.Q=other}};new C().set();",
    "class C{static set=function(){this.Q=other}};C.set();",
    "class C{['set']=function(){this.Q=other}};new C().set();",
    "class B{set=function(){this.Q=other}};class C extends B{};new C().set();",
    "function set(){this.Q=other}class C{set=set};new C().set();",
    "class C{set=()=>{this.Q=other}};new C().set();",
  ])("keeps an invoked field's receiver separate: %s", (setup) => {
    expect(analyze(setup)).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "class C{set=function(){this.Q=other}};new C().set.call(globalThis);",
    "class C{set=function(){this.Q=other}};const c=new C();c.set();use(c.set);",
    "class C{static set=function(){this.Q=other}};C.set();use(C.set);",
    "class C{set=function(){this.Q=other}};new C().set();use([new C()]);",
    "function set(){this.Q=other}class C{set=set};const c=new C();c.set();const run=c.set;run();",
    "class B{constructor(){return globalThis}}class C extends B{set=function(){this.Q=other}};new C().set();",
  ])("retains an escaped or global field receiver: %s", (setup) => {
    expect(analyze(setup)).toEqual([]);
  });
});

describe("escaped construction and invocation results", () => {
  const local = "class C{set=function(){this.Q=other}};new C().set();";

  it.each([
    "consume(new C());",
    "consume?.(new C());",
    "use([new C()]);",
    "consume({item:new C()});",
    "globalThis.saved=new C();",
    "let saved;saved=new C();consume(saved);",
    "const box={};box.item=new C();consume(box);",
    "let c;consume(c=new C());",
    "let c;consume(c=Reflect.construct(C,[]));",
    "let c;consume((c=new C()).set);",
    "function make(){return new C()}consume(make());",
    "const make=()=>new C();consume(make?.());",
    "function make(){return new C()}globalThis.saved=make();",
    "consume(flag?new C():null);",
    "consume((0,new C()));",
    "consume(flag&&new C());",
    "consume(Reflect.construct(C,[]));",
    "consume(Reflect.construct.call(null,C,[]));",
    "const make=Reflect.construct;consume(make(C,[]));",
    "const make=Reflect.construct.bind(null,C);consume(make([]));",
    "function make(){return Reflect.construct(C,[])}consume(make());",
    "function make(){return flag?new C():make()}consume(make());",
    "consume([[new C()]]);",
    "consume((flag?new C():new C()).set);",
    "consume(class extends C{});",
  ])("retains escaped result contents: %s", (escape) => {
    expect(analyze(`${local}${escape}`)).toEqual([]);
  });

  it.each([
    "new C();",
    "Reflect.construct(C,[]);",
    "const c=new C();c.set();",
    "let c;c=new C();c.set();",
    "const values=[new C()];values[0].set();",
    "const box={item:new C()};box.item.set();",
    "(new C(),0);",
    "consume((new C(),0));",
    "void new C();",
    "(Reflect.construct(C,[]),0);",
    "consume((Reflect.construct(C,[]),0));",
    "if(new C()){}",
    "!(new C());",
    "typeof new C();",
    "(flag?new C():new C()).set();",
    "(0,new C()).set();",
    "const values=[[new C()]];values[0][0].set();",
    "let c;(c=new C()).set();",
    "(class extends C{});",
    "const Derived=class extends C{};new Derived().set();",
  ])("keeps discarded and locally selected results separate: %s", (use) => {
    expect(analyze(`${local}${use}`)).toMatchObject([{ channel: "kept" }]);
  });

  it("retains directly passed class fields with a shared source target", () => {
    expect(
      analyze(
        "function set(){this.Q=other};new(class{set=set})().set();consume(class{set=set});",
      ),
    ).toEqual([]);
  });
});

it.each([
  ["function make(){return new C()}", "make()"],
  ["function make(){return ()=>new C()}", "make()()"],
  ["function make(){return {item:new C()}}", "make().item"],
  ["function make(){return ()=>({item:new C()})}", "make()().item"],
  ["function make(){return C}", "new (make())()"],
  ["function make(){return flag?new C():make()}", "make()"],
  [
    "function make(){return again()}function again(){return flag?make():new C()}",
    "make()",
  ],
])(
  "expands source result contents with bounded contexts: %s",
  (setup, result) => {
    const parsed = parseJavaScriptSource(
      `class C{set=function(){this.Q=other}};${setup};consume(${result});`,
      "bundle.js",
    );
    if (parsed === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    const owner = parsed.program.body[0];
    const member =
      owner?.type === "ClassDeclaration" ? owner.body.body[0] : undefined;
    const expected =
      member?.type === "ClassProperty" ? member.value : undefined;
    const statement = parsed.program.body.at(-1);
    const call =
      statement?.type === "ExpressionStatement"
        ? statement.expression
        : undefined;
    const argument =
      call?.type === "CallExpression" ? call.arguments[0] : undefined;
    if (expected == null || argument == null)
      throw new Error("Expected target and result");
    const contents = createSemanticCallableTargets(index.bindings, "contents");
    expect(contents(argument)).toContain(expected);
    expect(contents(argument)).toContain(expected);
  },
);

describe("normalized construction receivers", () => {
  it.each([
    "Reflect.construct(set,[]);",
    "Reflect.construct?.(set,[]);",
    "const make=Reflect.construct;make(set,[]);",
    "const {construct:make}=Reflect;make(set,[]);",
    "Reflect.construct.call(null,set,[]);",
    "Reflect.construct.apply(null,[set,[]]);",
    "Reflect.apply(Reflect.construct,null,[set,[]]);",
    "const make=Reflect.construct.bind(null,set);make([]);",
    "const make=Reflect.construct.bind(null);make.call(null,set,[]);",
    "Reflect.construct(set,[],function Alternate(){});",
    "const make=Reflect.construct;Reflect.construct=other;make(set,[]);",
    "const make=Reflect.construct.bind(null,set);Reflect.construct=other;make([]);",
    "Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "const make=Reflect.construct.call.call.bind(Reflect.construct,null,set);function fn(){}fn.call.call=other;make([]);",
    "function fn(){}fn.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "Reflect.call={};Reflect.call.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "const make=Reflect.construct;function fn(){}fn.call.call=other;make(set,[]);",
  ])("keeps a constructed function's receiver separate: %s", (call) => {
    expect(analyze(`function set(){this.Q=other}${call}`)).toMatchObject([
      { channel: "kept" },
    ]);
  });

  it("does not use a base constructor's returned object as its own receiver", () => {
    expect(
      analyze(
        "function set(){this.Q=other;return globalThis}Reflect.construct(set,[]);",
      ),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "function set(){this.Q=other}Reflect.construct(set,[]);set();",
    "function set(){this.Q=other}Reflect.construct(set,[]);set.call(globalThis);",
    "function set(){this.Q=other}Reflect.construct(set,[]);use(set);",
    "function set(){this.Q=other}const Reflect={construct(fn){fn()}};Reflect.construct(set,[]);",
    "function set(){this.Q=other}Reflect.construct=other;Reflect.construct(set,[]);",
    "function set(){this.Q=other}Reflect.construct=other;const make=Reflect.construct;make(set,[]);",
    "function set(){this.Q=other}const R=Reflect;R.construct=other;R.construct(set,[]);",
    "function set(){this.Q=other}Object.defineProperty(Reflect,'construct',{value:other});Reflect.construct(set,[]);",
    "function set(){this.Q=other}Reflect.construct.call=other;Reflect.construct.call(null,set,[]);",
    "function set(){this.Q=other}Function.prototype.call=other;Reflect.construct.call(null,set,[]);",
    "function set(){this.Q=other}Reflect.apply=other;Reflect.apply(Reflect.construct,null,[set,[]]);",
    "function set(){this.Q=other}function fn(){}fn.call.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}Object.assign.call.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}const helper=Function.prototype.call;helper.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}function patch(){Reflect.construct=other}patch();Reflect.construct(set,[]);",
    "function set(){this.Q=other}patch();Reflect.construct(set,[]);function patch(){Reflect.construct=other}",
    "function set(){this.Q=other}function patch(){Reflect.construct=other}use(patch);Reflect.construct(set,[]);",
    "function set(){this.Q=other}function fn(){}function patch(){fn.call.call=other}patch();Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}function patch(){Reflect.construct.bind=other}patch();const make=Reflect.construct.bind(null,set);make([]);",
    "function set(){this.Q=other}eval('Reflect.construct=other');Reflect.construct(set,[]);",
    "function set(){this.Q=other}(0,eval)('Reflect.construct=other');Reflect.construct(set,[]);",
    "function set(){this.Q=other}var make=Reflect.construct;eval('make=other');make(set,[]);",
    "function set(){this.Q=other}Reflect.construct(...args,set,[]);",
    "function set(){this.Q=other}Reflect.construct.apply(null,[set,[set]]);",
    "function set(){this.Q=other}Reflect.construct.bind(null,set)([set]);",
    "class B{constructor(){return globalThis}}class C extends B{constructor(){super();this.Q=other}}Reflect.construct(C,[]);",
    "class B{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}Reflect.construct(C,[]);",
  ])("retains global, escaped, and inherited receivers: %s", (setup) => {
    expect(analyze(setup)).toEqual([]);
  });
});

describe("construction helper prototype selection", () => {
  it.each([
    "Reflect.construct.__proto__={call(_this,fn,args){fn()}};Reflect.construct.call(null,set,[]);",
    "Reflect.construct.__proto__={apply(_this,args){args[0]()}};Reflect.construct.apply(null,[set,[]]);",
    "Reflect.construct.__proto__={bind(_this,fn){return ()=>fn()}};const make=Reflect.construct.bind(null,set);make([]);",
    "const make=Reflect.construct;Reflect.construct.__proto__={call(_this,fn,args){fn()}};make.call(null,set,[]);",
    "const make=Reflect.construct;Object.setPrototypeOf(make,{call(_this,fn,args){fn()}});make.call(null,set,[]);",
    "Reflect.construct.call.__proto__={call(_this,_receiver,fn,args){fn()}};Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "Reflect.apply.__proto__={call(_this,_target,_receiver,args){args[0]()}};Reflect.apply.call(null,Reflect.construct,null,[set,[]]);",
    "Reflect.construct.__proto__={call(_this,fn,args){fn()}};Reflect.apply(Reflect.construct.call,Reflect.construct,[null,set,[]]);",
    "const call=Reflect.construct.call;call.__proto__={call(_this,_receiver,fn,args){fn()}};call.call(Reflect.construct,null,set,[]);",
    "Reflect.construct.__proto__={call(_this,fn,args){fn()}};const {call}=Reflect.construct;call.call(Reflect.construct,null,set,[]);",
    "const make=Reflect.construct;function patch(){Reflect.construct.__proto__={call(_this,fn,args){fn()}}}patch();make.call(null,set,[]);",
    "const make=Reflect.construct;Reflect.setPrototypeOf(make,{apply(_this,args){args[0]()}});make.apply(null,[set,[]]);",
    "Reflect.construct.call=other;Reflect.construct.__proto__={};Reflect.construct.call(null,set,[]);",
  ])(
    "retains callback effects after replacing an inherited helper: %s",
    (call) => {
      expect(analyze(`function set(){this.Q=other}${call}`)).toEqual([]);
    },
  );

  it.each([
    "Reflect.construct.call(null,set,[]);Reflect.construct.__proto__={call(_this,fn,args){fn()}};",
    "const call=Reflect.construct.call;Reflect.construct.__proto__={call(_this,fn,args){fn()}};call.call(Reflect.construct,null,set,[]);",
    "const apply=Reflect.construct.apply;Reflect.construct.__proto__={apply(_this,args){args[0]()}};apply.call(Reflect.construct,null,[set,[]]);",
    "const bind=Function.prototype.bind;Reflect.construct.__proto__={bind(_this,fn){return ()=>fn()}};const make=bind.call(Reflect.construct,null,set);make([]);",
    "const invoke=Reflect.construct.call;Reflect.construct.__proto__={call(_this,fn,args){fn()}};Reflect.apply(invoke,Reflect.construct,[null,set,[]]);",
    "const make=Reflect.construct.bind(null,set);Reflect.construct.__proto__={bind(_this,fn){return ()=>fn()}};make([]);",
    "const make=Reflect.construct;Reflect.construct=other;make.call(null,set,[]);",
    "Reflect.construct.__proto__={call(_this,fn,args){fn()}};Reflect.construct(set,[]);",
    "Function.prototype.__proto__={call(_this,fn,args){fn()}};Reflect.construct.call(null,set,[]);",
    "Object.prototype.call=other;Reflect.construct.call(null,set,[]);",
    "const local=function(){};local.__proto__={call(_this,fn,args){fn()}};Reflect.construct.call(null,set,[]);",
    "const local={construct:{}};local.construct.__proto__={call(_this,fn,args){fn()}};Reflect.construct.call(null,set,[]);",
  ])(
    "preserves captured helpers and unrelated prototype changes: %s",
    (call) => {
      expect(analyze(`function set(){this.Q=other}${call}`)).toMatchObject([
        { channel: "kept" },
      ]);
    },
  );
});

describe("bound construction helper suppliers", () => {
  it.each([
    "const make=Reflect.construct.bind(null);make.__proto__={call(_this,fn,args){fn()}};make.call(null,set,[]);",
    "const make=Reflect.construct.bind(null);make.call=function(_this,fn,args){fn()};make.call(null,set,[]);",
    "const make=Reflect.construct.bind(null);const alias=make;alias.__proto__={apply(_this,args){args[0]()}};make.apply(null,[set,[]]);",
    "const make=Reflect.construct.bind(null);Object.setPrototypeOf(make,{call(_this,fn,args){fn()}});make.call(null,set,[]);",
    "const make=Reflect.construct.bind(null);consume(make);make.call(null,set,[]);",
    "const make=Reflect.construct.bind(null);Function.prototype.call=other;make.call(null,set,[]);",
    "Reflect.construct.__proto__={call(_this,fn,args){fn()}};const make=Function.prototype.bind.call(Reflect.construct,null);make.call(null,set,[]);",
    "const first=Reflect.construct.bind(null);first.bind=function(_this,fn){return ()=>fn()};const make=first.bind(null,set);make([]);",
  ])("retains callback effects from the physical bound helper: %s", (call) => {
    expect(analyze(`function set(){this.Q=other}${call}`)).toEqual([]);
  });

  it.each([
    "const make=Reflect.construct.bind(null,set);Reflect.construct.__proto__={call(_this,fn,args){fn()}};make.call(null,[]);",
    "const make=Reflect.construct.bind(null);make.call(null,set,[]);make.__proto__={call(_this,fn,args){fn()}};",
    "const make=Reflect.construct.bind(null);make.__proto__={call(_this,fn,args){fn()}};make(set,[]);",
    "const make=Reflect.construct.bind(null);make.call=other;make(set,[]);",
    "Reflect.construct.call=function(_this,fn,args){fn()};const make=Reflect.construct.bind(null);make.call(null,set,[]);",
    "const first=Reflect.construct.bind(null);const make=first.bind(null,set);Reflect.construct.__proto__={call(_this,fn,args){fn()}};make.call(null,[]);",
    "const first=Reflect.construct.bind(null);Reflect.construct.__proto__={call(_this,fn,args){fn()}};const make=first.bind(null,set);make.call(null,[]);",
    "const first=Reflect.construct.bind(null);first.call=other;const make=first.bind(null,set);make.call(null,[]);",
  ])("preserves the bound target and captured prototype: %s", (call) => {
    expect(analyze(`function set(){this.Q=other}${call}`)).toMatchObject([
      { channel: "kept" },
    ]);
  });
});

describe("bound source-function receivers", () => {
  it.each([
    "const make=set.bind({});make.call(null);",
    "const make=set.bind({});set.__proto__={call(_this){this()}};make.call(null);",
    "set.call=other;const make=set.bind({});make.call(null);",
    "const make=(0,set).bind({});make.call(null);",
    "const make=(flag?set:set).bind({});make.call(null);",
    "const box={fn:set};const make=box.fn.bind({});make.call(null);",
    "const box=[set];const make=box[0].bind({});make.call(null);",
    "var candidate=set;const captured=(0,candidate);globalThis.candidate=other;const make=captured.bind({});make.call(null);",
  ])("preserves a captured local receiver: %s", (call) => {
    expect(analyze(`function set(){this.Q=other}${call}`)).toMatchObject([
      { channel: "kept" },
    ]);
  });

  it.each([
    "const make=set.bind(globalThis);make.call(null);",
    "const make=set.bind(null);make.call(null);",
    "const make=set.bind({});make.call=other;make.call(null);",
    "const make=set.bind({});make.__proto__={call:other};make.call(null);",
    "set.bind=other;const make=set.bind({});make.call(null);",
    "set.__proto__={bind:other};const make=set.bind({});make.call(null);",
    "consume(set);const make=set.bind({});make.call(null);",
    "const selected=condition?set:other;const make=selected.bind({});make.call(null);",
    "var candidate=set;globalThis.candidate=other;const make=(0,candidate).bind({});make.call(null);",
    "var candidate=set;eval('candidate=other');const make=(0,candidate).bind({});make.call(null);",
    "const box={fn:set};box.fn=other;const make=box.fn.bind({});make.call(null);",
    "const box={fn:set};consume(box);const make=box.fn.bind({});make.call(null);",
    "const box={fn:set};const make=box[key].bind({});make.call(null);",
    "const box=[set];box[0]=other;const make=box[0].bind({});make.call(null);",
    "const box=[set];consume(box);const make=box[0].bind({});make.call(null);",
    "const box=[...unknown,set];const make=box[0].bind({});make.call(null);",
  ])("keeps an unproven bound receiver global: %s", (call) => {
    expect(analyze(`function set(){this.Q=other}${call}`)).toEqual([]);
  });

  it("captures a hoisted source declaration", () => {
    expect(
      analyze(
        "const make=set.bind({});function set(){this.Q=other};make.call(null);",
      ),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it("does not capture a source expression before initialization", () => {
    expect(
      analyze(
        "const make=set.bind({});const set=function(){this.Q=other};make.call(null);",
      ),
    ).toEqual([]);
  });
});

describe("bound function-family helper suppliers", () => {
  it.each([
    "async function set(){this.Q=other}const make=set.bind({});make.call(null);",
    "async function set(){this.Q=other}const make=set.bind({});set.__proto__={call:other};make.call(null);",
    "async function set(){this.Q=other}const family=set.__proto__;const make=set.bind({});family.call=other;make();",
    "async function set(){this.Q=other}const family=set.__proto__;const make=set.bind({});make.call(null);family.__proto__={call:other};",
    "function* set(){this.Q=other}const make=set.bind({});make.call(null).next();",
    "async function* set(){this.Q=other}const make=set.bind({});make.call(null).next();",
  ])(
    "preserves captured prototypes and independent direct calls: %s",
    (setup) => {
      expect(analyze(setup)).toMatchObject([{ channel: "kept" }]);
    },
  );

  it.each([
    "async function set(){this.Q=other}const family=set.__proto__;const make=set.bind({});family.call=other;make.call(null);",
    "async function set(){this.Q=other}const family=set.__proto__;const make=set.bind({});family.__proto__={call:other};make.call(null);",
    "function* set(){this.Q=other}const family=set.__proto__;const make=set.bind({});family.call=other;make.call(null).next();",
    "function* set(){this.Q=other}const family=set.__proto__;const make=set.bind({});family.__proto__={call:other};make.call(null).next();",
    "async function* set(){this.Q=other}const family=set.__proto__;const make=set.bind({});family.call=other;make.call(null).next();",
  ])("keeps captured prototype slots and crossed links live: %s", (setup) => {
    expect(analyze(setup)).toEqual([]);
  });
});

it.each([
  ["first", true],
  ["condition?first:second", false],
])(
  "retains member selection sites in source capture proof: %s",
  (selection, complete) => {
    // Observable receiver analysis remains conservative after an overwritten
    // container slot; this exercises the strict capture fact consumed beneath it.
    const source = `function set(){}const box={fn:set};const first=box.fn;box.fn=other;const second=box.fn;(${selection}).bind({});`;
    const parsed = parseJavaScriptSource(source, "bundle.js");
    if (parsed === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    const last = parsed.program.body.at(-1);
    if (
      last?.type !== "ExpressionStatement" ||
      last.expression.type !== "CallExpression"
    )
      throw new Error("Expected bound source call");
    const capture = createSemanticFunctionValueCapture(index.bindings, {
      bindingReadMayHaveChanged: () => false,
      ownSlotUnchanged: (_owner, _key, read) =>
        (read.start ?? Infinity) < source.indexOf("box.fn=other"),
    });
    expect(capture(last.expression.callee) !== undefined).toBe(complete);
  },
);

it("refreshes a retained receiver query after ambient facts complete", () => {
  const parsed = parseJavaScriptSource(
    "var local={};function set(){this.Q=other}set.call(local);",
    "bundle.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const target = parsed.program.body[1];
  const statement =
    target?.type === "FunctionDeclaration" ? target.body.body[0] : undefined;
  const assignment =
    statement?.type === "ExpressionStatement"
      ? statement.expression
      : undefined;
  const receiver =
    assignment?.type === "AssignmentExpression" &&
    assignment.left.type === "MemberExpression"
      ? assignment.left.object
      : undefined;
  if (receiver?.type !== "ThisExpression") throw new Error("Expected receiver");
  const references = createSemanticReceiverReferences(index.bindings);
  expect(references(receiver)).toContain(parsed.program);
  completeSemanticSteps(index.indexAmbientWritesSteps());
  expect(references(receiver)).not.toContain(parsed.program);
});

it.each([
  ["eval('Reflect.construct=other');Reflect.construct(set,[]);", "opaque"],
  ["(0,eval)('Reflect.construct=other');Reflect.construct(set,[]);", "opaque"],
  [
    "const make=Reflect.construct;eval('Reflect.construct=other');make(set,[]);",
    "known",
  ],
  [
    "const make=Reflect.construct.bind(null,set);eval('Reflect.construct=other');make([]);",
    "known",
  ],
  ["var make=Reflect.construct;eval('make=other');make(set,[]);", "opaque"],
])("checks helper captures against complete eval facts: %s", (setup, kind) => {
  const parsed = parseJavaScriptSource(`function set(){}${setup}`, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  const state = index.bindings;
  const nominal = createSemanticModuleInterop(state);
  const checked = createSemanticModuleInterop(state, {
    intrinsicPath: nominal.intrinsicPath,
    intrinsicWriteFacts: {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      opaqueGlobalSites: state.opaqueEffects.globalSites,
      complete: true,
    },
  });
  const statement = parsed.program.body.at(-1);
  const call =
    statement?.type === "ExpressionStatement"
      ? statement.expression
      : undefined;
  if (call?.type !== "CallExpression") throw new Error("Expected call");
  expect(checked.intrinsicInvocation(call)?.kind).toBe(kind);
});
