/**
 * zod schemas of the raw JSON written by `bpprobe catalog` and `bpprobe apptypes`. Only the
 * fields the catalogue exposes are checked; SS&C display names and help texts are optional
 * (the committed test fixtures leave them out) and dropped.
 */
import { z } from "zod";

const id = z.string().min(1);

const argument = z.object({ id, dataType: z.string().min(1) });

const operation = z.object({
  id,
  /** Data type of the value a read returns; empty for actions. */
  returns: z.string().nullish(),
  arguments: z.array(argument),
  outputs: z.array(argument).nullish(),
});

const condition = z.object({
  id,
  dataType: z.string().min(1),
  default: z.string().nullish(),
  arguments: z.array(argument),
});

const elementType = z.object({
  id,
  appType: z.string().min(1),
  defaultDataType: z.string().nullish(),
  actions: z.array(operation),
  readActions: z.array(operation),
  // Blue Prism allows at most one write action per element type.
  writeActions: z.array(operation).max(1),
  conditions: z.array(condition),
});

const webIdentifier = z.object({
  id,
  dataType: z.string().min(1),
  enableByDefault: z.boolean(),
  comparison: z.string().nullish(),
  userVisible: z.boolean(),
});

export const catalogFileSchema = z.object({
  source: z.string(),
  browserElementTypes: z.array(elementType).min(1),
  /** Absent in older dumps; an explicit BrowserAttach lookup must then request re-extraction. */
  browserAttachApplication: elementType
    .extend({ id: z.literal("Application"), appType: z.literal("Application") })
    .optional(),
  webIdentifiers: z.array(webIdentifier).min(1),
});

const appTypeParameter = z.object({
  Name: id,
  DataTypeEquivalent: z.string().min(1),
  ParameterType: z.string().min(1),
  Value: z.string().nullish(),
  Enabled: z.boolean().nullish(),
});

export interface RawAppType {
  ID: string;
  parameters?: z.infer<typeof appTypeParameter>[] | null | undefined;
  subTypes?: RawAppType[] | null | undefined;
}

const appType: z.ZodType<RawAppType> = z.lazy(() =>
  z.object({
    ID: id,
    parameters: z.array(appTypeParameter).nullish(),
    subTypes: z.array(appType).nullish(),
  }),
);

export const appTypesFileSchema = z.array(appType).min(1);

export type RawCatalogFile = z.infer<typeof catalogFileSchema>;
export type RawElementType = z.infer<typeof elementType>;
export type RawOperation = z.infer<typeof operation>;
export type RawCondition = z.infer<typeof condition>;
