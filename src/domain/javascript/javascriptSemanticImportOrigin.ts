import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import { semanticMemberChain } from "./javascriptSemanticRequireOrigin.js";
import {
  unwrapJavaScriptExpression,
  readExactJavaScriptNormalResult,
  semanticFinalObjectMember,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  semanticPromiseSettlementDependency,
  semanticExactValueIdentity,
} from "./javascriptSemanticPromiseIdentity.js";
import { webSocketInitializerDominatesRead } from "./javascriptWebSocketExecution.js";
import {
  syntaxEvaluationAlwaysThrows,
  syntaxEvaluationCannotThrow,
} from "./javascriptSymbolicControlFlow.js";
import { semanticLiteralOwnKeysStable } from "./javascriptSemanticLiteralProjection.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";

/** Identity, initialization and prior relevant mutations are separate obligations. */
const importOptionValue = (
  raw: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  attributes: boolean,
  onLiteralProjection?: () => void,
): t.Node | undefined => {
  const result = semanticExactValueIdentity(raw, state, onLiteralProjection);
  if (
    result === undefined ||
    result.aliases.some(({ read, initializer }) => {
      if (
        !webSocketInitializerDominatesRead(
          initializer.node,
          read,
          state,
          initializer.bindingNode,
        )
      )
        return true;
      const binding = resolveSemanticBindingState(state, read, read.name);
      return (
        binding === undefined ||
        [...binding.memberWrites, ...binding.escapedPaths].some(
          (effect) =>
            effect.node !== capture &&
            semanticEffectTiming(capture, effect.node, state) !== "after" &&
            (effect.path.length === 0 ||
              attributes ||
              effect.path[0] === null ||
              effect.path[0] === "with"),
        )
      );
    })
  )
    return undefined;
  return result.node;
};

/** Fresh syntax objects expose only known own keys and known built-in prototypes. */
const importOptionObject = (node: t.Node): boolean =>
  syntaxEvaluationCannotThrow(node) &&
  (t.isArrayExpression(node) ||
    ((t.isFunctionExpression(node) ||
      t.isArrowFunctionExpression(node) ||
      t.isFunctionDeclaration(node)) &&
      !node.async &&
      !node.generator) ||
    (t.isObjectExpression(node) &&
      node.properties.every(
        (property) =>
          !t.isSpreadElement(property) &&
          semanticStaticPropertyKey(property.key, property.computed) !== null,
      )));

const importOptionOwnKeysStable = (
  node: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  !(t.isObjectExpression(node) || t.isArrayExpression(node)) ||
  semanticLiteralOwnKeysStable(node, capture, state, capture);

/** A valid options record is separate from evaluating the options expression. */
const importOptionsCanComplete = (
  options: t.Node | null | undefined,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): boolean => {
  if (options == null) return true;
  onLiteralProjection?.();
  const node = importOptionValue(
    options,
    capture,
    state,
    false,
    onLiteralProjection,
  );
  if (node === undefined) return false;
  if (isUnshadowedGlobal(node, state, "undefined")) return true;
  const normal = readExactJavaScriptNormalResult(
    node,
    syntaxEvaluationCannotThrow,
  );
  if (normal.found) return normal.value === undefined;
  if (
    !importOptionObject(node) ||
    !importOptionOwnKeysStable(node, capture, state)
  )
    return false;
  const attributes = t.isObjectExpression(node)
    ? semanticFinalObjectMember(node, "with")
    : undefined;
  if (attributes !== undefined) {
    if (!t.isObjectProperty(attributes)) return false;
    const value = importOptionValue(
      attributes.value,
      capture,
      state,
      true,
      onLiteralProjection,
    );
    if (value === undefined) return false;
    if (isUnshadowedGlobal(value, state, "undefined")) return true;
    const result = readExactJavaScriptNormalResult(
      value,
      syntaxEvaluationCannotThrow,
    );
    return result.found
      ? result.value === undefined
      : importOptionObject(value) &&
          (t.isObjectExpression(value)
            ? value.properties.length === 0
            : t.isArrayExpression(value)
              ? value.elements.length === 0
              : true) &&
          importOptionOwnKeysStable(value, capture, state);
  }
  const prototype = t.isObjectExpression(node)
    ? node.properties.find(
        (property) =>
          t.isObjectProperty(property) &&
          !property.computed &&
          !property.shorthand &&
          semanticStaticPropertyKey(property.key, false) === "__proto__",
      )
    : undefined;
  if (prototype !== undefined)
    return t.isObjectProperty(prototype) && t.isNullLiteral(prototype.value);
  // Array.prototype.with is itself a function with no enumerable attributes;
  // both replacing it and changing its properties invalidate this proof.
  const prototypes = [
    "Object",
    ...(t.isArrayExpression(node)
      ? ["Array"]
      : t.isFunction(node)
        ? ["Function"]
        : []),
  ];
  return prototypes.every(
    (name) =>
      !state.ambientWrites.covers(["global", name, "prototype", "with"]) &&
      !state.ambientEscapes.covers(["global", name, "prototype", "with"]),
  );
};

/** Recover an exact export of a fulfilled literal import, never its promise. */
export const semanticAwaitedImportOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): JavaScriptModuleOrigin | undefined => {
  const chain = semanticMemberChain(node);
  if (chain === undefined || !t.isAwaitExpression(chain.root)) return undefined;
  const result = semanticPromiseSettlementDependency(
    chain.root.argument,
    state,
    onLiteralProjection,
  );
  if (
    result === undefined ||
    result.aliases.some(
      ({ read, initializer }) =>
        !webSocketInitializerDominatesRead(
          initializer.node,
          read,
          state,
          initializer.bindingNode,
        ),
    )
  )
    return undefined;
  const imported = unwrapJavaScriptExpression(result.node).node;
  if (syntaxEvaluationAlwaysThrows(imported)) return undefined;
  const options = t.isImportExpression(imported)
    ? imported.options
    : t.isCallExpression(imported) && t.isImport(imported.callee)
      ? imported.arguments[1]
      : undefined;
  if (!importOptionsCanComplete(options, imported, state, onLiteralProjection))
    return undefined;
  const source = t.isImportExpression(imported)
    ? imported.source
    : t.isCallExpression(imported) && t.isImport(imported.callee)
      ? imported.arguments[0]
      : undefined;
  const specifier = stringValue(source);
  return specifier === undefined
    ? undefined
    : { specifier, importedPath: chain.members, resolutionMode: "import" };
};
