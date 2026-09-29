import { z } from "zod";
import { SpecValidationError } from "./errors.js";

// Bounded native queue loop, one text key, one attempt and no automatic item retry.
// Queue keys do not guarantee seed deduplication.
const name = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[^<>:"/\\|?*]+$/)
  .refine(noControlCharacters, "control characters are not allowed")
  .refine(
    (value) => !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value),
    "reserved Windows file name",
  )
  .refine(
    (value) => value.trim() === value && !/[. ]$/.test(value),
    "must not start/end with whitespace or end with a dot",
  );
const label = z
  .string()
  .min(1)
  .max(120)
  .refine(noControlCharacters, "control characters are not allowed")
  .refine(
    (value) => !value.includes("[") && !value.includes("]"),
    "brackets are not allowed in parameter names",
  );

export const queueDefinitionSpecSchema = z.strictObject({
  name,
  keyField: z.literal("CaseKey").default("CaseKey"),
  maxAttempts: z.literal(1).default(1),
  /** Explicit source timestamp keeps the generated release reproducible. */
  createdAt: z.iso.datetime(),
});

export const queueSeedSpecSchema = z
  .strictObject({
    name,
    queueName: name,
    items: z
      .array(z.strictObject({ CaseKey: z.string().min(1).max(255).refine(noControlCharacters) }))
      .min(1)
      .max(20),
  })
  .superRefine((spec, ctx) => {
    const keys = new Set<string>();
    spec.items.forEach((item, index) => {
      if (keys.has(item.CaseKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "CaseKey"],
          message: "duplicate case key in seed batch",
        });
      }
      keys.add(item.CaseKey);
    });
  });

const actionReference = z.strictObject({ object: label, action: label });

export const queueConsumerSpecSchema = z
  .strictObject({
    name,
    queueName: name,
    maxItems: z.number().int().min(1).max(1000).default(100),
    consecutiveSystemExceptionLimit: z.number().int().min(1).max(100).default(3),
    retryPolicy: z.literal("never").default("never"),
    /** Both absent: supplied action owns its lifecycle. Both present: template owns it. */
    launch: actionReference.optional(),
    cleanup: actionReference.optional(),
    call: z.strictObject({
      object: label,
      action: label,
      input: label,
      confirmationOutput: label,
      /** Compare this literal prefix concatenated with the actual queue case key. */
      expectedConfirmationPrefix: z.string().min(1).max(256).refine(noControlCharacters),
      /** Only an explicitly correlated rejection may be classified as a business exception. */
      businessRejectionPrefix: z.string().min(1).max(256).refine(noControlCharacters).optional(),
    }),
  })
  .superRefine((spec, ctx) => {
    if (spec.call.businessRejectionPrefix === spec.call.expectedConfirmationPrefix)
      ctx.addIssue({
        code: "custom",
        path: ["call", "businessRejectionPrefix"],
        message: "rejection and confirmation prefixes must differ",
      });
    if ((spec.launch === undefined) !== (spec.cleanup === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["cleanup"],
        message: "launch and cleanup must be supplied together",
      });
    }
  });

export type QueueDefinitionSpec = z.input<typeof queueDefinitionSpecSchema>;
export type QueueSeedSpec = z.input<typeof queueSeedSpecSchema>;
export type QueueConsumerSpec = z.input<typeof queueConsumerSpecSchema>;
export type ParsedQueueConsumerSpec = z.output<typeof queueConsumerSpecSchema>;

function noControlCharacters(value: string): boolean {
  return !Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

export function parseQueueSpec<T>(schema: z.ZodType<T>, value: unknown, spec: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new SpecValidationError(
    spec,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    })),
  );
}
