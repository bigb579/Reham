import * as t from "@babel/types";

import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

/** A known intrinsic may return an argument without copying its identity. */
export const javaScriptIntrinsicResultReference = (
  invocation: JavaScriptIntrinsicInvocation | undefined,
): t.Expression | undefined => {
  const argument = invocation?.arguments?.[0];
  return invocation?.kind === "known" &&
    invocation.path.join(".") === "intrinsic.Object.freeze" &&
    t.isExpression(argument)
    ? argument
    : undefined;
};

/** Expand only literal array spreads whose positional arguments are all known. */
export const expandJavaScriptInvocationArguments = (
  arguments_: readonly t.CallExpression["arguments"][number][],
): t.CallExpression["arguments"] => {
  const expanded: t.CallExpression["arguments"] = [];
  const pending = [...arguments_].reverse();
  while (pending.length > 0) {
    const argument = pending.pop();
    if (argument === undefined) break;
    const array = t.isSpreadElement(argument)
      ? unwrapJavaScriptExpression(argument.argument).node
      : undefined;
    if (
      t.isArrayExpression(array) &&
      array.elements.every(
        (element) => t.isExpression(element) || t.isSpreadElement(element),
      )
    )
      for (let index = array.elements.length - 1; index >= 0; index -= 1) {
        const element = array.elements[index];
        if (element !== null && element !== undefined) pending.push(element);
      }
    else expanded.push(argument);
  }
  return expanded;
};

const arrayArguments = (node: t.Node | undefined) => {
  const array =
    node === undefined ? undefined : unwrapJavaScriptExpression(node).node;
  if (
    !t.isArrayExpression(array) ||
    array.elements.some((element) => element === null)
  )
    return undefined;
  const expanded = expandJavaScriptInvocationArguments(
    array.elements.filter(
      (element): element is t.Expression | t.SpreadElement => element !== null,
    ),
  );
  return expanded.every((element) => t.isExpression(element))
    ? expanded.filter((element): element is t.Expression =>
        t.isExpression(element),
      )
    : undefined;
};

const invocationArguments = (
  method: "call" | "apply",
  arguments_: JavaScriptIntrinsicInvocation["arguments"],
) =>
  t.isSpreadElement(arguments_?.[0])
    ? undefined
    : method === "apply"
      ? arrayArguments(arguments_?.[1])
      : arguments_?.slice(1);

/**
 * Normalize known invocation syntax once, retaining bound argument prefixes.
 * Binding a function alone is not a write; only its eventual call is examined.
 */
export const resolveJavaScriptIntrinsicInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  intrinsicPath: (node: t.Node) => readonly string[] | undefined,
  boundIntrinsic: (node: t.Node) => JavaScriptIntrinsicInvocation | undefined,
  intrinsicReadChanged: (node: t.Node, path: readonly string[]) => boolean,
): JavaScriptIntrinsicInvocation | undefined =>
  resolveIntrinsicInvocations(
    node,
    (value) => {
      const path = intrinsicPath(value);
      return path === undefined ? [] : [path];
    },
    (value) => {
      const bound = boundIntrinsic(value);
      return bound === undefined ? [] : [bound];
    },
    intrinsicReadChanged,
    true,
  )[0];

/** Normalize possible callable identities without selecting one union member. */
export const resolveJavaScriptIntrinsicInvocations = (
  node: t.CallExpression | t.OptionalCallExpression,
  intrinsicPaths: (node: t.Node) => readonly (readonly string[])[],
  boundIntrinsics: (node: t.Node) => readonly JavaScriptIntrinsicInvocation[],
  intrinsicReadChanged: (node: t.Node, path: readonly string[]) => boolean,
): readonly JavaScriptIntrinsicInvocation[] =>
  resolveIntrinsicInvocations(
    node,
    intrinsicPaths,
    boundIntrinsics,
    intrinsicReadChanged,
    false,
  );

const resolveIntrinsicInvocations = (
  node: t.CallExpression | t.OptionalCallExpression,
  intrinsicPaths: (node: t.Node) => readonly (readonly string[])[],
  boundIntrinsics: (node: t.Node) => readonly JavaScriptIntrinsicInvocation[],
  intrinsicReadChanged: (node: t.Node, path: readonly string[]) => boolean,
  singleIdentity: boolean,
): readonly JavaScriptIntrinsicInvocation[] => {
  interface PendingInvocation {
    callee: t.Node;
    arguments_: JavaScriptIntrinsicInvocation["arguments"];
    receiver: t.Node | undefined;
    explicitReceiver: boolean;
    visited: ReadonlySet<t.Node>;
  }
  const pending: PendingInvocation[] = [
    {
      callee: node.callee,
      arguments_: expandJavaScriptInvocationArguments(node.arguments),
      receiver: undefined,
      explicitReceiver: false,
      visited: new Set(),
    },
  ];
  const ids = new WeakMap<t.Node, number>();
  let nextId = 0;
  const id = (value: t.Node | null | undefined): number => {
    if (value === undefined) return -1;
    // Parser recovery retains null argument holes; keep their position distinct.
    if (value === null) return -2;
    let result = ids.get(value);
    if (result === undefined) ids.set(value, (result = nextId++));
    return result;
  };
  const states = new Set<string>();
  const results = new Map<string, JavaScriptIntrinsicInvocation>();
  const retain = (invocation: JavaScriptIntrinsicInvocation): void => {
    const key = JSON.stringify([
      invocation.kind,
      invocation.path,
      id(invocation.receiver),
      invocation.arguments?.map(id),
    ]);
    results.set(key, invocation);
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    const callee = unwrapJavaScriptExpression(current.callee).node;
    const { arguments_, receiver, explicitReceiver } = current;
    if (t.isSequenceExpression(callee)) {
      const finalExpression = callee.expressions.at(-1);
      if (finalExpression === undefined) continue;
      // The comma operator returns the final value without its member receiver.
      // Keep that lost receiver explicit so intrinsic call/apply stays unknown.
      pending.push({
        ...current,
        callee: finalExpression,
        explicitReceiver: true,
      });
      continue;
    }
    // A route cannot apply the same bound prefix repeatedly. Deduplicate states
    // only when both invocation arguments and their cycle context agree.
    if (current.visited.has(callee)) continue;
    const key = JSON.stringify([
      id(callee),
      id(receiver),
      explicitReceiver,
      arguments_?.map(id),
      [...current.visited].map(id).sort((a, b) => a - b),
    ]);
    if (states.has(key)) continue;
    states.add(key);
    const visited = new Set(current.visited);
    visited.add(callee);
    const paths = intrinsicPaths(callee);
    const memberMethod =
      t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
        ? semanticStaticPropertyKey(callee.property, callee.computed)
        : undefined;
    const possibleBounds =
      (singleIdentity && paths.length > 0) ||
      (paths.length === 0 &&
        (memberMethod === "call" || memberMethod === "apply"))
        ? []
        : boundIntrinsics(callee);
    for (const bound of possibleBounds) {
      if (bound.kind === "opaque") retain(bound);
      else
        normalize(bound.path, {
          ...current,
          callee,
          receiver: bound.receiver,
          explicitReceiver: true,
          arguments_:
            bound.arguments === undefined
              ? undefined
              : [...bound.arguments, ...(arguments_ ?? [])],
          visited,
        });
    }

    if (paths.length === 0) {
      if (
        t.isMemberExpression(callee) ||
        t.isOptionalMemberExpression(callee)
      ) {
        const method = semanticStaticPropertyKey(
          callee.property,
          callee.computed,
        );
        if (method === "call" || method === "apply") {
          const bounds = boundIntrinsics(callee.object);
          const changed = bounds.filter((bound) =>
            intrinsicReadChanged(callee, [...bound.path, method]),
          );
          for (const bound of changed)
            retain({ kind: "opaque", path: bound.path, arguments: undefined });
          if (bounds.length === 0 || changed.length < bounds.length)
            pending.push({
              callee: callee.object,
              receiver: arguments_?.[0],
              explicitReceiver: true,
              arguments_: invocationArguments(method, arguments_),
              visited,
            });
          continue;
        }
      }
    }
    for (const path of paths)
      if (intrinsicReadChanged(callee, path))
        retain({ kind: "opaque", path, arguments: undefined });
      else normalize(path, { ...current, callee, visited });
  }
  return [...results.values()];

  function normalize(
    path: readonly string[],
    current: PendingInvocation,
  ): void {
    const { callee, arguments_, receiver, explicitReceiver, visited } = current;
    const method = path.length > 3 ? path.at(-1) : undefined;
    if (method === "call" || method === "apply") {
      // These properties hold generic function values. Their receiver selects
      // the callable; property-chain depth does not consume more arguments.
      const callable: t.Node | undefined = explicitReceiver
        ? receiver
        : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee.object
          : undefined;
      if (!t.isExpression(callable)) {
        retain({ kind: "opaque", path, arguments: undefined });
        return;
      }
      pending.push({
        callee: callable,
        receiver: arguments_?.[0],
        explicitReceiver: true,
        arguments_: invocationArguments(method, arguments_),
        visited,
      });
      return;
    }
    if (path.join(".") === "intrinsic.Reflect.apply") {
      const callable = arguments_?.[0];
      if (!t.isExpression(callable)) return;
      pending.push({
        callee: callable,
        receiver: arguments_?.[1],
        explicitReceiver: true,
        arguments_: arrayArguments(arguments_?.[2]),
        visited,
      });
      return;
    }
    retain({
      kind: "known",
      path,
      arguments: arguments_,
      ...(receiver === undefined
        ? !singleIdentity &&
          method === "bind" &&
          !explicitReceiver &&
          (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
          ? { receiver: callee.object }
          : {}
        : { receiver }),
    });
  }
};
