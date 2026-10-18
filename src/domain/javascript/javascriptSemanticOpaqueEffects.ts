import * as t from "@babel/types";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import type { createAmbientPathResolver } from "./javascriptSemanticAmbientWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import {
  semanticEffectTiming,
  semanticBindingEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
} from "./javascriptSemanticState.js";

const blockFunctionNames = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReadonlySet<string>
>();

/** Annex B may copy a block function into a same-named var without an indexed
 * assignment. Preserve the existing conservative source-wide name check until
 * those implicit writes have an explicit scope and timing owner. */
export const semanticBindingMayHaveBlockFunctionWrite = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !binding.declarationKinds.has("var") ||
    javaScriptRuntimeContext(state.program) === "module"
  )
    return false;
  let names = blockFunctionNames.get(state);
  if (names === undefined) {
    const collected = new Set<string>();
    traverseJavaScriptAst(state.program, {
      enter(node, parent) {
        if (
          t.isFunctionDeclaration(node) &&
          node.id != null &&
          !t.isProgram(parent) &&
          !(
            t.isBlockStatement(parent) &&
            t.isFunction(state.parentsByNode.get(parent))
          )
        )
          collected.add(node.id.name);
      },
    });
    names = collected;
    blockFunctionNames.set(state, names);
  }
  return names.has(binding.name);
};

/** One source owns sites and the minimal scope tree reaching them; O(AST) storage. */
export interface JavaScriptOpaqueScopeEffects {
  /** Cheap source evidence collected with declarations, before alias queries. */
  mayReferenceGlobalEval: boolean;
  readonly sites: WeakSet<t.Node>;
  readonly sloppySites: WeakSet<t.Node>;
  readonly byScope: Map<string, t.CallExpression[]>;
  readonly children: Map<string, Set<string>>;
  readonly globalSites: (t.CallExpression | t.OptionalCallExpression)[];
}

const globalEvalRoots = new Set([
  "eval",
  "globalThis",
  "global",
  "window",
  "self",
]);
const possibleGlobalEvalRoots = new WeakMap<
  JavaScriptSemanticAnalysisState,
  t.Node[]
>();

/** Retain cheap origins in the declaration pass for capture-aware phase checks. */
export const indexSemanticPossibleGlobalEvalRoot = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): void => {
  if (!t.isIdentifier(node) || !globalEvalRoots.has(node.name)) return;
  state.opaqueEffects.mayReferenceGlobalEval = true;
  const roots = possibleGlobalEvalRoots.get(state) ?? [];
  roots.push(node);
  possibleGlobalEvalRoots.set(state, roots);
};

export const indexSemanticOpaqueEffects = (
  candidates: readonly {
    node: t.CallExpression;
    scopeId: string;
  }[],
  state: JavaScriptSemanticAnalysisState,
): void => {
  for (const { node, scopeId } of candidates) {
    const callee = unwrapJavaScriptExpression(node.callee).node;
    if (!isUnshadowedGlobal(callee, state, "eval")) continue;
    state.opaqueEffects.sites.add(node);
    if (!semanticStrictContext(node, state))
      state.opaqueEffects.sloppySites.add(node);
    const sites = state.opaqueEffects.byScope.get(scopeId) ?? [];
    sites.push(node);
    state.opaqueEffects.byScope.set(scopeId, sites);
    let scope = state.scopesById.get(scopeId);
    while (scope?.parentScopeId != null) {
      const children =
        state.opaqueEffects.children.get(scope.parentScopeId) ??
        new Set<string>();
      if (children.has(scope.scopeId)) break;
      children.add(scope.scopeId);
      state.opaqueEffects.children.set(scope.parentScopeId, children);
      scope = state.scopesById.get(scope.parentScopeId);
    }
  }
};

/** Share the ambient invocation walk and its completed container-store facts.
 * Only sources referencing eval retain calls for deferred observation; the
 * observer consumes the owner's resolver rather than rebuilding alias facts. */
export const createSemanticOpaqueGlobalObserver = (
  state: JavaScriptSemanticAnalysisState,
  ambientPaths: ReturnType<typeof createAmbientPathResolver>,
  retainGlobal: (node: t.CallExpression | t.OptionalCallExpression) => void = (
    node,
  ) => {
    state.opaqueEffects.globalSites.push(node);
  },
): ((node: t.Node) => void) | undefined => {
  if (!state.opaqueEffects.mayReferenceGlobalEval) return undefined;
  let invocationSite: t.Node | undefined;
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const paths = ambientPaths(node, invocationSite);
      const path = paths.find((path) => path[1] === "eval") ?? paths[0];
      if (path?.[0] !== "global" || path.some((key) => key === null))
        return undefined;
      // Keep the global callable owner for generic call/apply/bind resolution.
      return path[1] === "eval"
        ? ["intrinsic", ...(path as readonly string[])]
        : ["intrinsic", ...(path.slice(1) as readonly string[])];
    },
  });
  return (node) => {
    if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
    invocationSite = node;
    const invocation = interop.intrinsicInvocation(node);
    if (invocation?.path.join(".") === "intrinsic.global.eval")
      retainGlobal(node);
  };
};

/** Indirect eval can change globals, but cannot rebind its caller's locals. */
export const semanticOpaqueGlobalMayHaveChanged = (
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  state.opaqueEffects.globalSites.some(
    (effect) => semanticEffectTiming(read, effect, state) !== "after",
  );

/** Rebinding requires lexical visibility. Object references can remain reachable
 * through aliases even where the original name is shadowed or out of block scope.
 * Without a disjointness proof, consider their enclosing activation and closures.
 * Queries retain no binding-by-eval table. */
export function* semanticOpaqueBindingEffects(
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  kind: "binding" | "reference" = "binding",
): Generator<t.CallExpression> {
  if (state.opaqueEffects.byScope.size === 0) return;
  const pending = [
    kind === "reference" ? activation(binding.scopeId, state) : binding.scopeId,
  ];
  while (pending.length > 0) {
    const scope = pending.pop()!;
    for (const node of state.opaqueEffects.byScope.get(scope) ?? [])
      if (
        kind === "reference" ||
        resolveSemanticBindingState(state, node, binding.name)?.bindingId ===
          binding.bindingId
      )
        yield node;
    for (const child of state.opaqueEffects.children.get(scope) ?? [])
      pending.push(child);
  }
}

export const semanticBindingMayHaveOpaqueEffect = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  read?: t.Node,
  kind: "binding" | "reference" = "binding",
): boolean => {
  if (state.opaqueEffects.byScope.size === 0) return false;
  for (const effect of semanticOpaqueBindingEffects(binding, state, kind))
    if (
      read === undefined ||
      (semanticEffectTiming(read, effect, state) !== "after" &&
        !semanticBindingEffectFollowsCapture(
          binding,
          read,
          effect,
          state.parentsByNode,
        ))
    )
      return true;
  return false;
};

/** Opaque eval may introduce an otherwise unbound name in a visible activation. */
export const semanticOpaqueNameMayHaveChanged = (
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  binding?: JavaScriptSemanticBindingState,
): boolean => {
  if (state.opaqueEffects.byScope.size === 0) return false;
  const visible = new Set<string>();
  let node: t.Node | undefined = read;
  while (node !== undefined) {
    const scope = state.scopeByNode.get(node);
    if (scope !== undefined) {
      let current: typeof scope | undefined = scope;
      while (current !== undefined) {
        visible.add(current.scopeId);
        current =
          current.parentScopeId === null
            ? undefined
            : state.scopesById.get(current.parentScopeId);
      }
      break;
    }
    node = state.parentsByNode.get(node);
  }
  for (const [scopeId, sites] of state.opaqueEffects.byScope) {
    let scope = state.scopesById.get(scopeId);
    while (
      scope !== undefined &&
      scope.kind !== "function" &&
      scope.kind !== "program"
    )
      scope =
        scope.parentScopeId === null
          ? undefined
          : state.scopesById.get(scope.parentScopeId);
    if (
      scope !== undefined &&
      visible.has(scope.scopeId) &&
      (binding === undefined ||
        activation(binding.scopeId, state) !== scope.scopeId) &&
      sites.some(
        (effect) =>
          state.opaqueEffects.sloppySites.has(effect) &&
          (binding === undefined ||
            resolveSemanticBindingState(state, effect, binding.name)
              ?.bindingId === binding.bindingId) &&
          semanticEffectTiming(read, effect, state) !== "after",
      )
    )
      return true;
  }
  return false;
};

/** Declaration assignability is independent of observed explicit writes. */
export const semanticBindingCanBeRebound = (
  binding: JavaScriptSemanticBindingState,
): boolean =>
  binding.mutable ||
  (binding.definitions.some(
    ({ kind }) => kind === "function" || kind === "class",
  ) &&
    binding.initializers.some(
      ({ node }) => t.isFunctionDeclaration(node) || t.isClassDeclaration(node),
    ));

export const semanticOpaqueBindingReadMayHaveChanged = (
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  (semanticBindingCanBeRebound(binding) &&
    semanticBindingMayHaveOpaqueEffect(binding, state, read)) ||
  semanticOpaqueNameMayHaveChanged(read, state, binding);

/** Global eval can rebind mutable script bindings, including lexical lets.
 * Script vars also share storage with own global properties. Consume the
 * ambient owner's canonical writes; CommonJS and module bindings are local. */
export type SemanticGlobalBindingFacts = Pick<
  JavaScriptSemanticAnalysisState,
  "ambientWrites" | "ambientWriteEffects"
> & {
  /** False while global writes or deferred global eval are still unexamined. */
  readonly complete?: boolean;
  readonly opaqueGlobalSites?: readonly t.Node[];
};

interface AmbientWriteCandidates {
  indexed: number;
  readonly roots: Map<
    string,
    {
      readonly owners: Map<string, JavaScriptSemanticMemberEffect[]>;
      readonly broad: JavaScriptSemanticMemberEffect[];
    }
  >;
  readonly broad: JavaScriptSemanticMemberEffect[];
}

// The ambient producer appends immutable effects. Share one linear-size index
// per snapshot, extending it for later appends without retaining another AST.
const ambientWriteCandidates = new WeakMap<
  readonly JavaScriptSemanticMemberEffect[],
  AmbientWriteCandidates
>();

/** Select possible owner prefixes; the full path and caller proof still decide. */
export const semanticAmbientWriteMayMatch = (
  facts: SemanticGlobalBindingFacts,
  path: readonly string[],
  predicate: (effect: JavaScriptSemanticMemberEffect) => boolean,
): boolean => {
  const effects = facts.ambientWriteEffects;
  let candidates = ambientWriteCandidates.get(effects);
  if (candidates === undefined) {
    candidates = { indexed: 0, roots: new Map(), broad: [] };
    ambientWriteCandidates.set(effects, candidates);
  }
  for (; candidates.indexed < effects.length; candidates.indexed += 1) {
    const effect = effects[candidates.indexed]!;
    const [root, owner] = effect.path;
    if (typeof root !== "string" && typeof root !== "number") {
      candidates.broad.push(effect);
      continue;
    }
    let group = candidates.roots.get(String(root));
    if (group === undefined) {
      group = { owners: new Map(), broad: [] };
      candidates.roots.set(String(root), group);
    }
    if (typeof owner !== "string" && typeof owner !== "number")
      group.broad.push(effect);
    else {
      const selected = group.owners.get(String(owner)) ?? [];
      selected.push(effect);
      group.owners.set(String(owner), selected);
    }
  }
  const matches = (effect: JavaScriptSemanticMemberEffect) =>
    effect.path.length <= path.length &&
    effect.path.every((key, index) =>
      semanticPropertyPathKeyMatches(key, path[index]!),
    ) &&
    predicate(effect);
  const group =
    path[0] === undefined ? undefined : candidates.roots.get(path[0]);
  return (
    candidates.broad.some(matches) ||
    (group?.broad.some(matches) ?? false) ||
    (path[1] !== undefined &&
      (group?.owners.get(path[1])?.some(matches) ?? false))
  );
};

export const semanticGlobalBindingReadMayHaveChanged = (
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  facts: SemanticGlobalBindingFacts = state,
): boolean => {
  if (
    !semanticBindingCanBeRebound(binding) ||
    state.scopesById.get(binding.scopeId)?.kind !== "program" ||
    javaScriptRuntimeContext(state.program) !== "unknown"
  )
    return false;
  if (
    facts.complete === false &&
    (binding.declarationKinds.has("var") ||
      (possibleGlobalEvalRoots
        .get(state)
        ?.some((root) => semanticEffectTiming(read, root, state) !== "after") ??
        state.opaqueEffects.mayReferenceGlobalEval))
  )
    return true;
  if (
    (facts.opaqueGlobalSites ?? state.opaqueEffects.globalSites).some(
      (effect) => semanticEffectTiming(read, effect, state) !== "after",
    )
  )
    return true;
  if (
    !binding.declarationKinds.has("var") ||
    !facts.ambientWrites.covers(["global", binding.name])
  )
    return false;
  const initializer =
    binding.initializers.length === 1
      ? binding.initializers[0]?.node
      : undefined;
  const bindingPath = ["global", binding.name];
  return semanticAmbientWriteMayMatch(
    facts,
    bindingPath,
    ({ node }) =>
      semanticEffectTiming(read, node, state) !== "after" &&
      // Initialization replaces earlier assigned values. Reflective writes may
      // instead change a descriptor and prevent that initialization, so keep
      // them without trying to infer the host property's descriptor state.
      (initializer === undefined ||
        !t.isAssignmentExpression(node) ||
        semanticEffectTiming(initializer, node, state) !== "before"),
  );
};

const activation = (
  scopeId: string,
  state: JavaScriptSemanticAnalysisState,
): string => {
  let scope = state.scopesById.get(scopeId);
  while (
    scope !== undefined &&
    scope.kind !== "function" &&
    scope.kind !== "program" &&
    scope.parentScopeId !== null
  )
    scope = state.scopesById.get(scope.parentScopeId);
  return scope?.scopeId ?? scopeId;
};

/** Runtime syntax, rather than erased TypeScript imports, establishes strictness. */
export const semanticStrictContext = (
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  for (
    let node: t.Node | undefined = site;
    node !== undefined;
    node = state.parentsByNode.get(node)
  ) {
    if (
      t.isClass(node) ||
      (t.isProgram(node) && javaScriptRuntimeContext(node) === "module")
    )
      return true;
    const directives = t.isProgram(node)
      ? node.directives
      : t.isFunction(node) && t.isBlockStatement(node.body)
        ? node.body.directives
        : [];
    if (directives.some(({ value }) => value.value === "use strict"))
      return true;
  }
  return false;
};
