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
  createSemanticCallableTargets,
  createSemanticFunctionValueCapture,
  createSemanticPrivateMemberTargets,
  createSemanticReturnedReferences,
} from "./javascriptSemanticReturnedReferences.js";
import { semanticAmbientOwnSlotUnchanged } from "./javascriptSemanticAmbientWrites.js";
import {
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  semanticStrictContext,
  type SemanticGlobalBindingFacts,
} from "./javascriptSemanticOpaqueEffects.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { javaScriptRuntimeContext } from "./javascriptSourceParser.js";

/** Expressions that can supply a receiver; the Program denotes the global object. */
const receiverQueries = new WeakMap<
  JavaScriptSemanticAnalysisState,
  (node: t.ThisExpression) => readonly t.Node[]
>();

/** Possible receiver identity is shared by all ambient-write consumers. */
export const createSemanticReceiverReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
  intrinsicWriteFacts?: SemanticGlobalBindingFacts,
) => {
  const customContext =
    isDefinitelyObject !== undefined || intrinsicWriteFacts !== undefined;
  const prior = customContext ? undefined : receiverQueries.get(state);
  if (prior !== undefined) return prior;
  const owners = new WeakMap<t.Node, t.Node>();
  const lexicalOwner = (node: t.Node): t.Node => {
    const visited: t.Node[] = [];
    let current = node;
    let owner: t.Node = state.program;
    for (;;) {
      const cached = owners.get(current);
      if (cached !== undefined) {
        owner = cached;
        break;
      }
      visited.push(current);
      let parent = state.parentsByNode.get(current);
      if (parent === undefined) break;
      // Parameter decorators can sit below patterns and TSParameterProperty.
      // Their expressions execute outside the decorated function or class.
      if (t.isDecorator(current)) {
        while (
          parent !== undefined &&
          !t.isFunction(parent) &&
          !t.isClass(parent) &&
          !t.isClassProperty(parent) &&
          !t.isClassPrivateProperty(parent) &&
          !t.isClassAccessorProperty(parent)
        )
          parent = state.parentsByNode.get(parent);
        current = parent ?? state.program;
        continue;
      }
      if (
        (t.isFunction(parent) &&
          !t.isArrowFunctionExpression(parent) &&
          !(
            (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
            parent.computed &&
            parent.key === current
          )) ||
        t.isStaticBlock(parent) ||
        ((t.isClassProperty(parent) ||
          t.isClassPrivateProperty(parent) ||
          t.isClassAccessorProperty(parent)) &&
          parent.value === current)
      ) {
        owner = parent;
        break;
      }
      current = parent;
    }
    for (const visitedNode of visited) owners.set(visitedNode, owner);
    return owner;
  };
  let receivers: WeakMap<t.Function, Set<t.Node>> | undefined;
  let factsReady = semanticFreshObjectFactsReady(state);
  const indexReceivers = () => {
    const indexed = new WeakMap<t.Function, Set<t.Node>>();
    receivers = indexed;
    const targets = createSemanticCallableTargets(
      state,
      "callable",
      isDefinitelyObject,
    );
    const contents = createSemanticCallableTargets(
      state,
      "contents",
      isDefinitelyObject,
    );
    const inactiveDefaults = new WeakSet<t.Node>();
    const defaultSources = new Map<
      t.AssignmentPattern,
      Set<JavaScriptSemanticInitializer>
    >();
    for (const binding of state.bindingsById.values())
      for (const reference of binding.referenceInitializers)
        for (const source of reference.fallbackSources ?? []) {
          if (source.selection === undefined) continue;
          const sources = defaultSources.get(source.selection) ?? new Set();
          sources.add(source);
          defaultSources.set(source.selection, sources);
        }
    // Nested patterns can select from the original input or an outer default.
    // The expression is inactive only when every retained input excludes it.
    for (const [selection, sources] of defaultSources)
      if (
        [...sources].every((source) =>
          semanticReferenceSourcesInactive(
            { fallbackSources: [source] },
            state,
            "syntax-only",
          ),
        )
      )
        inactiveDefaults.add(selection.right);
    const intrinsics = createSemanticModuleInterop(state);
    const definiteObject = isDefinitelyObject ?? intrinsics.isDefinitelyObject;
    const receiverObjects =
      intrinsicWriteFacts === undefined
        ? intrinsics
        : createSemanticModuleInterop(state, {
            intrinsicPath: intrinsics.intrinsicPath,
            bindingReadMayHaveChanged: (binding, read) =>
              semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
              semanticGlobalBindingReadMayHaveChanged(
                binding,
                read,
                state,
                intrinsicWriteFacts,
              ),
          });
    const privateTargets = createSemanticPrivateMemberTargets(state);
    const groups = new Map<
      string,
      { node: t.Node; targets: readonly t.Function[] }
    >();
    const paths = new WeakMap<t.Node, readonly string[]>();
    const covered = new WeakSet<t.Node>();
    const localPath = (node: t.Node): readonly string[] | undefined => {
      const current = unwrapJavaScriptExpression(node).node;
      const cached = paths.get(current);
      if (cached !== undefined) return cached;
      const functions = targets(current);
      if (functions.length > 0) {
        const id = String(groups.size);
        groups.set(id, { node: current, targets: functions });
        const path = ["intrinsic", "local-receiver", id];
        paths.set(current, path);
        return path;
      }
      if (
        t.isMemberExpression(current) ||
        t.isOptionalMemberExpression(current)
      ) {
        const key = semanticStaticPropertyKey(
          current.property,
          current.computed,
        );
        if (key === "call" || key === "apply" || key === "bind") {
          const path = localPath(current.object);
          if (path !== undefined) return [...path, key];
        }
      }
      return intrinsics.intrinsicPath(current);
    };
    const invocationFacts = intrinsicWriteFacts ?? {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      opaqueGlobalSites: state.opaqueEffects.globalSites,
      get complete() {
        return semanticFreshObjectFactsReady(state);
      },
    };
    const sourceCapture = createSemanticFunctionValueCapture(state, {
      bindingReadMayHaveChanged: (binding, read) =>
        invocationFacts.complete !== true ||
        semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
        semanticGlobalBindingReadMayHaveChanged(
          binding,
          read,
          state,
          invocationFacts,
        ),
      ownSlotUnchanged: (owner, key, read) =>
        semanticAmbientOwnSlotUnchanged(state, owner, key, read),
    });
    const invocations = createSemanticModuleInterop(state, {
      intrinsicPath: localPath,
      boundFunctionWriteFacts: invocationFacts,
      sourceFunctionCapture: sourceCapture,
    });
    // Only the ambient owner can supply complete canonical mutation facts.
    // Provisional queries retain uncertainty until that snapshot is available.
    const constructionInvocations = createSemanticModuleInterop(state, {
      intrinsicPath: intrinsics.intrinsicPath,
      intrinsicWriteFacts: invocationFacts,
    });
    const retain = (target: t.Function, receiver?: t.Node) => {
      const values = indexed.get(target) ?? new Set<t.Node>();
      if (receiver !== undefined) values.add(receiver);
      indexed.set(target, values);
    };
    const privateReceivers = (
      name: t.PrivateName,
    ): readonly t.Node[] | undefined => {
      const declaration = privateTargets(name);
      if (declaration === undefined) return undefined;
      const values = new Set<t.Node>();
      if (declaration.members.some((member) => member.static))
        values.add(declaration.owner);
      if (declaration.members.some((member) => !member.static)) {
        // A successful private lookup checks the declaring class's brand. Its
        // instance starts fresh unless super() supplies an existing object.
        // Unknown bases and returned values cannot prove global exclusion.
        const inherited =
          declaration.owner.superClass == null
            ? []
            : returned(declaration.owner.superClass).map(({ node }) => node);
        for (const node of inherited) values.add(node);
        if (
          declaration.lineage.unknownBase !== undefined ||
          declaration.lineage.classes.some(
            (owner) =>
              owner.superClass != null &&
              !receiverObjects.isFreshObject(owner.superClass),
          ) ||
          inherited.some((node) => !receiverObjects.isFreshObject(node))
        )
          values.add(state.program);
      }
      return [...values];
    };
    const retainPrivate = (target: t.Function, values: readonly t.Node[]) => {
      retain(target);
      for (const receiver of values) retain(target, receiver);
    };
    const construct = (callee: t.Node) => {
      // An explicit returned object does not replace the fresh receiver used
      // inside a base constructor.
      for (const target of targets(callee)) retain(target);
      covered.add(callee);
    };
    traverseJavaScriptAst(state.program, {
      skip: (node) => inactiveDefaults.has(node),
      enter: (node) => {
        if (t.isPrivateName(node)) {
          // A decorator can expose the original callable even when the private
          // slot itself never leaves the class's lexical scope.
          for (const member of privateTargets(node)?.members ?? [])
            if (
              member.key.kind === "private" &&
              member.key.declaration === node &&
              member.decorated &&
              member.value !== null
            )
              for (const target of contents(member.value))
                retain(target, state.program);
        }
        if (
          (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
          t.isPrivateName(node.property)
        ) {
          const declaration = privateTargets(node.property);
          const values = privateReceivers(node.property);
          const parent = state.parentsByNode.get(node);
          const assignment =
            t.isAssignmentExpression(parent) && parent.left === node;
          const update =
            t.isUpdateExpression(parent) && parent.argument === node;
          for (const member of declaration?.members ?? []) {
            if (
              values !== undefined &&
              t.isFunction(member.value) &&
              ((member.kind === "get" &&
                (!assignment || parent.operator !== "=")) ||
                (member.kind === "set" && (assignment || update)))
            )
              retainPrivate(member.value, values);
          }
        }
        if (t.isNewExpression(node)) {
          construct(node.callee);
          return;
        }
        if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
          return;
        let invocation = invocations.intrinsicInvocation(node);
        if (invocation?.path.join(".") === "intrinsic.Reflect.construct")
          invocation = constructionInvocations.intrinsicInvocation(node);
        if (
          invocation?.kind === "known" &&
          invocation.path.join(".") === "intrinsic.Reflect.construct"
        ) {
          const target = invocation.arguments?.[0];
          if (t.isExpression(target)) construct(target);
          return;
        }
        if (
          invocation?.path.length !== 3 ||
          invocation.path[1] !== "local-receiver"
        )
          return;
        const group = groups.get(invocation.path[2]!);
        if (group === undefined) return;
        covered.add(group.node);
        for (const read of invocation.callableReads ?? []) covered.add(read);
        const callee = unwrapJavaScriptExpression(node.callee).node;
        const receiver = invocation.receiver ?? invocation.memberReceiver;
        const branded =
          invocation.receiver === undefined &&
          callee === group.node &&
          (t.isMemberExpression(callee) ||
            t.isOptionalMemberExpression(callee)) &&
          t.isPrivateName(callee.property)
            ? privateReceivers(callee.property)
            : undefined;
        for (const target of group.targets) {
          if (branded !== undefined) {
            retainPrivate(target, branded);
            continue;
          }
          retain(target, receiver);
          if (
            invocation.receiverUncertain === true ||
            t.isSpreadElement(receiver) ||
            (invocation.kind === "opaque" && receiver === undefined)
          )
            retain(target, state.program);
          // Unknown arguments can be nullish. Only proven objects/non-null
          // literals exclude sloppy receiver substitution; reads remain strict.
          const value =
            receiver === undefined
              ? undefined
              : unwrapJavaScriptExpression(receiver).node;
          const nonNullish =
            value !== undefined &&
            (definiteObject(value) ||
              (t.isLiteral(value) && !t.isNullLiteral(value)) ||
              ["globalThis", "global", "window", "self", "module"].some(
                (name) => isUnshadowedGlobal(value, state, name),
              ));
          if (!nonNullish && !semanticStrictContext(target, state))
            retain(target, state.program);
        }
      },
    });
    // Recovered calls are not a complete use set: stored, returned or passed
    // callable values can be invoked through a receiver we did not recover.
    const inactiveNodes = new WeakSet<t.Node>();
    const inactiveTargets = new Set<t.Function>();
    const storedSources: [t.Node, t.Node][] = [];
    const escapedValues = new WeakSet<t.Node>();
    traverseJavaScriptAst(state.program, {
      enter: (node, parent) => {
        if (
          inactiveDefaults.has(node) ||
          (parent !== null && inactiveNodes.has(parent))
        ) {
          inactiveNodes.add(node);
          if (t.isFunction(node)) inactiveTargets.add(node);
          else if (
            parent !== null &&
            t.isIdentifier(node) &&
            t.isReferenced(node, parent, state.parentsByNode.get(parent))
          )
            for (const target of contents(node)) inactiveTargets.add(target);
          return;
        }
        if (parent !== null && t.isClassDeclaration(node)) {
          storedSources.push([node, parent]);
          return;
        }
        if (parent === null || !t.isExpression(node)) return;
        if (
          t.isIdentifier(node) &&
          !t.isReferenced(node, parent, state.parentsByNode.get(parent))
        )
          return;
        let current: t.Node = node;
        // Follow edges that select this value before deciding whether it is
        // stored, consumed, or discarded. The expression's syntax alone does
        // not distinguish an escaped instance from a local method receiver.
        for (;;) {
          if (covered.has(current)) return;
          if (
            (t.isSequenceExpression(parent) &&
              parent.expressions.at(-1) !== current) ||
            (t.isConditionalExpression(parent) && parent.test === current) ||
            (t.isExpressionStatement(parent) &&
              parent.expression === current) ||
            (t.isUnaryExpression(parent) &&
              ["void", "typeof", "!"].includes(parent.operator)) ||
            ((t.isIfStatement(parent) ||
              t.isWhileStatement(parent) ||
              t.isDoWhileStatement(parent)) &&
              parent.test === current) ||
            (t.isForStatement(parent) &&
              (parent.init === current ||
                parent.test === current ||
                parent.update === current))
          )
            return;
          if (
            parent === null ||
            !(
              ((t.isMemberExpression(parent) ||
                t.isOptionalMemberExpression(parent)) &&
                parent.object === current) ||
              unwrapJavaScriptExpression(parent).node === current ||
              t.isSequenceExpression(parent) ||
              t.isConditionalExpression(parent) ||
              t.isLogicalExpression(parent) ||
              (t.isAssignmentExpression(parent, { operator: "=" }) &&
                parent.right === current &&
                t.isIdentifier(parent.left) &&
                resolveSemanticBindingState(
                  state,
                  parent.left,
                  parent.left.name,
                ) !== undefined)
            )
          )
            break;
          current = parent;
          parent = state.parentsByNode.get(current) ?? null;
        }
        if (
          (t.isVariableDeclarator(parent) &&
            parent.init === current &&
            t.isIdentifier(parent.id)) ||
          ((t.isObjectProperty(parent) ||
            t.isClassProperty(parent) ||
            t.isClassPrivateProperty(parent) ||
            t.isClassAccessorProperty(parent)) &&
            parent.value === current) ||
          t.isArrayExpression(parent) ||
          (t.isSpreadElement(parent) &&
            t.isArrayExpression(state.parentsByNode.get(parent))) ||
          (t.isClass(parent) && parent.superClass === current)
        ) {
          storedSources.push([node, parent]);
          return;
        }
        if (escapedValues.has(current)) return;
        escapedValues.add(current);
        // Literal invocation arrays can contain a consumed callable selection.
        // Walk their leaves without hiding other arguments or nested contents.
        const values = [current];
        while (values.length > 0) {
          const value = values.pop();
          if (value === undefined || covered.has(value)) continue;
          const unwrapped = unwrapJavaScriptExpression(value).node;
          if (t.isArrayExpression(unwrapped)) {
            for (const element of unwrapped.elements)
              if (element !== null)
                values.push(
                  t.isSpreadElement(element) ? element.argument : element,
                );
            continue;
          }
          for (const target of contents(value)) retain(target, state.program);
        }
      },
    });
    // An explicitly unused default is a known non-invocation. Keep independent
    // calls and escapes, and leave unobserved stored/exported uses unknown.
    for (const [node, parent] of storedSources) {
      if (inactiveTargets.size === 0) break;
      const declaration = state.parentsByNode.get(parent);
      // A local function initializer defines the target rather than using it.
      if (
        t.isFunction(node) &&
        t.isVariableDeclarator(parent) &&
        !t.isExportNamedDeclaration(
          declaration === undefined
            ? undefined
            : state.parentsByNode.get(declaration),
        )
      )
        continue;
      for (const target of contents(node)) inactiveTargets.delete(target);
    }
    for (const target of inactiveTargets) {
      const parent = state.parentsByNode.get(target);
      if (
        !indexed.has(target) &&
        !t.isExportNamedDeclaration(parent) &&
        !t.isExportDefaultDeclaration(parent)
      )
        retain(target);
    }
  };
  const returned = createSemanticReturnedReferences(state, isDefinitelyObject);
  const inheritedReceiver = (owner: t.Node): readonly t.Node[] => {
    if (
      !(
        (t.isClassMethod(owner) && owner.kind === "constructor") ||
        ((t.isClassProperty(owner) ||
          t.isClassPrivateProperty(owner) ||
          t.isClassAccessorProperty(owner)) &&
          !owner.static)
      )
    )
      return [];
    const body = state.parentsByNode.get(owner);
    const declaring =
      body === undefined ? undefined : state.parentsByNode.get(body);
    return t.isClass(declaring) && declaring.superClass != null
      ? returned(declaring.superClass).map(({ node }) => node)
      : [];
  };
  const query = (node: t.ThisExpression): readonly t.Node[] => {
    const ready = semanticFreshObjectFactsReady(state);
    if (!customContext && factsReady !== ready) {
      factsReady = ready;
      receivers = undefined;
    }
    const owner = lexicalOwner(node);
    if (t.isProgram(owner))
      return javaScriptRuntimeContext(owner) === "unknown" ? [owner] : [];
    if (
      t.isStaticBlock(owner) ||
      ((t.isClassProperty(owner) ||
        t.isClassPrivateProperty(owner) ||
        t.isClassAccessorProperty(owner)) &&
        owner.static)
    ) {
      // Static initialization uses the declaring constructor, including in
      // lexical arrows. Its inherited helpers can still be shared intrinsics.
      const body = state.parentsByNode.get(owner);
      const declaring =
        body === undefined ? undefined : state.parentsByNode.get(body);
      return t.isClass(declaring) ? [declaring] : [];
    }
    if (!t.isFunction(owner)) return inheritedReceiver(owner);
    if (receivers === undefined) indexReceivers();
    const known = receivers?.get(owner);
    // Unrecovered calls/accessors may choose the global receiver. Absence of
    // a recovered call is not evidence that a source-visible write is harmless.
    return known === undefined
      ? [state.program, ...inheritedReceiver(owner)]
      : [...known, ...inheritedReceiver(owner)];
  };
  if (!customContext) receiverQueries.set(state, query);
  return query;
};
