import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
  semanticIntrinsicMutation,
  semanticIntrinsicMutationTargets,
  type JavaScriptIntrinsicMutationRecipient,
} from "./javascriptElectronMemberWrites.js";
import {
  completeSemanticFreshObjectFacts,
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticRequireOrigin,
  semanticRequireFunctionValue,
} from "./javascriptSemanticRequireOrigin.js";
import {
  semanticCallableValueIdentity,
  semanticPossibleFunctionValueIdentities,
  semanticSourceFunctionValueIdentities,
  semanticOrdinaryFunctionValueIdentities,
  semanticLiteralInheritedValueIdentities,
} from "./javascriptSemanticFunctionValues.js";
import { semanticRequireShimOrigin } from "./javascriptRequireShimOrigin.js";
import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  semanticBindingAtRead,
  semanticDefiniteMutationPrecedesRead,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticCopiedReferencePath,
  semanticReferenceSourcesInactive,
} from "./javascriptSemanticReferenceSources.js";
import {
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import {
  createSemanticFunctionValueReferences,
  createSemanticReturnedReferences,
  createSemanticStaticClassSlotReferences,
} from "./javascriptSemanticReturnedReferences.js";
import { createSemanticReceiverReferences } from "./javascriptSemanticReceiverReferences.js";
import {
  semanticArrayIndex,
  SemanticPropertyPathCoverage,
} from "./javascriptSemanticPropertyPaths.js";
import {
  semanticBindingCanBeRebound,
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  type SemanticGlobalBindingFacts,
} from "./javascriptSemanticOpaqueEffects.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";

const GLOBAL_OBJECT_NAMES = ["globalThis", "global", "window", "self"];

const globalObjectName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined =>
  GLOBAL_OBJECT_NAMES.find((name) => isUnshadowedGlobal(node, state, name));

/** Global self references retain object identity, rather than adding a property. */
const canonicalAmbientPath = (
  path: readonly (string | null)[],
): readonly (string | null)[] => {
  if (path[0] !== "global") return path;
  let firstProperty = 1;
  while (GLOBAL_OBJECT_NAMES.includes(path[firstProperty] ?? ""))
    firstProperty += 1;
  return ["global", ...path.slice(firstProperty)];
};

type AmbientPath = readonly (string | null)[];

/** Undefined means a cyclic or conflicting projection can select any depth. */
type AmbientProjection = AmbientPath | undefined;
type AmbientCaptures = readonly (t.Node | undefined)[];

/** Node exports the constructor whose prototype owns the wrapper delegate. */
const moduleConstructorPath = (
  origin: JavaScriptModuleOrigin,
  projection: AmbientProjection,
): AmbientPath | undefined => {
  if (!["module", "node:module"].includes(origin.specifier)) return undefined;
  const path = [...origin.importedPath, ...(projection ?? [null])];
  // ESM namespace slots select the constructor; the namespace is not itself it.
  if (origin.resolutionMode !== "require") {
    const selected = path.shift();
    if (selected === "createRequire")
      return ["commonjs-module", "constructor", "createRequire", ...path];
    if (selected !== "default" && selected !== "Module" && selected !== null)
      return undefined;
  }
  return ["commonjs-module", "constructor", ...path];
};

const joinAmbientProjection = (
  left: AmbientProjection,
  right: AmbientProjection,
): AmbientProjection =>
  left === undefined || right === undefined || left.length !== right.length
    ? undefined
    : left.map((key, index) => (key === right[index] ? key : null));

interface AmbientReferenceFacts {
  readonly stores: WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >;
  readonly replacements: WeakMap<
    t.Node,
    Map<string, SemanticIterationSource[]>
  >;
  readonly prototypeTarget: (node: t.Node) => t.Node | undefined;
  readonly freshObject: (node: t.Node) => boolean;
  /** A completed conservative binding snapshot may refine constructor results. */
  readonly definiteObject?: (node: t.Node) => boolean;
  readonly intrinsicWriteFacts?: SemanticGlobalBindingFacts;
  readonly ownStaticSlotUnchanged?: (
    owner: t.Class,
    key: string,
    read: t.Node,
  ) => boolean;
}

/**
 * Follow local object identities without equating shallow copies with their
 * sources. Writes select aliases at their capture; uncertain execution order
 * retains possible initializers. Intrinsic reads stay strict.
 */
export const createAmbientPathResolver = (
  state: JavaScriptSemanticAnalysisState,
  possibleWrites: boolean,
  facts?: AmbientReferenceFacts,
) => {
  const cached = new WeakMap<t.Node, readonly AmbientPath[]>();
  const returnedReferences = createSemanticReturnedReferences(
    state,
    facts?.definiteObject,
  );
  const functionReferences = createSemanticFunctionValueReferences(
    state,
    facts?.definiteObject,
  );
  const receiverReferences = createSemanticReceiverReferences(
    state,
    facts?.definiteObject,
    facts?.intrinsicWriteFacts,
  );
  const intrinsics = createSemanticModuleInterop(state);
  const staticClassSlots = createSemanticStaticClassSlotReferences(
    state,
    facts?.freshObject ?? intrinsics.isFreshObject,
  );
  const functionGroups = new Map<string, readonly (t.Function | t.Class)[]>();
  const functionPaths = new WeakMap<t.Node, readonly string[]>();
  const functionInterop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const intrinsic = intrinsics.intrinsicPath(node);
      if (intrinsic !== undefined) return intrinsic;
      const prior = functionPaths.get(node);
      if (prior !== undefined) return prior;
      const references = functionReferences(node);
      const projection = references[0]?.projection;
      if (
        projection === undefined ||
        projection.some((key) => key === null) ||
        references.some(
          (reference) =>
            JSON.stringify(reference.projection) !== JSON.stringify(projection),
        )
      )
        return undefined;
      const id = String(functionGroups.size);
      functionGroups.set(
        id,
        references.map(({ node }) => node),
      );
      const path = [
        "intrinsic",
        "source-function",
        id,
        ...projection.map(String),
      ];
      functionPaths.set(node, path);
      return path;
    },
  });
  const resolve = (
    node: t.Node,
    capture?: t.Node,
    escapedContents = false,
    projection: AmbientProjection = [],
    localIdentity?: (node: t.Node, path: AmbientProjection) => void,
    initialBinding?: JavaScriptSemanticBindingState,
  ): readonly AmbientPath[] => {
    const prior =
      possibleWrites || initialBinding !== undefined
        ? undefined
        : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientProjection;
      captures: AmbientCaptures;
      readsAtSelf?: true;
      binding?: JavaScriptSemanticBindingState;
    }[] = [
      {
        node,
        suffix: projection,
        captures: (projection ?? []).map(() => capture ?? node),
        ...(initialBinding === undefined ? {} : { binding: initialBinding }),
      },
    ];
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    const expanded = new WeakMap<t.Node, AmbientProjection>();
    const expandedCaptures = new WeakMap<t.Node, AmbientCaptures>();
    const retain = (path: AmbientPath) => {
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
        if (possibleWrites)
          for (const identity of semanticPossibleFunctionValueIdentities(
            canonical,
            (storage) => {
              if (!result.has(JSON.stringify(storage))) retain(storage);
            },
          ))
            if (!result.has(JSON.stringify(identity))) retain(identity);
        if (
          possibleWrites &&
          canonical[0] === "global" &&
          canonical[2] === "prototype" &&
          canonical[3] === "constructor"
        ) {
          canonical = ["global", canonical[1] ?? null, ...canonical.slice(4)];
          continue;
        }
        // An unknown key may select a global self reference as well as a
        // distinct property. Retain both possible object identities for writes.
        if (
          !possibleWrites ||
          canonical[0] !== "global" ||
          canonical[1] !== null
        )
          break;
        canonical = canonicalAmbientPath(["global", ...canonical.slice(2)]);
      }
    };
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const { root, members } =
        current.binding === undefined
          ? electronMemberPath(current.node)
          : { root: current.node, members: [] };
      let suffix: AmbientProjection =
        current.suffix === undefined
          ? undefined
          : [...members, ...current.suffix];
      let captures: AmbientCaptures = [
        ...members.map(() => current.node),
        ...current.captures,
      ];
      if (expanded.has(root)) {
        const previous = expanded.get(root);
        if (previous === undefined) continue;
        if (suffix !== undefined && previous.length === suffix.length) {
          const joined: AmbientPath = previous.map((key, index) =>
            key === suffix?.[index] ? key : null,
          );
          const previousCaptures = expandedCaptures.get(root) ?? [];
          const joinedCaptures = joined.map((_, index) =>
            captures[index] === previousCaptures[index]
              ? captures[index]
              : undefined,
          );
          if (
            joined.every((key, index) => key === previous[index]) &&
            joinedCaptures.every(
              (site, index) => site === previousCaptures[index],
            )
          )
            continue;
          suffix = joined;
          captures = joinedCaptures;
        } else suffix = undefined;
        if (!possibleWrites) {
          cached.set(node, []);
          return [];
        }
      }
      expanded.set(root, suffix);
      expandedCaptures.set(root, captures);
      // A widened projection is a possible write, never proof of an intrinsic.
      if (suffix === undefined && !possibleWrites) continue;
      const continueWith = (
        node: t.Node,
        path: AmbientProjection = suffix,
        readCaptures: AmbientCaptures = captures,
      ) =>
        pending.push({
          node,
          suffix: path,
          captures: readCaptures,
          ...(current.readsAtSelf && { readsAtSelf: true }),
        });
      const continueReturned = (
        callee: t.Node,
        path: AmbientProjection,
        readCaptures: AmbientCaptures = captures,
      ) => {
        for (const source of returnedReferences(callee))
          continueWith(
            source.node,
            path === undefined
              ? undefined
              : [
                  ...source.projection.map((key) =>
                    key === null || typeof key === "object"
                      ? null
                      : String(key),
                  ),
                  ...path,
                ],
            [...source.projection.map(() => source.node), ...readCaptures],
          );
      };
      if (possibleWrites && t.isFunction(root))
        retain([...semanticCallableValueIdentity(root), ...(suffix ?? [])]);
      if (!t.isIdentifier(root) && facts?.freshObject(root)) {
        localIdentity?.(root, suffix);
        const firstKey = suffix?.[0];
        const selectedAt = captures[0];
        let replacement: SemanticIterationSource | undefined;
        if (typeof firstKey === "string" && selectedAt !== undefined)
          for (const source of facts.replacements.get(root)?.get(firstKey) ??
            [])
            if (
              semanticDefiniteMutationPrecedesRead(
                source.mutation,
                selectedAt,
                state.parentsByNode,
              ) &&
              (replacement === undefined ||
                semanticEffectTiming(
                  source.mutation,
                  replacement.mutation,
                  state,
                ) === "before")
            )
              replacement = source;
        for (const [source, path] of facts?.stores.get(root) ?? []) {
          const selected =
            suffix === undefined ||
            path === undefined ||
            path.every(
              (key, index) =>
                index >= suffix.length ||
                key === null ||
                suffix[index] === null ||
                key === suffix[index],
            );
          if (
            !selected ||
            (suffix !== undefined &&
              path !== undefined &&
              suffix.length < path.length &&
              !escapedContents)
          )
            continue;
          if (semanticReferenceSourcesInactive(source, state, "syntax-only"))
            continue;
          // A definite first-slot replacement also cuts paths through its old
          // contents. Unknown order and captured earlier slots remain possible.
          if (
            replacement !== undefined &&
            path?.[0] === firstKey &&
            semanticEffectTiming(
              replacement.mutation,
              source.mutation,
              state,
            ) === "before"
          )
            continue;
          const selectedAt =
            path === undefined ? undefined : captures[path.length - 1];
          // Only overlapping stores need ordering. Unrelated properties cannot
          // replace this reference and must not replay costly timing queries.
          // Unknown order remains a possible alias, including deferred calls.
          if (
            selectedAt !== undefined &&
            semanticEffectTiming(selectedAt, source.mutation, state) === "after"
          )
            continue;
          const remaining =
            suffix === undefined || path === undefined
              ? undefined
              : suffix.slice(path.length);
          pending.push({
            node: source.node,
            readsAtSelf: true,
            captures: [
              ...source.projection.map(() => source.node),
              ...(path === undefined ? [] : captures.slice(path.length)),
            ],
            suffix:
              remaining === undefined
                ? undefined
                : [
                    ...source.projection.map((key) =>
                      key === null || typeof key === "object"
                        ? null
                        : String(key),
                    ),
                    ...remaining,
                  ],
          });
        }
      }
      if (
        t.isMetaProperty(root) &&
        root.meta.name === "import" &&
        root.property.name === "meta"
      ) {
        retain(["import-meta", ...(suffix ?? [])]);
        continue;
      }
      if (possibleWrites && t.isThisExpression(root)) {
        for (const receiver of receiverReferences(root))
          if (t.isProgram(receiver)) retain(["global", ...(suffix ?? [])]);
          else
            pending.push({
              node: receiver,
              suffix,
              captures,
              readsAtSelf: true,
            });
        continue;
      }
      const classKey = suffix?.[0];
      const classRead = captures[0];
      const classSlot =
        possibleWrites &&
        t.isClass(root) &&
        typeof classKey === "string" &&
        classKey !== "prototype"
          ? staticClassSlots(root, classKey, classRead)
          : undefined;
      for (const value of classSlot?.values ?? [])
        continueWith(value, suffix?.slice(1), captures.slice(1));
      const ownClassSlot =
        classSlot?.ownLocal === true &&
        typeof classKey === "string" &&
        classRead !== undefined &&
        classSlot.owners.every(
          (owner, index) =>
            facts?.ownStaticSlotUnchanged?.(owner, classKey, classRead) ===
              true &&
            // Inherited selection also depends on every crossed prototype
            // link. The declaring owner's own slot needs no such proof.
            (index === classSlot.owners.length - 1 ||
              facts?.ownStaticSlotUnchanged?.(owner, "__proto__", classRead) ===
                true),
        );
      if (
        !ownClassSlot &&
        classSlot?.inherited != null &&
        suffix?.[0] !== "__proto__"
      )
        continueWith(classSlot.inherited, suffix, captures);
      if (
        possibleWrites &&
        (t.isFunction(root) || t.isClass(root)) &&
        !ownClassSlot
      ) {
        // A derived class inherits its constructor prototype from its base,
        // rather than directly from Function.prototype.
        if (
          t.isClass(root) &&
          root.superClass != null &&
          !t.isNullLiteral(unwrapJavaScriptExpression(root.superClass).node) &&
          suffix?.[0] === "__proto__"
        )
          continueWith(root.superClass, suffix.slice(1), captures.slice(1));
        else
          for (const identity of semanticSourceFunctionValueIdentities(
            root,
            suffix ?? [null],
          ))
            retain(identity);
      }
      if (
        possibleWrites &&
        suffix !== undefined &&
        typeof suffix[0] === "string" &&
        ((t.isObjectExpression(root) &&
          staticObjectProperty(root, suffix[0]).status === "missing" &&
          staticObjectProperty(root, "__proto__").status === "missing") ||
          (t.isArrayExpression(root) &&
            suffix[0] !== "length" &&
            semanticArrayIndex(suffix[0]) === null))
      )
        for (const identity of semanticLiteralInheritedValueIdentities(
          t.isArrayExpression(root) ? "array" : "object",
          suffix,
        ))
          retain(identity);
      if (
        possibleWrites &&
        suffix !== undefined &&
        classSlot?.own !== true &&
        (t.isObjectExpression(root) ||
          t.isClass(root) ||
          t.isNewExpression(root))
      )
        // One projection walk avoids retaining every prefix of helper chains.
        for (const { node: target, projection } of functionReferences(
          root,
          suffix,
        )) {
          const remaining = projection.map((key) =>
            key === null ? null : String(key),
          );
          for (const identity of semanticSourceFunctionValueIdentities(
            target,
            remaining,
          ))
            retain(identity);
        }
      if (current.binding !== undefined || t.isIdentifier(root)) {
        // The wrapper module object is distinct from globalThis.module. Keep
        // its identity through the same alias/projection owner used for writes.
        if (
          current.binding === undefined &&
          isUnshadowedGlobal(root, state, "module")
        ) {
          retain(["commonjs-module", ...(suffix ?? [])]);
          continue;
        }
        if (
          current.binding === undefined &&
          globalObjectName(root, state) !== undefined
        ) {
          retain(["global", ...(suffix ?? [])]);
          continue;
        }
        if (
          current.binding === undefined &&
          t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
        ) {
          retain(["global", root.name, ...(suffix ?? [])]);
          continue;
        }
        const binding =
          current.binding ??
          (t.isIdentifier(root)
            ? resolveSemanticBindingState(state, root, root.name)
            : undefined);
        if (binding === undefined) continue;
        const stable = semanticStableInitializer(binding, state);
        const readAt = current.readsAtSelf ? root : capture;
        const selected =
          possibleWrites && readAt !== undefined
            ? semanticBindingAtRead(binding, readAt, state.parentsByNode)
                .binding
            : binding;
        if (possibleWrites)
          for (const origin of selected.directOrigins) {
            const path = moduleConstructorPath(origin, suffix);
            if (path !== undefined) retain(path);
          }
        const initializers = possibleWrites
          ? selected.initializers
          : stable === undefined
            ? []
            : [stable];
        if (possibleWrites)
          for (const initializer of selected.referenceInitializers) {
            if (
              semanticReferenceSourcesInactive(
                initializer,
                state,
                "syntax-only",
              )
            )
              continue;
            const path = semanticCopiedReferencePath(
              initializer,
              suffix ?? [null],
              escapedContents ? "escape" : "reference",
            );
            if (path === null) continue;
            const referenceCaptures = [
              ...initializer.projection.map(() => initializer.node),
              ...captures,
            ];
            const offset = initializer.copyProjectionOffset;
            if (offset !== undefined) {
              referenceCaptures.splice(offset, 1);
              referenceCaptures[offset] = initializer.node;
            }
            pending.push({
              node: initializer.node,
              readsAtSelf: true,
              captures: referenceCaptures,
              suffix: path.map((key) =>
                key === null || typeof key === "object" ? null : String(key),
              ),
            });
          }
        for (const initializer of initializers)
          pending.push({
            node: initializer.node,
            readsAtSelf: true,
            captures: [
              ...initializer.projection.map(() => initializer.node),
              ...captures,
            ],
            suffix:
              suffix === undefined
                ? undefined
                : [
                    ...initializer.projection.map((key) =>
                      key === null ? null : String(key),
                    ),
                    ...suffix,
                  ],
          });
        continue;
      }
      if (
        possibleWrites &&
        t.isNewExpression(root) &&
        (suffix?.[0] === "__proto__" || suffix?.[0] === "constructor")
      ) {
        continueWith(
          root.callee,
          suffix[0] === "__proto__"
            ? ["prototype", ...suffix.slice(1)]
            : suffix.slice(1),
          suffix[0] === "__proto__" ? captures : captures.slice(1),
        );
        continue;
      }
      const prototypeTarget = possibleWrites
        ? facts?.prototypeTarget(root)
        : undefined;
      if (prototypeTarget !== undefined) {
        continueWith(
          prototypeTarget,
          suffix === undefined ? undefined : ["__proto__", ...suffix],
          [root, ...captures],
        );
        continue;
      }
      if (
        possibleWrites &&
        (t.isCallExpression(root) || t.isOptionalCallExpression(root))
      ) {
        const bound = functionInterop.boundIntrinsic(root);
        const allocation = bound?.boundFunction?.allocations[0];
        if (allocation !== undefined)
          retain([
            ...semanticCallableValueIdentity(allocation),
            ...(suffix ?? []),
          ]);
        if (suffix === undefined || suffix.length > 0) {
          if (bound?.path[1] === "source-function" && bound.path.length === 3) {
            for (const target of functionGroups.get(bound.path[2]!) ?? []) {
              if (
                t.isClass(target) &&
                target.superClass != null &&
                !t.isNullLiteral(
                  unwrapJavaScriptExpression(target.superClass).node,
                ) &&
                suffix?.[0] === "__proto__"
              )
                continueWith(
                  target.superClass,
                  suffix.slice(1),
                  captures.slice(1),
                );
              else
                for (const identity of semanticSourceFunctionValueIdentities(
                  target,
                  suffix ?? [null],
                  true,
                ))
                  retain(identity);
            }
          } else if (
            bound !== undefined ||
            functionInterop.intrinsicInvocation(root)?.path.join(".") ===
              "intrinsic.Function"
          )
            for (const identity of semanticOrdinaryFunctionValueIdentities(
              suffix ?? [null],
            ))
              retain(identity);
        }
        if (
          (suffix === undefined || suffix.length > 0) &&
          semanticRequireFunctionValue(root, state)
        )
          for (const identity of semanticOrdinaryFunctionValueIdentities(
            suffix ?? [null],
          ))
            retain(identity);
        const origin =
          semanticRequireOrigin(root, state)?.origin ??
          semanticRequireShimOrigin(root, state)?.origin;
        const path =
          origin === undefined
            ? undefined
            : moduleConstructorPath(origin, suffix);
        if (path !== undefined) retain(path);
      }
      if (
        possibleWrites &&
        t.isNewExpression(root) &&
        intrinsics.intrinsicPath(root.callee)?.join(".") ===
          "intrinsic.Function"
      )
        for (const identity of semanticOrdinaryFunctionValueIdentities(
          suffix ?? [null],
        ))
          retain(identity);
      if (
        possibleWrites &&
        (t.isCallExpression(root) ||
          t.isOptionalCallExpression(root) ||
          t.isNewExpression(root) ||
          t.isTaggedTemplateExpression(root) ||
          (escapedContents && (t.isFunction(root) || t.isClass(root))))
      ) {
        continueReturned(
          t.isFunction(root) || t.isClass(root)
            ? root
            : t.isTaggedTemplateExpression(root)
              ? root.tag
              : root.callee,
          suffix,
        );
        continue;
      }
      if (possibleWrites && t.isConditionalExpression(root)) {
        continueWith(root.consequent);
        continueWith(root.alternate);
        continue;
      }
      if (possibleWrites && t.isLogicalExpression(root)) {
        continueWith(root.left);
        continueWith(root.right);
        continue;
      }
      if (possibleWrites && t.isSequenceExpression(root)) {
        const value = root.expressions.at(-1);
        if (value !== undefined) continueWith(value);
        continue;
      }
      if (
        possibleWrites &&
        t.isAssignmentExpression(root) &&
        root.operator === "="
      ) {
        continueWith(root.right);
        continue;
      }
      const key = suffix?.[0];
      // Container escapes reuse the finite worklist, including alias cycles.
      if (escapedContents && suffix?.length === 0) {
        if (t.isObjectExpression(root)) {
          for (const property of root.properties)
            if (t.isSpreadElement(property))
              continueWith(property.argument, []);
            else if (
              t.isObjectProperty(property) &&
              t.isExpression(property.value)
            )
              continueWith(property.value, []);
            else if (t.isObjectMethod(property) && property.kind === "get")
              continueReturned(property, [], []);
          continue;
        }
        if (t.isArrayExpression(root)) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument, []);
            else if (t.isExpression(element)) continueWith(element, []);
          continue;
        }
      }
      if (suffix !== undefined && key === undefined) continue;
      if (t.isObjectExpression(root)) {
        if (possibleWrites) {
          for (const property of root.properties) {
            if (t.isSpreadElement(property))
              continueWith(property.argument, suffix, [
                property,
                ...captures.slice(1),
              ]);
            else if (
              (t.isObjectProperty(property) &&
                t.isExpression(property.value)) ||
              (t.isObjectMethod(property) && property.kind === "get")
            ) {
              const ownKey = semanticStaticPropertyKey(
                property.key,
                property.computed,
              );
              if (
                suffix === undefined ||
                key === null ||
                ownKey === null ||
                ownKey === key
              )
                if (t.isObjectMethod(property))
                  continueReturned(
                    property,
                    suffix?.slice(1),
                    captures.slice(1),
                  );
                else if (t.isExpression(property.value))
                  continueWith(
                    property.value,
                    suffix?.slice(1),
                    captures.slice(1),
                  );
            }
          }
        } else if (
          suffix !== undefined &&
          key !== null &&
          root.properties.every(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) !==
                null,
          )
        ) {
          const property = root.properties.findLast(
            (property) =>
              t.isObjectProperty(property) &&
              semanticStaticPropertyKey(property.key, property.computed) ===
                key,
          );
          if (t.isObjectProperty(property) && t.isExpression(property.value))
            continueWith(property.value, suffix.slice(1), captures.slice(1));
        }
      } else if (t.isArrayExpression(root)) {
        if (suffix === undefined) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument);
            else if (t.isExpression(element)) continueWith(element);
        } else if (!root.elements.some(t.isSpreadElement)) {
          const index = Number(key);
          if (key === null && possibleWrites) {
            for (const element of root.elements)
              if (t.isExpression(element))
                continueWith(element, suffix.slice(1), captures.slice(1));
          } else if (
            key !== null &&
            Number.isInteger(index) &&
            index >= 0 &&
            String(index) === key
          ) {
            const element = root.elements[index];
            if (t.isExpression(element))
              continueWith(element, suffix.slice(1), captures.slice(1));
          }
        }
      }
    }
    const paths = [...result.values()];
    if (!possibleWrites && initialBinding === undefined)
      cached.set(node, paths);
    return paths;
  };
  return Object.assign(
    (
      node: t.Node,
      capture?: t.Node,
      escapedContents = false,
      projection: AmbientProjection = [],
      localIdentity?: (node: t.Node, path: AmbientProjection) => void,
    ) => resolve(node, capture, escapedContents, projection, localIdentity),
    {
      binding: (binding: JavaScriptSemanticBindingState, capture: t.Node) =>
        resolve(capture, capture, true, [], undefined, binding),
    },
  );
};

const completedAmbientResolvers = new WeakMap<
  JavaScriptSemanticAnalysisState,
  ReturnType<typeof createAmbientPathResolver>
>();

type OwnSlotUnchanged = (owner: t.Node, key: string, read: t.Node) => boolean;
const completedOwnSlots = new WeakMap<
  JavaScriptSemanticAnalysisState,
  OwnSlotUnchanged
>();

/** Strict local capture uses the same completed store and escape snapshot. */
export const semanticAmbientOwnSlotUnchanged = (
  state: JavaScriptSemanticAnalysisState,
  owner: t.Node,
  key: string,
  read: t.Node,
): boolean => completedOwnSlots.get(state)?.(owner, key, read) === true;

export const semanticAmbientIdentitySourcesReady = (
  state: JavaScriptSemanticAnalysisState,
): boolean => completedAmbientResolvers.has(state);

/** Opaque lexical consumers use the same possible reference graph as writes. */
export const semanticAmbientBindingPaths = (
  binding: JavaScriptSemanticBindingState,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly AmbientPath[] =>
  (
    completedAmbientResolvers.get(state) ??
    createAmbientPathResolver(state, true)
  ).binding(binding, capture);

/** Each slot keeps its own capture when shared Module owners are normalized. */
export type SemanticModuleProjection = readonly {
  readonly key: string | number | null;
  readonly capture: t.Node;
}[];

/** Source stores can replace a Module property with the wrapper itself. Reads
 * and writes use the same nominal storage owner, without proving a loader.
 * The require-write cache recreates this query when ambient/fresh facts change. */
export const createSemanticModuleStorageQuery = (
  state: JavaScriptSemanticAnalysisState,
  interop: ReturnType<typeof createSemanticModuleInterop>,
) => {
  type Write = {
    node: t.Node;
    path: AmbientPath;
    sources: readonly SemanticIterationSource[];
  };
  let writes: Write[] | undefined;
  return (projection: SemanticModuleProjection): boolean => {
    if (writes === undefined) {
      const collected: Write[] = [];
      writes = collected;
      const paths = createAmbientPathResolver(state, true);
      const sources = new WeakMap<t.Node, readonly SemanticIterationSource[]>();
      const targets = new WeakMap<
        SemanticIterationSource,
        ReadonlySet<string>
      >();
      completeSemanticSteps(
        collectJavaScriptIdentityWritesSteps(
          state.program,
          (node, kind, site) => (kind === "member" ? paths(node, site) : []),
          interop.intrinsicInvocation,
          interop.staticString,
          interop.isFreshObject,
          (node, path) => {
            if (path[0] !== "commonjs-module") return;
            let references = sources.get(node);
            if (references === undefined) {
              references = semanticIterationSources(
                node,
                state.parentsByNode.get(node) ?? null,
              ).filter((source) => source.kind === "reference-store");
              sources.set(node, references);
            }
            const selected = references.filter((source) => {
              if (source.target === undefined) return false;
              let stored = targets.get(source);
              if (stored === undefined) {
                const key = semanticStaticPropertyKey(
                  source.target.property,
                  source.target.computed,
                );
                stored = new Set(
                  paths(source.target.object, source.mutation).map((owner) =>
                    JSON.stringify([...owner, key]),
                  ),
                );
                targets.set(source, stored);
              }
              return stored.has(JSON.stringify(path));
            });
            collected.push({ node, path, sources: selected });
          },
        ),
      );
    }
    const nominal: AmbientPath = [
      "commonjs-module",
      ...projection.map(({ key }) => (key === null ? null : String(key))),
    ];
    const captures: AmbientCaptures = [
      undefined,
      ...projection.map(({ capture }) => capture),
    ];
    const reads = new Map<
      string,
      { path: AmbientPath; captures: AmbientCaptures }
    >([[JSON.stringify(nominal), { path: nominal, captures }]]);
    semanticPossibleFunctionValueIdentities(nominal, (path, offset) => {
      const suffix = captures.slice(offset);
      reads.set(JSON.stringify(path), {
        path,
        captures: [
          ...Array<t.Node | undefined>(path.length - suffix.length).fill(
            captures[offset - 1],
          ),
          ...suffix,
        ],
      });
    });
    return [...reads.values()].some((read) =>
      writes!.some(({ node, path, sources }) => {
        const capture = read.captures[path.length - 1];
        if (
          capture === undefined ||
          path.length > read.path.length ||
          !path.every(
            (key, index) =>
              key === null ||
              read.path[index] === null ||
              key === read.path[index],
          ) ||
          semanticEffectTiming(capture, node, state) === "after"
        )
          return false;
        if (sources.length === 0) return true;
        return sources.some(
          (source) =>
            !semanticReferenceSourcesInactive(source, state, "syntax-only") &&
            !(
              path.length === read.path.length &&
              source.projection.length === 0 &&
              (readExactJavaScriptLiteral(source.node).found ||
                (semanticFreshObjectFactsReady(state) &&
                  interop.isFreshObject(source.node)))
            ),
        );
      }),
    );
  };
};

/** Possible inherited accessor helpers are effects, never strict call proofs. */
const createPossibleAccessorMutations = (
  state: JavaScriptSemanticAnalysisState,
  possiblePaths: ReturnType<typeof createAmbientPathResolver>,
  interop: ReturnType<typeof createSemanticModuleInterop>,
) => {
  const candidates = new WeakSet<t.Node>();
  const paths = new WeakMap<t.Node, readonly string[] | null>();
  const possible = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const known = interop.intrinsicPath(node);
      const prior = paths.get(node);
      if (prior !== undefined) return prior ?? known;
      for (const nominal of possiblePaths(node)) {
        for (let end = 1; end <= nominal.length; end += 1)
          for (const value of semanticPossibleFunctionValueIdentities(
            nominal.slice(0, end),
          )) {
            if (value[0] !== "global") continue;
            const path = ["intrinsic", ...value.slice(1)];
            if (
              semanticIntrinsicMutation({
                kind: "known",
                path,
                arguments: undefined,
              })?.receiver !== true
            )
              continue;
            // Typed selectors before the helper can be unknown cache keys.
            // Invocation syntax after the selected callable must stay exact.
            const suffix = nominal.slice(end);
            if (suffix.some((key) => key === null)) continue;
            const selected = [...path, ...(suffix as readonly string[])];
            paths.set(node, selected);
            return selected;
          }
      }
      paths.set(node, null);
      return known;
    },
  });
  return {
    candidates,
    invocation: (node: t.CallExpression | t.OptionalCallExpression) => {
      const known = interop.intrinsicInvocation(node);
      if (semanticIntrinsicMutation(known) !== undefined) return known;
      const candidate = possible.intrinsicInvocation(node);
      if (semanticIntrinsicMutation(candidate)?.receiver !== true) return known;
      candidates.add(node);
      return candidate;
    },
  };
};

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  createOpaqueObserver?: (
    paths: ReturnType<typeof createAmbientPathResolver>,
    retainGlobal?: (node: t.CallExpression | t.OptionalCallExpression) => void,
  ) => ((node: t.Node) => void) | undefined,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const browserReceiverMethods = new Set<string>();
  const storedSites = new WeakSet<t.Node>();
  const storedReferences: SemanticIterationSource[] = [];
  const replacementSources: SemanticIterationSource[] = [];
  const replacements = new WeakMap<
    t.Node,
    Map<string, SemanticIterationSource[]>
  >();
  const writes: {
    node: t.Node;
    path: AmbientPath;
    recipient?: JavaScriptIntrinsicMutationRecipient;
  }[] = [];
  const targets: { node: t.Node; capture: t.Node }[] = [];
  const escapes: {
    node: t.Node;
    target: t.Node;
    browserReceiver: boolean;
    projection?: AmbientProjection;
  }[] = [];
  const stores = new WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >();
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node);
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  let ownStaticSlotUnchanged: AmbientReferenceFacts["ownStaticSlotUnchanged"];
  const referenceFacts: AmbientReferenceFacts = {
    stores,
    replacements,
    freshObject: interop.isFreshObject,
    ownStaticSlotUnchanged: (owner, key, read) =>
      ownStaticSlotUnchanged?.(owner, key, read) === true,
    prototypeTarget: (node) => {
      if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
        return undefined;
      const invocation = interop.intrinsicInvocation(node);
      if (
        invocation?.kind !== "known" ||
        invocation.path.length !== 3 ||
        !["Object", "Reflect"].includes(invocation.path[1] ?? "") ||
        invocation.path[2] !== "getPrototypeOf"
      )
        return undefined;
      const target = invocation.arguments?.[0];
      return t.isNode(target) && !t.isSpreadElement(target)
        ? target
        : undefined;
    },
  };
  let ambientWrites = createAmbientPathResolver(state, true, referenceFacts);
  let observeOpaqueInvocation = createOpaqueObserver?.(ambientWrites);
  const opaqueCalls =
    observeOpaqueInvocation === undefined ? undefined : new Set<t.Node>();
  const accessorMutations = createPossibleAccessorMutations(
    state,
    ambientWrites,
    interop,
  );
  yield* collectJavaScriptIdentityWritesSteps(
    program,
    (root, kind, writeSite) => {
      if (kind === "opaque-call") return [];
      // Reassigning a local alias changes the binding, not the referenced object.
      if (kind === "binding")
        return t.isIdentifier(root) &&
          isUnshadowedGlobal(root, state, root.name)
          ? [["global", root.name]]
          : [];
      if (!storedSites.has(writeSite)) {
        storedSites.add(writeSite);
        for (const source of semanticIterationSources(
          writeSite,
          state.parentsByNode.get(writeSite) ?? null,
        )) {
          // Fresh direct receivers identify one concrete slot. Keep replacement
          // evidence apart from reference edges, including primitive tombstones.
          if (
            source.kind === "reference-store" &&
            source.target !== undefined &&
            t.isAssignmentExpression(source.mutation, { operator: "=" }) &&
            source.mutation.left === source.target &&
            semanticStaticPropertyKey(
              source.target.property,
              source.target.computed,
            ) !== null
          )
            replacementSources.push(source);
          // Direct primitive values cannot retain an ambient object identity.
          // A projection may select a reference from a boxed primitive. Keeping
          // direct primitives in the alias graph makes every receiver escape
          // revisit every primitive field written by its methods.
          if (
            source.kind === "reference-store" &&
            (source.projection.length !== 0 ||
              !readExactJavaScriptLiteral(source.node).found)
          )
            storedReferences.push(source);
        }
      }
      // Resolve identities after the traversal has collected every local store.
      const id = targets.push({ node: root, capture: writeSite }) - 1;
      return [["pending-target", String(id)]];
    },
    accessorMutations.invocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path, recipient) => {
      writes.push({
        node,
        path,
        ...(recipient === undefined ? {} : { recipient }),
      });
    },
    (node, selectedInvocation) => {
      // A possible inherited helper supplies only mutation recipients. It
      // cannot suppress the receiver escape of an unresolved actual callable.
      const invocation = accessorMutations.candidates.has(node)
        ? undefined
        : selectedInvocation;
      opaqueCalls?.add(node);
      // Escaping objects can change contents without replacing their identity.
      const retainEscape = (target: t.Node, browserReceiver = false) => {
        escapes.push({ target, node, browserReceiver });
      };
      for (const argument of t.isTaggedTemplateExpression(node)
        ? node.quasi.expressions
        : node.arguments)
        if (t.isNode(argument))
          retainEscape(
            t.isSpreadElement(argument) ? argument.argument : argument,
          );
      const callee = unwrapJavaScriptExpression(
        t.isTaggedTemplateExpression(node) ? node.tag : node.callee,
      ).node;
      const browserMethod =
        invocation?.kind === "known" &&
        invocation.path.length === 2 &&
        ["open", "fetch"].includes(invocation.path[1] ?? "")
          ? invocation.path[1]
          : undefined;
      if (
        !t.isNewExpression(node) &&
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        !(
          invocation?.kind === "known" &&
          ["Object", "Reflect"].includes(invocation.path[1] ?? "")
        )
      ) {
        if (browserMethod !== undefined)
          browserReceiverMethods.add(browserMethod);
        retainEscape(callee.object, browserMethod !== undefined);
      }
    },
  );
  // Build all possible references before accepting strong replacements. A
  // superseded alias can still carry an earlier escape that freezes its owner.
  const pendingStores = new Set(storedReferences);
  const dependents = new WeakMap<t.Node, Set<SemanticIterationSource>>();
  while (pendingStores.size > 0) {
    const source = pendingStores.values().next().value;
    if (source === undefined) break;
    pendingStores.delete(source);
    if (source.target === undefined) continue;
    const identities = new Map<t.Node, AmbientProjection>();
    ambientWrites(source.target, source.mutation, false, [], (node, path) => {
      // Assigning a slot replaces the reference in its containing object; it
      // does not replace an object previously read from that slot.
      if (path?.length === 0) return;
      const users = dependents.get(node) ?? new Set<SemanticIterationSource>();
      users.add(source);
      dependents.set(node, users);
      identities.set(
        node,
        identities.has(node)
          ? joinAmbientProjection(identities.get(node), path)
          : path,
      );
    });
    // Publish only completed queries; each source/root projection can only widen.
    for (const [node, path] of identities) {
      const entries =
        stores.get(node) ??
        new Map<SemanticIterationSource, AmbientProjection>();
      const previous = entries.get(source);
      const joined = entries.has(source)
        ? joinAmbientProjection(previous, path)
        : path;
      if (
        entries.has(source) &&
        (previous === undefined ||
          (joined !== undefined &&
            previous.every((key, index) => key === joined[index])))
      )
        continue;
      entries.set(source, joined);
      stores.set(node, entries);
      for (const dependent of dependents.get(node) ?? [])
        pendingStores.add(dependent);
    }
    yield;
  }
  // Possible eval sites are proof inputs before pruning, not published facts.
  // The observer reuses its invocation owner and resolves final sites below.
  const weakGlobalSites = [...state.opaqueEffects.globalSites];
  const observeWeakOpaqueInvocation = createOpaqueObserver?.(
    ambientWrites,
    (node) => {
      weakGlobalSites.push(node);
    },
  );
  for (const node of opaqueCalls ?? []) observeWeakOpaqueInvocation?.(node);
  type DataSlot = "own" | "missing" | "unknown";
  const ordinaryContainers = new WeakMap<t.Node, boolean>();
  const dataSlots = new WeakMap<t.Node, Map<string, DataSlot>>();
  const dataSlot = (root: t.Node, key: string): DataSlot => {
    if (key === "__proto__") return "unknown";
    let ordinary = ordinaryContainers.get(root);
    if (ordinary === undefined) {
      ordinary = t.isArrayExpression(root)
        ? !root.elements.some(t.isSpreadElement)
        : t.isObjectExpression(root) &&
          !root.properties.some(
            (property) =>
              t.isObjectProperty(property) &&
              !property.computed &&
              !property.shorthand &&
              semanticStaticPropertyKey(property.key, false) === "__proto__",
          );
      ordinaryContainers.set(root, ordinary);
    }
    if (!ordinary) return "unknown";
    if (t.isArrayExpression(root))
      return key === "length" ? "unknown" : "missing";
    const slots = dataSlots.get(root) ?? new Map<string, DataSlot>();
    let slot = slots.get(key);
    if (slot === undefined) {
      const property = staticObjectProperty(root, key);
      slot =
        property.status === "explicit"
          ? "own"
          : property.status === "missing"
            ? "missing"
            : "unknown";
      slots.set(key, slot);
      dataSlots.set(root, slots);
    }
    return slot;
  };
  const resolveWeakTargets = () =>
    targets.map(({ node, capture }) => {
      const local = new Map<t.Node, AmbientProjection>();
      const paths = ambientWrites(node, capture, false, [], (root, path) => {
        local.set(
          root,
          local.has(root) ? joinAmbientProjection(local.get(root), path) : path,
        );
      });
      return { paths, local };
    });
  let weakTargets: ReturnType<typeof resolveWeakTargets> | undefined;
  const completedTargets = () => (weakTargets ??= resolveWeakTargets());
  let weakBindingFacts: SemanticGlobalBindingFacts | undefined;
  const completedBindingFacts = (): SemanticGlobalBindingFacts => {
    if (weakBindingFacts !== undefined) return weakBindingFacts;
    const facts: SemanticGlobalBindingFacts = {
      ambientWrites: new SemanticPropertyPathCoverage(),
      ambientWriteEffects: [],
      opaqueGlobalSites: weakGlobalSites,
      complete:
        observeWeakOpaqueInvocation !== undefined ||
        !state.opaqueEffects.mayReferenceGlobalEval,
    };
    const resolved = completedTargets();
    for (const { node, path } of writes) {
      const target =
        path[0] === "pending-target" ? resolved[Number(path[1])] : undefined;
      const paths =
        target === undefined
          ? [path]
          : target.paths.map((identity) => [...identity, ...path.slice(2)]);
      for (const identity of paths) {
        facts.ambientWrites.retain(identity);
        facts.ambientWriteEffects.push({ path: identity, node });
      }
    }
    for (const escape of escapes)
      for (const identity of ambientWrites(
        escape.target,
        escape.node,
        true,
        escape.projection,
      ))
        if (identity[0] === "callable-value") {
          const path = [...identity, null];
          facts.ambientWrites.retain(path);
          facts.ambientWriteEffects.push({ path, node: escape.node });
        }
    weakBindingFacts = facts;
    return facts;
  };
  // Complete the weak snapshot before any refined resolver can consult it.
  // Constructor receiver queries cannot justify their own binding stability.
  const bindingFacts = completedBindingFacts();
  const proofInterop = createSemanticModuleInterop(state, {
    intrinsicPath: interop.intrinsicPath,
    bindingReadMayHaveChanged: (binding, read) =>
      semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
      (semanticBindingCanBeRebound(binding) &&
        semanticGlobalBindingReadMayHaveChanged(
          binding,
          read,
          state,
          bindingFacts,
        )),
  });
  // Provisional result/receiver caches retain all possible inherited objects.
  // Refinement owns fresh caches and consumes the frozen weak proof inputs.
  ambientWrites = createAmbientPathResolver(state, true, {
    ...referenceFacts,
    freshObject: proofInterop.isFreshObject,
    definiteObject: proofInterop.isDefinitelyObject,
    intrinsicWriteFacts: bindingFacts,
  });
  observeOpaqueInvocation = createOpaqueObserver?.(ambientWrites);
  // Early recipient candidates remain in weak proof inputs. Refine the parsed
  // invocation once before publishing or interpreting its possible writes.
  const selectedRecipients = new WeakMap<
    JavaScriptIntrinsicMutationRecipient["invocation"],
    ReadonlySet<t.Node | undefined>
  >();
  const activeWrites = writes.filter(({ recipient }) => {
    if (recipient === undefined) return true;
    let selected = selectedRecipients.get(recipient.invocation);
    if (selected === undefined) {
      selected = new Set(
        semanticIntrinsicMutationTargets(
          recipient.invocation,
          proofInterop.isFreshObject,
        ),
      );
      selectedRecipients.set(recipient.invocation, selected);
    }
    return selected.has(recipient.target);
  });
  const activeTargetIds = new Set(
    activeWrites.flatMap(({ path }) =>
      path[0] === "pending-target" ? [Number(path[1])] : [],
    ),
  );
  let memberWrites:
    | WeakMap<t.Node, Map<string | null, Set<t.Node>>>
    | undefined;
  const writesToMember = (root: t.Node, key: string): readonly t.Node[] => {
    if (memberWrites === undefined) {
      memberWrites = new WeakMap();
      const resolved = completedTargets();
      for (const { node, path } of activeWrites) {
        if (path[0] !== "pending-target") continue;
        for (const [owner, projection] of resolved[Number(path[1])]?.local ??
          []) {
          const member =
            projection === undefined
              ? undefined
              : [...projection, ...path.slice(2)];
          if (member !== undefined && member.length > 1) continue;
          const byKey =
            memberWrites.get(owner) ?? new Map<string | null, Set<t.Node>>();
          const memberKey = member?.[0] ?? null;
          const sites = byKey.get(memberKey) ?? new Set<t.Node>();
          sites.add(node);
          byKey.set(memberKey, sites);
          memberWrites.set(owner, byKey);
        }
      }
    }
    const byKey = memberWrites.get(root);
    return [...(byKey?.get(key) ?? []), ...(byKey?.get(null) ?? [])];
  };
  interface ReceiverSlot {
    readonly root: t.Node;
    readonly key: string;
    readonly slot: "own" | "missing";
  }
  interface StoreReceiver extends ReceiverSlot {
    readonly guards: readonly ReceiverSlot[];
  }
  const freshRoot = (node: t.Node, capture: t.Node): t.Node | null => {
    if (!proofInterop.isFreshObject(node)) return null;
    const identities = new Map<t.Node, AmbientProjection>();
    const ambient = ambientWrites(node, capture, false, [], (root, path) => {
      identities.set(
        root,
        identities.has(root)
          ? joinAmbientProjection(identities.get(root), path)
          : path,
      );
    });
    if (ambient.length !== 0 || identities.size !== 1) return null;
    for (const [root, path] of identities) if (path?.length === 0) return root;
    return null;
  };
  const receiverFacts = new WeakMap<
    SemanticIterationSource,
    StoreReceiver | null
  >();
  const storeReceiver = (
    source: SemanticIterationSource,
  ): StoreReceiver | null => {
    const cached = receiverFacts.get(source);
    if (cached !== undefined) return cached;
    // Recursive store dependencies cannot establish their own completeness.
    receiverFacts.set(source, null);
    // Finding one local alternative does not establish complete receiver
    // identity. Returned, mixed, accessor, and prototype receivers may consume
    // the RHS even when their other alternatives are fresh local containers.
    const target = source.target;
    if (target === undefined) return null;
    const key = semanticStaticPropertyKey(target.property, target.computed);
    if (key === null) return null;
    const path = electronMemberPath(target.object);
    let root = freshRoot(path.root, source.mutation);
    if (root === null) return null;
    const guards: ReceiverSlot[] = [];
    // Member receivers need complete contents, not merely one recovered local
    // alternative. Follow only exact fresh stores in the completed weak graph.
    for (const member of path.members) {
      if (member === null) return null;
      const slot = dataSlot(root, member);
      if (slot === "unknown") return null;
      guards.push({ root, key: member, slot });
      let selected: t.Node | null = null;
      let definite = false;
      const accepted = new Set<t.Node>();
      for (const [stored, projection] of stores.get(root) ?? []) {
        if (
          semanticEffectTiming(source.mutation, stored.mutation, state) ===
            "after" ||
          semanticReferenceSourcesInactive(stored, state, "syntax-only")
        )
          continue;
        if (projection === undefined) return null;
        if (projection.length !== 1) continue;
        if (projection[0] === null) return null;
        if (projection[0] !== member) continue;
        if (stored.projection.length !== 0) return null;
        const receiver = storeReceiver(stored);
        const value = freshRoot(stored.node, stored.node);
        if (
          receiver?.root !== root ||
          receiver.key !== member ||
          value === null ||
          (selected !== null && selected !== value)
        )
          return null;
        selected = value;
        guards.push(...receiver.guards);
        accepted.add(stored.mutation);
        definite ||= semanticDefiniteMutationPrecedesRead(
          stored.mutation,
          source.mutation,
          state.parentsByNode,
        );
      }
      // Primitive and unknown writes are intentionally absent from reference
      // edges. The existing write index still excludes them from a fresh proof.
      if (
        writesToMember(root, member).some(
          (site) =>
            semanticEffectTiming(source.mutation, site, state) !== "after" &&
            !accepted.has(site),
        )
      )
        return null;
      const initial = staticObjectProperty(root, member);
      if (initial.status === "explicit") {
        const value = freshRoot(initial.property.value, initial.property.value);
        if (value === null || (selected !== null && selected !== value))
          return null;
        selected = value;
        definite = true;
      }
      if (selected === null || !definite) return null;
      root = selected;
    }
    const slot = dataSlot(root, key);
    if (slot === "unknown") return null;
    guards.push({ root, key, slot });
    const receiver: StoreReceiver = { root, key, slot, guards };
    receiverFacts.set(source, receiver);
    return receiver;
  };
  const receiverUsers = new WeakMap<t.Node, Set<SemanticIterationSource>>();
  const inheritedReceiverUsers = new Set<SemanticIterationSource>();
  const pendingReferenceEscapes = new Set(storedReferences);
  const escapedReferences = new WeakSet<SemanticIterationSource>();
  let hasReceiverProofs = false;
  for (const source of storedReferences) {
    const receiver = storeReceiver(source);
    if (receiver === null) continue;
    hasReceiverProofs = true;
    for (const guard of receiver.guards) {
      const users =
        receiverUsers.get(guard.root) ?? new Set<SemanticIterationSource>();
      users.add(source);
      receiverUsers.set(guard.root, users);
      if (guard.slot === "missing") inheritedReceiverUsers.add(source);
    }
  }
  for (const source of replacementSources)
    if (storeReceiver(source) !== null) hasReceiverProofs = true;
  const descriptorEffects = new WeakMap<t.Node, Set<t.Node>>();
  const prototypeEffects = new Set<t.Node>();
  const retainDescriptorEffect = (root: t.Node, site: t.Node): void => {
    const effects = descriptorEffects.get(root) ?? new Set<t.Node>();
    if (effects.has(site)) return;
    effects.add(site);
    descriptorEffects.set(root, effects);
    for (const source of receiverUsers.get(root) ?? [])
      if (!escapedReferences.has(source)) pendingReferenceEscapes.add(source);
  };
  const retainPrototypeEffect = (site: t.Node): void => {
    if (prototypeEffects.has(site)) return;
    prototypeEffects.add(site);
    for (const source of inheritedReceiverUsers)
      if (!escapedReferences.has(source)) pendingReferenceEscapes.add(source);
  };
  const mayReachPrototype = (path: AmbientPath): boolean =>
    ["Object", "Array"].some((owner) =>
      ["global", owner, "prototype"].every(
        (key, index) =>
          path[index] === undefined ||
          path[index] === null ||
          path[index] === key,
      ),
    );
  // Resolve each discovered escape once against the completed weak graph.
  // Its descriptor effects recheck only stores depending on that receiver.
  const resolvedEscapes: {
    node: t.Node;
    browserReceiver: boolean;
    paths: readonly AmbientPath[];
  }[] = [];
  const resolveEscape = (escape: (typeof escapes)[number]): void => {
    const paths = ambientWrites(
      escape.target,
      escape.node,
      true,
      escape.projection,
      (root, path) => {
        if (
          hasReceiverProofs ||
          t.isClass(root) ||
          t.isObjectExpression(root) ||
          t.isArrayExpression(root)
        ) {
          if (path === undefined || path.length === 0)
            retainDescriptorEffect(root, escape.node);
          else if (path.includes("__proto__"))
            retainPrototypeEffect(escape.node);
        }
      },
    );
    if (hasReceiverProofs && paths.some(mayReachPrototype))
      retainPrototypeEffect(escape.node);
    resolvedEscapes.push({
      node: escape.node,
      browserReceiver: escape.browserReceiver,
      paths,
    });
  };
  for (const escape of escapes) resolveEscape(escape);
  if (hasReceiverProofs) {
    // Existing write targets also own delete/prototype evidence. Resolve each
    // target once here, rather than scanning all writes for every stored slot.
    const weakTargets = completedTargets();
    for (const [index, target] of weakTargets.entries()) {
      if (!activeTargetIds.has(index)) continue;
      for (const path of target.local.values())
        if (path === undefined || path.includes("__proto__"))
          retainPrototypeEffect(targets[index]!.capture);
    }
    for (const { node, path } of activeWrites) {
      const target =
        path[0] === "pending-target" ? weakTargets[Number(path[1])] : undefined;
      const paths =
        target === undefined
          ? [path]
          : target.paths.map((identity) => [...identity, ...path.slice(2)]);
      if (paths.some(mayReachPrototype)) retainPrototypeEffect(node);
      if (
        t.isUnaryExpression(node, { operator: "delete" }) ||
        path.slice(2).some((key) => key === null || key === "__proto__")
      )
        for (const [root, projection] of target?.local ?? [])
          if (projection === undefined || projection.length === 0)
            retainDescriptorEffect(root, node);
    }
  }
  const effectMayPrecede = (
    mutation: t.Node,
    effects: ReadonlySet<t.Node> | undefined,
  ): boolean => {
    for (const site of effects ?? [])
      if (semanticEffectTiming(mutation, site, state) !== "after") return true;
    return false;
  };
  const inertReceiver = (
    source: SemanticIterationSource,
  ): StoreReceiver | null => {
    const receiver = storeReceiver(source);
    return receiver !== null &&
      receiver.guards.every(
        (guard) =>
          !effectMayPrecede(
            source.mutation,
            descriptorEffects.get(guard.root),
          ) &&
          (guard.slot === "own" ||
            !effectMayPrecede(source.mutation, prototypeEffects)),
      )
      ? receiver
      : null;
  };
  // An escaped RHS may invalidate another tentative receiver proof. Each store
  // escapes at most once; only affected receiver/prototype users are revisited.
  while (pendingReferenceEscapes.size > 0) {
    const source = pendingReferenceEscapes.values().next().value;
    if (source === undefined) break;
    pendingReferenceEscapes.delete(source);
    if (escapedReferences.has(source) || inertReceiver(source) !== null)
      continue;
    escapedReferences.add(source);
    resolveEscape({
      node: source.mutation,
      target: source.node,
      browserReceiver: false,
      projection: source.projection.map((key) =>
        key === null || typeof key === "object" ? null : String(key),
      ),
    });
    yield;
  }
  // Only final inert data writes replace prior references. Primitive tombstones
  // remain replacement evidence and never become reference edges.
  for (const source of replacementSources) {
    const receiver = inertReceiver(source);
    if (receiver === null) continue;
    const byKey =
      replacements.get(receiver.root) ??
      new Map<string, SemanticIterationSource[]>();
    const sources = byKey.get(receiver.key) ?? [];
    sources.push(source);
    byKey.set(receiver.key, sources);
    replacements.set(receiver.root, byKey);
  }
  // Exclusion needs the completed write/escape snapshot. Earlier resolver
  // queries retain inherited possibilities; their declarative slot cache does
  // not memoize this mutable proof, and possible-write paths are never cached.
  const ownSlotUnchanged: OwnSlotUnchanged = (owner, key, read) =>
    !effectMayPrecede(read, descriptorEffects.get(owner)) &&
    !writesToMember(owner, key).some(
      (site) => semanticEffectTiming(read, site, state) !== "after",
    );
  ownStaticSlotUnchanged = ownSlotUnchanged;
  completedOwnSlots.set(state, ownSlotUnchanged);
  // Resolve possible identities against one completed store snapshot before
  // publishing any writes. Incremental publication would invalidate loader
  // origin indexes for every target and replay a full source scan each time.
  completedAmbientResolvers.set(state, ambientWrites);
  const targetPaths = targets.map(({ node, capture }) =>
    ambientWrites(node, capture),
  );
  for (const { node, path } of activeWrites) {
    const resolvedTargets =
      path[0] === "pending-target" ? targetPaths[Number(path[1])] : undefined;
    const paths =
      resolvedTargets === undefined
        ? [path]
        : resolvedTargets.map((identity) => [...identity, ...path.slice(2)]);
    for (const resolved of paths) {
      state.ambientWrites.retain(resolved);
      state.ambientWriteEffects.push({ path: resolved, node });
    }
  }
  for (const { node, paths, browserReceiver } of resolvedEscapes)
    for (const path of paths) {
      if (path[0] === "callable-value") {
        const escaped = [...path, null];
        state.ambientWrites.retain(escaped);
        state.ambientWriteEffects.push({ path: escaped, node });
      }
      // Only proven browser APIs keep their global receiver from user code.
      if (!(browserReceiver && path.length === 1 && path[0] === "global"))
        state.ambientEscapes.retain([...path, null]);
    }
  // A function may call a browser method replaced later in source order.
  if (
    [...browserReceiverMethods].some((method) =>
      state.ambientWrites.covers(["global", method]),
    )
  )
    state.ambientEscapes.retain(["global", null]);
  // Opaque callees can be stored after container creation. Resolve them with
  // the completed store facts instead of a second resolver without those facts.
  for (const node of opaqueCalls ?? []) observeOpaqueInvocation?.(node);
  if (
    observeOpaqueInvocation !== undefined ||
    !state.opaqueEffects.mayReferenceGlobalEval
  )
    completeSemanticFreshObjectFacts(state);
}

/**
 * Recognize an ambient property path, optionally through a global object, without a visible
 * source-local overwrite. This is a syntax-local identity fact, not proof that
 * the runtime's globals have never been patched by other code.
 */
export const isUnmodifiedGlobalReference = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string | readonly [string, ...string[]],
): boolean => {
  const path: readonly [string, ...string[]] =
    typeof name === "string" ? [name] : name;
  if (state.ambientWrites.covers(["global", ...path])) return false;
  const { root, members } = electronMemberPath(callee);
  const matches = (expected: readonly string[]) =>
    members.length === expected.length &&
    members.every((key, index) => key === expected[index]);
  if (isUnshadowedGlobal(root, state, path[0]) && matches(path.slice(1)))
    return true;
  const namespace = globalObjectName(root, state);
  return (
    namespace !== undefined &&
    matches(path) &&
    !state.ambientWrites.covers(["global", namespace])
  );
};

/** A module URL base is known only while its property has no visible write. */
export const isUnmodifiedImportMetaUrl = (
  node: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isImportMetaUrl(node) && !state.ambientWrites.covers(["import-meta", "url"]);
