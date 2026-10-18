import * as t from "@babel/types";
import {
  semanticPatternSuspendsBeforeGeneratorRead,
  semanticPatternSuspendsBeforeTarget,
  semanticGeneratorReadInCleanup,
  semanticGeneratorReadAfterYield,
  semanticIteratorAcquisitionAlwaysFails,
} from "./javascriptGeneratorConsumerPhases.js";

import {
  unwrapJavaScriptExpression,
  semanticStaticPropertyName,
  readExactJavaScriptLiteral,
  semanticFinalObjectMember,
  semanticFinalClassMember,
  semanticStaticPropertyKey,
  javaScriptClassField,
  semanticDirectFunctionReturn,
  semanticValueIsRead,
  semanticValueWriteSite,
  javaScriptExactResultOperand,
  runtimeFunctionParameters,
} from "./javascriptAstValues.js";
import {
  javaScriptOptionalOperandsMayBeSkipped,
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { semanticAwaitedResultSites } from "./javascriptSemanticPromiseIdentity.js";
import {
  syntaxMayExitByJump,
  syntaxUnconditionalOperands,
  syntaxEvaluationOperands,
  syntaxEvaluationCannotThrow,
  syntaxMayCompleteNormally,
  syntaxAlwaysThrows,
  syntaxMayReachNextIteration,
  syntaxMayContinue,
  syntaxSwitchCaseTests,
  syntaxEvaluationAlwaysThrows,
  syntaxStaticInitializers,
  syntaxBeforeDefiniteThrow,
  syntaxReachableOperands,
  syntaxOperandAlwaysThrows,
} from "./javascriptSymbolicControlFlow.js";
import { childNodes } from "./javascriptSemanticTraversal.js";

/** A direct return preserves the value separately from the completed activation. */
const webSocketReturnedOwner = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  const statement = state.parentsByNode.get(value);
  if (t.isArrowFunctionExpression(statement) && statement.body === value)
    return semanticDirectFunctionReturn(statement) === value
      ? statement
      : undefined;
  if (!t.isReturnStatement(statement) || statement.argument !== value)
    return undefined;
  const block = state.parentsByNode.get(statement);
  const owner =
    block === undefined ? undefined : state.parentsByNode.get(block);
  return t.isFunction(owner) && semanticDirectFunctionReturn(owner) === value
    ? owner
    : undefined;
};

/** Outward syntax wrappers preserve the expression's runtime identity. */
const webSocketOuterExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  stopAtPatternConsumer = false,
): t.Node => {
  let current = node;
  let identity = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (
      stopAtPatternConsumer &&
      t.isAssignmentExpression(parent) &&
      parent.right === current &&
      (t.isArrayPattern(parent.left) ||
        t.isObjectPattern(parent.left) ||
        webSocketImmediateCaller(parent, state) !== undefined)
    )
      return current;
    if (
      parent !== undefined &&
      // Invocation order is conditional on reaching the body, not on proving
      // that every prefix or target write can finish. A reached call retains
      // this frame independently of the stricter completed-value proof.
      javaScriptExactResultOperand(
        parent,
        () => true,
        syntaxEvaluationCannotThrow,
      ) === current
    ) {
      current = parent;
      identity = parent;
      continue;
    }
    if (
      parent === undefined ||
      unwrapJavaScriptExpression(parent).node !== identity
    ) {
      const owner = webSocketReturnedOwner(current, state);
      const selection =
        owner === undefined
          ? undefined
          : (t.isObjectMethod(owner) || t.isClassMethod(owner)) &&
              owner.kind === "get"
            ? webSocketFreshMethodSelection(owner, owner, state)
            : webSocketImmediateInvocation(owner, state);
      if (selection === undefined) return current;
      current = selection;
      identity = selection;
      continue;
    }
    current = parent;
  }
};

/** A directly selected method/data function on a fresh literal owns its call. */
const webSocketFreshMethodSelection = (
  node: t.Function | t.ClassExpression,
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.MemberExpression | t.OptionalMemberExpression | undefined => {
  const parent = state.parentsByNode.get(value);
  const property =
    (t.isObjectMethod(node) || t.isClassMethod(node)) &&
    (node.kind === "method" || node.kind === "get" || node.kind === "set")
      ? node
      : (t.isObjectProperty(parent) || javaScriptClassField(parent)) &&
          parent.value === value
        ? parent
        : undefined;
  if (property === undefined) return undefined;
  const container = state.parentsByNode.get(property);
  const literal = t.isClassBody(container)
    ? state.parentsByNode.get(container)
    : container;
  if (!t.isObjectExpression(literal) && !t.isClassExpression(literal))
    return undefined;
  let object = webSocketOuterExpression(literal, state);
  const isStatic =
    !t.isClassMethod(property) && !javaScriptClassField(property)
      ? true
      : property.static;
  if (!isStatic) {
    const construction = state.parentsByNode.get(object);
    if (!t.isNewExpression(construction) || construction.callee !== object)
      return undefined;
    object = webSocketOuterExpression(construction, state);
  }
  const member = state.parentsByNode.get(object);
  if (
    (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) ||
    member.object !== object
  )
    return undefined;
  const key = semanticStaticPropertyKey(member.property, member.computed);
  return key !== null &&
    (t.isObjectExpression(literal)
      ? semanticFinalObjectMember(
          literal,
          key,
          t.isObjectMethod(property) && property.kind === "set" ? "set" : "get",
        )
      : semanticFinalClassMember(
          literal,
          key,
          isStatic,
          t.isClassMethod(property) && property.kind === "set" ? "set" : "get",
        )) === property
    ? member
    : undefined;
};

/** Binding a literal defers it only until that bound result is invoked. */
const webSocketImmediateInvocation = (
  node: t.Function | t.ClassExpression,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression
  | t.TaggedTemplateExpression
  | t.Decorator
  | t.MemberExpression
  | t.OptionalMemberExpression
  | undefined => {
  const value = webSocketOuterExpression(node, state);
  const selection = webSocketFreshMethodSelection(node, value, state);
  // Reading an accessor invokes its getter before any returned value is called.
  if (
    selection !== undefined &&
    (t.isObjectMethod(node) || t.isClassMethod(node)) &&
    node.kind === "get"
  )
    return semanticValueIsRead(selection, state.parentsByNode)
      ? selection
      : undefined;
  if (
    selection !== undefined &&
    (t.isObjectMethod(node) || t.isClassMethod(node)) &&
    node.kind === "set"
  )
    return semanticValueWriteSite(selection, state.parentsByNode) !== undefined
      ? selection
      : undefined;
  let callee =
    selection === undefined
      ? value
      : webSocketOuterExpression(selection, state);
  for (;;) {
    let invocation = state.parentsByNode.get(callee);
    let binds = false;
    if (
      (t.isMemberExpression(invocation) ||
        t.isOptionalMemberExpression(invocation)) &&
      invocation.object === callee
    ) {
      const member = semanticStaticPropertyName(
        invocation.property,
        invocation.computed,
      );
      if (member !== "call" && member !== "apply" && member !== "bind")
        return undefined;
      binds = member === "bind";
      callee = webSocketOuterExpression(invocation, state);
      invocation = state.parentsByNode.get(callee);
    }
    if (t.isDecorator(invocation)) {
      if (invocation.expression !== callee) return undefined;
    } else if (t.isTaggedTemplateExpression(invocation)) {
      if (invocation.tag !== callee) return undefined;
    } else if (
      (!t.isCallExpression(invocation) &&
        !t.isOptionalCallExpression(invocation) &&
        !t.isNewExpression(invocation)) ||
      invocation.callee !== callee
    )
      return undefined;
    if (!binds || t.isNewExpression(invocation)) return invocation;
    callee = webSocketOuterExpression(invocation, state);
  }
};

type WebSocketSuspension =
  | t.AwaitExpression
  | t.YieldExpression
  | t.ForOfStatement
  | t.BlockStatement;

const loopJumpFacts = new WeakMap<t.Node, boolean>();
/** An abrupt loop path cannot prove normal body completion before its test/update. */
const webSocketBodyMayJump = (body: t.Node): boolean => {
  const known = loopJumpFacts.get(body);
  if (known !== undefined) return known;
  const mayJump = syntaxMayExitByJump(body);
  loopJumpFacts.set(body, mayJump);
  return mayJump;
};

const scopeExitSuspensions = new WeakMap<
  t.BlockStatement,
  t.AwaitExpression | t.BlockStatement | null
>();
/** A wait precedes every scope exit only if no earlier throw/jump can bypass it. */
const webSocketEveryExitSuspension = (
  block: t.BlockStatement,
): t.AwaitExpression | t.BlockStatement | undefined => {
  const known = scopeExitSuspensions.get(block);
  if (known !== undefined) return known ?? undefined;
  const pending: t.Node[] = [block];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const node = unwrapJavaScriptExpression(next).node;
    if (
      t.isAwaitExpression(node) &&
      syntaxEvaluationCannotThrow(node.argument)
    ) {
      scopeExitSuspensions.set(block, node);
      return node;
    }
    if (syntaxEvaluationAlwaysThrows(node)) {
      pending.push(...syntaxBeforeDefiniteThrow(node).toReversed());
      continue;
    }
    if (syntaxEvaluationCannotThrow(node)) continue;
    // A successfully acquired null async resource still schedules a disposal
    // await on every exit, including throw/return/break. The declaration itself
    // does not suspend, and a possibly throwing initializer cannot prove this.
    if (
      t.isVariableDeclaration(node) &&
      node.kind === "await using" &&
      t.isIdentifier(node.declarations[0]?.id) &&
      t.isNullLiteral(node.declarations[0]?.init)
    ) {
      scopeExitSuspensions.set(block, block);
      return block;
    }
    if (t.isExpressionStatement(node)) pending.push(node.expression);
    else if (t.isThrowStatement(node) || t.isReturnStatement(node)) {
      // Abrupt completion discards every later statement, but evaluates its
      // argument before entering a finalizer.
      pending.length = 0;
      if (node.argument != null) pending.push(node.argument);
    } else if (t.isBlockStatement(node))
      pending.push(...node.body.toReversed());
    else if (t.isSequenceExpression(node))
      pending.push(...node.expressions.toReversed());
    else if (
      t.isVariableDeclaration(node) &&
      (node.kind === "var" || node.kind === "let" || node.kind === "const") &&
      node.declarations.every((item) => t.isIdentifier(item.id))
    ) {
      for (const item of node.declarations.toReversed())
        if (item.init != null) pending.push(item.init);
    } else break;
  }
  scopeExitSuspensions.set(block, null);
  return undefined;
};

/** A definite throw enters a simple catch binding before its handler can run. */
const webSocketMandatoryHandler = (
  node: t.TryStatement,
): t.BlockStatement | undefined =>
  node.handler != null &&
  (node.handler.param == null || t.isIdentifier(node.handler.param)) &&
  syntaxAlwaysThrows(node.block)
    ? node.handler.body
    : undefined;

/** Children completed in order if this straight-line node completes normally. */
const webSocketOrderedEvaluation = (node: t.Node): readonly t.Node[] => {
  if (t.isBlockStatement(node)) {
    const reachable: t.Node[] = [];
    for (const statement of node.body) {
      reachable.push(statement);
      if (!syntaxMayCompleteNormally(statement)) break;
    }
    return reachable;
  }
  const operands =
    syntaxUnconditionalOperands(node) ?? syntaxEvaluationOperands(node);
  if (operands !== undefined) {
    const failed = operands.findIndex((operand) =>
      syntaxOperandAlwaysThrows(node, operand),
    );
    return failed < 0 ? operands : operands.slice(0, failed + 1);
  }
  if (t.isLabeledStatement(node)) {
    const prefix: t.Node[] = [];
    for (const statement of t.isBlockStatement(node.body)
      ? node.body.body
      : [node.body]) {
      if (webSocketBodyMayJump(statement)) break;
      prefix.push(statement);
    }
    const exit = t.isBlockStatement(node.body)
      ? webSocketEveryExitSuspension(node.body)
      : undefined;
    return exit === undefined ? prefix : [...prefix, exit];
  }
  if (t.isWithStatement(node)) return [node.object, node.body];
  if (t.isSwitchStatement(node)) return [node.discriminant];
  // Every normally completed loop evaluates its initial test, but its body
  // and updates may never execute. A do/while body precedes its first test.
  if (t.isWhileStatement(node)) return [node.test];
  if (t.isDoWhileStatement(node))
    return webSocketBodyMayJump(node.body)
      ? t.isBlockStatement(node.body)
        ? [webSocketEveryExitSuspension(node.body)].filter(
            (item) => item !== undefined,
          )
        : []
      : [node.body, node.test];
  if (t.isTryStatement(node))
    return [
      node.handler == null
        ? node.block
        : webSocketEveryExitSuspension(node.block),
      webSocketMandatoryHandler(node),
      node.finalizer,
    ].filter((item) => item != null);
  if (t.isForStatement(node))
    return [node.init, node.test].filter((element) => element != null);
  // Conditional/short-circuit branches, nested functions and try/catch do not
  // establish a suspension on every path to the following expression.
  return [];
};

const webSocketCompletedSuspensions = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, WebSocketSuspension | null>
>();

/** Successful completion crosses the last suspension in this straight-line node. */
const webSocketCompletedSuspension = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  if (
    syntaxEvaluationAlwaysThrows(node) ||
    (t.isForOfStatement(node) &&
      semanticIteratorAcquisitionAlwaysFails(node.right, state))
  )
    return undefined;
  let cached = webSocketCompletedSuspensions.get(state);
  if (cached === undefined) {
    cached = new WeakMap();
    webSocketCompletedSuspensions.set(state, cached);
  }
  const existing = cached.get(node);
  if (existing !== undefined) return existing ?? undefined;
  const pending = [node];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    const current = unwrapJavaScriptExpression(next).node;
    // Disposal belongs to successful scope exit, never the declaration point.
    if (
      t.isBlockStatement(current) &&
      current.body.some(
        (statement) =>
          t.isVariableDeclaration(statement) &&
          statement.kind === "await using",
      )
    ) {
      cached.set(node, current);
      return current;
    }
    const delegateOwner =
      t.isYieldExpression(current) && current.delegate
        ? webSocketSuspensionOwner(current, state)
        : undefined;
    if (
      (t.isAwaitExpression(current) &&
        !syntaxEvaluationAlwaysThrows(current.argument)) ||
      (t.isForOfStatement(current) &&
        current.await &&
        !semanticIteratorAcquisitionAlwaysFails(current.right, state)) ||
      (t.isYieldExpression(current) &&
        (!current.delegate ||
          // Async delegation awaits the iterator result even when it is done;
          // synchronous delegation can finish without yielding at all.
          (t.isFunction(delegateOwner) && delegateOwner.async)))
    ) {
      cached.set(node, current);
      return current;
    }
    for (const child of webSocketOrderedEvaluation(current))
      pending.push(child);
  }
  cached.set(node, null);
  return undefined;
};

const webSocketSuspensionPrefixes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, ReadonlyMap<t.Node, WebSocketSuspension>>
>();

/** Break/return/throw paths bypass updates; only a continuing path can skip its wait. */
const webSocketUpdateSuspension = (
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined =>
  syntaxMayContinue(body)
    ? t.isBlockStatement(body)
      ? webSocketEveryExitSuspension(body)
      : undefined
    : webSocketCompletedSuspension(body, state);

/** Index sibling phases once rather than rescan a suspended body per socket. */
const webSocketPrecedingSuspension = (
  parent: t.Node,
  child: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  if (
    (t.isIfStatement(parent) || t.isConditionalExpression(parent)) &&
    (child === parent.consequent || child === parent.alternate)
  )
    return webSocketCompletedSuspension(parent.test, state);
  if (
    (t.isLogicalExpression(parent) ||
      (t.isAssignmentExpression(parent) &&
        ["&&=", "||=", "??="].includes(parent.operator))) &&
    child === parent.right
  )
    return webSocketCompletedSuspension(parent.left, state);
  if (t.isTryStatement(parent) && child === parent.handler)
    return webSocketEveryExitSuspension(parent.block);
  if (t.isTryStatement(parent) && child === parent.finalizer) {
    const handler = webSocketMandatoryHandler(parent);
    return (
      (handler === undefined
        ? undefined
        : webSocketEveryExitSuspension(handler)) ??
      webSocketEveryExitSuspension(parent.block)
    );
  }
  if (
    t.isSwitchStatement(parent) &&
    parent.cases.includes(child as t.SwitchCase)
  )
    return webSocketCompletedSuspension(parent.discriminant, state);
  if (t.isSwitchCase(parent) && child !== parent.test) {
    const selection = state.parentsByNode.get(parent);
    if (t.isSwitchStatement(selection)) {
      for (const test of syntaxSwitchCaseTests(
        selection,
        parent,
      ).toReversed()) {
        const suspension = webSocketCompletedSuspension(test, state);
        if (suspension !== undefined) return suspension;
      }
    }
  }
  if (
    t.isOptionalMemberExpression(parent) &&
    parent.computed &&
    child === parent.property
  )
    return webSocketCompletedSuspension(parent.object, state);
  if (
    t.isForOfStatement(parent) &&
    parent.await &&
    (child === parent.body || child === parent.left)
  )
    return semanticIteratorAcquisitionAlwaysFails(parent.right, state)
      ? undefined
      : parent;
  if (
    (t.isForOfStatement(parent) || t.isForInStatement(parent)) &&
    (child === parent.body || child === parent.left)
  )
    return webSocketCompletedSuspension(parent.right, state);
  if (
    (t.isWhileStatement(parent) || t.isForStatement(parent)) &&
    (child === parent.body ||
      (t.isForStatement(parent) && child === parent.update))
  )
    return (
      (t.isForStatement(parent) && child === parent.update
        ? webSocketUpdateSuspension(parent.body, state)
        : undefined) ??
      (parent.test == null
        ? undefined
        : webSocketCompletedSuspension(parent.test, state)) ??
      (t.isForStatement(parent) && parent.init != null
        ? webSocketCompletedSuspension(parent.init, state)
        : undefined)
    );
  let byParent = webSocketSuspensionPrefixes.get(state);
  if (byParent === undefined) {
    byParent = new WeakMap();
    webSocketSuspensionPrefixes.set(state, byParent);
  }
  let prefixes = byParent.get(parent);
  if (prefixes === undefined) {
    const indexed = new Map<t.Node, WebSocketSuspension>();
    let awaited: WebSocketSuspension | undefined;
    // Reaching any call argument proves that optional short-circuiting did not
    // skip this call's argument list. Index earlier arguments once for reads
    // inside the list, without making them mandatory for code after the call.
    const operands =
      (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
      javaScriptOptionalOperandsMayBeSkipped(parent)
        ? [parent.callee, ...parent.arguments]
        : webSocketOrderedEvaluation(parent);
    for (const node of operands) {
      if (awaited !== undefined) indexed.set(node, awaited);
      if (
        syntaxEvaluationAlwaysThrows(node) ||
        (t.isForOfStatement(node) &&
          semanticIteratorAcquisitionAlwaysFails(node.right, state))
      )
        break;
      awaited = webSocketCompletedSuspension(node, state) ?? awaited;
    }
    byParent.set(parent, indexed);
    prefixes = indexed;
  }
  return prefixes.get(child);
};

/** Find a completed suspension on the containing straight-line evaluation path. */
const webSocketContinuation = (
  node: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  let current = node;
  while (current !== body) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return undefined;
    const awaited = webSocketPrecedingSuspension(parent, current, state);
    if (awaited !== undefined) return awaited;
    current = parent;
  }
  return undefined;
};

/** Find the literal class whose construction evaluates a field or constructor. */
const webSocketClassConstruction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.NewExpression | undefined => {
  const body = state.parentsByNode.get(node);
  const declaration =
    body === undefined ? undefined : state.parentsByNode.get(body);
  if (!t.isClassExpression(declaration)) return undefined;
  const invocation = webSocketImmediateInvocation(declaration, state);
  return t.isNewExpression(invocation) ? invocation : undefined;
};

/** Legacy decorator application follows its class's keys and static values. */
const webSocketDecoratedClass = (
  node: t.Decorator,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  let parent = state.parentsByNode.get(node);
  while (parent !== undefined) {
    if (t.isClass(parent)) return parent;
    if (
      t.isProgram(parent) ||
      (t.isFunction(parent) &&
        !t.isClassMethod(parent) &&
        !t.isClassPrivateMethod(parent))
    )
      return undefined;
    parent = state.parentsByNode.get(parent);
  }
  return undefined;
};

interface WebSocketParameterResume {
  readonly parameter: t.ArrayPattern;
  readonly invocation:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.NewExpression
    | t.AssignmentExpression;
}

/** Select a potential reached callee without imposing completed-write validity. */
const webSocketSelectedCallee = (raw: t.Node): t.Node => {
  let node = unwrapJavaScriptExpression(raw).node;
  for (;;) {
    const selected = javaScriptExactResultOperand(
      node,
      () => true,
      syntaxEvaluationCannotThrow,
    );
    if (selected === undefined) return node;
    node = unwrapJavaScriptExpression(selected).node;
  }
};

const immediateCallers = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, t.Function | null>
>();

/** Reuse body activation ownership, caching only each requested callee subtree. */
const webSocketImmediateCaller = (
  call: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  let callers = immediateCallers.get(state);
  if (callers === undefined) {
    callers = new WeakMap();
    immediateCallers.set(state, callers);
  }
  const cached = callers.get(call);
  if (cached !== undefined) return cached ?? undefined;
  if (
    !t.isCallExpression(call) &&
    !t.isOptionalCallExpression(call) &&
    !t.isNewExpression(call) &&
    !t.isAssignmentExpression(call)
  )
    return undefined;
  const pending: t.Node[] = [
    t.isAssignmentExpression(call) ? call.left : call.callee,
  ];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (t.isFunction(node)) {
      const invocation =
        t.isClassMethod(node) && node.kind === "constructor"
          ? webSocketClassConstruction(node, state)
          : webSocketImmediateInvocation(node, state);
      if (
        invocation === call ||
        (t.isAssignmentExpression(call) &&
          (t.isObjectMethod(node) || t.isClassMethod(node)) &&
          node.kind === "set" &&
          invocation !== undefined &&
          semanticValueWriteSite(invocation, state.parentsByNode) === call)
      ) {
        callers.set(call, node);
        return node;
      }
    }
    pending.push(...childNodes(node));
  }
  callers.set(call, null);
  return undefined;
};

/** Match a known literal invocation's positional argument, never an unknown spread offset. */
const webSocketParameterResume = (
  result: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketParameterResume | undefined => {
  const parent = state.parentsByNode.get(result);
  if (
    t.isAssignmentExpression(parent) &&
    parent.operator === "=" &&
    parent.right === result
  ) {
    const owner = webSocketImmediateCaller(parent, state);
    const parameter =
      owner === undefined ? undefined : runtimeFunctionParameters(owner)[0];
    const pattern = t.isAssignmentPattern(parameter)
      ? parameter.left
      : parameter;
    return t.isArrayPattern(pattern) && pattern.elements.length > 0
      ? { parameter: pattern, invocation: parent }
      : undefined;
  }
  const array = t.isArrayExpression(parent) ? parent : undefined;
  const call = array === undefined ? parent : state.parentsByNode.get(array);
  if (
    !t.isCallExpression(call) &&
    !t.isOptionalCallExpression(call) &&
    !t.isNewExpression(call)
  )
    return undefined;
  let callee = webSocketSelectedCallee(call.callee);
  const owner = webSocketImmediateCaller(call, state);
  if (owner === undefined) return undefined;
  const classBody = state.parentsByNode.get(owner);
  const literalClass = t.isClassBody(classBody)
    ? state.parentsByNode.get(classBody)
    : undefined;
  const value =
    t.isClassMethod(owner) &&
    owner.kind === "constructor" &&
    t.isClassExpression(literalClass)
      ? webSocketOuterExpression(literalClass, state)
      : webSocketOuterExpression(owner, state);
  const selection = webSocketFreshMethodSelection(owner, value, state);
  const callable = webSocketSelectedCallee(
    selection === undefined
      ? value
      : webSocketOuterExpression(selection, state),
  );
  let offset = 0;
  if (
    callee !== callable &&
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
  ) {
    const method = semanticStaticPropertyName(callee.property, callee.computed);
    if (method !== "call" && method !== "apply") return undefined;
    if (
      method === "apply"
        ? array === undefined || call.arguments[1] !== array
        : array !== undefined
    )
      return undefined;
    offset = method === "call" ? 1 : 0;
    callee = webSocketSelectedCallee(callee.object);
  } else if (array !== undefined) return undefined;
  // Bound argument lists need a separate positional proof; the activation alone
  // does not say which parameter receives this generator.
  if (callee !== callable) return undefined;
  const arguments_ = array?.elements ?? call.arguments;
  const index = arguments_.indexOf(result as t.Expression);
  if (
    index < offset ||
    arguments_.slice(0, index).some((argument) => t.isSpreadElement(argument))
  )
    return undefined;
  const parameter = runtimeFunctionParameters(owner)[index - offset];
  const pattern = t.isAssignmentPattern(parameter) ? parameter.left : parameter;
  return t.isArrayPattern(pattern) && pattern.elements.length > 0
    ? { parameter: pattern, invocation: call }
    : undefined;
};

/** Direct iteration, literal parameters and iterable spreads resume a fresh generator in-turn. */
const webSocketGeneratorResume = (
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.ForOfStatement
  | t.SpreadElement
  | t.ArrayPattern
  | t.YieldExpression
  | WebSocketParameterResume
  | undefined => {
  const result = webSocketOuterExpression(invocation, state, true);
  const member = state.parentsByNode.get(result);
  if (t.isForOfStatement(member) && member.right === result) return member;
  if (
    t.isYieldExpression(member) &&
    member.delegate &&
    member.argument === result
  )
    return member;
  const pattern =
    t.isVariableDeclarator(member) && member.init === result
      ? member.id
      : t.isAssignmentExpression(member) &&
          member.right === result &&
          member.operator === "="
        ? member.left
        : undefined;
  if (t.isArrayPattern(pattern) && pattern.elements.length > 0) return pattern;
  const parameter = webSocketParameterResume(result, state);
  if (parameter !== undefined) return parameter;
  if (t.isSpreadElement(member) && member.argument === result) {
    const consumer = state.parentsByNode.get(member);
    if (
      t.isArrayExpression(consumer) ||
      t.isCallExpression(consumer) ||
      t.isOptionalCallExpression(consumer) ||
      t.isNewExpression(consumer)
    )
      return member;
  }
  if (
    (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) ||
    member.object !== result ||
    semanticStaticPropertyName(member.property, member.computed) !== "next"
  )
    return undefined;
  const callee = webSocketOuterExpression(member, state);
  const call = state.parentsByNode.get(callee);
  return (t.isCallExpression(call) || t.isOptionalCallExpression(call)) &&
    call.callee === callee
    ? call
    : undefined;
};

const bodySuspensionFacts = new WeakMap<
  t.Node,
  {
    readonly effects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
    readonly phase: JavaScriptSemanticAnalysisState["memberMutationFactsPhase"];
    readonly value: boolean;
  }
>();
/** A synchronous iterator resumes in-turn unless its consumer body can await. */
const webSocketBodyMaySuspend = (
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const known = bodySuspensionFacts.get(body);
  if (
    known !== undefined &&
    known.effects === state.literalMemberEffects &&
    known.phase === state.memberMutationFactsPhase
  )
    return known.value;
  const remember = (value: boolean): boolean => {
    bodySuspensionFacts.set(body, {
      effects: state.literalMemberEffects,
      phase: state.memberMutationFactsPhase,
      value,
    });
    return value;
  };
  const pending = [body];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (
      (t.isAwaitExpression(node) &&
        !syntaxEvaluationAlwaysThrows(node.argument)) ||
      (t.isYieldExpression(node) &&
        (node.argument == null ||
          !syntaxEvaluationAlwaysThrows(node.argument))) ||
      (t.isForOfStatement(node) &&
        node.await &&
        !semanticIteratorAcquisitionAlwaysFails(node.right, state)) ||
      (t.isVariableDeclaration(node) &&
        node.kind === "await using" &&
        node.declarations[0]?.init != null &&
        !syntaxEvaluationAlwaysThrows(node.declarations[0].init))
    ) {
      return remember(true);
    }
    if (
      t.isForOfStatement(node) &&
      semanticIteratorAcquisitionAlwaysFails(node.right, state)
    ) {
      pending.push(node.right);
      continue;
    }
    pending.push(...syntaxReachableOperands(node));
  }
  return remember(false);
};

type WebSocketConsumerPhase = "same-turn" | "after-wait" | "unknown";

/** A delegated generator inherits the surrounding generator's actual consumer phase. */
const webSocketGeneratorConsumerPhase = (
  invocation: t.Node,
  read: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
  seen = new Set<t.Node>(),
): WebSocketConsumerPhase => {
  if (seen.has(invocation)) return "unknown";
  seen.add(invocation);
  if (t.isSpreadElement(invocation)) return "same-turn";
  if (t.isArrayPattern(invocation))
    return semanticPatternSuspendsBeforeGeneratorRead({
      executionFrames: (node) => webSocketExecutionContexts(node, state, true),
      read,
      body,
      pattern: invocation,
      state,
      ...(ownedResultEscape === undefined ? {} : { ownedResultEscape }),
      ordered: webSocketOrderedEvaluation,
      maySuspend: (node) => webSocketBodyMaySuspend(node, state),
      completedSuspension: (node) =>
        webSocketCompletedSuspension(node, state) !== undefined,
    })
      ? "after-wait"
      : "same-turn";
  if (
    t.isForOfStatement(invocation) &&
    !syntaxMayReachNextIteration(invocation.body)
  )
    return semanticGeneratorReadInCleanup(
      read,
      body,
      state,
      webSocketOrderedEvaluation,
      (node) => webSocketBodyMaySuspend(node, state),
    ) &&
      (invocation.await ||
        (t.isBlockStatement(invocation.body) &&
          webSocketEveryExitSuspension(invocation.body) !== undefined))
      ? "after-wait"
      : "same-turn";
  if (t.isForOfStatement(invocation))
    return !invocation.await &&
      !webSocketBodyMaySuspend(invocation.left, state) &&
      !webSocketBodyMaySuspend(invocation.body, state)
      ? "same-turn"
      : "after-wait";
  if (t.isYieldExpression(invocation) && invocation.delegate) {
    const owner = webSocketSuspensionOwner(invocation, state);
    if (
      !t.isFunction(owner) ||
      t.isArrowFunctionExpression(owner) ||
      !owner.generator ||
      owner.async
    )
      return "unknown";
    const call = webSocketImmediateInvocation(owner, state);
    const resume =
      call === undefined ? undefined : webSocketGeneratorResume(call, state);
    return resume === undefined
      ? "unknown"
      : webSocketGeneratorConsumerPhase(
          "parameter" in resume ? resume.parameter : resume,
          read,
          owner.body,
          state,
          call,
          seen,
        );
  }
  return "unknown";
};

/** The lexical body that actually suspends owns the continuation boundary. */
const webSocketSuspensionOwner = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node => {
  let current: t.Node = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return current;
    if (
      t.isFunction(parent) &&
      !(
        (t.isClassMethod(parent) || t.isObjectMethod(parent)) &&
        parent.key === current
      )
    )
      return parent;
    current = parent;
  }
};

/** A caller directly awaiting this result cannot initialize later locals yet. */
const webSocketWaitingContexts = (
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly SemanticExecutionFrame[] => {
  const contexts: SemanticExecutionFrame[] = [];
  const pending = [invocation];
  const seen = new Set<t.Node>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const awaited of semanticAwaitedResultSites(current, state, (node) =>
      webSocketExecutionContexts(node, state, true),
    )) {
      const owner = webSocketSuspensionOwner(awaited, state);
      contexts.push({ owner, point: awaited });
      if (t.isFunction(owner)) {
        const caller = webSocketImmediateInvocation(owner, state);
        if (caller !== undefined) pending.push(caller);
      }
    }
  }
  return contexts;
};

/** A lexical switch initializer is not reached by entering another case. */
export const webSocketInitializerDominatesRead = (
  initializer: t.Node,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  bindingNode?: t.Node,
): boolean => {
  return (
    semanticInitializerPrecedesRead({
      initializer,
      read,
      ...(bindingNode === undefined ? {} : { bindingNode }),
      parents: state.parentsByNode,
      initializerContexts: webSocketExecutionContexts(initializer, state),
      readContexts: webSocketExecutionContexts(read, state),
    }) ?? true
  );
};

const webSocketClassPrefixes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<
    t.Class,
    {
      readonly keys: ReadonlyMap<t.Node, WebSocketSuspension | null>;
      readonly statics: ReadonlyMap<t.Node, WebSocketSuspension | null>;
    }
  >
>();

/** Index class evaluation once; all keys precede every static initializer. */
const webSocketClassPrefix = (
  member: t.Node,
  computedKey: boolean,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  const body = state.parentsByNode.get(member);
  const declaration =
    body === undefined ? undefined : state.parentsByNode.get(body);
  if (!t.isClass(declaration)) return undefined;
  let byClass = webSocketClassPrefixes.get(state);
  if (byClass === undefined) {
    byClass = new WeakMap();
    webSocketClassPrefixes.set(state, byClass);
  }
  let prefixes = byClass.get(declaration);
  if (prefixes === undefined) {
    const keys = new Map<t.Node, WebSocketSuspension | null>();
    const statics = new Map<t.Node, WebSocketSuspension | null>();
    let suspended: WebSocketSuspension | undefined;
    let failed = false;
    const advance = (operand: t.Node): void => {
      if (failed) return;
      if (syntaxEvaluationAlwaysThrows(operand)) {
        failed = true;
        suspended = undefined;
      } else
        suspended = webSocketCompletedSuspension(operand, state) ?? suspended;
    };
    if (declaration.superClass != null) advance(declaration.superClass);
    for (const item of declaration.body.body) {
      if (failed) break;
      keys.set(item, suspended ?? null);
      if (
        (javaScriptClassField(item) || t.isClassMethod(item)) &&
        "computed" in item &&
        item.computed
      )
        advance(item.key);
    }
    for (const item of declaration.body.body) {
      if (failed) break;
      statics.set(item, suspended ?? null);
      for (const initializer of syntaxStaticInitializers(item))
        advance(initializer);
    }
    prefixes = { keys, statics };
    byClass.set(declaration, prefixes);
  }
  return (
    (computedKey ? prefixes.keys : prefixes.statics).get(member) ?? undefined
  );
};

/**
 * Keep local initialization ordered across suspension phases. A suspension cuts
 * off outer execution frames only after retaining the body that owns it. Calls
 * evaluate callee/arguments before bodies; classes evaluate keys, static values,
 * and construction arguments before instance fields and constructor bodies.
 */
export const webSocketExecutionContexts = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  directOnly = false,
): readonly SemanticExecutionFrame[] => {
  const contexts: SemanticExecutionFrame[] = [];
  let point = node;
  let suspendedOwner: t.Node | undefined;
  const suspendedAt = (suspension: WebSocketSuspension | undefined): void => {
    if (suspension !== undefined)
      suspendedOwner = webSocketSuspensionOwner(suspension, state);
  };
  const suspendedAfter = (evaluated: t.Node): void =>
    suspendedAt(webSocketCompletedSuspension(evaluated, state));
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return [...contexts, { owner: current, point }];
    if (javaScriptClassField(parent) && parent.value === current) {
      if (parent.static)
        suspendedAt(webSocketClassPrefix(parent, false, state));
      else {
        const construction = webSocketClassConstruction(parent, state);
        if (construction === undefined)
          return [...contexts, { owner: parent, point }];
        suspendedAfter(construction);
      }
    }
    if (
      (javaScriptClassField(parent) || t.isClassMethod(parent)) &&
      "computed" in parent &&
      parent.computed &&
      parent.key === current
    )
      suspendedAt(webSocketClassPrefix(parent, true, state));
    if (t.isStaticBlock(parent))
      suspendedAt(webSocketClassPrefix(parent, false, state));
    if (t.isFunction(parent)) {
      if (
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.key === current
      ) {
        current = parent;
        continue;
      }
      let invocation:
        | ReturnType<typeof webSocketImmediateInvocation>
        | t.ForOfStatement
        | t.SpreadElement
        | t.ArrayPattern
        | t.AssignmentExpression
        | t.YieldExpression =
        t.isClassMethod(parent) && parent.kind === "constructor"
          ? webSocketClassConstruction(parent, state)
          : webSocketImmediateInvocation(parent, state);
      contexts.push({ owner: parent, point });
      const generatorBody =
        current === parent.body &&
        !t.isArrowFunctionExpression(parent) &&
        parent.generator;
      const generatorInvocation = invocation;
      let parameterConsumer: t.ArrayPattern | undefined;
      if (
        generatorBody &&
        invocation !== undefined &&
        !t.isNewExpression(invocation)
      ) {
        const resume = webSocketGeneratorResume(invocation, state);
        parameterConsumer =
          resume !== undefined && "parameter" in resume
            ? resume.parameter
            : undefined;
        invocation =
          resume !== undefined && "parameter" in resume
            ? resume.invocation
            : resume;
      }
      if (invocation === undefined) return contexts;
      const decoratedClass = t.isDecorator(invocation)
        ? webSocketDecoratedClass(invocation, state)
        : undefined;
      if (t.isOptionalCallExpression(invocation)) {
        // Reaching this literal body proves the optional call was taken.
        // Its argument evaluation therefore precedes body entry.
        for (const operand of [invocation.callee, ...invocation.arguments])
          suspendedAfter(operand);
      } else if (
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.kind === "set"
      ) {
        const site = semanticValueWriteSite(invocation, state.parentsByNode);
        if (site !== undefined) {
          // RHS and preceding pattern slots finish before the selected write,
          // whereas later slots must not defer this setter activation.
          const structuredPattern =
            t.isAssignmentExpression(site) &&
            (t.isObjectPattern(site.left) || t.isArrayPattern(site.left));
          if (!structuredPattern)
            suspendedAt(webSocketContinuation(invocation, site, state));
          if (t.isAssignmentExpression(site)) {
            if (!structuredPattern) suspendedAfter(site.right);
            if (
              semanticPatternSuspendsBeforeTarget(
                site.left,
                site.right,
                invocation,
                state,
                (operand) =>
                  webSocketCompletedSuspension(operand, state) !== undefined,
                (node) => webSocketExecutionContexts(node, state, true),
              )
            )
              suspendedOwner = webSocketSuspensionOwner(site, state);
          }
          if (t.isForOfStatement(site) && site.await) suspendedAt(site);
          if (!structuredPattern) suspendedAfter(invocation);
          else invocation = site;
        }
      } else if (!t.isArrayPattern(invocation)) {
        suspendedAfter(
          t.isForOfStatement(invocation)
            ? invocation.right
            : t.isYieldExpression(invocation)
              ? (invocation.argument ?? invocation)
              : (decoratedClass ?? invocation),
        );
      }
      const consumerPhase =
        generatorBody && !parent.async
          ? webSocketGeneratorConsumerPhase(
              parameterConsumer ?? invocation,
              node,
              parent.body,
              state,
              generatorInvocation,
            )
          : "unknown";
      if (
        (parent.async || generatorBody) &&
        current === parent.body &&
        // Synchronous for-of resumes after every ordinary yield in the same turn.
        consumerPhase !== "same-turn"
      ) {
        if (
          consumerPhase === "after-wait" &&
          semanticGeneratorReadAfterYield(
            node,
            parent.body,
            state,
            webSocketOrderedEvaluation,
            (node) => webSocketBodyMaySuspend(node, state),
          )
        )
          suspendedOwner = parent;
        const continuation = webSocketContinuation(point, parent.body, state);
        if (continuation !== undefined)
          suspendedOwner = webSocketSuspensionOwner(continuation, state);
      }
      // Direct frames are an earlier invocation bound for alias initialization.
      // They do not consult the waiting index that is currently being built.
      if (suspendedOwner === parent && !directOnly)
        return [...contexts, ...webSocketWaitingContexts(invocation, state)];
      point = invocation;
      // A returned callable executes outside its producer's completed activation.
      if (webSocketReturnedOwner(parent, state) !== undefined) {
        current = invocation;
        continue;
      }
      // Method/parameter decorator metadata is evaluated with the class, not
      // within the decorated method's runtime activation.
      if (decoratedClass !== undefined) {
        current = decoratedClass;
        continue;
      }
    }
    current = parent;
  }
};
