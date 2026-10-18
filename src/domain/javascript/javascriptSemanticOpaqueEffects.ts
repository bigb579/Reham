import * as t from "@babel/types";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import type {
  AmbientInvocationObserver,
  AmbientPathResolver,
} from "./javascriptSemanticAmbientWrites.js";
import {
  expandJavaScriptInvocationArguments,
  javaScriptIntrinsicResultReference,
  resolveJavaScriptIntrinsicInvocations,
} from "./javascriptIntrinsicInvocation.js";
import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  semanticEffectTiming,
  semanticBindingEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

/** One source owns sites and the minimal scope tree reaching them; O(AST) storage. */
export interface JavaScriptOpaqueScopeEffects {
  /** Cheap source evidence collected with declarations, before alias queries. */
  mayReferenceGlobalCode: boolean;
  readonly sites: WeakSet<t.Node>;
  readonly sloppySites: WeakSet<t.Node>;
  readonly byScope: Map<string, t.CallExpression[]>;
  readonly children: Map<string, Set<string>>;
  readonly globalSites: t.Node[];
}

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
    if (!strictEval(node, state)) state.opaqueEffects.sloppySites.add(node);
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

/** The existing ambient invocation walk owns global effects; ordinary sources
 * neither retain a second call list nor create another alias resolver. */
export const createSemanticOpaqueGlobalObserver = (
  state: JavaScriptSemanticAnalysisState,
): AmbientInvocationObserver | undefined => {
  if (!state.opaqueEffects.mayReferenceGlobalCode) return undefined;
  let ambientPaths: AmbientPathResolver;
  let invocationSite: t.Node | undefined;
  let constructionTarget = false;
  const resolvingResults = new WeakSet<t.Node>();
  const boundValues: JavaScriptIntrinsicInvocation[] = [];
  const boundKeys = new Map<string, number>();
  const nodeIds = new WeakMap<t.Node, number>();
  let nextNodeId = 0;
  const nodeId = (node: t.Node | null | undefined): number => {
    if (node === undefined) return -1;
    // Parser recovery retains null argument holes; keep their position distinct.
    if (node === null) return -2;
    let id = nodeIds.get(node);
    if (id === undefined) nodeIds.set(node, (id = nextNodeId++));
    return id;
  };
  const inheritedFunctionConstructor = (
    path: readonly string[],
    node: t.Node,
  ): readonly string[] => {
    const inherited =
      (path[0] === "global" &&
        ["Function", "eval"].includes(path[1] ?? "") &&
        path[2] === "constructor") ||
      (path[0] === "generated-function" && path[1] === "constructor");
    if (!inherited) return path;
    synchronizeIntrinsicWrites();
    const original =
      path[0] === "global"
        ? ["intrinsic", ...path.slice(1, 3)]
        : ["intrinsic", "Function", "prototype", "constructor"];
    const changed =
      strictInterop.intrinsicReadChanged(node, original) ||
      strictInterop.intrinsicReadChanged(node, [
        "intrinsic",
        "Function",
        "prototype",
        "constructor",
      ]);
    return changed
      ? path
      : ["global", "Function", ...path.slice(path[0] === "global" ? 3 : 2)];
  };
  const paths = (node: t.Node): readonly (readonly string[])[] =>
    ambientPaths(
      node,
      invocationSite,
      false,
      [],
      undefined,
      undefined,
      constructionTarget,
    ).flatMap((path) => {
      if (path.includes(null)) return [];
      const complete = inheritedFunctionConstructor(
        path as readonly string[],
        node,
      );
      if (complete[0] === "bound-global-callable") {
        const bound = boundValues[Number(complete[1])];
        return bound === undefined || complete.length === 2
          ? []
          : [[...bound.path, ...complete.slice(2)]];
      }
      if (complete[0] === "generated-function")
        return [["intrinsic", "generated", "function", ...complete.slice(1)]];
      if (complete[0] !== "global") return [];
      return [
        complete[1] === "eval" ||
        (complete[1] === "Function" && complete[2] !== "prototype")
          ? ["intrinsic", ...complete]
          : ["intrinsic", ...complete.slice(1)],
      ];
    });
  const bounds = (node: t.Node): readonly JavaScriptIntrinsicInvocation[] =>
    ambientPaths(
      node,
      invocationSite,
      false,
      [],
      undefined,
      undefined,
      constructionTarget,
    ).flatMap((path) => {
      const bound =
        path[0] === "bound-global-callable" && path.length === 2
          ? boundValues[Number(path[1])]
          : undefined;
      return bound === undefined ? [] : [bound];
    });
  const interop = createSemanticModuleInterop(state, {
    // Mutation lookup only needs a capture when its identity is unambiguous.
    intrinsicPath: (node) => {
      const candidates = paths(node);
      return candidates.length === 1 ? candidates[0] : undefined;
    },
  });
  const strictResults = new WeakSet<t.Node>();
  let retainedWrites = 0;
  const synchronizeIntrinsicWrites = (): void => {
    while (retainedWrites < state.ambientWriteEffects.length) {
      const effect = state.ambientWriteEffects[retainedWrites++];
      if (effect?.path[0] === "global")
        strictInterop.retainWrite(effect.node, [
          "intrinsic",
          ...effect.path.slice(1),
        ]);
    }
  };
  const strictInterop: ReturnType<typeof createSemanticModuleInterop> =
    createSemanticModuleInterop(state, {
      additionalGlobals: ["eval"],
      callableResult: (node): readonly string[] | undefined => {
        if (
          (!t.isClass(node) &&
            !t.isArrowFunctionExpression(node) &&
            !t.isCallExpression(node) &&
            !t.isOptionalCallExpression(node) &&
            !t.isNewExpression(node) &&
            !t.isTaggedTemplateExpression(node)) ||
          strictResults.has(node)
        )
          return undefined;
        strictResults.add(node);
        try {
          if (t.isArrowFunctionExpression(node)) {
            const parent = state.parentsByNode.get(node);
            return (t.isMemberExpression(parent) ||
              t.isOptionalMemberExpression(parent)) &&
              parent.object === node &&
              semanticStaticPropertyKey(parent.property, parent.computed) ===
                "bind"
              ? ["intrinsic", "Function", "prototype"]
              : undefined;
          }
          if (t.isClass(node)) {
            const overridden = node.body.body.some(
              (member) =>
                (t.isClassMethod(member) || t.isClassProperty(member)) &&
                member.static &&
                [null, "bind", "call", "apply"].includes(
                  semanticStaticPropertyKey(member.key, member.computed),
                ),
            );
            if (overridden) return undefined;
            if (
              node.superClass !== null &&
              node.superClass !== undefined &&
              strictInterop.intrinsicPath(node.superClass) === undefined
            )
              return undefined;
            return ["intrinsic", "class", "constructor"];
          }
          const invocation = strictInvocation(node);
          if (invocation !== undefined && isIntrinsicBind(invocation)) {
            const bound = strictInterop.boundIntrinsic(node);
            if (bound?.kind === "known") return bound.path;
          }
          const reference = javaScriptIntrinsicResultReference(invocation);
          if (reference !== undefined)
            return strictInterop.intrinsicPath(reference);
          const path =
            invocation?.kind === "known" ? invocation.path : undefined;
          return path?.join(".") === "intrinsic.Function"
            ? ["intrinsic", "generated", "function"]
            : undefined;
        } finally {
          strictResults.delete(node);
        }
      },
    });
  const isFunctionFactory = (node: t.Node | undefined): boolean => {
    if (!t.isExpression(node)) return false;
    const rawPath = strictInterop.intrinsicPath(node);
    const path =
      rawPath === undefined ? undefined : strictConstructorPath(rawPath, node);
    if (path !== undefined)
      return (
        path.join(".") === "intrinsic.Function" &&
        !strictInterop.intrinsicReadChanged(node, path)
      );
    const bound = strictInterop.boundIntrinsic(node);
    return (
      bound?.kind === "known" &&
      strictConstructorPath(bound.path, node).join(".") === "intrinsic.Function"
    );
  };
  const identities = (
    node: t.Node,
    constructing = false,
  ): readonly JavaScriptIntrinsicInvocation[] => {
    const previous = constructionTarget;
    constructionTarget = constructing;
    try {
      return [
        ...paths(node).map((path): JavaScriptIntrinsicInvocation => ({
          kind: interop.intrinsicReadChanged(node, path) ? "opaque" : "known",
          path,
          arguments: [],
        })),
        ...bounds(node),
      ];
    } finally {
      constructionTarget = previous;
    }
  };
  const invocations = (
    node:
      | t.CallExpression
      | t.OptionalCallExpression
      | t.NewExpression
      | t.TaggedTemplateExpression,
  ): readonly JavaScriptIntrinsicInvocation[] => {
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
      return resolveJavaScriptIntrinsicInvocations(
        node,
        paths,
        bounds,
        interop.intrinsicReadChanged,
      );
    const callee = t.isTaggedTemplateExpression(node) ? node.tag : node.callee;
    const targets = identities(callee, t.isNewExpression(node));
    return t.isNewExpression(node)
      ? targets.map((target) => ({
          ...target,
          arguments:
            target.arguments === undefined
              ? undefined
              : expandJavaScriptInvocationArguments([
                  ...target.arguments,
                  ...node.arguments,
                ]),
        }))
      : targets;
  };
  // Reflect.construct executes only its first target; newTarget selects the
  // resulting prototype without executing that constructor's body.
  const constructedTargets = (
    invocation: JavaScriptIntrinsicInvocation,
  ): readonly JavaScriptIntrinsicInvocation[] => {
    const target = invocation.arguments?.[0];
    return invocation.path.join(".") === "intrinsic.Reflect.construct" &&
      t.isExpression(target)
      ? identities(target, true)
      : [];
  };
  const retainBound = (
    value: JavaScriptIntrinsicInvocation,
  ): readonly string[] => {
    const key = JSON.stringify([
      value.kind,
      value.path,
      nodeId(value.receiver),
      value.arguments?.map(nodeId),
    ]);
    let id = boundKeys.get(key);
    if (id === undefined) {
      id = boundValues.length;
      boundValues.push(value);
      boundKeys.set(key, id);
    }
    return ["bound-global-callable", String(id)];
  };
  const isIntrinsicBind = (
    invocation: JavaScriptIntrinsicInvocation,
  ): boolean => {
    const original = invocation.path;
    const path =
      original[1] === "eval" ||
      (original[1] === "Function" && original[2] !== "prototype")
        ? ["intrinsic", "global", ...original.slice(1)]
        : original;
    return (
      invocation.kind === "known" &&
      path.at(-1) === "bind" &&
      [
        "intrinsic.global.eval",
        "intrinsic.global.Function",
        "intrinsic.generated.function",
        "intrinsic.Function.prototype",
        "intrinsic.class.constructor",
      ].includes(path.slice(0, 3).join(".")) &&
      path
        .slice(3)
        .every((method) => ["call", "apply", "bind"].includes(method))
    );
  };
  const nonCallingIntrinsic = (
    invocation: JavaScriptIntrinsicInvocation | undefined,
  ): boolean =>
    invocation?.kind === "known" &&
    ([
      "intrinsic.Function",
      "intrinsic.global.Function",
      "intrinsic.Object.freeze",
    ].includes(invocation.path.join(".")) ||
      isIntrinsicBind(invocation));
  const strictConstructorPath = (
    path: readonly string[],
    node: t.Node,
  ): readonly string[] => {
    const ambient =
      path[0] === "intrinsic" &&
      path[1] === "generated" &&
      path[2] === "function"
        ? ["generated-function", ...path.slice(3)]
        : path[0] === "intrinsic"
          ? ["global", ...path.slice(1)]
          : path;
    const canonical = inheritedFunctionConstructor(ambient, node);
    return canonical === ambient ? path : ["intrinsic", ...canonical.slice(1)];
  };
  const strictInvocation = (
    node:
      | t.CallExpression
      | t.OptionalCallExpression
      | t.NewExpression
      | t.TaggedTemplateExpression,
  ): JavaScriptIntrinsicInvocation | undefined => {
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      const invocation = strictInterop.intrinsicInvocation(node);
      return invocation === undefined
        ? undefined
        : {
            ...invocation,
            path: strictConstructorPath(invocation.path, node.callee),
          };
    }
    const callee = t.isTaggedTemplateExpression(node) ? node.tag : node.callee;
    const rawPath = strictInterop.intrinsicPath(callee);
    const path =
      rawPath === undefined
        ? undefined
        : strictConstructorPath(rawPath, callee);
    return path === undefined ||
      strictInterop.intrinsicReadChanged(callee, path)
      ? undefined
      : {
          kind: "known",
          path,
          arguments: t.isNewExpression(node)
            ? expandJavaScriptInvocationArguments(node.arguments)
            : undefined,
        };
  };
  const escapedCode = (path: readonly (string | null)[]): boolean => {
    if (
      (path[0] === "generated-function" && path.length === 1) ||
      (path[0] === "global" &&
        path.length === 2 &&
        ["eval", "Function"].includes(path[1] ?? ""))
    )
      return true;
    const bound =
      path[0] === "bound-global-callable" && path.length === 2
        ? boundValues[Number(path[1])]
        : undefined;
    return (
      bound !== undefined &&
      (bound.kind === "opaque" ||
        [
          "intrinsic.generated.function",
          "intrinsic.global.eval",
          "intrinsic.global.Function",
        ].includes(bound.path.join(".")))
    );
  };
  const invocationFacts = (node: t.Node, resolve: AmbientPathResolver) => {
    if (
      !t.isCallExpression(node) &&
      !t.isOptionalCallExpression(node) &&
      !t.isNewExpression(node) &&
      !t.isTaggedTemplateExpression(node)
    )
      return undefined;
    ambientPaths = resolve;
    invocationSite = node;
    const outcomes = invocations(node);
    synchronizeIntrinsicWrites();
    const strict = strictInvocation(node);
    const provenNonCalling =
      nonCallingIntrinsic(strict) ||
      ((t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
        strict?.kind === "known" &&
        strict.path.join(".") === "intrinsic.class.constructor");
    const completeArguments =
      !t.isTaggedTemplateExpression(node) &&
      outcomes.every(
        (invocation) =>
          invocation.arguments !== undefined &&
          invocation.arguments.every(
            (argument) => !t.isSpreadElement(argument),
          ),
      );
    const coverage =
      provenNonCalling && completeArguments
        ? ("all" as const)
        : outcomes.length > 0 &&
            completeArguments &&
            (t.isCallExpression(node) || t.isOptionalCallExpression(node))
          ? ("arguments" as const)
          : undefined;
    const targets: { node: t.Node; projection: readonly (string | null)[] }[] =
      [];
    const retain = (
      arguments_: readonly t.Node[] | undefined,
      projection: readonly (string | null)[] = [],
    ) => {
      for (const argument of arguments_ ?? [])
        if (t.isNode(argument))
          targets.push({
            node: t.isSpreadElement(argument) ? argument.argument : argument,
            projection,
          });
    };
    const coercion = (
      arguments_: readonly t.Node[] | undefined,
      list = false,
    ) => {
      for (const method of ["toString", "valueOf"])
        retain(arguments_, list ? [null, method] : [method]);
    };
    for (const invocation of outcomes) {
      const path = invocation.path.join(".");
      if (path === "intrinsic.global.Function") {
        coercion(
          t.isTaggedTemplateExpression(node)
            ? [...(invocation.arguments ?? []), ...node.quasi.expressions]
            : invocation.arguments,
        );
      }
      if (provenNonCalling) continue;
      if (path === "intrinsic.Reflect.construct") {
        const list = invocation.arguments?.[1];
        if (isFunctionFactory(invocation.arguments?.[0])) {
          for (const target of constructedTargets(invocation))
            if (target.path.join(".") === "intrinsic.global.Function")
              coercion(target.arguments);
          if (t.isExpression(list)) coercion([list], true);
        } else if (t.isExpression(list)) retain([list], [null]);
      } else retain(invocation.arguments);
    }
    return { node, outcomes, targets, coverage };
  };
  return {
    invocationHandoffs: (node, resolve) => invocationFacts(node, resolve),
    callableResult: (node, resolve, constructing = false) => {
      if (resolvingResults.has(node)) return [];
      resolvingResults.add(node);
      const previousSite = invocationSite;
      const previousConstruction = constructionTarget;
      constructionTarget = constructing;
      ambientPaths = resolve;
      invocationSite = node;
      try {
        const results: (readonly string[])[] = [];
        for (const invocation of invocations(node)) {
          const path = invocation.path.join(".");
          if (invocation.kind === "opaque") {
            // A modified constructor/helper may return executable code too.
            results.push(retainBound(invocation));
            continue;
          }
          if (path === "intrinsic.global.Function")
            results.push(["generated-function"]);
          if (
            constructedTargets(invocation).some(
              (value) =>
                value.kind === "opaque" ||
                value.path.join(".") === "intrinsic.global.Function",
            )
          )
            results.push(["generated-function"]);
          if (!isIntrinsicBind(invocation) || invocation.receiver === undefined)
            continue;
          for (const target of identities(invocation.receiver, constructing)) {
            const args = invocation.arguments;
            const receiver = target.receiver ?? args?.[0] ?? undefined;
            results.push(
              retainBound({
                kind:
                  target.kind === "opaque" ||
                  args === undefined ||
                  args.some((arg) => t.isSpreadElement(arg))
                    ? "opaque"
                    : "known",
                path: target.path,
                ...(receiver === undefined ? {} : { receiver }),
                arguments:
                  target.arguments === undefined || args === undefined
                    ? undefined
                    : [...target.arguments, ...args.slice(1)],
              }),
            );
          }
        }
        return results;
      } finally {
        invocationSite = previousSite;
        constructionTarget = previousConstruction;
        resolvingResults.delete(node);
      }
    },
    observeInvocation: (input, resolve) => {
      const facts = invocationFacts(input, resolve);
      if (facts === undefined) return undefined;
      const { node, outcomes, targets, coverage } = facts;
      const directExecution = outcomes.some((invocation) => {
        const path = invocation.path.join(".");
        return (
          invocation.kind === "opaque" ||
          path === "intrinsic.generated.function" ||
          constructedTargets(invocation).some(
            (target) =>
              target.kind === "opaque" ||
              target.path.join(".") === "intrinsic.generated.function",
          ) ||
          (path === "intrinsic.global.eval" &&
            (t.isCallExpression(node) ||
              t.isOptionalCallExpression(node) ||
              (t.isTaggedTemplateExpression(node) &&
                (invocation.arguments?.length ?? 0) > 0)))
        );
      });

      const handedOff = targets.some((target) =>
        ambientPaths(target.node, node, true, target.projection).some(
          escapedCode,
        ),
      );
      if (directExecution || handedOff)
        state.opaqueEffects.globalSites.push(node);
      // Possible identities may omit unresolved alternatives; only the strict
      // owner can exempt all argument and receiver handoffs.
      return coverage;
    },
    observeEscape: (node, identity) => {
      if (escapedCode(identity)) state.opaqueEffects.globalSites.push(node);
    },
  };
};

/** Indirect eval and generated code can change globals without rebinding the
 * caller's lexical locals. Creation alone is not an execution effect. */
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

const strictEval = (
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  for (
    let node: t.Node | undefined = site;
    node !== undefined;
    node = state.parentsByNode.get(node)
  ) {
    if (t.isClass(node) || (t.isProgram(node) && node.sourceType === "module"))
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
