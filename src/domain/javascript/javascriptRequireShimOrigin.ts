import * as t from "@babel/types";

import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticHostRequireIntact,
  semanticHostRequireModuleWritesIntact,
  semanticMemberChain,
  type JavaScriptRequireOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import { argumentValue } from "./javascriptStaticAnalysisHelpers.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticBindingMayHaveBlockFunctionWrite,
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";

/**
 * Recover a literal require reached through esbuild's CommonJS `__require` shim.
 *
 * esbuild replaces `require` with an IIFE that selects the host `require` at
 * runtime and otherwise falls back to the passed function:
 *
 *   var Q = (e => typeof require < "u" ? require : typeof Proxy < "u"
 *     ? new Proxy(e, { get: (t, n) => (typeof require < "u" ? require : t)[n] })
 *     : e)(function (e) { ... });
 *
 * Minification then turns `require("electron")` into `Q("electron")`, which the
 * direct-require resolver cannot follow. The shim is accepted only when one
 * never-reassigned binding holds a flat IIFE whose arrow callee guards the
 * unshadowed global `require` behind its availability test, and is applied to a
 * fallback function. `Q("electron")` inside that scope is then the same literal
 * require. Syntax is proven, never inferred from the binding name, and a shim
 * that would always return its fallback is refused.
 */
export const semanticRequireShimOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    !t.isCallExpression(current) ||
    !t.isIdentifier(current.callee) ||
    current.arguments.length !== 1
  )
    return undefined;
  const specifier = argumentValue(current.arguments[0]);
  if (specifier === undefined) return undefined;
  const binding = resolveSemanticBindingState(
    state,
    current.callee,
    current.callee.name,
  );
  if (
    binding === undefined ||
    semanticResolutionBlocked(state, current.callee, current.callee.name) ||
    semanticOpaqueBindingReadMayHaveChanged(binding, current.callee, state) ||
    semanticBindingMayHaveBlockFunctionWrite(binding, state) ||
    binding.definitions.length !== 1 ||
    binding.definitions[0]?.kind === "assignment"
  )
    return undefined;
  const atRead = semanticBindingAtRead(
    binding,
    current.callee,
    state.parentsByNode,
  );
  if (
    // Unordered reads retain possible initializers for conservative alias
    // effects. They do not prove that the loader exists at this call site.
    !atRead.hasDefiniteInitializer ||
    semanticGlobalBindingReadMayHaveChanged(
      atRead.binding,
      current.callee,
      state,
    ) ||
    !bindsRequireShim(atRead.binding, state) ||
    // The shim captured `require` at its own definition, so a later bare
    // `require = ...` does not change the saved loader and is not a reason to
    // reject here. A write to the module `require` delegate still redirects the
    // saved function at load time, so that check runs at the consumer call.
    !semanticHostRequireModuleWritesIntact(current, state)
  )
    return undefined;
  return {
    origin: {
      specifier,
      importedPath: chain.members,
      resolutionMode: "require",
    },
    call: current,
  };
};

/**
 * Prove that this binding is the whole shim result, never a destructured or
 * member projection of it. `semanticStableInitializer` pairs the initializer
 * with its projection, so a destructured property such as
 * `const { notTheLoader: Q } = shim(fallback)` reads the shim node with a
 * nonempty projection and must not alias the host loader. Reference and
 * default sources copy a value through destructuring the same way, so they are
 * refused too.
 */
const bindsRequireShim = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.referenceInitializers.length !== 0) return false;
  const stable = semanticStableInitializer(binding, state);
  if (
    stable === undefined ||
    stable.projection.length !== 0 ||
    !t.isCallExpression(stable.node)
  )
    return false;
  // Provenance can be queried while effect indexing is still in progress.
  // The proof includes host-loader integrity, so do not retain it beyond the
  // shared provenance owner's dependency-aware query lifetime.
  return shimSelectsRequire(stable.node, state);
};

/**
 * A flat IIFE whose arrow callee guards the host `require` with its
 * availability and is applied to a fallback function. esbuild emits exactly
 * this shape, so the argument count and callee form are part of the proof.
 */
const shimSelectsRequire = (
  call: t.CallExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const callee = call.callee;
  if (
    (!t.isArrowFunctionExpression(callee) && !t.isFunctionExpression(callee)) ||
    callee.generator ||
    callee.async ||
    callee.params.length !== 1 ||
    !t.isIdentifier(callee.params[0]) ||
    call.arguments.length !== 1 ||
    // Arguments run before the guard reads require. Only creating a function
    // is inert here; an evaluated fallback could replace the host loader.
    (!t.isFunctionExpression(call.arguments[0]) &&
      !t.isArrowFunctionExpression(call.arguments[0]))
  )
    return false;
  const body = t.isBlockStatement(callee.body) ? undefined : callee.body;
  return body !== undefined && selectsGlobalRequire(body, call, state);
};

/**
 * The expression yields the unshadowed global `require` on the branch its own
 * availability guard selects.
 *
 * esbuild reaches `require` only through its availability test and nests that
 * test for the Proxy fallback, so a nested conditional is followed only when
 * its own guard establishes the same availability. Any other condition, such
 * as a literal `false`, is refused: the shim would then always return the
 * fallback and never load the requested module.
 */
const selectsGlobalRequire = (
  expression: t.Expression,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (t.isConditionalExpression(expression)) {
    if (!guardsRequireAvailability(expression.test, capture, state))
      return false;
    return selectsGlobalRequire(expression.consequent, capture, state);
  }
  return isGlobalRequire(expression, capture, state);
};

/**
 * The unshadowed global `require` at the point `capture` runs. This reuses the
 * direct resolver's host-loader checks so a module-level replacement, such as
 * `require = mockLoader` before the shim, is not mistaken for the host loader.
 */
const isGlobalRequire = (
  node: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isIdentifier(node, { name: "require" }) &&
  semanticHostRequireIntact(node, capture, state);

/**
 * Whether `test` is the availability check for the host `require`. esbuild
 * emits `typeof require < "u"` after minification and `typeof require !==
 * "undefined"` before it; both are accepted, and nothing weaker, so a branch
 * reached under an unrelated condition is not treated as the host loader.
 */
const guardsRequireAvailability = (
  test: t.Expression,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!t.isBinaryExpression(test)) return false;
  const testOnLeft = isTypeofRequire(test.left, capture, state);
  const testOnRight = isTypeofRequire(test.right, capture, state);
  if (testOnLeft === testOnRight) return false;
  const literal = readLiteralText(testOnLeft ? test.right : test.left);
  if (test.operator === "<") return testOnLeft && literal === "u";
  return (
    (test.operator === "!=" || test.operator === "!==") &&
    literal === "undefined"
  );
};

/** Whether this operand is `typeof require` for the unshadowed host `require`. */
const isTypeofRequire = (
  node: t.Node,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  t.isUnaryExpression(node, { operator: "typeof" }) &&
  isGlobalRequire(node.argument, capture, state);

const readLiteralText = (node: t.Node): string | undefined =>
  t.isStringLiteral(node) ? node.value : undefined;
