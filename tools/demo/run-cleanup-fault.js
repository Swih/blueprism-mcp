// Native qualification through public MCP only. Never auto-reconcile or edit runner records.
// Run from the repository root after build and operator guards:
// BP_INTEGRATION=1 BPDEMO_QUEUE_ID=<stable-id> BPDEMO_PHASE=deploy|run
// All receipts stay in ignored .bpdev/demo/<stable-id>; native CSV review remains mandatory.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env, execPath, loadEnvFile } from "node:process";
import { log } from "node:console";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (env.BP_INTEGRATION !== "1")
  throw new Error("Set BP_INTEGRATION=1 to enable this native cleanup-fault qualification");
loadEnvFile(".env");
const root = resolve(".");
const phase = env.BPDEMO_PHASE ?? "deploy";
if (!["deploy", "run"].includes(phase)) throw new Error("BPDEMO_PHASE must be deploy or run");
const id = env.BPDEMO_QUEUE_ID;
if (!id || !/^[a-zA-Z0-9-]{1,45}$/.test(id))
  throw new Error("Specify the same short BPDEMO_QUEUE_ID for both phases and every resumption");
const directory = resolve(".bpdev/demo", id);
const stateFile = resolve(directory, "suite.json");
const marker = "BPDEV-INJECT-CLEANUP-ONCE";
const expectedOutcome = "Completed";
const expectedCounts = { completed: 2, businessExceptions: 0, systemExceptions: 0 };
const queueName = `BPDEV Cleanup Fault Queue ${id}`;
const keys = [`cleanup-a-${id}`, `cleanup-b-${id}`];
const unresolvedMessage =
  "A recorded run is active or unresolved; inspect it before another mutation";
await mkdir(directory, { recursive: true, mode: 0o700 });
let state;
try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  if (phase !== "deploy")
    throw new Error("Run phase requires this suite's recorded deployment", { cause: error });
  state = { schemaVersion: 1, scenario: "cleanup-fault", suffix: id, queueName, keys, marker };
}
if (
  state.schemaVersion !== 1 ||
  state.scenario !== "cleanup-fault" ||
  state.suffix !== id ||
  state.queueName !== queueName ||
  state.marker !== marker ||
  JSON.stringify(state.keys) !== JSON.stringify(keys)
)
  throw new Error(
    "Suite identity does not match this cleanup-fault scenario; preserve its evidence",
  );
if (state.unexpectedRetryRun)
  throw new Error("A replay guard failed previously; operator investigation is required");

async function save() {
  const temporary = resolve(directory, `suite-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, stateFile);
}
let event = (await readdir(directory)).reduce((next, name) => {
  const match = /^event-(\d+)-/.exec(name);
  return match ? Math.max(next, Number(match[1]) + 1) : next;
}, 0);
async function receipt(label, value) {
  const file = `event-${String(event++).padStart(4, "0")}-${label}.json`;
  await writeFile(resolve(directory, file), JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return file;
}
const client = new Client({ name: "bpdev-cleanup-fault-qualification", version: "1" });
const transport = new StdioClientTransport({
  command: execPath,
  args: [resolve("packages/mcp/dist/cli.js"), root],
  stderr: "pipe",
});
// Drain child diagnostics without printing or saving potentially sensitive stderr.
transport.stderr?.resume();
async function request(name, args) {
  await receipt(`${name}-request`, { name, arguments: args });
  const result = await client.callTool({ name, arguments: args });
  const file = await receipt(`${name}-response`, result);
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return { result, text, file };
}
async function call(name, args) {
  const reply = await request(name, args);
  if (reply.result.isError)
    throw new Error(
      `${name} failed; inspect its private response receipt before any further mutation`,
    );
  return JSON.parse(reply.text);
}
async function qualify(artifact) {
  const validation = await call("bp_validate", { artifactId: artifact.artifactId });
  if (!validation.valid) throw new Error("Native validation rejected the artifact");
  const deployment = await call("bp_deploy", { artifactId: artifact.artifactId });
  if (deployment.state !== "deployed") throw new Error("Deployment is not confirmed");
  return deployment;
}
async function observe(slot, artifact, requestKey) {
  if (!state[slot]) {
    // The key is persisted before launch; interruption never selects another key.
    state.launchIntents ??= {};
    state.launchIntents[slot] ??= { artifactId: artifact.artifactId, requestKey };
    const intent = state.launchIntents[slot];
    if (intent.artifactId !== artifact.artifactId || intent.requestKey !== requestKey)
      throw new Error("Saved launch identity changed; do not launch");
    await save();
    state[slot] = await call("bp_start", { artifactId: artifact.artifactId, requestKey });
    await save();
  }
  const started = state[slot];
  if (started.artifactId !== artifact.artifactId || !started.runId || !started.bpSessionId)
    throw new Error(
      "No matching acknowledged native session; inspect receipts without relaunching",
    );
  let cursor = 0;
  for (let poll = 0; poll < 240; poll++) {
    const observed = await call("bp_inspect", { runId: started.runId, cursor, limit: 200 });
    if (observed.run.runId !== started.runId || observed.run.bpSessionId !== started.bpSessionId)
      throw new Error("Observation belongs to another session");
    state[slot] = observed.run;
    await save();
    cursor = observed.nextCursor;
    if (["completed", "failed", "stopped"].includes(observed.run.state) && !observed.more)
      return observed;
    await setTimeout(1500);
  }
  throw new Error("Observation budget exceeded; retain the same request key and do not relaunch");
}
function objectSpec() {
  return {
    name: `BPDEV Cleanup Fault Object ${id}`,
    description: "Synthetic calculation and cleanup fault; no browser or HTTP interaction",
    runMode: "Exclusive",
    application: { kind: "BrowserAttach", name: "Synthetic Browser" },
    elements: [],
    actions: [
      {
        name: "Launch NoOp",
        description: "Latch lifecycle without launching a browser",
        inputs: [],
        outputs: [],
        steps: [],
      },
      {
        name: "Work",
        description: "Return a synthetic case-correlated confirmation",
        inputs: [{ name: "CaseKey", type: "text", description: "Synthetic case key" }],
        outputs: [{ name: "Confirmation", type: "text", description: "Synthetic confirmation" }],
        steps: [{ kind: "calc", expression: '"CONFIRMED:" & [CaseKey]', into: "Confirmation" }],
      },
      {
        name: "Cleanup Fault",
        description: "Raise once after successful queue finalization",
        inputs: [],
        outputs: [],
        steps: [
          {
            kind: "raise",
            exception: {
              type: "System Exception",
              detail: marker,
              saveScreenCapture: false,
            },
          },
        ],
      },
    ],
  };
}

await save();
try {
  await client.connect(transport);
  transport.stderr?.resume();
  if (phase === "deploy") {
    if (state.launchIntents || state.seedRun || state.consumerRun)
      throw new Error(
        "Deployment phase is closed after a launch intent; resume only the run phase",
      );
    if (!state.queue) {
      state.queue = await call("bp_create_queue", { name: queueName });
      await save();
    }
    if (state.queue.state !== "created") throw new Error("Queue creation is unresolved");
    if (!state.seed) {
      state.seed = await call("bp_prepare_queue_seed", {
        name: `BPDEV Cleanup Fault Seed ${id}`,
        queueName,
        items: keys.map((CaseKey) => ({ CaseKey })),
      });
      await save();
    }
    state.seedDeployment = await qualify(state.seed);
    await save();
    if (!state.consumer) {
      const object = objectSpec();
      state.consumer = await call("bp_prepare_queue_consumer", {
        objects: [object],
        consumer: {
          name: `BPDEV Cleanup Fault Consumer ${id}`,
          queueName,
          maxItems: 2,
          consecutiveSystemExceptionLimit: 3,
          retryPolicy: "never",
          launch: { object: object.name, action: "Launch NoOp" },
          cleanup: { object: object.name, action: "Cleanup Fault" },
          call: {
            object: object.name,
            action: "Work",
            input: "CaseKey",
            confirmationOutput: "Confirmation",
            expectedConfirmationPrefix: "CONFIRMED:",
          },
        },
        // Keep the normal two-item success contract; a fatal session cannot satisfy it.
        expectedOutcome,
        expectedCounts,
      });
      await save();
    }
    state.consumerDeployment = await qualify(state.consumer);
    state.requestKeys = {
      seed: `cleanup-seed-${state.seed.artifactId}`,
      consumer: `cleanup-consumer-${state.consumer.artifactId}`,
      blockedProbe: `cleanup-blocked-${state.consumer.artifactId}`,
    };
    state.qualification = { overallPassed: false, status: "deployed-awaiting-operator-review" };
    await save();
    log({
      stage: "deployed; no items seeded or consumed",
      directory,
      processName: state.consumer.processName,
      overallPassed: false,
    });
  } else {
    if (
      state.queue?.state !== "created" ||
      state.seedDeployment?.state !== "deployed" ||
      state.consumerDeployment?.state !== "deployed" ||
      !state.seed ||
      !state.consumer ||
      state.seedDeployment.artifactId !== state.seed.artifactId ||
      state.consumerDeployment.artifactId !== state.consumer.artifactId ||
      state.requestKeys?.seed !== `cleanup-seed-${state.seed.artifactId}` ||
      state.requestKeys.consumer !== `cleanup-consumer-${state.consumer.artifactId}` ||
      state.requestKeys.blockedProbe !== `cleanup-blocked-${state.consumer.artifactId}`
    )
      throw new Error("Run requires this suite's confirmed deployments and stable request keys");
    // Do not re-run deployment or seed creation when resuming a failed consumer observation.
    if (!state.seedVerified) {
      const seed = await observe("seedRun", state.seed, state.requestKeys.seed);
      if (
        seed.run.state !== "completed" ||
        seed.run.verification.status !== "passed" ||
        seed.run.reconciliationRequired ||
        seed.observationHealth !== "fresh"
      )
        throw new Error(
          "Seed is not freshly verified; no consumer launch or seed replay permitted",
        );
      state.seedVerified = true;
      await save();
    }
    const observation = await observe("consumerRun", state.consumer, state.requestKeys.consumer);
    const run = observation.run;
    const exceptions = [
      run.logEvidence?.firstLoggedException,
      ...(run.logEvidence?.subsequentLoggedExceptions ?? []),
    ].filter(Boolean);
    const markerRecorded = exceptions.some(
      (exception) =>
        exception.exceptionType === "System Exception" && exception.detail.includes(marker),
    );
    if (
      run.state !== "failed" ||
      run.bpStatus !== "Failed" ||
      run.verification.status !== "not_run" ||
      run.reconciliationRequired !== true ||
      run.logHistoryChanged ||
      run.logEvidence?.truncated ||
      observation.logsTruncated ||
      run.logEvidence?.bpSessionId !== run.bpSessionId ||
      !markerRecorded ||
      observation.reason !== "Recorded evidence requires reconciliation"
    )
      throw new Error(
        "Expected cleanup fault is not fully evidenced; inspect private receipts and do not relaunch",
      );
    const same = await call("bp_start", {
      artifactId: state.consumer.artifactId,
      requestKey: state.requestKeys.consumer,
    });
    if (same.runId !== run.runId || same.bpSessionId !== run.bpSessionId)
      throw new Error(
        "Original request key did not return the same session; operator investigation required",
      );
    state.blockedProbeIntent ??= {
      artifactId: state.consumer.artifactId,
      requestKey: state.requestKeys.blockedProbe,
    };
    if (
      state.blockedProbeIntent.artifactId !== state.consumer.artifactId ||
      state.blockedProbeIntent.requestKey !== state.requestKeys.blockedProbe
    )
      throw new Error("Saved replay-check identity changed; no request sent");
    await save();
    const blocked = await request("bp_start", state.blockedProbeIntent);
    if (!blocked.result.isError) {
      state.unexpectedRetryRun = { responseReceipt: blocked.file };
      state.qualification = { overallPassed: false, status: "replay-guard-failed" };
      await save();
      throw new Error(
        "New request was not blocked; preserve its receipt and investigate without further execution",
      );
    }
    if (blocked.text !== unresolvedMessage)
      throw new Error(
        "New request failed for an unverified reason; no RUN_UNRESOLVED evidence claimed",
      );
    state.qualification = {
      overallPassed: false,
      status: "awaiting-native-csv",
      nativeCsvVerified: false,
      normalExpectedOutcome: expectedOutcome,
      normalExpectedCounts: expectedCounts,
      observedRunId: run.runId,
      observedSessionId: run.bpSessionId,
      expectedFatalObserved: true,
      markerRecorded: true,
      originalKeyReturnedSameRun: true,
      freshKeyBlocked: true,
      expectedRunnerCode: "RUN_UNRESOLVED",
      // MCP currently exposes the exact error message, not RunnerError.code.
      runnerCodeTransmitted: false,
      blockedMessageMatched: true,
      blockedResponseReceipt: blocked.file,
      pendingNativeChecks: [
        "Export this queue read-only and match exactly the two seeded keys; do not assume acquisition order.",
        "Confirm one completed item and one untouched pending item, with no retry/new-item rows.",
        "Correlate native session/stage evidence: one work call, one completion, one cleanup fault, no second acquisition or finalization.",
      ],
    };
    state.qualificationReceipt = await receipt("cleanup-fault-evidence", state.qualification);
    await save();
    log({
      stage: "expected fault and replay guards observed; native CSV review required",
      directory,
      overallPassed: false,
      nativeCsvVerified: false,
    });
  }
} finally {
  await client.close();
}
