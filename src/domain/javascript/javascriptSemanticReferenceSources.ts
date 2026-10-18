import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath as PropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import {
  semanticContainer,
  semanticSlotAtPath,
} from "./javascriptSemanticSlots.js";
import { semanticExpressionEvaluationOrder } from "./javascriptSemanticMutationInitializers.js";
import {
  childNodes,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";
import type {
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";

/** A retained source and the pattern selection that guards its reference. */
export interface JavaScriptSemanticReferenceSource {
  readonly node: t.Node;
  readonly projection: PropertyPath;
  readonly selection?: t.AssignmentPattern;
}

/** Exclude references whose source slot or destructuring fallback is absent.
 * Before member effects exist, only inline syntax can prove a fallback unused;
 * named values must stay possible until their mutation facts are available. */
export const semanticReferenceSourcesInactive = (
  reference: {
    readonly requiredSources?: readonly JavaScriptSemanticReferenceSource[];
    readonly fallbackSources?: readonly JavaScriptSemanticReferenceSource[];
  },
  state: JavaScriptSemanticAnalysisState,
  mode: "effects" | "syntax-only" = "effects",
): boolean =>
  reference.fallbackSources?.some(
    (source) =>
      referenceSelectionStable(source, state) &&
      syntaxReferenceSourceDefined(source),
  ) === true ||
  (mode === "effects" &&
    (reference.requiredSources?.some(
      (source) => selectedDefaultInput(source, state)?.presence === "absent",
    ) === true ||
      reference.fallbackSources?.some((source) => {
        // Selection precedes effects through the chosen reference. A later escape
        // cannot make a fallback that was excluded at destructuring reachable.
        const slot = selectedDefaultInput(source, state);
        return (
          slot?.presence === "present" &&
          (slot.value.status === "literal" ||
            slot.value.status === "union" ||
            slot.value.status === "object" ||
            slot.value.status === "array")
        );
      }) === true));

interface PatternSelectionFacts {
  readonly effects: readonly t.Node[];
  readonly arrays: readonly t.ArrayPattern[];
  readonly reads: readonly {
    readonly node: t.ObjectProperty;
    readonly projection: PropertyPath;
  }[];
  readonly objectRests: readonly {
    readonly node: t.RestElement;
    readonly projection: PropertyPath;
  }[];
  readonly projections: WeakMap<t.Node, PropertyPath>;
  readonly inertPrefixes: WeakMap<t.AssignmentPattern, boolean>;
  readonly prototypeReads: WeakMap<t.Node, readonly t.Node[]>;
  readonly uncertainReads: WeakMap<JavaScriptSemanticValue, readonly t.Node[]>;
}

const patternSelectionFacts = new WeakMap<t.Node, PatternSelectionFacts>();

/** Pattern syntax is immutable; index it once, without traversing default bodies. */
const selectionFacts = (
  selection: t.AssignmentPattern,
  state: JavaScriptSemanticAnalysisState,
): PatternSelectionFacts => {
  const cached = patternSelectionFacts.get(selection);
  if (cached !== undefined) return cached;
  let root: t.Node = selection;
  for (;;) {
    const parent = state.parentsByNode.get(root);
    if (
      !(
        t.isObjectPattern(parent) ||
        t.isArrayPattern(parent) ||
        t.isRestElement(parent) ||
        (t.isObjectProperty(parent) && parent.value === root) ||
        (t.isAssignmentPattern(parent) && parent.left === root)
      )
    )
      break;
    root = parent;
  }
  const effects: t.Node[] = [];
  const arrays: t.ArrayPattern[] = [];
  const reads: { node: t.ObjectProperty; projection: PropertyPath }[] = [];
  const objectRests: { node: t.RestElement; projection: PropertyPath }[] = [];
  const projections = new WeakMap<t.Node, PropertyPath>();
  projections.set(root, []);
  const selections: t.AssignmentPattern[] = [];
  const skipped = new Set<t.Node>();
  traverseJavaScriptAst(root, {
    skip: (node) => skipped.has(node),
    enter: (node, parent) => {
      const projection =
        projections.get(node) ??
        (parent === null ? [] : projections.get(parent)) ??
        [];
      projections.set(node, projection);
      if (t.isAssignmentPattern(node)) {
        selections.push(node);
        skipped.add(node.right);
        if (!syntaxDataSource(node.right)) effects.push(node.right);
      } else if (t.isObjectProperty(node)) {
        const selected = [
          ...projection,
          semanticStaticPropertyKey(node.key, node.computed),
        ];
        reads.push({ node, projection: selected });
        projections.set(node.value, selected);
        skipped.add(node.key);
        if (node.computed && !readExactJavaScriptLiteral(node.key).found)
          effects.push(node.key);
      } else if (t.isMemberExpression(node)) {
        effects.push(node);
        skipped.add(node.object);
        skipped.add(node.property);
      } else if (t.isArrayPattern(node)) {
        arrays.push(node);
        for (const [index, element] of node.elements.entries())
          if (element !== null)
            projections.set(element, [...projection, index]);
      } else if (t.isRestElement(node) && t.isObjectPattern(parent)) {
        objectRests.push({ node, projection });
      }
    },
  });
  const facts: PatternSelectionFacts = {
    effects,
    arrays,
    reads,
    objectRests,
    projections,
    inertPrefixes: new WeakMap(),
    prototypeReads: new WeakMap(),
    uncertainReads: new WeakMap(),
  };
  for (const node of selections) patternSelectionFacts.set(node, facts);
  return facts;
};

const referenceSelectionPrecedes = (
  selection: t.AssignmentPattern,
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  // The selected input is read before its default or nested pattern executes.
  // A member assignment target is different: its receiver/key is evaluated
  // before that input read, while its eventual setter runs afterward.
  let current: t.Node | undefined = node;
  while (current !== undefined && current !== selection) {
    if (current === selection.right) return true;
    if (
      current === selection.left &&
      (t.isObjectPattern(current) || t.isArrayPattern(current))
    )
      return true;
    current = state.parentsByNode.get(current);
  }
  return (
    semanticExpressionEvaluationOrder(selection, node, state.parentsByNode) ===
    "before"
  );
};

const selectionProjectsSource = (
  source: JavaScriptSemanticReferenceSource,
  selection: t.AssignmentPattern,
  facts: PatternSelectionFacts,
): boolean => {
  const projection = facts.projections.get(selection);
  return (
    projection !== undefined &&
    projection.length === source.projection.length &&
    projection.every((key, index) => key === source.projection[index])
  );
};

/** Earlier defaults, keys, stores and custom iteration can change a later slot. */
const referenceSelectionStable = (
  source: JavaScriptSemanticReferenceSource,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const selection = source.selection;
  if (selection === undefined) return true;
  const facts = selectionFacts(selection, state);
  const followsSelection = (node: t.Node): boolean =>
    referenceSelectionPrecedes(selection, node, state);
  let inertPrefix = facts.inertPrefixes.get(selection);
  if (inertPrefix === undefined) {
    inertPrefix = facts.effects.every(
      (effect) =>
        (effect === selection.left &&
          t.isMemberExpression(effect) &&
          t.isIdentifier(effect.object) &&
          resolveSemanticBindingState(
            state,
            effect.object,
            effect.object.name,
          ) !== undefined &&
          (!effect.computed ||
            readExactJavaScriptLiteral(effect.property).found)) ||
        followsSelection(effect),
    );
    facts.inertPrefixes.set(selection, inertPrefix);
  }
  if (!inertPrefix || state.prototypeEnumerationMayAffect === false)
    return inertPrefix;
  if (
    !facts.arrays.every(followsSelection) ||
    !selectionProjectsSource(source, selection, facts)
  )
    return false;
  let prototypeReads = facts.prototypeReads.get(source.node);
  if (prototypeReads === undefined) {
    // A wide pattern shares one source inventory. Do not rescan all own slots
    // separately for every default or every consumer of the same reference.
    prototypeReads = facts.reads
      .filter(
        (read) =>
          !syntaxReferenceSourceDefined({
            node: source.node,
            projection: read.projection,
          }),
      )
      .map(({ node }) => node);
    facts.prototypeReads.set(source.node, prototypeReads);
  }
  return prototypeReads.every(followsSelection);
};

const syntaxDataSources = new WeakMap<t.Node, boolean>();

/** Only plain data literals exclude accessor execution before a selected slot. */
const syntaxDataSource = (root: t.Node): boolean => {
  const cached = syntaxDataSources.get(root);
  if (cached !== undefined) return cached;
  let safe = true;
  const skipped = new Set<t.Node>();
  traverseJavaScriptAst(root, {
    skip: (node) => !safe || skipped.has(node),
    enter: (node) => {
      if (
        readExactJavaScriptLiteral(node).found ||
        t.isFunctionExpression(node) ||
        t.isArrowFunctionExpression(node) ||
        t.isRegExpLiteral(node)
      ) {
        for (const child of childNodes(node)) skipped.add(child);
        return;
      }
      if (t.isObjectExpression(node) || t.isArrayExpression(node)) return;
      if (
        t.isObjectProperty(node) &&
        semanticStaticPropertyKey(node.key, node.computed) !== null &&
        (node.computed ||
          node.shorthand ||
          semanticStaticPropertyKey(node.key, false) !== "__proto__")
      ) {
        skipped.add(node.key);
        return;
      }
      if (unwrapJavaScriptExpression(node).node !== node) return;
      safe = false;
    },
  });
  syntaxDataSources.set(root, safe);
  return safe;
};

const semanticDataSources = new WeakMap<JavaScriptSemanticValue, boolean>();

/** Unknown slots may be accessors; do not use their siblings as a no-effect proof. */
const semanticDataSource = (root: JavaScriptSemanticValue): boolean => {
  const cached = semanticDataSources.get(root);
  if (cached !== undefined) return cached;
  const pending = [root];
  const visited = new Set<JavaScriptSemanticValue>();
  let safe = true;
  while (pending.length > 0 && safe) {
    const value = pending.pop();
    if (
      value === undefined ||
      value.status === "literal" ||
      value.status === "union"
    )
      continue;
    if (visited.has(value)) continue;
    visited.add(value);
    const container = semanticContainer(value);
    if (container === null || container.coverage.status !== "complete") {
      safe = false;
      break;
    }
    for (const slot of container.slots) {
      if (slot.presence === "unknown-coverage") safe = false;
      if (slot.presence === "present") pending.push(slot.value);
    }
  }
  semanticDataSources.set(root, safe);
  return safe;
};

const semanticSlotReadKnown = (
  slot: JavaScriptSemanticProperty | undefined,
): boolean =>
  slot?.presence === "absent" ||
  (slot?.presence === "present" &&
    (slot.value.status === "literal" ||
      slot.value.status === "union" ||
      slot.value.status === "object" ||
      slot.value.status === "array"));

/** Only reads before this selection can run an accessor that changes its input. */
const semanticReadPrefixKnown = (
  source: JavaScriptSemanticReferenceSource,
  value: JavaScriptSemanticValue,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const selection = source.selection;
  if (selection === undefined) return false;
  const facts = selectionFacts(selection, state);
  const followsSelection = (node: t.Node): boolean =>
    referenceSelectionPrecedes(selection, node, state);
  // Array element reads come from iteration, not the object-property inventory.
  // Retain the complete data proof for any iteration before this selection.
  if (
    !facts.arrays.every(followsSelection) ||
    !selectionProjectsSource(source, selection, facts)
  )
    return false;
  let uncertainReads = facts.uncertainReads.get(value);
  if (uncertainReads === undefined) {
    const selectedSlot = (projection: PropertyPath) => {
      const path = referenceSourcePath({ ...source, projection });
      return path === undefined ? undefined : semanticSlotAtPath(value, path);
    };
    const propertyReads = facts.reads
      .filter((read) => {
        // Missing properties are inert once the shared prototype proof passed.
        // A known container is a data value; its unread children are irrelevant.
        return !semanticSlotReadKnown(selectedSlot(read.projection));
      })
      .map(({ node }) => node);
    // Object rest reads every retained own field, including getters omitted
    // from the explicit-property inventory. Keep their effects ordered too.
    const restReads = facts.objectRests
      .filter((read) => {
        const slot = selectedSlot(read.projection);
        if (slot?.presence !== "present") return true;
        const container = semanticContainer(slot.value);
        // Rest copies field values without traversing the values' children.
        return (
          container === null ||
          container.coverage.status !== "complete" ||
          !container.slots.every(semanticSlotReadKnown)
        );
      })
      .map(({ node }) => node);
    uncertainReads = [...propertyReads, ...restReads];
    facts.uncertainReads.set(value, uncertainReads);
  }
  return uncertainReads.every(followsSelection);
};

const selectedDefaultInput = (
  source: JavaScriptSemanticReferenceSource,
  state: JavaScriptSemanticAnalysisState,
) => {
  if (!referenceSelectionStable(source, state)) return undefined;
  const path = referenceSourcePath(source);
  if (path === undefined) return undefined;
  // An inert pattern prefix preserves the RHS capture until this selection.
  // Reuse that capture, including its shared named-source snapshot cache.
  const value = evaluateSemanticExpression(source.node, state, source.node);
  if (
    !syntaxDataSource(source.node) &&
    !semanticDataSource(value) &&
    !semanticReadPrefixKnown(source, value, state)
  )
    return undefined;
  return semanticSlotAtPath(value, path);
};

/** Reuse explicit-slot syntax without consulting potentially stale bindings. */
const syntaxReferenceSourceDefined = (
  source: JavaScriptSemanticReferenceSource,
): boolean => {
  if (!syntaxDataSource(source.node)) return false;
  let node = unwrapJavaScriptExpression(source.node).node;
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return false;
    if (t.isObjectExpression(node)) {
      const selected = staticObjectProperty(node, String(key));
      if (selected.status !== "explicit") return false;
      if (
        key === "__proto__" &&
        !selected.property.computed &&
        !selected.property.shorthand
      )
        return false;
      node = selected.property.value;
    } else if (t.isArrayExpression(node)) {
      if (node.elements.some(t.isSpreadElement)) return false;
      const index = semanticArrayIndex(key);
      const element = index === null ? undefined : node.elements[index];
      if (element == null) return false;
      node = element;
    } else return false;
    node = unwrapJavaScriptExpression(node).node;
  }
  return (
    readExactJavaScriptLiteral(node).found ||
    t.isObjectExpression(node) ||
    t.isArrayExpression(node) ||
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node)
  );
};

/** Select a retained source slot at its capture, before later effects. */
export const semanticSelectedReferenceSlot = (
  source: JavaScriptSemanticReferenceSource,
  state: JavaScriptSemanticAnalysisState,
  capturePoint?: t.Node,
) => {
  const path = referenceSourcePath(source);
  if (path === undefined) return undefined;
  return semanticSlotAtPath(
    evaluateSemanticExpression(source.node, state, capturePoint),
    path,
  );
};

const referenceSourcePath = (
  source: JavaScriptSemanticReferenceSource,
): string[] | undefined => {
  const path: string[] = [];
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return undefined;
    path.push(String(key));
  }
  return path;
};

/** Follow copied child references without equating a fresh rest copy with its source. */
export const semanticCopiedReferencePath = (
  initializer: JavaScriptSemanticBindingState["referenceInitializers"][number],
  path: PropertyPath,
  effect: "write" | "escape" | "reference",
): PropertyPath | null => {
  const offset = initializer.copyProjectionOffset;
  if (offset === undefined) return [...initializer.projection, ...path];
  const copiedPath = [...initializer.projection.slice(offset + 1), ...path];
  if (effect === "write" && copiedPath.length < 2) return null;
  if (effect === "reference" && copiedPath.length === 0) return null;
  let [key, ...remaining] = copiedPath;
  if (initializer.copyKind === "array-rest") {
    const startIndex = initializer.copyStartIndex ?? 0;
    if (key === undefined || key === null)
      key = { excludedKeys: [], startIndex };
    else if (typeof key === "object")
      key = {
        excludedKeys: key.excludedKeys.flatMap((name) => {
          const index = semanticArrayIndex(name);
          return index === null ? [] : [String(index + startIndex)];
        }),
        startIndex: (key.startIndex ?? 0) + startIndex,
      };
    else {
      const index = semanticArrayIndex(key);
      if (index === null) return null;
      key = index + startIndex;
    }
  } else {
    const excludedKeys = initializer.copyExcludedKeys ?? [];
    if (key === undefined || key === null) key = { excludedKeys };
    else if (typeof key === "object")
      key = {
        ...key,
        excludedKeys: [...new Set([...key.excludedKeys, ...excludedKeys])].sort(
          compareUnicodeCodePoints,
        ),
      };
    else if (excludedKeys.includes(String(key))) return null;
  }
  return [...initializer.projection.slice(0, offset), key, ...remaining];
};
