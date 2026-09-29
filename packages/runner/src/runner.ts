import type { Catalog } from "@bpdev/catalog";
import {
  generateObject,
  generateTestHarness,
  generateQueueSeed,
  generateQueueConsumer,
  verifyHarnessOutputs,
  type GeneratedFile,
  type QueueSeedSpec,
  type HarnessAssertionManifest,
  type HarnessOutput,
} from "@bpdev/generator";
import {
  CommandFailedError,
  CredentialsError,
  InvalidArgumentError,
  ToolLaunchError,
  type AutomateC,
  type RuntimeListener,
  type NativeProbe,
  type NativeValidation,
  type SessionStatus,
} from "@bpdev/bridge";
import {
  artifactSchema,
  checked,
  deploymentSchema,
  legacyArtifactSchema,
  legacyDeploymentSchema,
  MAX_PUBLICATION_RESUME_ATTEMPTS,
  now,
  publicRun,
  reservationSchema,
  queueRecordSchema,
  runSchema,
  safeName,
  terminal,
  unverified,
  type Artifact,
  type BuildSpec,
  type QueueBuildSpec,
  type QueueRecord,
  type DeploymentRecord,
  type PublicationResumeAttempt,
  type Inspection,
  type RunRecord,
  type StoredRun,
  type StopAcknowledgement,
  type ValidationReport,
} from "./contracts.js";
import { RunnerError } from "./errors.js";
import { applyPolicy, applyObjectPolicy, DEFAULT_BROWSER_PATH } from "./policy.js";
import { fingerprint, Store, UUID } from "./store.js";
import { exceptionEvidence } from "./diagnostics.js";

export type { Artifact, BuildSpec, RunRecord } from "./contracts.js";
export interface RunnerOptions {
  readonly dataDirectory: string;
  readonly robotProfileDirectory: string;
  readonly browserPath?: string;
  readonly resource: string;
  readonly resourcePort?: number;
  readonly catalog: Catalog;
  readonly automatec: Pick<
    AutomateC,
    "listProcesses" | "import" | "publish" | "export" | "run" | "status" | "getLog" | "requestStop"
  > &
    Partial<Pick<AutomateC, "createQueue">>;
  readonly listener: Pick<RuntimeListener, "busy" | "status"> & {
    outputs(sessionId: string): Promise<readonly HarnessOutput[]>;
  };
  readonly probe: Pick<NativeProbe, "validate">;
}
const filename = (file: Artifact["files"][number], index: number): string =>
  file.kind === "process" ? "process.bpprocess" : `object-${index}.bpobject`;
const unavailable = (message: string): never => {
  throw new RunnerError("OBSERVATION_UNAVAILABLE", message);
};

/** Product loop with write-ahead journals. A lost acknowledgement never permits replay. */
export class Runner {
  private readonly store: Store;
  constructor(private readonly options: RunnerOptions) {
    this.store = new Store(options.dataDirectory);
    if (!options.resource.trim() || /\p{Cc}/u.test(options.resource))
      throw new RunnerError("INVALID_OPTIONS", "A resource name is required");
    if (
      !/^[a-z]:[\\/]/i.test(options.robotProfileDirectory) ||
      /[\p{Cc}"]/u.test(options.robotProfileDirectory)
    )
      throw new RunnerError(
        "INVALID_OPTIONS",
        "A dedicated absolute Windows robot profile is required",
      );
  }
  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async prepare(input: BuildSpec): Promise<Artifact> {
    const spec = applyPolicy(input, this.options.browserPath ?? DEFAULT_BROWSER_PATH);
    const objects = spec.objects.map((object) =>
      generateObject(object, this.options.catalog, {
        robotProfileDir: this.options.robotProfileDirectory,
      }),
    );
    const harness = generateTestHarness(spec.harness, spec.objects, this.options.catalog);
    return this.persistArtifact(objects, harness, harness.assertionManifest);
  }

  async prepareQueueSeed(spec: QueueSeedSpec): Promise<Artifact> {
    safeName(spec.name);
    safeName(spec.queueName);
    const process = generateQueueSeed(spec);
    return this.persistArtifact(
      [],
      process,
      {
        version: 1,
        processName: process.name,
        assertions: [
          {
            callIndex: 0,
            object: process.name,
            action: "Seed queue",
            outputName: "Seed Count",
            type: "number",
            expected: String(spec.items.length),
          },
        ],
      },
      { name: spec.queueName, role: "seed" },
    );
  }

  async prepareQueueConsumer(input: QueueBuildSpec): Promise<Artifact> {
    const value: unknown = input;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new RunnerError("INVALID_SPEC", "A queue consumer build specification is required");
    if (
      !["Completed", "CompletedWithExceptions", "NoAvailableItem", "Stopped"].includes(
        input.expectedOutcome,
      )
    )
      throw new RunnerError("INVALID_SPEC", "An explicit queue outcome is required");
    const counts = (input as Partial<QueueBuildSpec>).expectedCounts;
    const countKeys = ["completed", "businessExceptions", "systemExceptions"] as const;
    if (
      !counts ||
      typeof counts !== "object" ||
      Array.isArray(counts) ||
      Object.keys(counts).length !== countKeys.length ||
      countKeys.some(
        (key) =>
          !Object.hasOwn(counts, key) ||
          !Number.isInteger(counts[key]) ||
          counts[key] < 0 ||
          counts[key] > 1000,
      )
    )
      throw new RunnerError(
        "INVALID_SPEC",
        "Explicit queue counts must be integers from 0 to 1000",
      );
    const processed = counts.completed + counts.businessExceptions + counts.systemExceptions;
    if (processed > 1000)
      throw new RunnerError("INVALID_SPEC", "Expected queue counts must total at most 1000");
    // Reuse the public schema so direct API callers receive the same bounds and defaults.
    const { queueConsumerSpecSchema } = await import("@bpdev/generator");
    const parsed = queueConsumerSpecSchema.safeParse(input.consumer);
    if (!parsed.success)
      throw new RunnerError("INVALID_SPEC", "Invalid queue consumer controls or action contract");
    const consumer = parsed.data;
    safeName(consumer.name);
    safeName(consumer.queueName);
    if (!Array.isArray(input.objects))
      throw new RunnerError("INVALID_SPEC", "Supplied queue objects must be an array");
    const specs = applyObjectPolicy(
      input.objects,
      this.options.browserPath ?? DEFAULT_BROWSER_PATH,
      [
        {
          object: consumer.call.object,
          action: consumer.call.action,
          inputs: { [consumer.call.input]: "[ItemCaseKey]" },
        },
        ...[consumer.launch, consumer.cleanup].filter(
          (value): value is { object: string; action: string } => value !== undefined,
        ),
      ],
    );
    const objects = specs.map((object) =>
      generateObject(object, this.options.catalog, {
        robotProfileDir: this.options.robotProfileDirectory,
      }),
    );
    const process = generateQueueConsumer(consumer, specs);
    const assertion = { callIndex: 0, object: process.name, action: "Process queue" };
    return this.persistArtifact(
      objects,
      process,
      {
        version: 1,
        processName: process.name,
        assertions: [
          { ...assertion, outputName: "Outcome", type: "text", expected: input.expectedOutcome },
          {
            ...assertion,
            outputName: "Completed Count",
            type: "number",
            expected: String(counts.completed),
          },
          {
            ...assertion,
            outputName: "Business Exception Count",
            type: "number",
            expected: String(counts.businessExceptions),
          },
          {
            ...assertion,
            outputName: "System Exception Count",
            type: "number",
            expected: String(counts.systemExceptions),
          },
          {
            ...assertion,
            outputName: "Processed Count",
            type: "number",
            expected: String(processed),
          },
        ],
      },
      { name: consumer.queueName, role: "consumer" },
    );
  }

  /** Create only. No release import, overwrite, reset, or automatic retry. */
  async createQueue(name: string): Promise<QueueRecord> {
    safeName(name);
    return this.store.exclusive(async () => {
      const key = name.toLowerCase();
      const id = fingerprint(key);
      if (await this.store.exists("queues", id)) {
        const prior = checked(queueRecordSchema, await this.store.read("queues", id));
        if (prior.name.toLowerCase() !== key || prior.state !== "created" || !prior.queueId)
          throw new RunnerError(
            "QUEUE_UNRESOLVED",
            "Queue creation requires reconciliation; no replay",
          );
        return prior;
      }
      if (!this.options.automatec.createQueue)
        throw new RunnerError("UNSUPPORTED_OPERATION", "Native queue creation is unavailable");
      await this.assertIdle();
      let record: QueueRecord = { name, state: "creating", createdAt: now() };
      if (!(await this.store.reserve(key, record, "queues")))
        throw new RunnerError("QUEUE_UNRESOLVED", "Queue creation has already been reserved");
      try {
        const queueId = (
          await this.options.automatec.createQueue(name, "CaseKey", 1)
        ).toLowerCase();
        if (!UUID.test(queueId)) throw new Error("Invalid acknowledgement");
        record = { ...record, queueId, state: "created" };
      } catch {
        record = { ...record, state: "unknown" };
      }
      await this.store.write("queues", id, record);
      return record;
    });
  }

  private async persistArtifact(
    objects: readonly GeneratedFile[],
    harness: GeneratedFile,
    assertions: HarnessAssertionManifest,
    queue?: Artifact["queue"],
  ): Promise<Artifact> {
    safeName(harness.name);
    const files = [...objects, harness];
    if (new Set(files.map((file) => file.name.toLowerCase())).size !== files.length)
      throw new RunnerError("INVALID_SPEC", "Artifact names must be unique, ignoring case");
    if (files.some((file) => Buffer.byteLength(file.xml) > 2 * 1024 * 1024))
      throw new RunnerError("ARTIFACT_LIMIT", "Generated artifact exceeds 2 MiB");
    const artifactId = await this.store.create("artifacts");
    const manifest: Artifact = {
      artifactId,
      createdAt: now(),
      processName: harness.name,
      ...(queue ? { queue } : {}),
      assertions,
      files: files.map((file, index) => ({
        kind: index === objects.length ? "process" : "object",
        name: file.name,
        sha256: fingerprint(file.xml),
      })),
    };
    for (const [index, file] of files.entries()) {
      const entry = manifest.files[index];
      if (!entry) throw new RunnerError("INVALID_SPEC", "Missing generated file");
      await this.store.writeArtifact(artifactId, filename(entry, index), file.xml);
    }
    await this.store.write("artifacts", artifactId, manifest);
    return manifest;
  }

  async artifact(artifactId: string): Promise<Artifact> {
    const raw = await this.store.read<unknown>("artifacts", artifactId);
    const legacy = legacyArtifactSchema.safeParse(raw);
    if (
      legacy.success &&
      legacy.data.files.some(
        (file, index) =>
          file.file !==
          (index === legacy.data.files.length - 1
            ? "process.bpprocess"
            : `object-${index}.bpobject`),
      )
    )
      throw new RunnerError(
        "STORE_INTEGRITY",
        "Legacy artifact filenames do not match the internal layout",
      );
    const artifact = checked(
      artifactSchema,
      legacy.success
        ? {
            ...legacy.data,
            files: legacy.data.files.map((file, index) => ({
              name: file.name,
              sha256: file.sha256,
              kind: index === legacy.data.files.length - 1 ? "process" : "object",
            })),
          }
        : raw,
    );
    if (
      artifact.artifactId !== artifactId ||
      artifact.files.at(-1)?.kind !== "process" ||
      artifact.files.at(-1)?.name !== artifact.processName ||
      artifact.assertions.processName !== artifact.processName ||
      artifact.files.slice(0, -1).some((file) => file.kind !== "object") ||
      new Set(artifact.files.map((file) => file.name.toLowerCase())).size !== artifact.files.length
    )
      throw new RunnerError("STORE_INTEGRITY", "Artifact metadata is inconsistent");
    try {
      verifyHarnessOutputs(artifact.assertions, []);
    } catch {
      throw new RunnerError("STORE_INTEGRITY", "Artifact assertion manifest is invalid");
    }
    for (const [index, file] of artifact.files.entries()) {
      if (
        fingerprint(await this.store.text("artifacts", artifactId, filename(file, index))) !==
        file.sha256
      )
        throw new RunnerError(
          "STORE_INTEGRITY",
          "Artifact changed after preparation; prepare a new version",
        );
    }
    return artifact;
  }

  async validate(artifactId: string): Promise<ValidationReport> {
    const artifact = await this.artifact(artifactId);
    const checks: NativeValidation[] = [];
    for (const [index, file] of artifact.files.entries()) {
      let result: NativeValidation;
      try {
        result = await this.options.probe.validate(
          this.store.path("artifacts", artifactId, filename(file, index)),
        );
      } catch {
        throw new RunnerError(
          "VALIDATION_UNAVAILABLE",
          "Native parser is unavailable; nothing is validated",
        );
      }
      // Whitelist the summary; a probe error or reason can contain XML and a private path.
      const matches =
        result.valid &&
        (result.nameSha256 === fingerprint(file.name) ||
          (!result.nameSha256 && result.name === file.name)) &&
        result.kind?.toLowerCase() === file.kind &&
        Number.isSafeInteger(result.stages) &&
        (result.stages ?? -1) >= 0 &&
        Number.isSafeInteger(result.expressionsChecked) &&
        (result.expressionsChecked ?? -1) >= 0;
      checks.push(
        matches
          ? {
              level: "native-parse",
              valid: true,
              name: file.name,
              kind: file.kind,
              stages: result.stages,
              expressionsChecked: result.expressionsChecked,
            }
          : {
              level: "native-parse",
              valid: false,
              name: file.name,
              kind: file.kind,
              reason:
                "Native parsing/expression validation rejected the file, its identity did not match, or the probe needs rebuilding",
            },
      );
    }
    return {
      valid: checks.every((check) => check.valid),
      checks,
      limitations: [
        "Native XML parsing and offline expressions checked; full Studio dependencies, recovery flow and business behavior still require qualification",
      ],
    };
  }

  async deployment(artifactId: string): Promise<DeploymentRecord> {
    const artifact = await this.artifact(artifactId);
    if (!(await this.store.hasDeployment(artifactId)))
      return { artifactId, state: "not_deployed", imported: [] };
    const raw = await this.store.read<unknown>("artifacts", artifactId, "deployment.json");
    const legacyArtifact = legacyArtifactSchema.safeParse(
      await this.store.read<unknown>("artifacts", artifactId),
    );
    const legacyDeployment = legacyArtifact.success
      ? legacyDeploymentSchema.safeParse(raw)
      : undefined;
    const record = checked(
      deploymentSchema,
      legacyDeployment?.success
        ? {
            artifactId,
            artifactHash: fingerprint(JSON.stringify(artifact)),
            state: legacyDeployment.data.state,
            imported: legacyDeployment.data.imported,
            updatedAt: legacyDeployment.data.at ?? artifact.createdAt,
          }
        : raw,
    );
    if (
      record.artifactId !== artifactId ||
      record.artifactHash !== fingerprint(JSON.stringify(artifact)) ||
      record.imported.some((name, index) => name !== artifact.files[index]?.name) ||
      (record.state === "deployed" &&
        (record.inFlight || record.imported.length !== artifact.files.length))
    )
      throw new RunnerError("STORE_INTEGRITY", "Deployment does not match the prepared artifact");
    const lastResume = record.publicationResumes?.at(-1);
    if (
      lastResume &&
      (record.imported.length !== artifact.files.length ||
        record.publicationResumes
          ?.slice(0, -1)
          .some((attempt) => attempt.outcome !== "unconfirmed") ||
        (record.state === "deployed"
          ? !["published", "already-published"].includes(lastResume.outcome)
          : record.state !== "partial" ||
            record.inFlight?.operation !== "publish" ||
            record.inFlight.name !== artifact.processName ||
            ["published", "already-published"].includes(lastResume.outcome)))
    )
      throw new RunnerError("STORE_INTEGRITY", "Publication recovery audit is inconsistent");
    const { artifactHash: _, ...view } = record;
    return view;
  }

  async deploy(artifactId: string): Promise<DeploymentRecord> {
    return this.store.exclusive(async () => {
      const artifact = await this.artifact(artifactId);
      const previous = await this.deployment(artifactId);
      if (previous.state === "deployed") return previous;
      if (previous.state !== "not_deployed")
        throw new RunnerError(
          "DEPLOYMENT_UNRESOLVED",
          "An interrupted import or publish must be reconciled; no automatic replay",
        );
      await this.assertIdle();
      if (!(await this.validate(artifactId)).valid)
        throw new RunnerError(
          "NATIVE_VALIDATION_FAILED",
          "Native validation failed; nothing imported",
        );
      let existing: string[];
      try {
        existing = await this.options.automatec.listProcesses();
      } catch {
        return unavailable("Cannot inspect existing BP names; no import attempted");
      }
      if (
        artifact.files.some((file) =>
          existing.some((name) => name.toLowerCase() === file.name.toLowerCase()),
        )
      )
        throw new RunnerError(
          "DEPLOYMENT_CONFLICT",
          "Existing BP names must be versioned before importing; nothing overwritten",
        );
      const imported: string[] = [];
      let inFlight: DeploymentRecord["inFlight"];
      const persist = async (state: "deploying" | "partial" | "deployed") => {
        await this.store.write(
          "artifacts",
          artifactId,
          {
            artifactId,
            artifactHash: fingerprint(JSON.stringify(artifact)),
            state,
            imported,
            inFlight,
            updatedAt: now(),
          },
          "deployment.json",
        );
      };
      try {
        for (const [index, file] of artifact.files.entries()) {
          inFlight = { operation: "import", name: file.name };
          await persist("deploying"); // Persist intent before any external side effect.
          await this.options.automatec.import(
            this.store.path("artifacts", artifactId, filename(file, index)),
          );
          imported.push(file.name);
          inFlight = undefined;
          await persist("deploying");
        }
        inFlight = { operation: "publish", name: artifact.processName };
        await persist("deploying");
        await this.options.automatec.publish(artifact.processName);
        inFlight = undefined;
        await persist("deployed");
      } catch {
        await persist("partial");
        throw new RunnerError(
          "DEPLOYMENT_PARTIAL",
          "Import/publish may be partial; inspect deployment evidence before any further mutation",
        );
      }
      return this.deployment(artifactId);
    });
  }

  /** Operator API only. One idempotent publication attempt, never import or execution. */
  async resumePublication(artifactId: string, evidence: string): Promise<DeploymentRecord> {
    if (typeof evidence !== "string" || evidence.trim().length < 20 || evidence.length > 2000)
      throw new RunnerError(
        "INVALID_EVIDENCE",
        "Record publication recovery evidence (20–2000 characters)",
      );
    return this.store.exclusive(async () => {
      const artifact = await this.artifact(artifactId);
      const previous = await this.deployment(artifactId);
      if (
        previous.state !== "partial" ||
        previous.imported.length !== artifact.files.length ||
        previous.imported.some((name, index) => name !== artifact.files[index]?.name) ||
        previous.inFlight?.operation !== "publish" ||
        previous.inFlight.name !== artifact.processName
      )
        throw new RunnerError(
          "PUBLICATION_RESUME_UNAVAILABLE",
          "Only a fully imported partial deployment awaiting publication of its exact process can be resumed",
        );
      const previousAttempts = previous.publicationResumes ?? [];
      if (previousAttempts.length >= MAX_PUBLICATION_RESUME_ATTEMPTS)
        throw new RunnerError(
          "PUBLICATION_RESUME_LIMIT",
          "Publication recovery attempt limit reached; operator investigation is required",
        );
      await this.assertIdle();
      // An interrupted audit has no receipt. An explicit new request can close it only
      // as unconfirmed; never infer native success from its pending publication intent.
      const history: readonly PublicationResumeAttempt[] = previousAttempts.map(
        (previousAttempt) =>
          previousAttempt.outcome === "pending"
            ? { ...previousAttempt, outcome: "unconfirmed", completedAt: now() }
            : previousAttempt,
      );
      const attempt: PublicationResumeAttempt = {
        attempt: history.length + 1,
        requestedAt: now(),
        evidence,
        outcome: "pending",
      };
      const persist = async (state: "partial" | "deployed", audit: PublicationResumeAttempt) => {
        await this.store.write(
          "artifacts",
          artifactId,
          {
            ...previous,
            artifactHash: fingerprint(JSON.stringify(artifact)),
            state,
            inFlight: state === "partial" ? previous.inFlight : undefined,
            publicationResumes: [...history, audit],
            updatedAt: now(),
          },
          "deployment.json",
        );
      };
      // A failed intent write must prevent publication. A crash leaves partial + pending.
      await persist("partial", attempt);
      try {
        const outcome: unknown = await this.options.automatec.publish(artifact.processName);
        if (outcome !== "published" && outcome !== "already-published")
          throw new Error("Publication acknowledgement was not recognized");
        await persist("deployed", { ...attempt, outcome, completedAt: now() });
      } catch {
        await persist("partial", { ...attempt, outcome: "unconfirmed", completedAt: now() });
        throw new RunnerError(
          "DEPLOYMENT_PARTIAL",
          "Publication is not durably confirmed; imports were not replayed and the deployment remains partial",
        );
      }
      return this.deployment(artifactId);
    });
  }

  async start(artifactId: string, requestKey: string): Promise<RunRecord> {
    if (!requestKey.trim() || requestKey.length > 200)
      throw new RunnerError(
        "INVALID_REQUEST_KEY",
        "A stable requestKey of 1–200 characters is required",
      );
    return this.store.exclusive(async () => {
      const reservationId = fingerprint(requestKey);
      if (await this.store.exists("requests", reservationId)) {
        const prior = checked(
          reservationSchema,
          await this.store.read<unknown>("requests", reservationId),
        );
        if (
          prior.artifactId !== artifactId ||
          prior.resource !== this.options.resource ||
          (prior.resourcePort ?? 8181) !== (this.options.resourcePort ?? 8181)
        )
          throw new RunnerError(
            "REQUEST_CONFLICT",
            "requestKey was already used for another artifact or resource",
          );
        // A missing/corrupt run is an integrity error, NEVER permission to submit another run.
        const record = await this.run(prior.runId);
        if (record.artifactId !== artifactId)
          throw new RunnerError("STORE_INTEGRITY", "Reservation and run disagree");
        return record;
      }
      const artifact = await this.artifact(artifactId);
      if ((await this.deployment(artifactId)).state !== "deployed")
        throw new RunnerError("NOT_DEPLOYED", "Artifact deployment is incomplete");
      await this.assertIdle();
      let seedQueue:
        { key: string; record: ReturnType<typeof queueRecordSchema.parse> } | undefined;
      if (artifact.queue?.role === "seed") {
        const queueKey = fingerprint(artifact.queue.name.toLowerCase());
        const queue = checked(queueRecordSchema, await this.store.read("queues", queueKey));
        if (queue.state !== "created" || !queue.queueId || queue.seedRunId)
          throw new RunnerError(
            "SEED_UNRESOLVED",
            "v1 seeds a newly created queue only once; existing attempts require reconciliation",
          );
        seedQueue = { key: queueKey, record: queue };
      }
      const runId = await this.store.create("runs");
      let record: StoredRun = {
        runId,
        artifactId,
        resource: this.options.resource,
        resourcePort: this.options.resourcePort ?? 8181,
        processName: artifact.processName,
        createdAt: now(),
        updatedAt: now(),
        state: "starting",
        verification: unverified,
      };
      await this.store.write("runs", runId, record);
      if (seedQueue)
        await this.store.write("queues", seedQueue.key, { ...seedQueue.record, seedRunId: runId });
      if (
        !(await this.store.reserve(requestKey, {
          artifactId,
          runId,
          resource: this.options.resource,
          resourcePort: this.options.resourcePort ?? 8181,
        }))
      )
        throw new RunnerError(
          "REQUEST_UNRESOLVED",
          "Existing reservation requires reconciliation; this call did not launch a process",
        );
      try {
        const bpSessionId = await this.options.automatec.run(artifact.processName, {
          resource: this.options.resource,
          ...(this.options.resourcePort === undefined ? {} : { port: this.options.resourcePort }),
        });
        if (!new RegExp(UUID.source, "i").test(bpSessionId))
          throw new Error("Invalid acknowledgement");
        record = { ...record, state: "running", bpSessionId, updatedAt: now() };
      } catch (error) {
        const rejected =
          error instanceof CredentialsError ||
          error instanceof InvalidArgumentError ||
          (error instanceof ToolLaunchError && error.tool === "AutomateC") ||
          (error instanceof CommandFailedError &&
            error.tool === "AutomateC" &&
            error.command === "/run");
        record = {
          ...record,
          state: rejected ? "failed" : "unknown",
          reconciliationRequired: !rejected,
          launchError: rejected
            ? `Launch rejected before session acknowledgement: ${error instanceof Error ? error.message.slice(0, 1500) : "unknown rejection"}`
            : "Launch outcome unknown; reconcile before any new launch",
          updatedAt: now(),
        };
      }
      await this.store.write("runs", runId, record);
      return publicRun(record);
    });
  }

  private async storedRun(runId: string): Promise<StoredRun> {
    const record = checked(runSchema, await this.store.read<unknown>("runs", runId));
    if (
      record.runId !== runId ||
      record.resource !== this.options.resource ||
      (record.verification.status !== "not_run" &&
        (!record.verifiedAt || record.state !== "completed" || !record.bpSessionId)) ||
      (record.verification.status === "passed" &&
        (record.verification.assertions.length === 0 ||
          record.verification.assertions.some((a) => a.status !== "passed"))) ||
      (record.verification.status === "failed" &&
        !record.verification.assertions.some((a) => a.status === "failed")) ||
      (record.verification.status === "not_run" && record.verification.assertions.length > 0)
    )
      throw new RunnerError(
        "STORE_INTEGRITY",
        "Run identity or verification evidence is inconsistent",
      );
    return record.state === "starting"
      ? {
          ...record,
          state: "unknown",
          reconciliationRequired: true,
          launchError: "Launch has no stored acknowledgement; reconcile before retrying",
        }
      : record;
  }
  async run(runId: string): Promise<RunRecord> {
    return publicRun(await this.storedRun(runId));
  }

  /** Operator API only: never registered as an LLM tool. Does not retry a run or queue item. */
  async recordReconciliation(runId: string, evidence: string): Promise<RunRecord> {
    if (evidence.trim().length < 20 || evidence.length > 2000)
      throw new RunnerError(
        "INVALID_EVIDENCE",
        "Record the independently checked business result (20–2000 characters)",
      );
    return this.store.exclusive(async () => {
      const run = await this.storedRun(runId);
      if (!terminal(run.state) || !run.bpSessionId || run.logHistoryChanged)
        throw new RunnerError(
          "RECONCILIATION_UNAVAILABLE",
          "Only an observed terminal session can be reconciled here; unknown launches need operator investigation",
        );
      const current = await this.options.automatec.status(run.bpSessionId);
      if (!["Failed", "Stopped", "Completed"].includes(current))
        throw new RunnerError(
          "RECONCILIATION_UNAVAILABLE",
          "Native session is not confirmed terminal",
        );
      const next = {
        ...run,
        reconciliationRequired: false,
        reconciliation: { recordedAt: now(), evidence },
        updatedAt: now(),
      };
      await this.store.write("runs", runId, next);
      return publicRun(next);
    });
  }

  async inspect(runId: string, cursor = 0, limit = 100): Promise<Inspection> {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new RunnerError("INVALID_CURSOR", "Invalid log cursor or limit");
    return this.store.exclusive(async () => {
      let current = await this.storedRun(runId);
      if (
        current.resourcePort !== undefined &&
        current.resourcePort !== (this.options.resourcePort ?? 8181)
      )
        throw new RunnerError(
          "RESOURCE_MISMATCH",
          "Run belongs to another runtime port; use its original configuration",
        );
      const session = current.bpSessionId;
      const result = (reason: string): Inspection => ({
        run: publicRun(current),
        logs: [],
        nextCursor: cursor,
        more: false,
        observationHealth: "unavailable",
        reason,
      });
      if (!session) return result("No acknowledged session is available to observe");
      const errors: string[] = [];
      let completed = false;
      try {
        const bpStatus = await this.options.automatec.status(session);
        const next = executionState(bpStatus);
        if (!next || (terminal(current.state) && current.state !== next)) {
          errors.push("Status cannot establish a new execution outcome");
          current = {
            ...current,
            bpStatus,
            observedAt: now(),
            reconciliationRequired: next !== undefined || current.reconciliationRequired,
          };
        } else {
          current = {
            ...current,
            state: next,
            bpStatus,
            observedAt: now(),
            ...((next === "failed" || next === "stopped") && !current.reconciliation
              ? { reconciliationRequired: true }
              : {}),
          };
          completed = next === "completed";
        }
      } catch {
        errors.push("Session status is unavailable");
      }
      if (completed) {
        try {
          const artifact = await this.artifact(current.artifactId);
          const outputs = await this.options.listener.outputs(session);
          const verification = verifyHarnessOutputs(artifact.assertions, outputs);
          if (
            current.verifiedAt &&
            JSON.stringify(current.verification) !== JSON.stringify(verification)
          ) {
            errors.push("Final outputs conflict with previously verified evidence");
            current = { ...current, reconciliationRequired: true };
          } else
            current = {
              ...current,
              verification,
              verifiedAt:
                verification.status === "not_run" ? undefined : (current.verifiedAt ?? now()),
            };
        } catch {
          errors.push("Final outputs could not be verified; prior evidence is retained");
        }
      }
      current = {
        ...current,
        updatedAt: now(),
        observationError: errors.length ? errors.join("; ") : undefined,
      };
      await this.store.write("runs", runId, current);
      let logs;
      try {
        logs = await this.options.automatec.getLog(session);
      } catch {
        return result("Logs are unavailable; cursor and prior evidence are retained");
      }
      const previous = current.logCheckpoint;
      const changed =
        previous !== undefined &&
        (logs.length < previous.count ||
          fingerprint(JSON.stringify(logs.slice(0, previous.count))) !== previous.sha256);
      current = {
        ...current,
        logCheckpoint: { count: logs.length, sha256: fingerprint(JSON.stringify(logs)) },
        ...(changed
          ? { reconciliationRequired: true, logHistoryChanged: true }
          : {
              logEvidence:
                current.logHistoryChanged && current.logEvidence
                  ? current.logEvidence
                  : exceptionEvidence(logs, session, now()),
            }),
      };
      await this.store.write("runs", runId, current);
      if (changed || cursor > logs.length || (cursor > 0 && previous === undefined)) {
        return {
          ...result("Log history changed or cursor has no verified prefix; restart from zero"),
          nextCursor: 0,
        };
      }
      if (current.reconciliationRequired) errors.push("Recorded evidence requires reconciliation");
      const page = logs.slice(cursor, cursor + limit);
      const bounded = page.map((entry) => ({
        time: entry.time.slice(0, 64),
        stageId: entry.stageId.slice(0, 64),
        stageName: entry.stageName.slice(0, 1024),
        result: entry.result.slice(0, 8192),
      }));
      return {
        run: publicRun(current),
        logs: bounded,
        nextCursor: Math.min(logs.length, cursor + limit),
        more: logs.length > cursor + limit,
        logsTruncated: JSON.stringify(page) !== JSON.stringify(bounded),
        observationHealth: errors.length ? "unavailable" : "fresh",
        ...(errors.length ? { reason: errors.join("; ") } : {}),
      };
    });
  }

  async requestStop(runId: string): Promise<StopAcknowledgement> {
    return this.store.exclusive(async () => {
      let run = await this.storedRun(runId);
      const session = run.bpSessionId;
      if (!session) throw new RunnerError("NO_SESSION", "No acknowledged session to stop");
      if (run.stopRequest)
        return { requested: true, runId, acknowledged: run.stopRequest.state === "acknowledged" };
      if (terminal(run.state))
        throw new RunnerError("RUN_TERMINAL", "The recorded session is already terminal");
      const requestedAt = now();
      run = { ...run, stopRequest: { state: "requesting", requestedAt }, updatedAt: now() };
      await this.store.write("runs", runId, run);
      try {
        await this.options.automatec.requestStop(session);
      } catch {
        await this.store.write("runs", runId, {
          ...run,
          stopRequest: { state: "unknown", requestedAt },
          updatedAt: now(),
        });
        throw new RunnerError(
          "STOP_OUTCOME_UNKNOWN",
          "Stop acknowledgement unavailable; this does not prove the robot stopped",
        );
      }
      await this.store.write("runs", runId, {
        ...run,
        stopRequest: { state: "acknowledged", requestedAt, acknowledgedAt: now() },
        updatedAt: now(),
      });
      return { requested: true, acknowledged: true, runId };
    });
  }

  private async assertIdle(): Promise<void> {
    for (const id of await this.store.ids("runs")) {
      const run = await this.run(id);
      const uncertainBusinessResult =
        run.bpSessionId &&
        terminal(run.state) &&
        run.verification.status !== "passed" &&
        !run.reconciliation;
      if (!terminal(run.state) || run.reconciliationRequired || uncertainBusinessResult)
        throw new RunnerError(
          "RUN_UNRESOLVED",
          "A recorded run is active or unresolved; inspect it before another mutation",
        );
    }
    try {
      const busy = await this.options.listener.busy();
      const status = await this.options.listener.status();
      if (
        busy ||
        // Native 7.5.1 includes retained COMPLETED sessions in "Total running".
        // An incomplete enumeration is unsafe, but retained terminal sessions are idle.
        status.totalRunning !== status.sessions.length ||
        status.sessions.some(
          (session) => !["COMPLETED", "FAILED", "STOPPED", "STARTFAILED"].includes(session.status),
        )
      )
        throw new RunnerError(
          "RESOURCE_BUSY",
          "Runtime has active or unresolved sessions; no mutation attempted",
        );
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      unavailable("Cannot establish that the runtime is idle; no mutation attempted");
    }
  }
}

function executionState(status: SessionStatus): RunRecord["state"] | undefined {
  switch (status) {
    case "Completed":
      return "completed";
    case "Failed":
      return "failed";
    case "Stopped":
      return "stopped";
    case "Pending":
    case "Running":
    case "Debugging":
    case "StopRequested":
    case "Stalled":
      return "running";
    case "Archived":
    case "PendingDeletion":
      return undefined;
  }
}
