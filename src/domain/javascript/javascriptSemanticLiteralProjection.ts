import { semanticExactResultOperand } from "./javascriptSemanticExpressionResults.js";
import * as t from "@babel/types";

import {
  semanticLiteralContainer,
  semanticLiteralProperty,
  semanticFinalObjectMember,
  semanticStaticPropertyKey,
  readExactJavaScriptLiteral,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticPatternInitializationPrecedesRead } from "./javascriptSemanticEvaluationOrder.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import { syntaxEvaluationAlwaysThrows } from "./javascriptSymbolicControlFlow.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticInitializer,
  JavaScriptSemanticLiteralMemberEffect,
} from "./javascriptSemanticState.js";

type LiteralProjectionSlot =
  | { readonly kind: "value"; readonly node: t.Node }
  | { readonly kind: "accessor"; readonly node: t.ObjectMethod }
  | { readonly kind: "undefined" }
  | { readonly kind: "unknown" | "invalid" };

/** Shared capture ordering and the sole consumer's owned result exposure. */
const literalEffectCanPrecede = (
  effect: JavaScriptSemanticLiteralMemberEffect,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
): boolean => {
  if (
    ownedResultEscape !== undefined &&
    effect.kind === "escape" &&
    effect.path.length === 0 &&
    effect.node === ownedResultEscape
  )
    return false;
  const patternOrder =
    effect.node === undefined
      ? undefined
      : semanticPatternInitializationPrecedesRead(
          capture,
          effect.node,
          state.parentsByNode,
        );
  return !(
    patternOrder ??
    semanticEffectTiming(capture, effect.node, state) === "after"
  );
};

/** Enumeration cannot ignore newly added own keys, even for an empty remainder. */
export const semanticLiteralOwnKeysStable = (
  container: t.ObjectExpression | t.ArrayExpression,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
  excluded: ReadonlySet<string> = new Set(),
): boolean =>
  !state.literalMemberEffects
    ?.get(container)
    ?.some(
      (effect) =>
        literalEffectCanPrecede(effect, capture, state, ownedResultEscape) &&
        (effect.path.length === 0 ||
          (effect.kind === "write" &&
            effect.path.length === 1 &&
            (effect.path[0] === null ||
              !excluded.has(String(effect.path[0]))))),
    );

/** Share slot validity and iterator exhaustion without conflating undefined with unknown. */
export const semanticLiteralProjectionSlot = (
  node: t.Node,
  key: string | number,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  options?: {
    readonly onLiteralProjection?: () => void;
    readonly ownedResultEscape?: t.Node;
  },
): LiteralProjectionSlot => {
  const exactResult = (node: t.Node) => semanticExactResultOperand(node, state);
  const container = semanticLiteralContainer(node, exactResult);
  if (container !== undefined) options?.onLiteralProjection?.();
  if (typeof key === "number" && state.arrayIterationUnknown === true)
    return { kind: "invalid" };
  if (container === undefined) return { kind: "unknown" };
  if (
    container !== undefined &&
    state.literalMemberEffects?.get(container)?.some((effect) => {
      const [affected] = effect.path;
      const affectsSlot =
        effect.path.length === 0 ||
        (effect.kind === "write" &&
          effect.path.length === 1 &&
          affected !== undefined &&
          (semanticPropertyPathKeyMatches(affected, String(key)) ||
            (t.isArrayExpression(container) &&
              semanticArrayIndex(key) !== null &&
              affected === "length")));
      if (!affectsSlot) return false;
      return literalEffectCanPrecede(
        effect,
        capture,
        state,
        options?.ownedResultEscape,
      );
    })
  )
    return { kind: "invalid" };
  const value = semanticLiteralProperty(node, key, exactResult);
  if (value !== undefined) return { kind: "value", node: value };
  if (t.isObjectExpression(container)) {
    const member = semanticFinalObjectMember(container, String(key));
    if (t.isObjectMethod(member) && member.kind === "get")
      return { kind: "accessor", node: member };
  }
  // Iterator exhaustion ignores inherited indexed properties; a hole within
  // the length does not. Spreads leave the actual length unknown.
  if (
    typeof key === "number" &&
    t.isArrayExpression(container) &&
    key >= container.elements.length &&
    !container.elements.some((item) => t.isSpreadElement(item))
  )
    return { kind: "undefined" };
  return { kind: "unknown" };
};

/** Own enumerable literal slots copied by rest, excluding keys already consumed. */
export const semanticLiteralRestSlots = (
  node: t.Node,
  excluded: ReadonlySet<string>,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
): readonly LiteralProjectionSlot[] | undefined => {
  const container = semanticLiteralContainer(node, (expression) =>
    semanticExactResultOperand(expression, state),
  );
  if (
    container !== undefined &&
    !semanticLiteralOwnKeysStable(
      container,
      capture,
      state,
      ownedResultEscape,
      excluded,
    )
  )
    return undefined;
  if (t.isArrayExpression(container)) {
    if (container.elements.some((element) => t.isSpreadElement(element)))
      return undefined;
    return container.elements.flatMap((element, index) =>
      element === null || excluded.has(String(index))
        ? []
        : [
            semanticLiteralProjectionSlot(
              node,
              String(index),
              capture,
              state,
              ownedResultEscape === undefined
                ? undefined
                : { ownedResultEscape },
            ),
          ],
    );
  }
  const value = unwrapJavaScriptExpression(node).node;
  const literal = readExactJavaScriptLiteral(value);
  // Primitive own slots are inert data (string indices); boxing reads no getters.
  if (
    (literal.found && literal.value !== null) ||
    t.isBigIntLiteral(value) ||
    (t.isUnaryExpression(value, { operator: "-" }) &&
      t.isBigIntLiteral(value.argument))
  )
    return [];
  if (!t.isObjectExpression(container)) return undefined;
  const keys = new Set<string>();
  for (const property of container.properties) {
    if (t.isSpreadElement(property)) return undefined;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null) return undefined;
    if (
      t.isObjectProperty(property) &&
      !property.computed &&
      !property.shorthand &&
      key === "__proto__"
    )
      continue;
    if (!excluded.has(key)) keys.add(key);
  }
  return [...keys].map((key) =>
    semanticLiteralProjectionSlot(
      node,
      key,
      capture,
      state,
      ownedResultEscape === undefined ? undefined : { ownedResultEscape },
    ),
  );
};

/** Resolve fresh-literal slots once, preserving capture order and iteration facts. */
export const semanticLiteralInitializerProjection = (
  initializer: JavaScriptSemanticInitializer,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): JavaScriptSemanticInitializer | undefined => {
  // Projection cannot initialize a binding if its owning RHS never completes.
  // Possible failures remain uncertain rather than rejecting useful metadata.
  if (syntaxEvaluationAlwaysThrows(initializer.node)) return undefined;
  let node = initializer.node;
  let projection = initializer.projection;
  while (projection.length > 0) {
    const key = projection[0];
    if (typeof key !== "string" && typeof key !== "number") return undefined;
    const selected = semanticLiteralProjectionSlot(
      node,
      key,
      initializer.bindingNode ?? initializer.node,
      state,
      onLiteralProjection === undefined ? undefined : { onLiteralProjection },
    );
    if (selected.kind === "invalid" || selected.kind === "accessor")
      return undefined;
    if (selected.kind !== "value") break;
    node = selected.node;
    projection = projection.slice(1);
  }
  return { ...initializer, node, projection };
};
