import type { z } from "zod";
import { CatalogSchemaError } from "./errors.js";
import {
  appTypesFileSchema,
  catalogFileSchema,
  type RawAppType,
  type RawCondition,
  type RawElementType,
  type RawOperation,
} from "./schema.js";

/** An argument (or output) of an action or condition, e.g. `trackingid: text`. */
export interface ArgumentInfo {
  readonly id: string;
  /** Blue Prism data type name: `text`, `number`, `flag`, `collection`… */
  readonly dataType: string;
}

/** An action, read action or write action allowed on an element type. */
export interface OperationInfo {
  readonly id: string;
  /** Data type a read returns (`text`, `flag`, `collection`…); empty for actions and writes. */
  readonly returns: string;
  /** Every argument, in catalogue order: a step must carry all of them, even empty. */
  readonly arguments: readonly ArgumentInfo[];
  readonly outputs: readonly ArgumentInfo[];
}

/** A Wait condition allowed on an element type. */
export interface ConditionInfo {
  readonly id: string;
  /** Data type of the value the condition yields (`flag` for `WebCheckExists`). */
  readonly dataType: string;
  /** Value Studio proposes to compare with (`True` for flag conditions). */
  readonly defaultValue: string;
  readonly arguments: readonly ArgumentInfo[];
}

/** An Application Manager element type (`Application`, `WebButton`, `WebTextEdit`…). */
export interface ElementTypeInfo {
  readonly id: string;
  /** `Application` for the root element, `Web` for browser elements. */
  readonly appType: string;
  /** Data type of the element itself (`text`, `flag`…); empty for `Application`. */
  readonly defaultDataType: string;
  readonly actions: readonly OperationInfo[];
  readonly readActions: readonly OperationInfo[];
  /** The write action (`WebWrite`), when the type can be written to. */
  readonly writeAction: OperationInfo | undefined;
  readonly conditions: readonly ConditionInfo[];
}

/** A web identifier (`wId`, `wCssSelector`…), in Blue Prism's order. */
export interface WebIdentifierInfo {
  readonly id: string;
  /** `text`, `number` or `flag`. */
  readonly dataType: string;
  readonly enabledByDefault: boolean;
  /** Default comparison (`Equal`, `Wildcard`…). */
  readonly comparison: string;
  readonly userVisible: boolean;
}

/** A selectable application type (`BrowserLaunch`, `BrowserAttach`, `Win32Launch`…). */
export interface AppTypeInfo {
  readonly id: string;
  /** Every parameter, in catalogue order: `apptypeinfo` must list all of them. */
  readonly parameters: readonly AppTypeParameterInfo[];
}

export interface AppTypeParameterInfo {
  /** Name written in `apptypeinfo` (`Path`, `prelaunchbrowser`…). */
  readonly name: string;
  /** Equivalent Blue Prism data type (`text`, `flag`, `number`). */
  readonly dataType: string;
  /** Editor kind in Application Modeller (`File`, `String`, `Boolean`, `List`…). */
  readonly parameterType: string;
  /** Value Application Modeller starts with (`False`, `Internal`, `0`…), if any. */
  readonly defaultValue: string | undefined;
  readonly enabled: boolean;
}

/** The catalogue of one Blue Prism install, as extracted by `bpprobe`. */
export interface Catalog {
  /** Where it came from, e.g. `AMI.dll 10.0.136.0`. */
  readonly source: string;
  readonly elementTypes: readonly ElementTypeInfo[];
  /** Actual BrowserAttach root operations; undefined in older catalogue dumps. */
  readonly browserAttachApplication?: ElementTypeInfo;
  readonly webIdentifiers: readonly WebIdentifierInfo[];
  /** Selectable application types only (the leaves of Blue Prism's type tree). */
  readonly appTypes: readonly AppTypeInfo[];
  /**
   * For Application, omitted kind / BrowserLaunch uses the legacy root; explicit BrowserAttach
   * requires its own profile (undefined means re-extract). Other explicit root modes are unknown.
   * Non-root element lookups are unchanged by applicationKind.
   */
  elementType(id: string, applicationKind?: string): ElementTypeInfo | undefined;
  appType(id: string): AppTypeInfo | undefined;
}

/**
 * Builds a catalogue from the parsed JSON of `bpprobe catalog` and `bpprobe apptypes`.
 * Throws `CatalogSchemaError` when either does not have the expected shape.
 */
export function createCatalog(
  catalogJson: unknown,
  appTypesJson: unknown,
  sources: { catalog?: string; appTypes?: string } = {},
): Catalog {
  const raw = check(catalogFileSchema, catalogJson, sources.catalog ?? "catalog JSON");
  const rawAppTypes = check(appTypesFileSchema, appTypesJson, sources.appTypes ?? "apptypes JSON");

  const elementTypes = raw.browserElementTypes.map(toElementType);
  const browserAttachApplication = raw.browserAttachApplication
    ? toElementType(raw.browserAttachApplication)
    : undefined;
  const webIdentifiers = raw.webIdentifiers.map((i): WebIdentifierInfo => ({
    id: i.id,
    dataType: i.dataType,
    enabledByDefault: i.enableByDefault,
    comparison: i.comparison ?? "",
    userVisible: i.userVisible,
  }));
  const appTypes = rawAppTypes.flatMap(leaves).map((t): AppTypeInfo => ({
    id: t.ID,
    parameters: (t.parameters ?? []).map((p) => ({
      name: p.Name,
      dataType: p.DataTypeEquivalent,
      parameterType: p.ParameterType,
      defaultValue: p.Value ?? undefined,
      enabled: p.Enabled ?? true,
    })),
  }));

  const label = sources.catalog ?? "catalog JSON";
  checkUnique(label, "browserElementTypes", elementTypes);
  checkUnique(label, "webIdentifiers", webIdentifiers);
  checkUnique(sources.appTypes ?? "apptypes JSON", "application types", appTypes);

  const typesById = new Map(elementTypes.map((t) => [t.id, t]));
  const appTypesById = new Map(appTypes.map((t) => [t.id, t]));
  return {
    source: raw.source,
    elementTypes,
    ...(browserAttachApplication ? { browserAttachApplication } : {}),
    webIdentifiers,
    appTypes,
    elementType: (id, applicationKind) => {
      if (
        id !== "Application" ||
        applicationKind === undefined ||
        applicationKind === "BrowserLaunch"
      ) {
        return typesById.get(id);
      }
      return applicationKind === "BrowserAttach" ? browserAttachApplication : undefined;
    },
    appType: (id) => appTypesById.get(id),
  };
}

function check<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new CatalogSchemaError(
    source,
    result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
  );
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((key, i) => (typeof key === "number" ? `[${key}]` : `${i === 0 ? "" : "."}${String(key)}`))
    .join("");
}

function checkUnique(source: string, what: string, items: readonly { id: string }[]): void {
  const seen = new Set<string>();
  const duplicates = items.filter((i) => seen.size === seen.add(i.id).size).map((i) => i.id);
  if (duplicates.length > 0) {
    throw new CatalogSchemaError(source, [`${what}: duplicate id(s) ${duplicates.join(", ")}`]);
  }
}

function leaves(node: RawAppType): RawAppType[] {
  const children = node.subTypes ?? [];
  return children.length === 0 ? [node] : children.flatMap(leaves);
}

function toElementType(t: RawElementType): ElementTypeInfo {
  return {
    id: t.id,
    appType: t.appType,
    defaultDataType: t.defaultDataType ?? "",
    actions: t.actions.map(toOperation),
    readActions: t.readActions.map(toOperation),
    writeAction: t.writeActions[0] && toOperation(t.writeActions[0]),
    conditions: t.conditions.map(toCondition),
  };
}

function toOperation(op: RawOperation): OperationInfo {
  return {
    id: op.id,
    returns: op.returns ?? "",
    arguments: op.arguments.map(toArgument),
    outputs: (op.outputs ?? []).map(toArgument),
  };
}

function toCondition(c: RawCondition): ConditionInfo {
  return {
    id: c.id,
    dataType: c.dataType,
    defaultValue: c.default ?? "",
    arguments: c.arguments.map(toArgument),
  };
}

function toArgument(a: { id: string; dataType: string }): ArgumentInfo {
  return { id: a.id, dataType: a.dataType };
}
