import { expect, it } from "vitest";
import {
  resolveJavaScriptIntrinsicInvocation,
  resolveJavaScriptIntrinsicInvocations,
} from "./javascriptIntrinsicInvocation.js";
import * as t from "@babel/types";

import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const invocationKinds = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("invocation fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const invocations: (ReturnType<typeof interop.intrinsicInvocation> | null)[] =
    [];
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        invocations.push(interop.intrinsicInvocation(node) ?? null);
    },
  });
  return invocations;
};

it.each([
  'const change = Object.defineProperty.call; change(null,Object,"create",{value:customCreate});',
  'const {apply:change} = Object.defineProperty; change(null,[Object,"create",{value:customCreate}]);',
  'const change = Reflect.apply.call; change(null,Object.defineProperty,null,[Object,"create",{value:customCreate}]);',
])(
  "keeps a bare invocation member alias unknown, not effect-free: %s",
  (source) => {
    expect(invocationKinds(source)).toEqual([
      expect.objectContaining({ kind: "opaque" }),
    ]);
  },
);

it("keeps a comma-expression intrinsic call unknown when its receiver is erased", () => {
  expect(
    invocationKinds(
      '(0, Object.defineProperty.call)(null, Object, "create", {value: customCreate});',
    ),
  ).toEqual([
    expect.objectContaining({
      kind: "opaque",
      path: ["intrinsic", "Object", "defineProperty", "call"],
    }),
  ]);
});

it("retains changed and healthy bound alternatives through call", () => {
  const target = t.identifier("target");
  const member = t.memberExpression(target, t.identifier("call"));
  const argument = t.stringLiteral("code");
  const invocations = resolveJavaScriptIntrinsicInvocations(
    t.callExpression(member, [t.nullLiteral(), argument]),
    () => [],
    (node) =>
      node === target
        ? [
            {
              kind: "known",
              path: ["intrinsic", "global", "eval"],
              arguments: [],
            },
            {
              kind: "known",
              path: ["intrinsic", "generated", "function"],
              arguments: [],
            },
          ]
        : [],
    (node, path) => node === member && path[1] === "global",
  );
  expect(invocations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "opaque",
        path: ["intrinsic", "global", "eval"],
      }),
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "generated", "function"],
        arguments: [argument],
      }),
    ]),
  );
});

it("terminates cyclic invocation routes while retaining an executable union branch", () => {
  const first = t.identifier("first");
  const second = t.identifier("second");
  const invocations = resolveJavaScriptIntrinsicInvocations(
    t.callExpression(first, []),
    () => [],
    (node) =>
      node === first
        ? [
            {
              kind: "known",
              path: ["intrinsic", "Function", "prototype", "call"],
              receiver: second,
              arguments: [],
            },
            {
              kind: "known",
              path: ["intrinsic", "global", "eval"],
              arguments: [],
            },
          ]
        : node === second
          ? [
              {
                kind: "known",
                path: ["intrinsic", "Function", "prototype", "call"],
                receiver: first,
                arguments: [],
              },
            ]
          : [],
    () => false,
  );
  expect(invocations).toEqual([
    expect.objectContaining({
      kind: "known",
      path: ["intrinsic", "global", "eval"],
    }),
  ]);
});

it("preserves the singular invocation contract for a direct bind", () => {
  const target = t.identifier("eval");
  const member = t.memberExpression(target, t.identifier("bind"));
  const node = t.callExpression(member, [t.nullLiteral()]);
  const result = resolveJavaScriptIntrinsicInvocation(
    node,
    () => ["intrinsic", "global", "eval", "bind"],
    () => {
      throw new Error("known singular paths do not query bound alternatives");
    },
    () => false,
  );
  expect(result).toEqual({
    kind: "known",
    path: ["intrinsic", "global", "eval", "bind"],
    arguments: node.arguments,
  });
});

it("retains an intrinsic write with an unknown site before every capture", () => {
  const parsed = parseJavaScriptSource("Object.freeze(value);");
  if (parsed === null) throw new Error("intrinsic write fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const statement = parsed.program.body[0];
  if (
    !t.isExpressionStatement(statement) ||
    !t.isCallExpression(statement.expression)
  )
    throw new Error("intrinsic write fixture has no call");
  const call = statement.expression;
  expect(interop.intrinsicInvocation(call)?.kind).toBe("known");
  interop.retainWrite(undefined, ["intrinsic", "Object", "freeze"]);
  expect(interop.intrinsicInvocation(call)?.kind).toBe("opaque");
});
