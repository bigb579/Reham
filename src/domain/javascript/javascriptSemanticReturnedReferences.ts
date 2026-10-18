import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  semanticCallableResultExpressions,
  type SemanticCallableResultExpression,
} from "./javascriptSemanticCallableResults.js";
import {
  semanticBindingAtRead,
  semanticEffectTiming,
  semanticLiteralActivationIsImmediate,
} from "./javascriptSemanticMutationInitializers.js";
import { delayedInstanceFieldValue } from "./javascriptSemanticEvaluationOrder.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface ValueSelection {
  readonly path: readonly (string | number | null)[];
  readonly instance?: true;
  /** Select this state from the result after resolving and invoking a callable. */
  readonly invocation?: ValueSelection;
}

interface Candidate extends ValueSelection {
  readonly node: t.Node;
  readonly initializers: ReadonlySet<JavaScriptSemanticInitializer>;
  readonly captures?: readonly t.Node[];
}

interface CallableReference {
  readonly node: t.Function | t.Class;
  readonly projection: readonly (string | number | null)[];
  readonly captures?: readonly t.Node[];
}

interface CallableReferenceSelection {
  readonly references: readonly CallableReference[];
  readonly complete: boolean;
}

interface CallableCaptureProofs {
  readonly bindingReadMayHaveChanged: (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
  ) => boolean;
  readonly ownSlotUnchanged: (
    owner: t.Node,
    key: string,
    read: t.Node,
  ) => boolean;
}

type InitializerContext = ReadonlySet<JavaScriptSemanticInitializer>;
type CompletedExpansions = WeakMap<
  t.Node,
  Map<string, readonly InitializerContext[]>
>;

interface ExpansionFrame {
  readonly item: Candidate;
  readonly node: t.Node;
  readonly pathKey: string;
  readonly parent: ExpansionFrame | null;
  readonly blockers: Set<JavaScriptSemanticInitializer>;
}

type ExpansionTask =
  | {
      readonly kind: "visit";
      readonly item: Candidate;
      readonly parent: ExpansionFrame | null;
    }
  | { readonly kind: "complete"; readonly frame: ExpansionFrame };

const contextContains = (
  context: InitializerContext,
  required: InitializerContext,
): boolean => {
  for (const initializer of required)
    if (!context.has(initializer)) return false;
  return true;
};

const propagateBlockers = (
  blockers: InitializerContext,
  parent: ExpansionFrame | null,
): void => {
  if (parent === null) return;
  for (const initializer of blockers)
    if (parent.item.initializers.has(initializer))
      parent.blockers.add(initializer);
};

const completeExpansion = (
  frame: ExpansionFrame,
  expanded: CompletedExpansions,
): void => {
  const paths =
    expanded.get(frame.node) ??
    new Map<string, readonly InitializerContext[]>();
  const contexts = paths.get(frame.pathKey) ?? [];
  const covered = contexts.find((context) =>
    contextContains(frame.blockers, context),
  );
  if (covered === undefined) {
    paths.set(frame.pathKey, [
      ...contexts.filter(
        (context) => !contextContains(context, frame.blockers),
      ),
      frame.blockers,
    ]);
    expanded.set(frame.node, paths);
  }
  propagateBlockers(covered ?? frame.blockers, frame.parent);
};

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

const callableInitializersAt = (
  node: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly initializers: readonly JavaScriptSemanticInitializer[];
  readonly definite: boolean;
} => {
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined) return { initializers: [], definite: false };
  const selected = semanticBindingAtRead(binding, node, state.parentsByNode);
  return {
    initializers: [
      ...selected.binding.initializers,
      ...selected.binding.referenceInitializers.filter(
        (initializer) =>
          !semanticReferenceSourcesInactive(initializer, state, "syntax-only"),
      ),
    ],
    definite:
      selected.hasDefiniteInitializer ||
      semanticStableInitializer(selected.binding, state) !== undefined,
  };
};

type ClassMember =
  | t.ClassMethod
  | t.ClassPrivateMethod
  | t.ClassProperty
  | t.ClassPrivateProperty
  | t.ClassAccessorProperty;
interface ClassTargetMember {
  readonly node: ClassMember;
  readonly key:
    | { readonly kind: "public"; readonly name: string | null }
    | {
        readonly kind: "private";
        readonly name: string;
        readonly declaration: t.PrivateName;
      };
  readonly kind: "method" | "get" | "set" | "accessor" | "field";
  readonly value: t.Node | null;
  readonly static: boolean;
  readonly decorated: boolean;
}
type ClassMemberLayer = "static" | "prototype" | "fields";
interface ClassTargetIndex {
  readonly static: readonly ClassTargetMember[];
  readonly prototype: readonly ClassTargetMember[];
  readonly fields: readonly ClassTargetMember[];
  readonly privateByName: ReadonlyMap<string, readonly ClassTargetMember[]>;
  readonly staticEvaluationOrder: ReadonlyMap<t.Node, number>;
  readonly constructorMethod?: t.ClassMethod;
}
interface ClassLineage {
  readonly classes: readonly t.Class[];
  readonly unknownBase?: t.Node;
}

/** Only a complete, unprojected local capture proves one superclass identity. */
const definiteClassAt = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  let node = unwrapJavaScriptExpression(expression).node;
  const seen = new Set<JavaScriptSemanticInitializer>();
  while (t.isIdentifier(node)) {
    const selected = callableInitializersAt(node, state);
    const initializer = selected.initializers[0];
    if (
      !selected.definite ||
      selected.initializers.length !== 1 ||
      initializer === undefined ||
      initializer.projection.length > 0 ||
      seen.has(initializer)
    )
      return undefined;
    seen.add(initializer);
    node = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isClass(node) ? node : undefined;
};

const classLineage = (
  node: t.Class,
  state: JavaScriptSemanticAnalysisState,
  cache: WeakMap<t.Class, ClassLineage>,
): ClassLineage => {
  const prior = cache.get(node);
  if (prior !== undefined) return prior;
  const classes = [node];
  const seen = new Set<t.Class>(classes);
  let current = node;
  let unknownBase: t.Node | undefined;
  while (current.superClass != null) {
    const base = definiteClassAt(current.superClass, state);
    if (base === undefined) {
      unknownBase = current.superClass;
      break;
    }
    if (seen.has(base)) break;
    seen.add(base);
    classes.push(base);
    current = base;
  }
  const result = {
    classes,
    ...(unknownBase === undefined ? {} : { unknownBase }),
  };
  cache.set(node, result);
  return result;
};

/** Methods/accessors form descriptors; fields initialize afterward. */
const classTargetIndex = (
  node: t.Class,
  cache: WeakMap<t.Class, ClassTargetIndex>,
): ClassTargetIndex => {
  const prior = cache.get(node);
  if (prior !== undefined) return prior;
  const descriptors: ClassTargetMember[] = [];
  const fields: ClassTargetMember[] = [];
  const privateByName = new Map<string, ClassTargetMember[]>();
  const staticEvaluationOrder = new Map<t.Node, number>();
  let constructor: t.ClassMethod | undefined;
  for (const [position, member] of node.body.body.entries()) {
    if (t.isStaticBlock(member)) {
      staticEvaluationOrder.set(member, position);
      continue;
    }
    if (t.isClassMethod(member, { kind: "constructor" })) {
      constructor = member;
      continue;
    }
    if (
      !t.isClassMethod(member) &&
      !t.isClassPrivateMethod(member) &&
      !t.isClassProperty(member) &&
      !t.isClassPrivateProperty(member) &&
      !t.isClassAccessorProperty(member)
    )
      continue;
    const target = classMemberTarget(member);
    if (
      target.static &&
      (target.kind === "field" || target.kind === "accessor")
    )
      staticEvaluationOrder.set(member, position);
    (target.kind === "field" ? fields : descriptors).push(target);
    if (target.key.kind === "private") {
      const named = privateByName.get(target.key.name) ?? [];
      named.push(target);
      privateByName.set(target.key.name, named);
    }
  }
  const result = {
    static: [
      ...descriptors.filter((member) => member.static),
      ...fields.filter((member) => member.static),
    ],
    prototype: descriptors.filter((member) => !member.static),
    fields: fields.filter((member) => !member.static),
    privateByName,
    staticEvaluationOrder,
    ...(constructor === undefined ? {} : { constructorMethod: constructor }),
  };
  cache.set(node, result);
  return result;
};

const classMemberTarget = (member: ClassMember): ClassTargetMember => {
  const method = t.isClassMethod(member) || t.isClassPrivateMethod(member);
  return {
    node: member,
    key: t.isPrivateName(member.key)
      ? {
          kind: "private",
          name: member.key.id.name,
          declaration: member.key,
        }
      : {
          kind: "public",
          name: semanticStaticPropertyKey(
            member.key,
            "computed" in member && member.computed,
          ),
        },
    kind: method
      ? member.kind === "get" || member.kind === "set"
        ? member.kind
        : "method"
      : t.isClassAccessorProperty(member)
        ? "accessor"
        : "field",
    value: method ? member : (member.value ?? null),
    static: member.static === true,
    decorated: (member.decorators?.length ?? 0) > 0,
  };
};

/** Private lookup selects a lexical declaration, never a public property path. */
export const createSemanticPrivateMemberTargets = (
  state: JavaScriptSemanticAnalysisState,
  indexes = new WeakMap<t.Class, ClassTargetIndex>(),
) => {
  const resolved = new WeakMap<
    t.PrivateName,
    {
      readonly owner: t.Class;
      readonly members: readonly ClassTargetMember[];
      readonly lineage: ClassLineage;
    }
  >();
  const lineages = new WeakMap<t.Class, ClassLineage>();
  return (name: t.PrivateName) => {
    const prior = resolved.get(name);
    if (prior !== undefined) return prior;
    let child: t.Node = name;
    for (
      let parent = state.parentsByNode.get(child);
      parent !== undefined;
      parent = state.parentsByNode.get(child)
    ) {
      if (t.isClass(parent) && parent.body === child) {
        const members = classTargetIndex(parent, indexes).privateByName.get(
          name.id.name,
        );
        if (members !== undefined) {
          const declaration = {
            owner: parent,
            members,
            lineage: classLineage(parent, state, lineages),
          };
          resolved.set(name, declaration);
          return declaration;
        }
      }
      child = parent;
    }
    return undefined;
  };
};

const selectPrivateTargets = (
  members: readonly ClassTargetMember[],
  item: Candidate,
  path: Candidate["path"],
  pending: Candidate[],
): void => {
  for (const member of members) {
    if (member.value === null || member.kind === "set") continue;
    if (member.kind === "get") {
      // The read invokes the getter; a following call invokes its result.
      pending.push({
        node: member.value,
        path: [],
        initializers: item.initializers,
        invocation: {
          path,
          ...(item.instance === true ? { instance: true } : {}),
          ...(item.invocation === undefined
            ? {}
            : { invocation: item.invocation }),
        },
      });
    } else pending.push({ ...item, node: member.value, path });
  }
};

const selectClassTargets = (
  members: readonly ClassTargetMember[],
  key: string | number | null | undefined,
  definitelyPresent: (member: ClassTargetMember) => boolean = () => true,
): {
  readonly values: readonly t.Node[];
  readonly members: readonly ClassTargetMember[];
  readonly own: boolean;
} => {
  const values: t.Node[] = [];
  const selected: ClassTargetMember[] = [];
  let own = false;
  let setter = false;
  for (const member of members.toReversed()) {
    if (member.key.kind === "private") continue;
    const name = member.key.name;
    if (key != null && name !== null && name !== String(key)) continue;
    const exact = key != null && name === String(key);
    const definite = exact && definitelyPresent(member);
    if (definite) own = true;
    if (member.kind === "set") {
      selected.push(member);
      if (definite) setter = true;
      continue;
    }
    // A setter pairs with an earlier getter, but replaces an earlier data slot.
    if (
      definite &&
      setter &&
      member.kind !== "get" &&
      member.kind !== "accessor"
    )
      break;
    const value = member.value;
    selected.push(member);
    if (value != null) values.push(value);
    if (definite) break;
  }
  return { values, members: selected, own };
};

/** Class descriptors exist before static initialization; fields do not. */
export const createSemanticStaticClassSlotReferences = (
  state: JavaScriptSemanticAnalysisState,
  isFreshObject: (node: t.Node) => boolean,
) => {
  const indexes = new WeakMap<t.Class, ClassTargetIndex>();
  const lineages = new WeakMap<t.Class, ClassLineage>();
  return (owner: t.Class, key: string, read: t.Node | undefined) => {
    const owners: t.Class[] = [];
    const values: t.Node[] = [];
    let own = false;
    let local = true;
    for (const declaring of classLineage(owner, state, lineages).classes) {
      owners.push(declaring);
      const index = classTargetIndex(declaring, indexes);
      let current = read;
      let child: t.Node | undefined;
      let deferred = false;
      while (
        current !== undefined &&
        state.parentsByNode.get(current) !== declaring.body
      ) {
        if (
          t.isFunction(current) &&
          (current.body === child ||
            current.params.some((parameter) => parameter === child)) &&
          !semanticLiteralActivationIsImmediate(current, state.parentsByNode)
        )
          deferred = true;
        if (delayedInstanceFieldValue(current, child)) {
          const body = state.parentsByNode.get(current);
          const owner =
            body === undefined ? undefined : state.parentsByNode.get(body);
          if (
            !t.isClass(owner) ||
            !semanticLiteralActivationIsImmediate(owner, state.parentsByNode)
          )
            deferred = true;
        }
        child = current;
        current = state.parentsByNode.get(current);
      }
      const position =
        current === undefined
          ? undefined
          : index.staticEvaluationOrder.get(current);
      const completed =
        read !== undefined &&
        semanticEffectTiming(read, declaring, state) === "before";
      const initialized = (member: ClassTargetMember): boolean | undefined => {
        if (member.kind !== "field" && member.kind !== "accessor") return true;
        if (position !== undefined) {
          if (
            (index.staticEvaluationOrder.get(member.node) ?? Infinity) <
            position
          )
            return true;
          // A deferred body can run after later fields initialize. Its
          // creation position is only an earliest activation bound.
          return deferred ? undefined : false;
        }
        return completed ? true : undefined;
      };
      const selected = selectClassTargets(
        index.static.filter((member) => initialized(member) !== false),
        key,
        (member) => initialized(member) === true,
      );
      for (const member of selected.members)
        if (member.kind === "get" && t.isFunction(member.value)) {
          for (const { node } of semanticCallableResultExpressions(
            member.value,
          ))
            if (node !== null) values.push(node);
        } else if (member.kind !== "set" && member.value !== null)
          values.push(member.value);
      local &&=
        !declaring.decorators?.length &&
        selected.members.every(
          (member) =>
            member.key.kind === "public" &&
            member.key.name === key &&
            !member.decorated &&
            member.kind !== "get" &&
            (member.kind === "set" ||
              member.value === null ||
              isFreshObject(member.value)),
        );
      if (selected.own) {
        own = true;
        break;
      }
      // A source binding alone does not prove that the runtime superclass
      // still names this declaration; reuse the completed fresh-value proof.
      if (declaring.superClass != null && !isFreshObject(declaring.superClass))
        local = false;
    }
    return {
      own,
      ownLocal: own && local,
      values,
      owners,
      inherited: owner.superClass,
    };
  };
};

const constructorReplacesReceiver = (
  constructor: t.ClassMethod | undefined,
  results: readonly SemanticCallableResultExpression[],
  isDefinitelyObject: (node: t.Node) => boolean,
): boolean => {
  const result = results[0];
  return (
    constructor !== undefined &&
    results.length === 1 &&
    result !== undefined &&
    constructor.body.body.some((statement) => statement === result.site) &&
    result.node !== null &&
    isDefinitelyObject(result.node)
  );
};

/** Resolve possible local callable identities without claiming call execution. */
const createSemanticCallableReferences = (
  state: JavaScriptSemanticAnalysisState,
  mode: "callable" | "contents" | "function-values" | "results",
  definiteObjectProof?: (node: t.Node) => boolean,
  captureProofs?: CallableCaptureProofs,
): ((
  callee: t.Node,
  projection?: readonly (string | number | null)[],
) => CallableReferenceSelection) => {
  let results = new WeakMap<t.Node, Map<string, CallableReferenceSelection>>();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  const classTargets = new WeakMap<t.Class, ClassTargetIndex>();
  const privateTargets = createSemanticPrivateMemberTargets(
    state,
    classTargets,
  );
  const classLineages = new WeakMap<t.Class, ClassLineage>();
  const interop = createSemanticModuleInterop(state);
  const isDefinitelyObject = definiteObjectProof ?? interop.isDefinitelyObject;
  const captureIds = new WeakMap<t.Node, number>();
  let nextCaptureId = 0;
  const captureKey = (captures?: readonly t.Node[]) =>
    captures?.map((node) => {
      let id = captureIds.get(node);
      if (id === undefined) {
        id = nextCaptureId++;
        captureIds.set(node, id);
      }
      return id;
    });
  let factsReady = semanticFreshObjectFactsReady(state);
  return (callee, projection = []) => {
    const ready = semanticFreshObjectFactsReady(state);
    if (factsReady !== ready) {
      // Provisional global-binding uncertainty is not a final result fact.
      factsReady = ready;
      results = new WeakMap();
    }
    const projectionKey = JSON.stringify(projection);
    const existing = results.get(callee)?.get(projectionKey);
    if (existing !== undefined) return existing;
    let complete = true;
    const functions = new Map<
      t.Function | t.Class,
      Map<string, CallableReference>
    >();
    const retain = (
      node: t.Function | t.Class,
      path: Candidate["path"],
      captures?: readonly t.Node[],
    ) => {
      const paths = functions.get(node) ?? new Map();
      paths.set(
        JSON.stringify(
          captureProofs === undefined ? path : [path, captureKey(captures)],
        ),
        {
          node,
          projection: path,
          ...(captures === undefined ? {} : { captures }),
        },
      );
      functions.set(node, paths);
    };
    const work: ExpansionTask[] = [
      {
        kind: "visit",
        item: {
          node: callee,
          path: projection,
          initializers: new Set(),
          ...(captureProofs === undefined
            ? {}
            : { captures: projection.map(() => callee) }),
        },
        parent: null,
      },
    ];
    // Finish descendants before memoizing an expansion. Only actual external
    // cycle blockers affect reuse; branch history is not a dependency. An
    // acyclic expression/path is consequently expanded once across a diamond.
    const expanded: CompletedExpansions = new WeakMap();
    while (work.length > 0) {
      const task = work.pop();
      if (task === undefined) break;
      if (task.kind === "complete") {
        completeExpansion(task.frame, expanded);
        continue;
      }
      const { item, parent } = task;
      const node = unwrapJavaScriptExpression(item.node).node;
      const pathKey = JSON.stringify([
        item.instance === true,
        item.path,
        item.invocation,
        ...(captureProofs === undefined ? [] : [captureKey(item.captures)]),
      ]);
      const covered = expanded
        .get(node)
        ?.get(pathKey)
        ?.find((context) => contextContains(item.initializers, context));
      if (covered !== undefined) {
        // Cached cycle dependencies must reach the caller's proof too.
        propagateBlockers(covered, parent);
        continue;
      }
      const frame: ExpansionFrame = {
        item,
        node,
        pathKey,
        parent,
        blockers: new Set(),
      };
      work.push({ kind: "complete", frame });
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        const selected = callableInitializersAt(node, state);
        if (captureProofs !== undefined) {
          const binding = resolveSemanticBindingState(state, node, node.name);
          complete &&=
            binding !== undefined &&
            selected.definite &&
            !captureProofs.bindingReadMayHaveChanged(binding, node) &&
            selected.initializers.every(
              ({ node: value }) =>
                t.isFunctionDeclaration(value) ||
                (value.end ?? Infinity) < (node.start ?? -1),
            );
        }
        for (const initializer of selected.initializers) {
          if (item.initializers.has(initializer)) {
            complete = false;
            frame.blockers.add(initializer);
            continue;
          }
          pending.push({
            ...item,
            node: initializer.node,
            path: [...initializer.projection, ...item.path],
            ...(item.captures === undefined
              ? {}
              : {
                  captures: [
                    ...initializer.projection.map(() => initializer.node),
                    ...item.captures,
                  ],
                }),
            initializers: new Set([...item.initializers, initializer]),
          });
        }
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        let privateRead = false;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          if (t.isPrivateName(receiver.property)) {
            privateRead = true;
            const declaration = privateTargets(receiver.property);
            selectPrivateTargets(
              declaration?.members ?? [],
              item,
              [...path.reverse(), ...item.path],
              pending,
            );
            break;
          }
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        if (!privateRead)
          pending.push({
            ...item,
            node: receiver,
            path: [...path.reverse(), ...item.path],
            ...(item.captures === undefined
              ? {}
              : { captures: [...path.map(() => node), ...item.captures] }),
          });
        if (captureProofs !== undefined && (privateRead || path.includes(null)))
          complete = false;
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...item, node: last });
      } else if (t.isAssignmentExpression(node, { operator: "=" })) {
        pending.push({ ...item, node: node.right });
      } else if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        complete = false;
        const invocation = interop.intrinsicInvocation(node);
        const target = invocation?.arguments?.[0];
        if (
          invocation?.path.join(".") === "intrinsic.Reflect.construct" &&
          t.isExpression(target)
        ) {
          // Nominal intrinsic selection adds possible result contents only.
          // It cannot establish helper integrity or a strict receiver proof.
          pending.push({ ...item, node: target, instance: true });
        } else {
          pending.push({
            node: node.callee,
            path: [],
            initializers: item.initializers,
            invocation: {
              path: item.path,
              ...(item.instance === true ? { instance: true } : {}),
              ...(item.invocation === undefined
                ? {}
                : { invocation: item.invocation }),
            },
          });
        }
      } else if (t.isFunction(node) && item.instance === true) {
        // An ordinary constructor's new object is distinct from the callable.
        // Only an explicit returned value can supply a callable result here.
        for (const result of semanticCallableResultExpressions(node))
          if (result.node !== null)
            pending.push({
              node: result.node,
              path: item.path,
              initializers: item.initializers,
              ...(item.invocation === undefined
                ? {}
                : { invocation: item.invocation }),
            });
      } else if (
        t.isFunction(node) &&
        item.path.length === 0 &&
        item.invocation !== undefined
      ) {
        for (const result of semanticCallableResultExpressions(node))
          if (result.node !== null)
            pending.push({
              ...item.invocation,
              node: result.node,
              initializers: item.initializers,
            });
      } else if (
        mode === "function-values" &&
        (t.isObjectMethod(node) || t.isClassMethod(node)) &&
        (node.kind === "get" || node.kind === "set")
      ) {
        // A property read selects an accessor's result, not its function.
        complete = false;
        if (node.kind === "get")
          for (const result of semanticCallableResultExpressions(node))
            if (result.node !== null)
              pending.push({
                node: result.node,
                path: item.path,
                initializers: item.initializers,
              });
      } else if (
        t.isFunction(node) &&
        item.invocation === undefined &&
        (item.path.length === 0 || mode === "function-values")
      ) {
        if (item.path.includes(null)) complete = false;
        retain(node, item.path, item.captures);
      } else if (
        t.isObjectExpression(node) &&
        (item.path.length > 0 || mode === "contents")
      ) {
        if (captureProofs !== undefined) {
          const key = item.path[0];
          const index = objectTargetIndex(node, objectTargets);
          const property =
            key == null ? undefined : index.propertyByName.get(String(key));
          complete &&=
            property !== undefined &&
            t.isObjectProperty(property) &&
            !index.trailingUnknownsByProperty.has(property) &&
            captureProofs.ownSlotUnchanged(
              node,
              String(key),
              item.captures?.[0] ?? callee,
            );
        }
        selectObjectTargets(node, item, pending, objectTargets);
      } else if (
        t.isArrayExpression(node) &&
        (item.path.length > 0 || mode === "contents")
      ) {
        const [key, ...path] = item.path;
        const index =
          key === undefined || key === null ? null : semanticArrayIndex(key);
        let uncertainOffset = false;
        let selectedOwn = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...item,
              node: element.argument,
              path: [null, ...path],
            });
          } else if (index === null || uncertainOffset || index === offset) {
            selectedOwn ||= index === offset && !uncertainOffset;
            pending.push({
              ...item,
              node: element,
              path,
              ...(item.captures === undefined
                ? {}
                : { captures: item.captures.slice(1) }),
            });
          }
        });
        if (captureProofs !== undefined)
          complete &&=
            selectedOwn &&
            index !== null &&
            captureProofs.ownSlotUnchanged(
              node,
              String(index),
              item.captures?.[0] ?? callee,
            );
      } else if (t.isNewExpression(node)) {
        complete = false;
        pending.push({ ...item, node: node.callee, instance: true });
      } else if (t.isClass(node)) {
        complete = false;
        const prototype = item.path[0] === "prototype";
        const [key, ...path] = prototype ? item.path.slice(1) : item.path;
        const lineage = classLineage(node, state, classLineages);
        const value = (node: t.Node, path: Candidate["path"]) =>
          pending.push({
            node,
            path,
            initializers: item.initializers,
            ...(item.invocation === undefined
              ? {}
              : { invocation: item.invocation }),
          });
        const select = (layer: ClassMemberLayer): boolean => {
          for (const owner of lineage.classes) {
            const selected = selectClassTargets(
              classTargetIndex(owner, classTargets)[layer],
              key,
            );
            for (const selectedValue of selected.values)
              value(selectedValue, path);
            if (selected.own) return true;
          }
          return false;
        };
        if (
          mode === "function-values" &&
          item.instance !== true &&
          !prototype &&
          key === undefined
        )
          retain(node, []);
        else if (mode === "contents" && key === undefined) {
          for (const owner of lineage.classes) {
            const index = classTargetIndex(owner, classTargets);
            for (const member of [
              ...index.static,
              ...index.prototype,
              ...index.fields,
            ]) {
              if (member.key.kind === "private") continue;
              const selected = member.value;
              if (selected != null) value(selected, []);
            }
          }
        } else if (item.instance === true && !prototype) {
          const constructor = classTargetIndex(
            node,
            classTargets,
          ).constructorMethod;
          const results =
            constructor === undefined
              ? []
              : semanticCallableResultExpressions(constructor);
          for (const result of results)
            if (result.node !== null) value(result.node, item.path);
          const replaced = constructorReplacesReceiver(
            constructor,
            results,
            isDefinitelyObject,
          );
          if (!replaced && key !== undefined) {
            // Every inherited field is an own slot on the new object, so base
            // fields precede even a derived prototype method or accessor.
            if (!select("fields")) {
              select("prototype");
              if (lineage.unknownBase !== undefined)
                pending.push({ ...item, node: lineage.unknownBase });
            }
          }
        } else if (key === undefined) {
          if (!prototype) {
            let followBaseResults = mode === "results";
            for (const owner of lineage.classes) {
              const constructor = classTargetIndex(
                owner,
                classTargets,
              ).constructorMethod;
              if (constructor === undefined) continue;
              value(constructor, []);
              // Invocation selects the first constructor, but normal derived
              // completion preserves the object supplied by super(). Only a
              // definite replacement can hide a possible inherited result.
              if (!followBaseResults) break;
              if (
                constructorReplacesReceiver(
                  constructor,
                  semanticCallableResultExpressions(constructor),
                  isDefinitelyObject,
                )
              ) {
                followBaseResults = false;
                break;
              }
            }
            if (followBaseResults && lineage.unknownBase !== undefined)
              pending.push({ ...item, node: lineage.unknownBase });
          }
        } else if (!select(prototype ? "prototype" : "static")) {
          if (!prototype && key === "__proto__" && node.superClass != null)
            pending.push({ ...item, node: node.superClass, path });
          else if (lineage.unknownBase !== undefined)
            pending.push({ ...item, node: lineage.unknownBase });
          if (
            mode === "function-values" &&
            !prototype &&
            !(key === "__proto__" && node.superClass != null)
          )
            retain(node, item.path);
        }
      } else complete = false;
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          work.push({ kind: "visit", item: child, parent: frame });
      }
    }
    const references = [...functions.values()].flatMap((paths) => [
      ...paths.values(),
    ]);
    const output = { references, complete };
    const byProjection = results.get(callee) ?? new Map();
    byProjection.set(projectionKey, output);
    results.set(callee, byProjection);
    return output;
  };
};

/** Resolve call targets, without retaining properties of their function values. */
export const createSemanticCallableTargets = (
  state: JavaScriptSemanticAnalysisState,
  mode: "callable" | "contents" = "callable",
  isDefinitelyObject?: (node: t.Node) => boolean,
) => {
  const references = createSemanticCallableReferences(
    state,
    mode,
    isDefinitelyObject,
  );
  return (callee: t.Node): readonly t.Function[] =>
    references(callee).references.flatMap(({ node }) =>
      t.isFunction(node) ? [node] : [],
    );
};

/** Select a callable once and leave its remaining value projection to its owner. */
export const createSemanticFunctionValueReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
) => {
  const references = createSemanticCallableReferences(
    state,
    "function-values",
    isDefinitelyObject,
  );
  return (callee: t.Node, projection?: readonly (string | number | null)[]) =>
    references(callee, projection).references;
};

/** Opt-in exact capture proof; possible-target consumers retain incomplete selections. */
export const createSemanticFunctionValueCapture = (
  state: JavaScriptSemanticAnalysisState,
  proofs: CallableCaptureProofs,
) => {
  const references = createSemanticCallableReferences(
    state,
    "function-values",
    undefined,
    proofs,
  );
  return (
    callee: t.Node,
    projection?: readonly (string | number | null)[],
  ): CallableReference | undefined => {
    const selected = references(callee, projection);
    return selected.complete && selected.references.length === 1
      ? selected.references[0]
      : undefined;
  };
};

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
): ((callee: t.Node) => readonly SemanticReturnedReference[]) => {
  const targets = createSemanticCallableReferences(
    state,
    "results",
    isDefinitelyObject,
  );
  let results = new WeakMap<t.Node, readonly SemanticReturnedReference[]>();
  let factsReady = semanticFreshObjectFactsReady(state);
  return (callee) => {
    const ready = semanticFreshObjectFactsReady(state);
    if (factsReady !== ready) {
      factsReady = ready;
      results = new WeakMap();
    }
    const prior = results.get(callee);
    if (prior !== undefined) return prior;
    const references = targets(callee).references.flatMap(
      ({ node: callable }) =>
        semanticCallableResultExpressions(callable).flatMap(
          ({ node, delegated }) =>
            node === null
              ? []
              : [{ node, projection: delegated ? [null] : [] }],
        ),
    );
    results.set(callee, references);
    return references;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): void => {
  const [key, ...path] = item.path;
  const selected = {
    path,
    ...(item.captures === undefined
      ? {}
      : { captures: item.captures.slice(1) }),
  };
  if (key !== null && key !== undefined) {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : selected),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        ...selected,
      });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, ...selected });
    else pending.push({ ...item, node: property, ...selected });
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
