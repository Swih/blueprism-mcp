import { z } from "zod";
import type { LogEntry, NativeValidation, SessionStatus } from "@bpdev/bridge";
import type {
  HarnessAssertionManifest,
  HarnessVerification,
  ObjectSpec,
  TestHarnessSpec,
  QueueConsumerSpec,
} from "@bpdev/generator";
import { RunnerError } from "./errors.js";
import { UUID } from "./store.js";

export interface BuildSpec {
  readonly objects: readonly ObjectSpec[];
  readonly harness: TestHarnessSpec;
}
export interface QueueBuildSpec {
  readonly objects: readonly ObjectSpec[];
  readonly consumer: QueueConsumerSpec;
  readonly expectedOutcome: "Completed" | "CompletedWithExceptions" | "NoAvailableItem" | "Stopped";
  readonly expectedCounts: {
    readonly completed: number;
    readonly businessExceptions: number;
    readonly systemExceptions: number;
  };
}
export interface QueueRecord {
  readonly name: string;
  readonly state: "creating" | "created" | "unknown";
  readonly queueId?: string;
  readonly createdAt: string;
}
export interface Artifact {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly processName: string;
  readonly queue?: { readonly name: string; readonly role: "seed" | "consumer" };
  readonly files: readonly {
    readonly name: string;
    readonly kind: "object" | "process";
    readonly sha256: string;
  }[];
  readonly assertions: HarnessAssertionManifest;
}
export interface StopRequest {
  readonly state: "requesting" | "acknowledged" | "unknown";
  readonly requestedAt: string;
  readonly acknowledgedAt?: string;
}
export interface RunRecord {
  readonly runId: string;
  readonly artifactId: string;
  readonly processName: string;
  readonly resource: string;
  readonly resourcePort?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: "starting" | "running" | "completed" | "failed" | "stopped" | "unknown";
  readonly bpSessionId?: string;
  readonly bpStatus?: SessionStatus;
  readonly verification: HarnessVerification;
  readonly verifiedAt?: string;
  readonly observedAt?: string;
  readonly observationError?: string;
  readonly launchError?: string;
  readonly reconciliationRequired?: boolean;
  readonly logHistoryChanged?: boolean;
  readonly reconciliation?: { readonly recordedAt: string; readonly evidence: string };
  readonly stopRequest?: StopRequest;
  /** Historical log evidence, not proof of which exception BP ultimately propagated. */
  readonly logEvidence?: LogEvidence;
}
export interface LoggedException {
  readonly logIndex: number;
  readonly time: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly exceptionType: string;
  readonly detail: string;
}
export interface LogEvidence {
  readonly source: "AutomateC/getLog";
  readonly scope: "logged-exceptions-only";
  readonly bpSessionId: string;
  readonly observedAt: string;
  readonly logCount: number;
  readonly logSha256: string;
  readonly truncated: boolean;
  readonly firstLoggedException?: LoggedException;
  readonly subsequentLoggedExceptions: readonly LoggedException[];
}
export interface DeploymentRecord {
  readonly artifactId: string;
  readonly state: "not_deployed" | "deploying" | "partial" | "deployed";
  readonly imported: readonly string[];
  readonly updatedAt?: string;
  readonly inFlight?: { readonly operation: "import" | "publish"; readonly name: string };
  readonly publicationResumes?: readonly PublicationResumeAttempt[];
}
export interface PublicationResumeAttempt {
  readonly attempt: number;
  readonly requestedAt: string;
  readonly evidence: string;
  readonly outcome: "pending" | "published" | "already-published" | "unconfirmed";
  readonly completedAt?: string;
}
export const MAX_PUBLICATION_RESUME_ATTEMPTS = 10;
export interface Inspection {
  readonly run: RunRecord;
  readonly logs: readonly LogEntry[];
  readonly nextCursor: number;
  readonly more: boolean;
  readonly observationHealth: "fresh" | "unavailable";
  readonly reason?: string;
  readonly logsTruncated?: boolean;
}
export interface ValidationReport {
  readonly valid: boolean;
  readonly checks: readonly NativeValidation[];
  readonly limitations: readonly string[];
}
export interface StopAcknowledgement {
  readonly requested: true;
  readonly acknowledged: boolean;
  readonly runId: string;
}

const id = z.string().regex(UUID);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const bpName = z.string().regex(/^BPDEV [^\\/:*?"<>|\p{Cc}]{1,150}$/u);
export const artifactSchema = z.strictObject({
  artifactId: id,
  createdAt: timestamp,
  processName: bpName,
  queue: z.strictObject({ name: bpName, role: z.enum(["seed", "consumer"]) }).optional(),
  files: z
    .array(z.strictObject({ name: bpName, kind: z.enum(["object", "process"]), sha256: hash }))
    .min(1)
    .max(11),
  assertions: z.strictObject({
    version: z.literal(1),
    processName: bpName,
    assertions: z.array(
      z.strictObject({
        callIndex: z.number().int().nonnegative(),
        object: bpName,
        action: z.string().min(1),
        outputName: z.string().min(1),
        type: z.enum(["text", "number", "flag", "date", "datetime"]),
        expected: z.string(),
      }),
    ),
  }),
});
/** Read-only compatibility with artifacts produced during the initial runner handoff. */
export const legacyArtifactSchema = artifactSchema.extend({
  files: z
    .array(z.strictObject({ file: z.string(), name: bpName, sha256: hash }))
    .min(2)
    .max(11),
});
export const legacyDeploymentSchema = z.strictObject({
  state: z.enum(["partial", "deployed"]),
  imported: z.array(bpName),
  at: timestamp.optional(),
  reason: z.string().optional(),
});
const assertionBase = { callIndex: z.number().int().nonnegative(), outputName: z.string().min(1) };
const verification = z.strictObject({
  status: z.enum(["passed", "failed", "not_run"]),
  assertions: z.array(
    z.discriminatedUnion("status", [
      z.strictObject({ ...assertionBase, status: z.literal("passed") }),
      z.strictObject({
        ...assertionBase,
        status: z.literal("failed"),
        reason: z.enum([
          "missing_output",
          "missing_value",
          "duplicate_output",
          "type_mismatch",
          "invalid_value",
          "value_mismatch",
        ]),
      }),
    ]),
  ),
});
const loggedException = z.strictObject({
  logIndex: z.number().int().nonnegative(),
  time: z.string().max(64),
  stageId: z.string().max(64),
  stageName: z.string().max(1024),
  exceptionType: z.string().max(256),
  detail: z.string().max(8192),
});
export const runSchema = z.strictObject({
  runId: id,
  artifactId: id,
  processName: bpName,
  resource: z.string().min(1),
  resourcePort: z.number().int().min(1).max(65535).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  state: z.enum(["starting", "running", "completed", "failed", "stopped", "unknown"]),
  bpSessionId: z.string().regex(new RegExp(UUID.source, "i")).optional(),
  bpStatus: z
    .enum([
      "Pending",
      "Running",
      "Failed",
      "Stopped",
      "Completed",
      "Debugging",
      "Archived",
      "StopRequested",
      "Stalled",
      "PendingDeletion",
    ])
    .optional(),
  verification,
  verifiedAt: timestamp.optional(),
  observedAt: timestamp.optional(),
  observationError: z.string().optional(),
  launchError: z.string().optional(),
  reconciliationRequired: z.boolean().optional(),
  logHistoryChanged: z.boolean().optional(),
  reconciliation: z
    .strictObject({ recordedAt: timestamp, evidence: z.string().min(20).max(2000) })
    .optional(),
  stopRequest: z
    .strictObject({
      state: z.enum(["requesting", "acknowledged", "unknown"]),
      requestedAt: timestamp,
      acknowledgedAt: timestamp.optional(),
    })
    .optional(),
  logCheckpoint: z.strictObject({ count: z.number().int().nonnegative(), sha256: hash }).optional(),
  logEvidence: z
    .strictObject({
      source: z.literal("AutomateC/getLog"),
      scope: z.literal("logged-exceptions-only"),
      bpSessionId: z.string().regex(new RegExp(UUID.source, "i")),
      observedAt: timestamp,
      logCount: z.number().int().nonnegative(),
      logSha256: hash,
      truncated: z.boolean(),
      firstLoggedException: loggedException.optional(),
      subsequentLoggedExceptions: z.array(loggedException).max(19),
    })
    .optional(),
});
export type StoredRun = RunRecord & {
  readonly logCheckpoint?: { readonly count: number; readonly sha256: string };
};
export const deploymentSchema = z.strictObject({
  artifactId: id,
  artifactHash: hash,
  state: z.enum(["deploying", "partial", "deployed"]),
  imported: z.array(bpName),
  updatedAt: timestamp,
  inFlight: z.strictObject({ operation: z.enum(["import", "publish"]), name: bpName }).optional(),
  publicationResumes: z
    .array(
      z
        .strictObject({
          attempt: z.number().int().min(1).max(MAX_PUBLICATION_RESUME_ATTEMPTS),
          requestedAt: timestamp,
          evidence: z
            .string()
            .max(2000)
            .refine((value) => value.trim().length >= 20),
          outcome: z.enum(["pending", "published", "already-published", "unconfirmed"]),
          completedAt: timestamp.optional(),
        })
        .refine(
          (attempt) => (attempt.outcome === "pending") === (attempt.completedAt === undefined),
        ),
    )
    .min(1)
    .max(MAX_PUBLICATION_RESUME_ATTEMPTS)
    .refine((attempts) => attempts.every((attempt, index) => attempt.attempt === index + 1))
    .optional(),
});
export const reservationSchema = z.strictObject({
  runId: id,
  artifactId: id,
  resource: z.string().min(1),
  resourcePort: z.number().int().min(1).max(65535).optional(),
});
export const queueRecordSchema = z.strictObject({
  name: bpName,
  state: z.enum(["creating", "created", "unknown"]),
  queueId: id.optional(),
  createdAt: timestamp,
  seedRunId: id.optional(),
});

export function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new RunnerError(
      "STORE_INTEGRITY",
      "Runner record does not satisfy its versioned contract",
    );
  return result.data;
}
export function safeName(name: string): void {
  if (!bpName.safeParse(name).success)
    throw new RunnerError("INVALID_SPEC", "v1 artifacts require a safe BPDEV name");
}
export const unverified: HarnessVerification = { status: "not_run", assertions: [] };
export const now = (): string => new Date().toISOString();
export const terminal = (state: RunRecord["state"]): boolean =>
  ["completed", "failed", "stopped"].includes(state);
export function publicRun(record: StoredRun): RunRecord {
  const { logCheckpoint: _, ...run } = record;
  return run;
}
