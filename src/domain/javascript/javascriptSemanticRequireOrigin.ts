import * as t from "@babel/types";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  createSemanticModuleStorageQuery,
  semanticAmbientBindingPaths,
  semanticAmbientIdentitySourcesReady,
  type SemanticModuleProjection as ModuleProjection,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  electronMemberPath,
  semanticIntrinsicMutation,
  semanticIntrinsicMutationTargets,
} from "./javascriptElectronMemberWrites.js";

import { BUILTIN_RESOURCE_METHODS } from "./javascriptBuiltinResourceMethods.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  isUnmodifiedCommonJsWrapperBinding,
  commonJsWrapperBindingDeclaration,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticBindingAtRead,
  semanticEffectFollowsInitialCapture,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  INVOCATION_HELPERS,
  semanticFunctionValueIdentity,
} from "./javascriptSemanticFunctionValues.js";
import {
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";

export interface JavaScriptRequireOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly call: t.CallExpression | t.OptionalCallExpression;
}

export type JavaScriptRequireLoaderFact =
  | "commonjs-loader"
  | "factory-loader"
  | "create-require"
  | "local"
  | "unknown";

/** Classify a bare `require(...)` using the shared lexical binding owner. */
export const semanticRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  factoryBindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  const loader = t.isIdentifier(callee, { name: "require" })
    ? callee
    : (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
        ["resolve", "main"].includes(
          semanticStaticPropertyKey(callee.property, callee.computed) ?? "",
        ) &&
        t.isIdentifier(callee.object, { name: "require" })
      ? callee.object
      : undefined;
  if (loader === undefined) return "local";
  const binding = resolveSemanticBindingState(state, loader, "require");
  if (binding === undefined) {
    if (semanticResolutionBlocked(state, loader, "require")) return "unknown";
    return (state.ambientBindingWrites.get("require") ?? []).some(
      (write) => !semanticEffectFollowsInitialCapture(node, write, state),
    )
      ? "unknown"
      : "commonjs-loader";
  }
  if (factoryBindingIds.has(binding.bindingId))
    return binding.initializers.length === 0 ? "factory-loader" : "unknown";
  if (
    binding.hostOrigin === "commonjs-wrapper" &&
    [...binding.declarationKinds].every((kind) => kind === "var")
  ) {
    if (binding.definitions.some(({ kind }) => kind === "function"))
      return "local";
    return commonJsWrapperBindingHasPriorWrite(node, binding, state)
      ? "unknown"
      : "commonjs-loader";
  }
  if (isWrapperRequireInitializerCall(binding, node, state))
    return "commonjs-loader";
  const wrapperBinding = commonJsWrapperBindingDeclaration(
    loader,
    "require",
    state,
  );
  if (
    wrapperBinding !== undefined &&
    !commonJsWrapperBindingHasPriorWrite(node, wrapperBinding, state)
  )
    return "commonjs-loader";
  if (isSemanticCreateRequireBinding(binding, state)) return "create-require";
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (
    (binding.kind === "function" || binding.kind === "class") &&
    initializer !== undefined
  )
    return "local";
  if (
    binding.declarationKinds.size === 1 &&
    binding.declarationKinds.has("const") &&
    (t.isFunctionExpression(initializer) ||
      t.isArrowFunctionExpression(initializer))
  )
    return "local";
  return "unknown";
};

const commonJsWrapperBindingHasPriorWrite = (
  site: t.Node,
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const writes = state.bindingWrites.get(binding.bindingId) ?? [];
  const declarationInitializers = binding.initializers
    .map(({ node }) => node)
    .filter(
      (initializer) =>
        !writes.some((write) => semanticNodeWithin(initializer, write, state)),
    );
  return (
    writes.some(
      (write) => !semanticEffectFollowsInitialCapture(site, write, state),
    ) ||
    declarationInitializers.some(
      (initializer) =>
        !semanticEffectFollowsInitialCapture(site, initializer, state),
    )
  );
};

const semanticNodeWithin = (
  node: t.Node,
  ancestor: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current: t.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = state.parentsByNode.get(current);
  }
  return false;
};

/** Classify a call through an exact recovered factory-loader binding. */
export const semanticFactoryRequireLoaderAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (t.isIdentifier(callee))
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, null);
  if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === "bind"
  )
    return semanticFactoryLoaderMemberAt(node, state, bindingIds, "bind");
  return undefined;
};

/** Classify an exact loader call by binding identity and expected member. */
export const semanticFactoryLoaderMemberAt = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
  bindingIds: ReadonlySet<string>,
  member: string | null,
): JavaScriptRequireLoaderFact | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  let loader: t.Identifier | undefined;
  if (member === null) {
    if (t.isIdentifier(callee)) loader = callee;
  } else if (
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
    semanticStaticPropertyKey(callee.property, callee.computed) === member
  ) {
    const root = unwrapJavaScriptExpression(callee.object).node;
    if (t.isIdentifier(root)) loader = root;
  }
  if (loader === undefined) return undefined;
  const binding = resolveSemanticBindingState(state, loader, loader.name);
  if (binding === undefined || !bindingIds.has(binding.bindingId))
    return undefined;
  return binding.initializers.length === 0 ? "factory-loader" : "unknown";
};

const isSemanticCreateRequireBinding = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (binding.initializers.length !== 1) return false;
  const initializer = semanticStableInitializer(binding, state)?.node;
  if (!t.isCallExpression(initializer)) return false;
  const callee = unwrapJavaScriptExpression(initializer.callee).node;
  if (t.isIdentifier(callee)) {
    const origins = resolveSemanticBindingState(
      state,
      callee,
      callee.name,
    )?.directOrigins;
    if (origins?.length !== 1) return false;
    const [origin] = origins;
    return (
      origin?.importedPath.at(-1) === "createRequire" &&
      ["module", "node:module"].includes(origin.specifier)
    );
  }
  const chain = semanticMemberChain(callee);
  if (chain === undefined || chain.members.at(-1) !== "createRequire")
    return false;
  if (!t.isNode(chain.root)) return false;
  const root = unwrapJavaScriptExpression(chain.root).node;
  if (!t.isIdentifier(root)) return false;
  const origins = resolveSemanticBindingState(
    state,
    root,
    root.name,
  )?.directOrigins;
  if (origins?.length !== 1) return false;
  const [origin] = origins;
  return (
    origin?.importedPath.length === 0 &&
    ["module", "node:module"].includes(origin.specifier)
  );
};

/** The RHS call runs before its assignment replaces Node's wrapper loader. */
const isWrapperRequireInitializerCall = (
  binding: NonNullable<ReturnType<typeof resolveSemanticBindingState>>,
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const scope = state.scopesById.get(binding.scopeId);
  if (
    scope?.kind !== "program" ||
    binding.kind !== "variable" ||
    binding.declarationKinds.size !== 1 ||
    !binding.declarationKinds.has("var") ||
    binding.initializers.length !== 1 ||
    binding.initializers[0]?.node !== node
  )
    return false;
  const assignment = state.parentsByNode.get(node);
  if (
    !t.isAssignmentExpression(assignment) ||
    assignment.right !== node ||
    state.conditionallySkippedExpressions.has(node)
  )
    return false;
  const statement = state.parentsByNode.get(assignment);
  if (!t.isExpressionStatement(statement)) return false;
  if (state.parentsByNode.get(statement) !== state.program) return false;
  const target = unwrapJavaScriptExpression(assignment.left).node;
  return (
    t.isIdentifier(target, { name: "require" }) &&
    resolveSemanticBindingState(state, target, target.name) === binding
  );
};

// Ambient indexing finishes before these derived facts are consumed. Keep only
// replacement sites, rather than rescanning unrelated global member writes.
const globalProcessReplacements = new WeakMap<
  JavaScriptSemanticAnalysisState,
  readonly (t.Node | undefined)[]
>();
const moduleRequireWrites = new WeakMap<
  JavaScriptSemanticAnalysisState,
  {
    readonly ambientCount: number;
    readonly ambientSourcesReady: boolean;
    readonly freshObjectFactsReady: boolean;
    readonly opaqueScopeCount: number;
    readonly writes: readonly ModuleDelegateWrite[];
  }
>();

interface ModuleDelegateWrite {
  readonly node: t.Node;
  readonly delegate: "require" | "_load";
  readonly shared: boolean;
}

const writesModuleRequire = (
  state: JavaScriptSemanticAnalysisState,
): readonly ModuleDelegateWrite[] => {
  const cached = moduleRequireWrites.get(state);
  const ambientCount = state.ambientWriteEffects.length;
  const ambientSourcesReady = semanticAmbientIdentitySourcesReady(state);
  const freshObjectFactsReady = semanticFreshObjectFactsReady(state);
  const opaqueScopeCount = state.opaqueEffects.byScope.size;
  if (
    cached?.ambientCount === ambientCount &&
    cached.ambientSourcesReady === ambientSourcesReady &&
    cached.freshObjectFactsReady === freshObjectFactsReady &&
    cached.opaqueScopeCount === opaqueScopeCount
  )
    return cached.writes;
  // Interop invocation resolution may ask for require provenance while this
  // index is being built. Publish a temporary empty result to break that cycle.
  moduleRequireWrites.set(state, {
    ambientCount,
    ambientSourcesReady,
    freshObjectFactsReady,
    opaqueScopeCount,
    writes: [],
  });
  const writes: ModuleDelegateWrite[] = [];
  const interop = createSemanticModuleInterop(state);
  // Ambient indexing owns container stores and intrinsic prototype aliases.
  // Queries made during indexing must be refreshed when those facts arrive.
  for (const { node, path } of state.ambientWriteEffects) {
    if (node === undefined) continue;
    const owner = moduleDelegateWriteOwner(path, node, interop);
    if (owner !== undefined) writes.push({ node, ...owner });
  }
  const projectionMayAliasModule = createSemanticModuleStorageQuery(
    state,
    interop,
  );
  const isModuleObject = (
    node: t.Node,
    visited = new Set<string>(),
    projection: ModuleProjection = [],
  ): boolean => {
    const { root: value, members } = electronMemberPath(node);
    const selected = [
      ...members.map((key) => ({ key, capture: node })),
      ...projection,
    ];
    if (!t.isIdentifier(value)) return false;
    if (value.name === "module") {
      const original =
        resolveSemanticBindingState(state, value, "module") === undefined
          ? !semanticResolutionBlocked(state, value, "module")
          : isUnmodifiedCommonJsWrapperBinding(value, "module", state);
      return (
        original &&
        (selected.length === 0 || projectionMayAliasModule(selected))
      );
    }
    const binding = resolveSemanticBindingState(state, value, value.name);
    if (binding === undefined || visited.has(binding.bindingId)) return false;
    const next = new Set(visited).add(binding.bindingId);
    const atRead = semanticBindingAtRead(
      binding,
      value,
      state.parentsByNode,
    ).binding;
    // A module property starts distinct, but a visible replacement can store
    // the module itself. Retain the complete path through nested projections.
    // Separate capture sites keep a copied slot fixed while allowing a later
    // read of a property inside that captured object to see intervening writes.
    const sources = [
      ...atRead.initializers.map((initializer) => ({
        node: initializer.node,
        path: [
          ...initializer.projection.map((key) => ({
            key,
            capture: initializer.node,
          })),
          ...selected,
        ],
      })),
      ...atRead.referenceInitializers.flatMap((initializer) => {
        if (semanticReferenceSourcesInactive(initializer, state, "syntax-only"))
          return [];
        const path = semanticCopiedReferencePath(
          initializer,
          selected.map(({ key }) => key),
          "reference",
        );
        if (path === null) return [];
        const captures = [
          ...initializer.projection.map(() => initializer.node),
          ...selected.map(({ capture }) => capture),
        ];
        const offset = initializer.copyProjectionOffset;
        if (offset !== undefined) {
          captures.splice(offset, 1);
          captures[offset] = initializer.node;
        }
        return [
          {
            node: initializer.node,
            path: path.map((key, index) => ({
              key: typeof key === "object" ? null : key,
              capture: captures[index] ?? initializer.node,
            })),
          },
        ];
      }),
    ];
    return sources.some(({ node: init, path }) =>
      isModuleObject(init, next, path),
    );
  };
  // Direct eval can reach the wrapper's live delegate through the module
  // binding or visible captured contents even when the saved loader is shadowed.
  // Its text is opaque: both the instance/prototype method and Module._load can
  // change. Keeping these in the shared index preserves invocation/capture
  // semantics for wrappers, saved delegates, and createRequire results.
  for (const [scopeId, effects] of state.opaqueEffects.byScope) {
    let visible: JavaScriptSemanticBindingState[] | undefined;
    const visibleBindings = (): readonly JavaScriptSemanticBindingState[] => {
      if (visible !== undefined) return visible;
      visible = [];
      const names = new Set<string>();
      let scope = state.scopesById.get(scopeId);
      while (scope !== undefined) {
        for (const binding of scope.bindings.values()) {
          if (names.has(binding.name)) continue;
          names.add(binding.name);
          visible.push(binding);
        }
        scope =
          scope.parentScopeId === null
            ? undefined
            : state.scopesById.get(scope.parentScopeId);
      }
      return visible;
    };
    for (const effect of effects) {
      const moduleBinding = resolveSemanticBindingState(
        state,
        effect,
        "module",
      );
      const seesWrapperModule =
        moduleBinding === undefined
          ? !semanticResolutionBlocked(state, effect, "module")
          : isUnmodifiedCommonJsWrapperBinding(effect, "module", state);
      if (
        !seesWrapperModule &&
        !visibleBindings().some((binding) =>
          semanticAmbientBindingPaths(binding, effect, state).some(
            (path) =>
              moduleDelegateWriteOwner([...path, "require"], effect, interop) ||
              moduleDelegateWriteOwner([...path, "_load"], effect, interop),
          ),
        )
      )
        continue;
      writes.push(
        { node: effect, delegate: "require", shared: true },
        { node: effect, delegate: "_load", shared: true },
      );
    }
  }
  traverseJavaScriptAst(state.program, {
    enter: (node) => {
      const target = t.isAssignmentExpression(node)
        ? node.left
        : t.isUpdateExpression(node) ||
            t.isUnaryExpression(node, { operator: "delete" })
          ? node.argument
          : undefined;
      if (
        (t.isMemberExpression(target) ||
          t.isOptionalMemberExpression(target)) &&
        isModuleObject(target.object)
      ) {
        const key = semanticStaticPropertyKey(target.property, target.computed);
        if (
          key === null ||
          key === "require" ||
          (key === "__proto__" && t.isAssignmentExpression(node))
        )
          writes.push({ node, delegate: "require", shared: false });
      }
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const invocation = interop.intrinsicInvocation(node);
        const mutation = semanticIntrinsicMutation(invocation);
        const args = invocation?.arguments;
        if (
          invocation !== undefined &&
          mutation !== undefined &&
          semanticIntrinsicMutationTargets(
            invocation,
            interop.isFreshObject,
          ).some((target) => target !== undefined && isModuleObject(target))
        ) {
          if ("key" in mutation) {
            const key = interop.staticString(mutation.key);
            if (
              key === "require" ||
              key === undefined ||
              (key === "__proto__" && mutation.kind === "set")
            )
              writes.push({ node, delegate: "require", shared: false });
          } else if (mutation.kind === "set-prototype") {
            // The CommonJS delegate can be inherited from Module.prototype.
            writes.push({ node, delegate: "require", shared: false });
          } else if (mutation.kind === "define-properties") {
            if (objectMayDefineDelegate(args?.[1]))
              writes.push({ node, delegate: "require", shared: false });
          } else if (
            args
              ?.slice(1)
              .some((source) => objectMayDefineDelegate(source, true))
          )
            writes.push({ node, delegate: "require", shared: false });
        }
      }
    },
  });
  moduleRequireWrites.set(state, {
    ambientCount,
    ambientSourcesReady,
    freshObjectFactsReady,
    opaqueScopeCount,
    writes,
  });
  return writes;
};

/** Unknown keys and spreads cannot prove the loader delegate was untouched. */
const objectMayDefineDelegate = (
  node: t.Node | undefined,
  invokesSetters = false,
  delegate: "require" | "_load" = "require",
): boolean =>
  !t.isObjectExpression(node) ||
  node.properties.some((property) => {
    if (t.isSpreadElement(property)) return true;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    return (
      key === null ||
      key === delegate ||
      // Object.assign invokes the legacy prototype setter for an own
      // __proto__ key. A literal prototype initializer creates no own key.
      (invokesSetters &&
        delegate === "require" &&
        key === "__proto__" &&
        (t.isObjectMethod(property) || property.computed || property.shorthand))
    );
  });

/** Whether the original global process object can still own effects at this source site. */
export const semanticOriginalGlobalProcessAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let replacements = globalProcessReplacements.get(state);
  if (replacements === undefined) {
    replacements = [
      ...state.ambientWriteEffects
        .filter(
          ({ path }) =>
            path.length <= 2 &&
            path.every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", "process"][index]!,
              ),
            ),
        )
        .map(({ node: write }) => write),
      ...(state.ambientBindingWrites.get("process") ?? []),
    ];
    globalProcessReplacements.set(state, replacements);
  }
  return !replacements.some(
    (write) =>
      !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
  );
};

/** Node's unbound process reference shares the cached process exports object. */
export const semanticGlobalProcessOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined =>
  t.isIdentifier(node, { name: "process" }) &&
  resolveSemanticBindingState(state, node, "process") === undefined &&
  !semanticResolutionBlocked(state, node, "process") &&
  semanticOriginalGlobalProcessAt(node, state)
    ? { specifier: "node:process", importedPath: [], resolutionMode: "require" }
    : undefined;

/** Resolve qualified global-object process references, preserving their selected path. */
export const semanticGlobalProcessPathOrigin = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptModuleOrigin | undefined => {
  const members: string[] = [];
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const key = semanticStaticPropertyKey(current.property, current.computed);
    if (key === null) return undefined;
    members.unshift(key);
    current = unwrapJavaScriptExpression(current.object).node;
  }
  if (
    !t.isIdentifier(current) ||
    !["globalThis", "global", "window", "self"].includes(current.name) ||
    resolveSemanticBindingState(state, current, current.name) !== undefined ||
    semanticResolutionBlocked(state, current, current.name) ||
    members[0] !== "process" ||
    !semanticOriginalGlobalProcessAt(node, state)
  )
    return undefined;
  return {
    specifier: "node:process",
    importedPath: members.slice(1),
    resolutionMode: "require",
  };
};

/** Strip a static member chain, returning its root expression and member path. */
export const semanticMemberChain = (
  node: t.Node | null | undefined,
):
  | { readonly root: t.Node | null | undefined; readonly members: string[] }
  | undefined => {
  const members: string[] = [];
  let current = node;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      break;
    const member = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (member === null || !t.isNode(current.object)) return undefined;
    members.push(member);
    current = current.object;
  }
  return { root: current, members: members.reverse() };
};

/**
 * Whether no write to the module `require` delegate happens before `capture`
 * runs. A saved `require` function still calls the current `module.require`, so
 * this check belongs at the point the loader is invoked, not only where it was
 * captured.
 */
export const semanticHostRequireModuleWritesIntact = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  !writesModuleRequire(state).some(
    ({ node: write }) =>
      !semanticEffectFollowsInitialCapture(capture, write, state),
  );

const moduleDelegateWriteOwner = (
  path: JavaScriptSemanticPropertyPath,
  node: t.Node,
  interop: ReturnType<typeof createSemanticModuleInterop>,
): Omit<ModuleDelegateWrite, "node"> | undefined => {
  if (path[0] !== "commonjs-module") return undefined;
  // Ambient value normalization already selects the shared Module owners.
  // Module.prototype owns require: changing its parent cannot replace that
  // slot, while changing the wrapper's immediate prototype can hide it.
  const wrapper = path.length <= 2;
  const shared =
    path.length === 3 && (path[1] === "__proto__" || path[1] === "constructor");
  if (!wrapper && !shared) return undefined;
  // The inherited instance method dispatches through Module._load as well.
  const delegate = shared && path[1] === "constructor" ? "_load" : "require";
  const owner = { delegate, shared } as const;
  const key = path.at(-1)!;
  if (path.length === 1) return owner;
  if (
    !semanticPropertyPathKeyMatches(key, delegate) &&
    !(wrapper && key === "__proto__")
  )
    return undefined;
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const invocation = interop.intrinsicInvocation(node);
    const mutation = semanticIntrinsicMutation(invocation);
    const args = invocation?.arguments;
    if (mutation?.kind === "set-prototype") return wrapper ? owner : undefined;
    if (mutation?.kind === "assign")
      return args === undefined ||
        args
          .slice(1)
          .some((source) => objectMayDefineDelegate(source, wrapper, delegate))
        ? owner
        : undefined;
    if (mutation?.kind === "define-properties")
      return objectMayDefineDelegate(args?.[1], false, delegate)
        ? owner
        : undefined;
    // Defining an own __proto__ property does not invoke the legacy setter.
    return key !== "__proto__" || mutation?.kind === "set" ? owner : undefined;
  }
  return key !== "__proto__" || t.isAssignmentExpression(node)
    ? owner
    : undefined;
};

/**
 * Whether no module or ambient write replaces `require` before `capture` runs.
 * These checks are mandatory for a bare `require` reference: a replaced loader
 * is not the host loader regardless of how its binding resolves.
 */
export const semanticHostRequireWritesIntact = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  semanticHostRequireModuleWritesIntact(capture, state) &&
  !(state.ambientBindingWrites.get("require") ?? []).some(
    (write) => !semanticEffectFollowsInitialCapture(capture, write, state),
  );

/**
 * Whether `reference` reads the intact host `require` at the point `capture`
 * runs. This is the single owner for the host-loader checks shared by the
 * direct resolver and by the esbuild shim resolver, which reaches `require`
 * only through a `typeof require` guard. It applies the mandatory write checks
 * and the binding check together; a caller that has its own binding exception
 * must still require {@link semanticHostRequireWritesIntact} separately.
 */
export const semanticHostRequireIntact = (
  reference: t.Identifier,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  semanticHostRequireWritesIntact(capture, state) &&
  semanticHostRequireBindingIntact(reference, state);

/** Whether the `require` reference is the unmodified CommonJS wrapper loader. */
const semanticHostRequireBindingIntact = (
  reference: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const binding = resolveSemanticBindingState(state, reference, "require");
  if (binding !== undefined)
    return isUnmodifiedCommonJsWrapperBinding(reference, "require", state);
  return !semanticResolutionBlocked(state, reference, "require");
};

const HOST_MODULE = "node-wrapper-module";
const HOST_LOADER = "node-host-loader";

/** Resolve the value read at each alias capture, rather than its current name. */
const hostLoaderPath = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly string[] | undefined => {
  let current = node;
  let selected: ModuleProjection = [];
  const visited = new Set<string>();
  // Preserve a rejected helper read through the invocation owner's generic
  // call/apply normalization; returning no path would retry its receiver.
  const invalid = ["invalid-host-loader"];
  const untouched = (
    path: readonly string[],
    captures: readonly t.Node[],
    ownFrom = 0,
  ): boolean => {
    if (!state.ambientWrites.covers(path)) return true;
    return !state.ambientWriteEffects.some((effect) => {
      return (
        effect.path.length > ownFrom &&
        effect.path.length <= path.length &&
        effect.path.every((key, index) =>
          semanticPropertyPathKeyMatches(key, path[index]!),
        ) &&
        !semanticEffectFollowsInitialCapture(
          captures[Math.min(effect.path.length - 1, captures.length - 1)]!,
          effect.node,
          state,
        )
      );
    });
  };
  const helpersIntact = (
    initial: readonly string[],
    suffix: ModuleProjection,
  ): boolean => {
    let identity: readonly string[] | undefined = initial;
    for (const { key, capture } of suffix) {
      if (typeof key !== "string" || identity === undefined) return false;
      if (
        !untouched([...identity, key], [capture], identity.length) ||
        (INVOCATION_HELPERS.includes(key) &&
          (!untouched(["global", "Function", "prototype", key], [capture]) ||
            !untouched([...identity, "__proto__"], [capture], identity.length)))
      )
        return false;
      identity = semanticFunctionValueIdentity([...identity, key]);
    }
    return identity !== undefined;
  };
  const callable = (
    kind: "wrapper" | "delegate" | "created" | "factory",
    suffix: ModuleProjection = selected,
  ): readonly string[] | undefined => {
    // Factory results are fresh callables. Their own invocation helpers do not
    // have a shared ambient identity, so only direct invocation is proven.
    if (kind === "created" && suffix.length !== 0) return invalid;
    const identity =
      kind === "wrapper"
        ? ["global", "require"]
        : kind === "delegate"
          ? ["commonjs-module", "__proto__", "require"]
          : kind === "factory"
            ? ["commonjs-module", "constructor", "createRequire"]
            : undefined;
    if (identity !== undefined && !helpersIntact(identity, suffix))
      return invalid;
    return [
      "intrinsic",
      HOST_LOADER,
      kind,
      ...suffix.map(({ key }) => String(key)),
    ];
  };
  const factoryPath = (
    origin: JavaScriptModuleOrigin,
    projection: ModuleProjection,
    importedAt: t.Node,
  ): readonly string[] | undefined => {
    if (!["module", "node:module"].includes(origin.specifier)) return undefined;
    const path = [
      ...origin.importedPath.map((key) => ({ key, capture: importedAt })),
      ...projection,
    ];
    // Namespace exports are captured values. Only default/Module selects the
    // mutable constructor object; CommonJS has no synthetic default property.
    if (origin.resolutionMode !== "require") {
      const exported = path.shift();
      if (exported?.key === "createRequire") return callable("factory", path);
      if (exported?.key !== "default" && exported?.key !== "Module")
        return undefined;
    }
    while (path[0]?.key === "Module") {
      const property = path.shift()!;
      if (
        !untouched(
          ["commonjs-module", "constructor", "Module"],
          [property.capture],
        )
      )
        return undefined;
    }
    const factory = path.shift();
    if (
      factory?.key !== "createRequire" ||
      !untouched(
        ["commonjs-module", "constructor", "createRequire"],
        [factory.capture],
      )
    )
      return undefined;
    return callable("factory", path);
  };
  for (;;) {
    const { root, members } = electronMemberPath(current);
    selected = [
      ...members.map((key) => ({ key, capture: current })),
      ...selected,
    ];
    if (selected.some(({ key }) => key === null)) return undefined;
    if (t.isIdentifier(root)) {
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (
        semanticResolutionBlocked(state, root, root.name) ||
        (binding !== undefined &&
          (semanticOpaqueBindingReadMayHaveChanged(binding, root, state) ||
            semanticGlobalBindingReadMayHaveChanged(binding, root, state)))
      )
        return undefined;
      if (
        root.name === "require" &&
        semanticHostRequireIntact(root, root, state)
      )
        return callable("wrapper");
      if (
        root.name === "module" &&
        (binding === undefined ||
          (commonJsWrapperBindingDeclaration(root, "module", state) !==
            undefined &&
            !commonJsWrapperBindingHasPriorWrite(root, binding, state))) &&
        !(state.ambientBindingWrites.get("module") ?? []).some(
          (write) => !semanticEffectFollowsInitialCapture(root, write, state),
        )
      ) {
        if (selected.length === 0) return [HOST_MODULE];
        const [property, ...suffix] = selected;
        return property?.key === "require" &&
          semanticHostRequireModuleWritesIntact(property.capture, state)
          ? callable("delegate", suffix)
          : undefined;
      }
      if (
        binding === undefined &&
        ["Function", "Reflect"].includes(root.name)
      ) {
        const path = [root.name, ...selected.map(({ key }) => String(key))];
        const helperStart = root.name === "Function" ? 0 : 1;
        const identity =
          root.name === "Function"
            ? ["global", "Function"]
            : ["global", "Reflect", "apply"];
        return untouched(
          ["global", ...path],
          [root, root, ...selected.map(({ capture }) => capture)],
        ) && helpersIntact(identity, selected.slice(helperStart))
          ? ["intrinsic", ...path]
          : invalid;
      }
      if (binding === undefined || visited.has(binding.bindingId))
        return undefined;
      visited.add(binding.bindingId);
      if (
        binding.memberWrites.some(
          (effect) =>
            effect.path.length <= selected.length &&
            effect.path.every((key, index) =>
              semanticPropertyPathKeyMatches(key, String(selected[index]!.key)),
            ) &&
            !semanticEffectFollowsInitialCapture(
              selected[Math.max(0, effect.path.length - 1)]?.capture ?? root,
              effect.node,
              state,
            ),
        )
      )
        return invalid;

      const atRead = semanticBindingAtRead(binding, root, state.parentsByNode);
      // Direct import origins describe entry values. A preceding assignment or
      // an uncertain replacement must be resolved before using that entry.
      if (
        binding.directOrigins.length === 1 &&
        !atRead.hasDefiniteInitializer
      ) {
        if (
          (state.bindingWrites.get(binding.bindingId) ?? []).some(
            (write) => !semanticEffectFollowsInitialCapture(root, write, state),
          )
        )
          return undefined;
        const origin = binding.directOrigins[0]!;
        if (!binding.runtimeImport && origin.resolutionMode !== "require")
          return undefined;
        return factoryPath(origin, selected, root);
      }
      const [initializer] = atRead.binding.initializers;
      if (
        !atRead.hasDefiniteInitializer ||
        initializer === undefined ||
        atRead.binding.initializers.length !== 1 ||
        atRead.binding.referenceInitializers.length !== 0 ||
        state.conditionallySkippedExpressions.has(initializer.node)
      )
        return undefined;
      selected = [
        ...initializer.projection.map((key) => ({
          key,
          capture: initializer.node,
        })),
        ...selected,
      ];
      current = initializer.node;
      continue;
    }
    if (t.isCallExpression(root) || t.isOptionalCallExpression(root)) {
      // A required Module export supplies the same public factory as its ESM
      // export. Keep factory selection at its own read, including destructuring.
      if (selected.some(({ key }) => key === "createRequire")) {
        const required = semanticRequireOrigin(root, state)?.origin;
        if (required !== undefined)
          return factoryPath(required, selected, root);
      }
      const invocation = hostLoaderInvocation(root, state);
      if (
        invocation?.kind === "known" &&
        invocation.path.join(".") === `intrinsic.${HOST_LOADER}.factory` &&
        invocation.arguments?.length === 1
      )
        return callable("created");
    }
    return undefined;
  }
};

const hostLoaderInvocations = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReturnType<typeof createSemanticModuleInterop>
>();
const activeHostInvocations = new WeakSet<t.Node>();

/** A proven loader/factory value is callable even when used only as a receiver. */
export const semanticRequireFunctionValue = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const path = hostLoaderPath(node, state);
  return path?.length === 3 && path[1] === HOST_LOADER;
};

/** Share call/apply/bind argument normalization with all other intrinsic users. */
const hostLoaderInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
) => {
  if (activeHostInvocations.has(node)) return undefined;
  activeHostInvocations.add(node);
  try {
    let resolver = hostLoaderInvocations.get(state);
    if (resolver === undefined) {
      resolver = createSemanticModuleInterop(state, {
        intrinsicPath: (value) => hostLoaderPath(value, state),
      });
      hostLoaderInvocations.set(state, resolver);
    }
    return resolver.intrinsicInvocation(node);
  } finally {
    activeHostInvocations.delete(node);
  }
};

/** Recover a proven host-loader call and its exact selected export path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const chain = semanticMemberChain(node);
  const current = chain?.root;
  if (
    chain === undefined ||
    (!t.isCallExpression(current) && !t.isOptionalCallExpression(current))
  )
    return undefined;
  if (t.isIdentifier(current.callee, { name: "require" })) {
    const requireBinding = resolveSemanticBindingState(
      state,
      current.callee,
      "require",
    );
    if (
      semanticHostRequireWritesIntact(current, state) &&
      (semanticHostRequireBindingIntact(current.callee, state) ||
        (requireBinding !== undefined &&
          isWrapperRequireInitializerCall(requireBinding, current, state)))
    ) {
      const specifier = stringValue(current.arguments[0]);
      return specifier === undefined
        ? undefined
        : {
            origin: {
              specifier,
              importedPath: chain.members,
              resolutionMode: "require",
            },
            call: current,
          };
    }
  }
  const invocation = hostLoaderInvocation(current, state);
  if (
    invocation?.kind !== "known" ||
    invocation.path.length !== 3 ||
    invocation.path[1] !== HOST_LOADER
  )
    return undefined;
  const kind = invocation.path[2];
  const specifier = stringValue(invocation.arguments?.[0]);
  if (
    specifier === undefined ||
    !["wrapper", "delegate", "created"].includes(kind ?? "")
  )
    return undefined;
  if (kind === "delegate") {
    const receiver = invocation.receiver ?? invocation.memberReceiver;
    if (
      receiver === undefined ||
      hostLoaderPath(receiver, state)?.join(".") !== HOST_MODULE ||
      writesModuleRequire(state).some(
        ({ node: write, delegate }) =>
          delegate === "_load" &&
          !semanticEffectFollowsInitialCapture(current, write, state),
      )
    )
      return undefined;
  } else if (
    writesModuleRequire(state).some(
      ({ node: write, shared }) =>
        (kind === "wrapper" || shared) &&
        !semanticEffectFollowsInitialCapture(current, write, state),
    )
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

/** Node's fs.promises export and fs/promises require share one object. */
export const semanticRequireExportsIdentity = <Key>(
  specifier: string,
  path: readonly Key[],
): { readonly specifier: string; readonly path: readonly (Key | string)[] } => {
  const name = specifier.replace(/^node:/u, "");
  if (name === "fs/promises") return { specifier: name, path };
  return name === "fs" && path[0] === "promises" && path.length > 1
    ? { specifier: "fs/promises", path: path.slice(1) }
    : { specifier: name, path };
};

const MUTABLE_BUILTIN_DEFAULTS = new Set([
  ...Object.keys(BUILTIN_RESOURCE_METHODS),
  "http",
  "https",
  "child_process",
  "timers",
  "process",
]);

/** Mutable default/object selections share CommonJS identity; namespace slots do not. */
export const semanticMutableBuiltinOrigin = <Key = never>(
  origin: JavaScriptModuleOrigin,
  selected: readonly Key[] = [],
):
  | { readonly specifier: string; readonly path: readonly (Key | string)[] }
  | undefined => {
  const path = [...origin.importedPath, ...selected];
  if (origin.resolutionMode === "require")
    return { specifier: origin.specifier, path };
  const specifier = origin.specifier.replace(/^node:/u, "");
  if (!MUTABLE_BUILTIN_DEFAULTS.has(specifier)) return undefined;
  if (path[0] === "default") return { specifier, path: path.slice(1) };
  if (specifier === "process" && (path[0] === "env" || path[0] === "argv"))
    return { specifier, path };
  return specifier === "fs" && path[0] === "promises"
    ? { specifier, path }
    : undefined;
};
