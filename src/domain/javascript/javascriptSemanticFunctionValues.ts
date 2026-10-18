import * as t from "@babel/types";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";

type Path = readonly string[];
type Projection = readonly (string | null)[];
type RetainReadDependency = (path: Path, ownFrom: number) => void;

export interface SemanticFunctionValueReadDependency {
  readonly path: Path;
  /** The selection in the original path which reads this slot. */
  readonly offset: number;
  /** Replacing an already captured owner does not mutate its properties. */
  readonly ownFrom: number;
}

export const INVOCATION_HELPERS = ["call", "apply", "bind"];

const callableValueIdentities = new WeakMap<t.Node, Path>();
let nextCallableValueIdentity = 0;

/** Internal allocation identity; aliases share it without equating the target. */
export const semanticCallableValueIdentity = (node: t.Node): Path => {
  let path = callableValueIdentities.get(node);
  if (path === undefined) {
    path = ["callable-value", String(nextCallableValueIdentity++)];
    callableValueIdentities.set(node, path);
  }
  return path;
};

interface FunctionValue {
  readonly path: Path;
  readonly kind:
    | "function"
    | "function-constructor"
    | "function-prototype"
    | "object-constructor"
    | "object-prototype"
    | "object-instance"
    | "instance-prototype"
    | "exotic-constructor"
    | "exotic-prototype"
    | "namespace"
    | "primitive"
    | "unknown-external";
  readonly owner?: FunctionValue;
  readonly family?: string;
  readonly ownsPrototype?: boolean;
  readonly external?: boolean;
}

const FUNCTION: FunctionValue = {
  path: ["global", "Function"],
  kind: "function-constructor",
  external: true,
};
const FUNCTION_PROTOTYPE: FunctionValue = {
  path: ["global", "Function", "prototype"],
  kind: "function-prototype",
  external: true,
};
const OBJECT: FunctionValue = {
  path: ["global", "Object"],
  kind: "object-constructor",
  external: true,
};
const OBJECT_PROTOTYPE: FunctionValue = {
  path: ["global", "Object", "prototype"],
  kind: "object-prototype",
  external: true,
};

// Unknown external slots may hold callable values. One joined state survives
// further selections; storing each spelling would multiply wildcard paths.
const UNKNOWN_EXTERNAL: FunctionValue = {
  path: ["unknown-external"],
  kind: "unknown-external",
  external: true,
};
const NAMESPACES = new Set([
  "Math",
  "JSON",
  "Atomics",
  "console",
  "Reflect",
  "Intl",
  "WebAssembly",
]);
const NUMBER_CONSTANTS: Readonly<Record<string, readonly string[]>> = {
  "global.Math": [
    "E",
    "LN2",
    "LN10",
    "LOG2E",
    "LOG10E",
    "PI",
    "SQRT1_2",
    "SQRT2",
  ],
  "global.Number": [
    "EPSILON",
    "MAX_SAFE_INTEGER",
    "MAX_VALUE",
    "MIN_SAFE_INTEGER",
    "MIN_VALUE",
    "NaN",
    "NEGATIVE_INFINITY",
    "POSITIVE_INFINITY",
  ],
};

// These are value facts, not permissions to invoke an intrinsic. Read proofs
// still establish binding and property integrity at each capture separately.
const FUNCTION_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "global.Object": [
    "assign",
    "create",
    "defineProperty",
    "defineProperties",
    "entries",
    "fromEntries",
    "freeze",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "getPrototypeOf",
    "groupBy",
    "hasOwn",
    "is",
    "isExtensible",
    "isFrozen",
    "isSealed",
    "keys",
    "preventExtensions",
    "seal",
    "setPrototypeOf",
    "values",
  ],
  "global.Object.prototype": [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
  ],
  "global.Function.prototype": ["toString"],
  "global.Reflect": [
    "apply",
    "construct",
    "defineProperty",
    "deleteProperty",
    "get",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "has",
    "isExtensible",
    "ownKeys",
    "preventExtensions",
    "set",
    "setPrototypeOf",
  ],
  "global.Array": ["from", "fromAsync", "isArray", "of"],
  "global.require": ["resolve"],
  "commonjs-module.constructor": [
    "_load",
    "_resolveFilename",
    "_resolveLookupPaths",
    "_initPaths",
    "_preloadModules",
    "createRequire",
    "findPackageJSON",
    "isBuiltin",
    "register",
    "registerHooks",
    "syncBuiltinESMExports",
  ],
};

const ordinary = (path: Path, ownsPrototype = true): FunctionValue => ({
  path,
  kind: "function",
  ownsPrototype,
  external: path[0] === "global" || path[0] === "commonjs-module",
});

const MODULE_CONSTRUCTOR = ordinary(["commonjs-module", "constructor"]);
const MODULE_REQUIRE = ordinary(["commonjs-module", "__proto__", "require"]);
const MODULE_PROTOTYPE: FunctionValue = {
  path: ["commonjs-module", "__proto__"],
  kind: "instance-prototype",
  owner: MODULE_CONSTRUCTOR,
  external: true,
};

// Main, parents, and children can be absent or belong to another wrapper.
// This finite value describes their type, not a shared instance identity: only
// selected constructor/prototype/delegate values leave this projection walk.
const MODULE_INSTANCE: FunctionValue = {
  path: ["module-instance"],
  kind: "object-instance",
  owner: MODULE_CONSTRUCTOR,
};
const WRAPPER_MODULE_INSTANCE: FunctionValue = {
  ...MODULE_INSTANCE,
  path: ["commonjs-module"],
};
const MODULE_CHILDREN: FunctionValue = {
  path: ["module-children"],
  kind: "object-instance",
  owner: ordinary(["global", "Array"]),
};
// require.cache and Module._cache initially expose the same null-prototype
// dictionary. An arbitrary entry can be this wrapper as well as another Module.
const MODULE_CACHE: FunctionValue = {
  path: ["commonjs-module", "constructor", "_cache"],
  kind: "object-instance",
};
const MODULE_INSTANCE_MEMBERS = {
  parent: MODULE_INSTANCE,
  children: MODULE_CHILDREN,
  require: MODULE_REQUIRE,
};

// Typed slots and inherited aliases are not ordinary functions at their nominal
// path. Exact and wildcard selections consume this same member inventory.
const VALUE_MEMBERS: Readonly<
  Record<string, Readonly<Record<string, FunctionValue>>>
> = {
  "global.require": { main: MODULE_INSTANCE, cache: MODULE_CACHE },
  "commonjs-module": MODULE_INSTANCE_MEMBERS,
  "module-instance": {
    ...MODULE_INSTANCE_MEMBERS,
    // Another module's exports are externally supplied. Source-added instance
    // slots and the current wrapper's exports remain with the store owner.
    exports: UNKNOWN_EXTERNAL,
  },
  "commonjs-module.constructor": {
    Module: MODULE_CONSTRUCTOR,
    prototype: MODULE_PROTOTYPE,
    _cache: MODULE_CACHE,
  },
  "commonjs-module.__proto__": { require: MODULE_REQUIRE },
};

const hasFunctionHelpers = (value: FunctionValue): boolean =>
  [
    "function",
    "function-constructor",
    "function-prototype",
    "object-constructor",
    "exotic-constructor",
    "exotic-prototype",
  ].includes(value.kind);

// CommonJS callable own slots have an explicit inventory. Source-added slots
// belong to the ambient store owner, rather than an unknown external value.
// Their external prototype objects still expose separately selected members.
const hasOpenMembers = (value: FunctionValue): boolean =>
  value.external === true &&
  !(
    value.kind === "function" &&
    (value.path[0] === "commonjs-module" ||
      (value.path[0] === "global" && value.path[1] === "require"))
  );

const primitive = (name: "String" | "Number"): FunctionValue => ({
  path: ["primitive", name],
  kind: "primitive",
  owner: ordinary(["global", name]),
  external: true,
});

const exotic = (family: string, prototype: boolean): FunctionValue => ({
  path: ["function-family", family, prototype ? "prototype" : "constructor"],
  kind: prototype ? "exotic-prototype" : "exotic-constructor",
  family,
});

/** Select values, keeping callable prototypes separate from ordinary objects. */
const propertyValue = (
  value: FunctionValue,
  key: string,
  retainReadDependency?: RetainReadDependency,
): FunctionValue | undefined => {
  retainReadDependency?.([...value.path, key], value.path.length);
  const members = VALUE_MEMBERS[value.path.join(".")];
  if (members !== undefined && Object.hasOwn(members, key)) return members[key];
  if (value === MODULE_CHILDREN && semanticArrayIndex(key) !== null)
    return MODULE_INSTANCE;
  if (INVOCATION_HELPERS.includes(key) && hasFunctionHelpers(value))
    return inheritedCallable(
      value,
      key,
      FUNCTION_PROTOTYPE,
      retainReadDependency,
    );
  if (hasFunctionHelpers(value) && (key === "name" || key === "length"))
    return primitive(key === "name" ? "String" : "Number");
  if (
    NUMBER_CONSTANTS[value.path.join(".")]?.includes(key) ||
    (key === "length" &&
      (value === MODULE_CHILDREN ||
        value.path.join(".") === "global.Array.prototype" ||
        value.path.join(".") === "primitive.String"))
  )
    return primitive("Number");
  if (FUNCTION_MEMBERS[value.path.join(".")]?.includes(key))
    return ordinary(
      [...value.path, key],
      value.path[0] === "commonjs-module" ||
        value.path.join(".") === "global.require",
    );
  if (hasFunctionHelpers(value) && key === "toString")
    return inheritedCallable(
      value,
      key,
      FUNCTION_PROTOTYPE,
      retainReadDependency,
    );
  if (
    (hasFunctionHelpers(value) ||
      (value.kind === "object-instance" && value.owner !== undefined) ||
      value.kind === "instance-prototype") &&
    FUNCTION_MEMBERS["global.Object.prototype"]!.includes(key)
  )
    return inheritedCallable(
      value,
      key,
      OBJECT_PROTOTYPE,
      retainReadDependency,
    );
  if (key === "constructor") {
    if (value.kind === "object-instance" || value.kind === "primitive")
      return value.owner;
    if (value.kind === "instance-prototype")
      return value.owner?.family?.includes("generator")
        ? exotic(value.owner.family, true)
        : value.owner;
    if (value.kind === "object-prototype" || value.kind === "namespace")
      return OBJECT;
    if (value.kind === "exotic-prototype") return exotic(value.family!, false);
    return value.family === undefined ? FUNCTION : exotic(value.family, false);
  }
  if (key === "__proto__") {
    if (value.kind === "object-prototype") return undefined;
    if (value.kind === "object-instance" || value.kind === "primitive")
      return value.owner === undefined
        ? undefined
        : propertyValue(value.owner, "prototype");
    if (
      value.kind === "function-prototype" ||
      value.kind === "instance-prototype" ||
      value.kind === "namespace"
    )
      return OBJECT_PROTOTYPE;
    if (value.kind === "exotic-constructor") return FUNCTION;
    if (value.kind === "exotic-prototype") return FUNCTION_PROTOTYPE;
    return value.family === undefined
      ? FUNCTION_PROTOTYPE
      : exotic(value.family, true);
  }
  if (key !== "prototype") return undefined;
  if (value.kind === "function-constructor") return FUNCTION_PROTOTYPE;
  if (value.kind === "object-constructor") return OBJECT_PROTOTYPE;
  if (value.kind === "exotic-constructor") return exotic(value.family!, true);
  if (value.kind !== "function" || value.ownsPrototype !== true)
    return undefined;
  return {
    path: [...value.path, key],
    kind: "instance-prototype",
    owner: value,
    external: value.external === true,
  };
};

/** Keep the traversed links and shadow slots with the value selection owner. */
const inheritedCallable = (
  value: FunctionValue,
  key: string,
  provider: FunctionValue,
  retainReadDependency?: RetainReadDependency,
): FunctionValue => {
  if (retainReadDependency !== undefined) {
    let current = value;
    const visited = new Set<string>();
    while (current.path.join(".") !== provider.path.join(".")) {
      const identity = `${current.kind}:${current.path.join(".")}`;
      if (visited.has(identity)) break;
      visited.add(identity);
      retainReadDependency([...current.path, "__proto__"], current.path.length);
      const parent = propertyValue(current, "__proto__");
      if (parent === undefined) break;
      retainReadDependency([...parent.path, key], parent.path.length);
      current = parent;
    }
  }
  return ordinary([...provider.path, key], false);
};

const possiblePropertyValues = (
  value: FunctionValue,
  key: string,
  retainReadDependency?: RetainReadDependency,
): readonly FunctionValue[] => {
  if (value === MODULE_CACHE) return [MODULE_INSTANCE, WRAPPER_MODULE_INSTANCE];
  if (value.kind === "unknown-external") {
    if (INVOCATION_HELPERS.includes(key))
      return [
        UNKNOWN_EXTERNAL,
        ordinary(["global", "Function", "prototype", key], false),
      ];
    if (key === "constructor") return [UNKNOWN_EXTERNAL, FUNCTION, OBJECT];
    if (key === "__proto__" || key === "prototype")
      return [UNKNOWN_EXTERNAL, FUNCTION_PROTOTYPE, OBJECT_PROTOTYPE];
    return [UNKNOWN_EXTERNAL];
  }
  const selected = propertyValue(value, key, retainReadDependency);
  if (selected !== undefined) return [selected];
  // Known absent prototype boundaries and primitive metadata must not become
  // functions merely because their owner is external.
  if (key === "prototype" || key === "__proto__") return [];
  return hasOpenMembers(value) ? [UNKNOWN_EXTERNAL] : [];
};

const rootValue = (
  path: Projection,
): { readonly value: FunctionValue; readonly length: number } | undefined => {
  if (path[0] === "global" && typeof path[1] === "string") {
    const name = path[1];
    if (name === "Function") return { value: FUNCTION, length: 2 };
    if (name === "Object") return { value: OBJECT, length: 2 };
    if (NAMESPACES.has(name))
      return {
        value: { path: ["global", name], kind: "namespace", external: true },
        length: 2,
      };
    if (name === "undefined") return undefined;
    if (name === "NaN" || name === "Infinity")
      return { value: primitive("Number"), length: 2 };
    return { value: ordinary(["global", name]), length: 2 };
  }
  if (path[0] === "commonjs-module")
    return { value: WRAPPER_MODULE_INSTANCE, length: 1 };
  return undefined;
};

/** Join equivalent values after each segment; alias paths never multiply. */
const selectedValues = (
  initial: FunctionValue,
  projection: Projection,
  retainModuleStorageProjection?: (
    path: Projection,
    suffixOffset: number,
  ) => void,
  retainReadDependency?: (
    path: Path,
    ownFrom: number,
    suffixOffset: number,
  ) => void,
): readonly FunctionValue[] => {
  let values = [initial];
  for (const [index, key] of projection.entries()) {
    const next = new Map<string, FunctionValue>();
    for (const value of values) {
      // A known shared owner also gives a nominal storage path when its member
      // value is unknown. Keep that fact separate from function identities;
      // abandoning the suffix would lose stores through equivalent owners.
      if (
        retainModuleStorageProjection !== undefined &&
        value.path[0] === "commonjs-module" &&
        (key === null || propertyValue(value, key) === undefined)
      )
        retainModuleStorageProjection(
          [...value.path, ...projection.slice(index)],
          index,
        );
      const keys =
        key === null
          ? [
              ...INVOCATION_HELPERS,
              "constructor",
              "__proto__",
              "prototype",
              ...(FUNCTION_MEMBERS[value.path.join(".")] ?? []),
              ...Object.keys(VALUE_MEMBERS[value.path.join(".")] ?? {}),
            ]
          : [key];
      if (key === null && hasOpenMembers(value))
        next.set("unknown-external:unknown-external", UNKNOWN_EXTERNAL);
      if (key === null && value === MODULE_CHILDREN)
        next.set("object-instance:module-instance", MODULE_INSTANCE);
      for (const property of keys) {
        for (const selected of possiblePropertyValues(
          value,
          property,
          retainReadDependency === undefined
            ? undefined
            : (path, ownFrom) => retainReadDependency(path, ownFrom, index),
        )) {
          retainReadDependency?.(
            selected.path,
            selected.path.length - 1,
            index,
          );
          next.set(`${selected.kind}:${selected.path.join(".")}`, selected);
        }
      }
    }
    values = [...next.values()];
    if (values.length === 0) break;
  }
  return values;
};

/** Slot and prototype dependencies of possible value selection, not proof that
 * the source currently reads that value. Capture timing remains with callers. */
export const semanticFunctionValueReadDependencies = (
  path: Path,
  source?: t.Function,
): readonly SemanticFunctionValueReadDependency[] => {
  const root =
    source === undefined
      ? rootValue(path)
      : {
          value: sourceFunctionValue(
            source,
            false,
            semanticCallableValueIdentity(source),
          ),
          length: 2,
        };
  if (root === undefined)
    return [{ path, offset: path.length - 1, ownFrom: 0 }];
  const dependencies = new Map<string, SemanticFunctionValueReadDependency>();
  const retain = (selected: Path, ownFrom: number, offset: number) => {
    if (
      ![
        "global",
        "commonjs-module",
        "callable-value",
        "function-family",
      ].includes(selected[0]!)
    )
      return;
    const dependency = { path: selected, offset, ownFrom };
    dependencies.set(JSON.stringify(dependency), dependency);
  };
  retain(path.slice(0, root.length), 0, root.length - 1);
  for (let offset = root.length; offset < path.length; offset += 1)
    retain(path.slice(0, offset + 1), offset, offset);
  selectedValues(
    root.value,
    path.slice(root.length),
    undefined,
    (selected, ownFrom, offset) =>
      retain(selected, ownFrom, root.length + offset),
  );
  return [...dependencies.values()];
};

/** Exact selectors are limited to the captures whose dependencies the loader
 * owner already validates. Possible constructor/member values do not grant
 * strict read proof for their inherited selection slots. */
export const semanticFunctionValueIdentity = (
  path: Projection,
): Path | undefined => {
  let rootLength: number;
  if (path[0] === "global" && ["require", "Function"].includes(path[1] ?? ""))
    rootLength = 2;
  else if (path[0] === "global" && path[1] === "Reflect" && path[2] === "apply")
    rootLength = 3;
  else if (path[0] === "commonjs-module") {
    if (path[1] === "require") rootLength = 2;
    else if (
      (path[1] === "__proto__" && path[2] === "require") ||
      (path[1] === "constructor" && path[2] === "createRequire")
    )
      rootLength = 3;
    else return undefined;
  } else return undefined;
  let identity = path.slice(0, rootLength) as Path;
  for (const key of path.slice(rootLength)) {
    if (key !== null && INVOCATION_HELPERS.includes(key))
      identity = ["global", "Function", "prototype", key];
    else if (
      (key === "prototype" && identity.join(".") === "global.Function") ||
      (key === "__proto__" &&
        identity.join(".") !== "global.Function.prototype")
    )
      identity = ["global", "Function", "prototype"];
    else return undefined;
  }
  return identity;
};

/** Possible selected values invalidate reads but never prove an invocation.
 * The optional callback separately retains nominal storage projections below
 * known Module owners, with the original suffix offset for capture tracking;
 * those paths do not establish the stored value's type. */
export const semanticPossibleFunctionValueIdentities = (
  path: Projection,
  retainModuleStorageProjection?: (
    path: Projection,
    suffixOffset: number,
  ) => void,
): readonly Path[] => {
  const root = rootValue(path);
  return root === undefined
    ? []
    : selectedValues(
        root.value,
        path.slice(root.length),
        retainModuleStorageProjection === undefined
          ? undefined
          : (storage, offset) =>
              retainModuleStorageProjection(storage, root.length + offset),
      )
        .filter(
          (value) =>
            value.path[0] === "global" || value.path[0] === "commonjs-module",
        )
        .map((value) => value.path);
};

export const semanticOrdinaryFunctionValueIdentities = (
  projection: Projection,
): readonly Path[] =>
  selectedValues(ordinary(["source-function"]), projection)
    .filter((selected) => selected.path[0] === "global")
    .map((selected) => selected.path);

/** Source callables share helpers, but own helpers/prototypes remain local. */
const sourceFunctionValue = (
  node: t.Function | t.Class,
  bound: boolean,
  path: Path,
): FunctionValue => {
  const family =
    t.isFunction(node) && (node.async || node.generator)
      ? `${node.async ? "async" : ""}${node.generator ? "generator" : ""}`
      : undefined;
  return {
    ...ordinary(
      path,
      !bound &&
        (t.isClass(node) ||
          (t.isFunction(node) &&
            (node.generator === true ||
              (!node.async &&
                !t.isArrowFunctionExpression(node) &&
                !t.isObjectMethod(node) &&
                !t.isClassMethod(node) &&
                !t.isClassPrivateMethod(node))))),
    ),
    ...(family === undefined ? {} : { family }),
  };
};

export const semanticSourceFunctionValueIdentities = (
  node: t.Function | t.Class,
  projection: Projection,
  bound = false,
): readonly Path[] => {
  return selectedValues(
    sourceFunctionValue(node, bound, ["source-function"]),
    projection,
  )
    .filter((selected) =>
      ["global", "function-family"].includes(selected.path[0]!),
    )
    .map((selected) => selected.path);
};

/** Default inherited slots only; the caller owns exclusion of source-written
 * properties and custom literal prototypes before selecting these values. */
export const semanticLiteralInheritedValueIdentities = (
  kind: "object" | "array",
  projection: Projection,
): readonly Path[] =>
  selectedValues(
    {
      path: ["source-instance"],
      kind: "object-instance",
      owner: kind === "object" ? OBJECT : ordinary(["global", "Array"]),
      external: true,
    },
    projection,
  )
    .filter((selected) => selected.path[0] === "global")
    .map((selected) => selected.path);
