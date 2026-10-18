import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import {
  javaScriptIntrinsicResultReference,
  resolveJavaScriptIntrinsicInvocations,
} from "./javascriptIntrinsicInvocation.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isImportMetaUrl } from "./javascriptStaticAnalysisHelpers.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticIterationSources,
  type SemanticIterationSource,
} from "./javascriptSemanticIterationSources.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";

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

interface DestinationProof {
  private: boolean;
  unknown: boolean;
  readonly dependencies: Set<DestinationProof>;
  readonly users: Set<DestinationProof>;
}

/** Every alternative must reach a private identity; unresolved cycles prove nothing. */
const provePrivateDestination = (
  root: DestinationProof,
  proofs: Iterable<DestinationProof>,
): boolean => {
  const remaining = new Map<DestinationProof, number>();
  const ready: DestinationProof[] = [];
  for (const proof of proofs) {
    remaining.set(proof, proof.dependencies.size);
    if (proof.private && !proof.unknown && proof.dependencies.size === 0)
      ready.push(proof);
  }
  const proven = new Set<DestinationProof>();
  while (ready.length > 0) {
    const proof = ready.pop();
    if (proof === undefined || proven.has(proof)) continue;
    proven.add(proof);
    for (const user of proof.users) {
      const count = (remaining.get(user) ?? 0) - 1;
      remaining.set(user, count);
      if (count === 0 && !user.unknown) ready.push(user);
    }
  }
  return proven.has(root);
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
  readonly prototypeTarget: (node: t.Node) => t.Node | undefined;
  readonly returnedReference: (node: t.Node) => t.Expression | undefined;
  readonly freshObject: (node: t.Node) => boolean;
  readonly superConstructors: WeakSet<t.Class>;
  readonly callableResult?: (
    node:
      | t.CallExpression
      | t.OptionalCallExpression
      | t.NewExpression
      | t.TaggedTemplateExpression,
    constructionTarget: boolean,
  ) => readonly AmbientPath[];
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
  const returnedReferences = createSemanticReturnedReferences(state);
  return (
    node: t.Node,
    capture?: t.Node,
    escapedContents = false,
    projection: AmbientProjection = [],
    localIdentity?: (node: t.Node, path: AmbientProjection) => void,
    observePrivateDestination?: (privateDestination: boolean) => void,
    constructionTarget = false,
  ): readonly AmbientPath[] => {
    const prior = possibleWrites ? undefined : cached.get(node);
    if (prior !== undefined) return prior;
    const result = new Map<string, AmbientPath>();
    // The caller's write site selects initializers for the written target.
    // Reads reached through an initializer occur at their own position.
    const pending: {
      node: t.Node;
      suffix: AmbientProjection;
      readsAtSelf?: true;
    }[] = [{ node, suffix: projection }];
    const destinations =
      observePrivateDestination === undefined
        ? undefined
        : new Map<t.Node, DestinationProof>();
    const destination = (node: t.Node): DestinationProof | undefined => {
      if (destinations === undefined) return undefined;
      const root = electronMemberPath(node).root;
      let proof = destinations.get(root);
      if (proof === undefined) {
        proof = {
          private: false,
          unknown: false,
          dependencies: new Set(),
          users: new Set(),
        };
        destinations.set(root, proof);
      }
      return proof;
    };
    const rootDestination = destination(node);
    let activeDestination: DestinationProof | undefined;
    const enqueue = (next: (typeof pending)[number]) => {
      const child = destination(next.node);
      // Stored contents cannot change an already selected fresh object's identity.
      if (
        activeDestination !== undefined &&
        !activeDestination.private &&
        child !== undefined
      ) {
        activeDestination.dependencies.add(child);
        child.users.add(activeDestination);
      }
      pending.push(next);
    };
    // Join projections at their producing expression, rather than enumerating
    // alias histories. Each key can only widen to a wildcard, and conflicting
    // depths widen to unknown, so diamonds and cycles have finite state.
    const expanded = new WeakMap<t.Node, AmbientProjection>();
    const retain = (path: AmbientPath) => {
      if (activeDestination !== undefined) activeDestination.unknown = true;
      let canonical = canonicalAmbientPath(path);
      for (;;) {
        result.set(JSON.stringify(canonical), canonical);
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
      const { root, members } = electronMemberPath(current.node);
      activeDestination = destination(root);
      let suffix: AmbientProjection =
        current.suffix === undefined
          ? undefined
          : [...members, ...current.suffix];
      if (expanded.has(root)) {
        const previous = expanded.get(root);
        if (previous === undefined) continue;
        if (suffix !== undefined && previous.length === suffix.length) {
          const joined: AmbientPath = previous.map((key, index) =>
            key === suffix?.[index] ? key : null,
          );
          if (joined.every((key, index) => key === previous[index])) continue;
          suffix = joined;
        } else suffix = undefined;
        if (!possibleWrites) {
          cached.set(node, []);
          return [];
        }
      }
      expanded.set(root, suffix);
      if (
        activeDestination !== undefined &&
        (suffix === undefined || suffix.includes(null))
      )
        activeDestination.unknown = true;
      // A widened projection is a possible write, never proof of an intrinsic.
      if (suffix === undefined && !possibleWrites) continue;
      const continueWith = (node: t.Node, path: AmbientProjection = suffix) =>
        enqueue({
          node,
          suffix: path,
          ...(current.readsAtSelf && { readsAtSelf: true }),
        });
      const continueReturned = (callee: t.Node, path: AmbientProjection) => {
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
          );
      };
      if (!t.isIdentifier(root) && facts?.freshObject(root)) {
        localIdentity?.(root, suffix);
        if (activeDestination !== undefined && suffix?.length === 0)
          activeDestination.private = true;
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
          const remaining =
            suffix === undefined || path === undefined
              ? undefined
              : suffix.slice(path.length);
          enqueue({
            node: source.node,
            readsAtSelf: true,
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
      if (t.isIdentifier(root)) {
        // The wrapper module object is distinct from globalThis.module. Keep
        // its identity through the same alias/projection owner used for writes.
        if (isUnshadowedGlobal(root, state, "module")) {
          retain(["commonjs-module", ...(suffix ?? [])]);
          continue;
        }
        if (globalObjectName(root, state) !== undefined) {
          retain(["global", ...(suffix ?? [])]);
          continue;
        }
        if (isUnshadowedGlobal(root, state, root.name)) {
          retain(["global", root.name, ...(suffix ?? [])]);
          continue;
        }
        const binding = resolveSemanticBindingState(state, root, root.name);
        if (binding === undefined) continue;
        const stable = semanticStableInitializer(binding, state);
        const readAt = current.readsAtSelf ? root : capture;
        const initializers = possibleWrites
          ? readAt === undefined
            ? binding.initializers
            : semanticBindingAtRead(binding, readAt, state.parentsByNode)
                .binding.initializers
          : stable === undefined
            ? []
            : [stable];
        for (const initializer of initializers)
          enqueue({
            node: initializer.node,
            readsAtSelf: true,
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
        );
        continue;
      }
      const returnedReference = possibleWrites
        ? facts?.returnedReference(root)
        : undefined;
      if (returnedReference !== undefined) {
        continueWith(returnedReference);
        continue;
      }
      const prototypeTarget = possibleWrites
        ? facts?.prototypeTarget(root)
        : undefined;
      if (prototypeTarget !== undefined) {
        continueWith(
          prototypeTarget,
          suffix === undefined ? undefined : ["__proto__", ...suffix],
        );
        continue;
      }
      if (
        possibleWrites &&
        constructionTarget &&
        t.isClass(root) &&
        suffix !== undefined &&
        suffix.every(
          (member) =>
            member !== null && ["bind", "call", "apply"].includes(member),
        )
      ) {
        const constructor = root.body.body.find(
          (member) => t.isClassMethod(member) && member.kind === "constructor",
        );
        if (
          root.superClass !== null &&
          root.superClass !== undefined &&
          (constructor === undefined || facts?.superConstructors.has(root))
        )
          continueWith(root.superClass, suffix);
        continue;
      }
      if (
        possibleWrites &&
        (t.isCallExpression(root) ||
          t.isOptionalCallExpression(root) ||
          t.isNewExpression(root) ||
          t.isTaggedTemplateExpression(root) ||
          (escapedContents && (t.isFunction(root) || t.isClass(root))))
      ) {
        if (
          t.isCallExpression(root) ||
          t.isOptionalCallExpression(root) ||
          t.isNewExpression(root) ||
          t.isTaggedTemplateExpression(root)
        ) {
          for (const identity of facts?.callableResult?.(
            root,
            constructionTarget,
          ) ?? [])
            retain([...identity, ...(suffix ?? [])]);
        }
        if (escapedContents && t.isClass(root) && suffix?.length === 0) {
          for (const member of root.body.body) {
            if (
              t.isClassMethod(member) &&
              member.static &&
              member.kind !== "set"
            )
              continueReturned(member, []);
            else if (
              t.isClassProperty(member) &&
              member.static &&
              t.isExpression(member.value)
            )
              continueWith(member.value, []);
          }
          if (root.superClass !== null && root.superClass !== undefined)
            continueWith(root.superClass, []);
        }
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
      if (possibleWrites && t.isAwaitExpression(root)) {
        // Await may preserve the value; this does not prove its identity for reads.
        if (activeDestination !== undefined) activeDestination.unknown = true;
        continueWith(root.argument);
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
        ["=", "||=", "&&=", "??="].includes(root.operator)
      ) {
        if (root.operator !== "=") continueWith(root.left);
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
            else if (t.isObjectMethod(property) && property.kind !== "set")
              continueReturned(property, []);
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
            if (t.isSpreadElement(property)) continueWith(property.argument);
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
                  continueReturned(property, suffix?.slice(1));
                else if (t.isExpression(property.value))
                  continueWith(property.value, suffix?.slice(1));
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
            continueWith(property.value, suffix.slice(1));
        }
      } else if (t.isArrayExpression(root)) {
        if (suffix === undefined) {
          for (const element of root.elements)
            if (t.isSpreadElement(element)) continueWith(element.argument);
            else if (t.isExpression(element)) continueWith(element);
        } else if (possibleWrites) {
          const index = Number(key);
          if (
            key !== null &&
            (!Number.isInteger(index) || index < 0 || String(index) !== key)
          )
            continue;
          let minimumOffset = 0;
          let uncertainOffset = false;
          for (const element of root.elements) {
            if (t.isSpreadElement(element)) {
              if (key === null || index >= minimumOffset)
                continueWith(element.argument, [null, ...suffix.slice(1)]);
              uncertainOffset = true;
            } else {
              if (
                t.isExpression(element) &&
                (key === null ||
                  index === minimumOffset ||
                  (uncertainOffset && index >= minimumOffset))
              )
                continueWith(element, suffix.slice(1));
              minimumOffset += 1;
            }
          }
        } else if (!root.elements.some(t.isSpreadElement)) {
          const index = Number(key);
          if (
            key !== null &&
            Number.isInteger(index) &&
            index >= 0 &&
            String(index) === key
          ) {
            const element = root.elements[index];
            if (t.isExpression(element)) continueWith(element, suffix.slice(1));
          }
        }
      }
    }
    const paths = [...result.values()];
    if (rootDestination !== undefined && destinations !== undefined)
      observePrivateDestination?.(
        provePrivateDestination(rootDestination, destinations.values()),
      );
    if (!possibleWrites) cached.set(node, paths);
    return paths;
  };
};

export type AmbientPathResolver = ReturnType<typeof createAmbientPathResolver>;

export interface AmbientInvocationObserver {
  readonly invocationHandoffs?: (
    node: t.Node,
    resolve: AmbientPathResolver,
  ) =>
    | {
        readonly targets: readonly {
          readonly node: t.Node;
          readonly projection: readonly (string | null)[];
        }[];
        readonly coverage: "all" | "arguments" | undefined;
      }
    | undefined;
  readonly observeInvocation: (
    node: t.Node,
    resolve: AmbientPathResolver,
  ) => "all" | "arguments" | undefined;
  readonly observeEscape?: (node: t.Node, identity: AmbientPath) => void;
  readonly callableResult?: (
    node:
      | t.CallExpression
      | t.OptionalCallExpression
      | t.NewExpression
      | t.TaggedTemplateExpression,
    resolve: AmbientPathResolver,
    constructionTarget?: boolean,
  ) => readonly AmbientPath[];
}

/**
 * Index source-local writes through ambient identities and stable aliases.
 * The shared invocation owner resolves intrinsic aliases, bind/call/apply and
 * literal argument spreads. Runtime reachability and arbitrary call effects
 * remain unevaluated; a visible possible write is sufficient.
 */
export function* indexJavaScriptAmbientWritesSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  opaqueObserver?: AmbientInvocationObserver,
): Generator<void> {
  const ambientReads = createAmbientPathResolver(state, false);
  const browserReceiverMethods = new Set<string>();
  const storedSites = new WeakSet<t.Node>();
  const storedReferences: SemanticIterationSource[] = [];
  const writes: { node: t.Node; path: AmbientPath }[] = [];
  const targets: { node: t.Node; capture: t.Node }[] = [];
  type EscapeTarget = {
    target: t.Node;
    browserReceiver: boolean;
    receiver?: true;
    projection?: AmbientProjection;
  };
  const escapes: {
    node: t.Node;
    invocation?: true;
    caller?: t.Function;
    targets: EscapeTarget[];
  }[] = [];
  const stores = new WeakMap<
    t.Node,
    Map<SemanticIterationSource, AmbientProjection>
  >();
  const superConstructors = new WeakSet<t.Class>();
  const derivedConstructors = new WeakSet<t.ClassMethod>();
  let hasDerivedConstructor = false;
  for (const callable of state.callableNodesById.values()) {
    if (!t.isClassMethod(callable) || callable.kind !== "constructor") continue;
    const body = state.parentsByNode.get(callable);
    const owner =
      body === undefined ? undefined : state.parentsByNode.get(body);
    if (t.isClass(owner) && owner.superClass != null) {
      derivedConstructors.add(callable);
      hasDerivedConstructor = true;
    }
  }
  const interop = createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const [path] = ambientReads(node);
      return path?.[0] === "global" && path.every((key) => key !== null)
        ? ["intrinsic", ...(path.slice(1) as readonly string[])]
        : undefined;
    },
  });
  const ambientWrites: AmbientPathResolver = createAmbientPathResolver(
    state,
    true,
    {
      stores,
      superConstructors,
      freshObject: interop.isFreshObject,
      returnedReference: (node) =>
        t.isCallExpression(node) || t.isOptionalCallExpression(node)
          ? javaScriptIntrinsicResultReference(
              interop.intrinsicInvocation(node),
            )
          : undefined,
      ...(opaqueObserver?.callableResult === undefined
        ? {}
        : {
            callableResult: (
              node:
                | t.CallExpression
                | t.OptionalCallExpression
                | t.NewExpression
                | t.TaggedTemplateExpression,
              constructionTarget: boolean,
            ) =>
              opaqueObserver.callableResult?.(
                node,
                ambientWrites,
                constructionTarget,
              ) ?? [],
          }),
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
    },
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
          if (source.kind === "reference-store") storedReferences.push(source);
        }
      }
      // Resolve identities after the traversal has collected every local store.
      const id = targets.push({ node: root, capture: writeSite }) - 1;
      return [["pending-target", String(id)]];
    },
    interop.intrinsicInvocation,
    interop.staticString,
    interop.isFreshObject,
    (node, path) => {
      writes.push({ node, path });
    },
    (node, invocation) => {
      if (t.isAwaitExpression(node)) {
        escapes.push({
          node,
          targets: [
            {
              target: node.argument,
              browserReceiver: false,
              projection: ["then"],
            },
          ],
        });
        return;
      }
      let caller: t.Function | undefined;
      for (
        let parent = hasDerivedConstructor
          ? state.parentsByNode.get(node)
          : undefined;
        parent !== undefined;
        parent = state.parentsByNode.get(parent)
      )
        if (t.isFunction(parent)) {
          caller = parent;
          break;
        }
      const targets: EscapeTarget[] = [];
      // Escaping objects can change contents without replacing their identity.
      const retainEscape = (
        target: t.Node,
        browserReceiver = false,
        receiver = false,
      ) => {
        targets.push({
          target,
          browserReceiver,
          ...(receiver && { receiver: true as const }),
        });
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
        retainEscape(callee.object, browserMethod !== undefined, true);
      }
      if (
        targets.length > 0 ||
        opaqueObserver !== undefined ||
        t.isArrowFunctionExpression(caller) ||
        (t.isClassMethod(caller) && derivedConstructors.has(caller))
      )
        escapes.push({
          node,
          invocation: true,
          ...(caller === undefined ? {} : { caller }),
          targets,
        });
    },
  );
  const pendingStores = new Set(storedReferences);
  const dependents = new WeakMap<t.Node, Set<SemanticIterationSource>>();
  while (pendingStores.size > 0) {
    const source = pendingStores.values().next().value;
    if (source === undefined) break;
    pendingStores.delete(source);
    if (source.target === undefined) continue;
    const identities = new Map<t.Node, AmbientProjection>();
    ambientWrites(source.target, source.mutation, false, [], (node, path) => {
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
  for (const { node, path } of writes) {
    const target =
      path[0] === "pending-target" ? targets[Number(path[1])] : undefined;
    const paths =
      target === undefined
        ? [path]
        : ambientWrites(target.node, target.capture).map((identity) => [
            ...identity,
            ...path.slice(2),
          ]);
    for (const resolved of paths) {
      state.ambientWrites.retain(resolved);
      state.ambientWriteEffects.push({ path: resolved, node });
      if (resolved[0] === "global")
        interop.retainWrite(node, ["intrinsic", ...resolved.slice(1)]);
    }
  }
  for (const source of storedReferences) {
    if (source.target === undefined) continue;
    let privateDestination = false;
    ambientWrites(
      source.target.object,
      source.mutation,
      false,
      [],
      undefined,
      (privateProof) => {
        privateDestination = privateProof;
      },
    );
    if (!privateDestination)
      escapes.push({
        node: source.mutation,
        targets: [
          {
            target: source.node,
            browserReceiver: false,
            projection: source.projection.map((key) =>
              key === null || typeof key === "object" ? null : String(key),
            ),
          },
        ],
      });
  }
  const invokedArrows = new WeakSet<t.ArrowFunctionExpression>();
  const resolvedCalls = new WeakSet<t.Node>();
  const callableIds = new WeakMap<t.Node, string>(
    hasDerivedConstructor
      ? [...state.callableNodesById].map(([id, node]) => [node, id])
      : [],
  );
  let changed = hasDerivedConstructor;
  while (changed) {
    changed = false;
    for (const { node, caller, targets } of escapes) {
      yield;
      if (
        (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
        resolvedCalls.has(node) ||
        (!(t.isClassMethod(caller) && derivedConstructors.has(caller)) &&
          !(t.isArrowFunctionExpression(caller) && invokedArrows.has(caller)))
      )
        continue;
      resolvedCalls.add(node);
      if (t.isSuper(node.callee)) {
        for (
          let parent: t.Node | undefined = caller;
          parent !== undefined;
          parent = state.parentsByNode.get(parent)
        ) {
          if (t.isArrowFunctionExpression(parent)) continue;
          if (!t.isFunction(parent)) continue;
          if (t.isClassMethod(parent) && parent.kind === "constructor") {
            const body = state.parentsByNode.get(parent);
            const owner =
              body === undefined ? undefined : state.parentsByNode.get(body);
            if (t.isClass(owner)) superConstructors.add(owner);
          }
          break;
        }
        continue;
      }
      for (const invocation of resolveJavaScriptIntrinsicInvocations(
        node,
        (target) => {
          const local: string[][] = [];
          ambientWrites(target, node, false, [], (identity, path) => {
            const id = callableIds.get(identity);
            if (
              t.isArrowFunctionExpression(identity) &&
              id !== undefined &&
              path !== undefined &&
              path.every((part) => part !== null)
            )
              local.push(["intrinsic", "local", id, ...(path as string[])]);
          });
          const intrinsic = interop.intrinsicPath(target);
          return [...local, ...(intrinsic === undefined ? [] : [intrinsic])];
        },
        () => [],
        interop.intrinsicReadChanged,
      )) {
        const target =
          invocation.path[1] === "local" && invocation.path.length === 3
            ? state.callableNodesById.get(invocation.path[2] ?? "")
            : undefined;
        if (t.isArrowFunctionExpression(target) && !invokedArrows.has(target)) {
          invokedArrows.add(target);
          changed = true;
        }
      }
      const handoffs = opaqueObserver?.invocationHandoffs?.(
        node,
        ambientWrites,
      );
      const activateEscapedArrow = (
        target: t.Node,
        projection: AmbientProjection,
      ): void => {
        ambientWrites(target, node, true, projection, (identity, path) => {
          if (
            t.isArrowFunctionExpression(identity) &&
            (path === undefined || path.length === 0) &&
            !invokedArrows.has(identity)
          ) {
            invokedArrows.add(identity);
            changed = true;
          }
        });
      };
      for (const target of handoffs?.targets ?? [])
        activateEscapedArrow(target.node, target.projection);
      if (
        javaScriptIntrinsicResultReference(
          interop.intrinsicInvocation(node),
        ) === undefined
      )
        for (const target of targets)
          if (
            handoffs?.coverage !== "all" &&
            (handoffs?.coverage !== "arguments" || target.receiver)
          )
            activateEscapedArrow(target.target, target.projection ?? []);
    }
    yield;
  }
  for (const { node, invocation, targets } of escapes) {
    const handledHandoffs =
      invocation && opaqueObserver?.observeInvocation(node, ambientWrites);
    if (
      invocation &&
      (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
      javaScriptIntrinsicResultReference(interop.intrinsicInvocation(node)) !==
        undefined
    )
      continue;
    for (const { target, browserReceiver, projection, receiver } of targets)
      for (const path of ambientWrites(target, node, true, projection)) {
        if (
          handledHandoffs !== "all" &&
          (handledHandoffs !== "arguments" || receiver)
        )
          opaqueObserver?.observeEscape?.(node, path);
        // Only proven browser APIs keep their global receiver from user code.
        if (!(browserReceiver && path.length === 1 && path[0] === "global"))
          state.ambientEscapes.retain([...path, null]);
      }
  }
  // A function may call a browser method replaced later in source order.
  if (
    [...browserReceiverMethods].some((method) =>
      state.ambientWrites.covers(["global", method]),
    )
  )
    state.ambientEscapes.retain(["global", null]);
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
