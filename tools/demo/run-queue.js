// All automation construction/execution uses MCP. Independent receipts reconcile the injected lost ACK.
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { env, execPath, loadEnvFile } from "node:process";
import { log } from "node:console";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serviceDeskObjects } from "./service-desk.js";

if (env.BP_INTEGRATION !== "1")
  throw new Error("Set BP_INTEGRATION=1 to enable this native queue demo");
loadEnvFile(".env");
const root = resolve(".");
const phase = env.BPDEMO_PHASE ?? "deploy";
if (!["deploy", "run"].includes(phase)) throw new Error("BPDEMO_PHASE must be deploy or run");
const scenario = env.BPDEMO_SCENARIO ?? "mixed";
if (!["mixed", "empty", "item-limit", "system-limit"].includes(scenario))
  throw new Error("BPDEMO_SCENARIO must be mixed, empty, item-limit or system-limit");
if (env.BPDEMO_QUEUE_ID && !/^[a-zA-Z0-9-]{1,40}$/.test(env.BPDEMO_QUEUE_ID))
  throw new Error("BPDEMO_QUEUE_ID must be a short demo identifier");
const directory = resolve(
  ".bpdev/demo",
  env.BPDEMO_QUEUE_ID ?? `queue-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
);
await mkdir(directory, { recursive: true });
const stateFile = resolve(directory, "suite.json");
let state;
try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = { schemaVersion: 2, suffix: directory.split(/[\\/]/).at(-1) };
}
if (state.schemaVersion !== 2)
  throw new Error("Legacy one-item suite: preserve its evidence and use a new suite directory");
state.scenario ??= "mixed";
if (state.consumer || state.seed) {
  if (state.scenario !== scenario) throw new Error("Use a new suite for a different scenario");
} else state.scenario = scenario;
const expectedCounts =
  scenario === "empty"
    ? { completed: 0, businessExceptions: 0, systemExceptions: 0 }
    : scenario === "item-limit"
      ? { completed: 2, businessExceptions: 0, systemExceptions: 0 }
      : scenario === "system-limit"
        ? { completed: 0, businessExceptions: 0, systemExceptions: 3 }
        : { completed: 2, businessExceptions: 1, systemExceptions: 1 };
const expectedOutcome =
  scenario === "empty"
    ? "NoAvailableItem"
    : scenario === "mixed"
      ? "CompletedWithExceptions"
      : "Stopped";
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2));
await save();
log({ directory, stage: "begin" });
const client = new Client({ name: "bpdev-queue-qualification", version: "1" });
const transport = new StdioClientTransport({
  command: execPath,
  args: [resolve("packages/mcp/dist/cli.js"), root],
  stderr: "pipe",
});
await client.connect(transport);
// Resume the same evidence directory without overwriting earlier observations.
let event = (await readdir(directory)).reduce((next, name) => {
  const match = /^event-(\d+)-/.exec(name);
  return match ? Math.max(next, Number(match[1]) + 1) : next;
}, 0);
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  await writeFile(
    resolve(directory, `event-${String(event++).padStart(4, "0")}-${name}.json`),
    JSON.stringify(result, null, 2),
  );
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
async function qualify(artifact) {
  const validation = await call("bp_validate", { artifactId: artifact.artifactId });
  if (!validation.valid) throw new Error("Native validation rejected the artifact");
  await call("bp_deploy", { artifactId: artifact.artifactId });
}
async function run(artifact, key) {
  const started = await call("bp_start", { artifactId: artifact.artifactId, requestKey: key });
  log({ key, runId: started.runId, state: started.state, launchError: started.launchError });
  if (!started.bpSessionId)
    throw new Error("No acknowledged native session; inspect saved evidence");
  let cursor = 0;
  for (let i = 0; i < 240; i++) {
    const observed = await call("bp_inspect", { runId: started.runId, cursor, limit: 200 });
    cursor = observed.nextCursor;
    if (["completed", "failed", "stopped"].includes(observed.run.state) && !observed.more)
      return observed.run;
    await setTimeout(1500);
  }
  throw new Error("Observation budget exceeded; do not relaunch");
}
try {
  state.queueName ??= `BPDEV Service Desk ${state.suffix}`;
  if (!state.queue) {
    state.queue = await call("bp_create_queue", { name: state.queueName });
    await save();
  }
  if (state.queue.state !== "created") throw new Error("Queue creation unresolved");
  const keys =
    scenario === "empty"
      ? []
      : scenario === "mixed"
        ? [
            `demo-first-${state.suffix}`,
            `demo-business-reject-${state.suffix}`,
            `demo-lost-ack-${state.suffix}`,
            `demo-next-${state.suffix}`,
          ]
        : [1, 2, 3, 4].map((index) => `demo-${scenario}-${index}-${state.suffix}`);
  if (keys.length && !state.seed) {
    state.seed = await call("bp_prepare_queue_seed", {
      name: `BPDEV Seed ${state.suffix}`,
      queueName: state.queueName,
      items: keys.map((CaseKey) => ({ CaseKey })),
    });
    await save();
  }
  if (state.seed) await qualify(state.seed);
  if (!state.consumer) {
    const objects = serviceDeskObjects(
      state.suffix,
      scenario === "system-limit" ? "http://127.0.0.1:8931/?mode=unavailable" : undefined,
    );
    state.consumer = await call("bp_prepare_queue_consumer", {
      objects,
      consumer: {
        name: `BPDEV Consumer ${state.suffix}`,
        queueName: state.queueName,
        maxItems: scenario === "item-limit" ? 2 : 100,
        consecutiveSystemExceptionLimit: 3,
        retryPolicy: "never",
        launch: { object: objects[0].name, action: "Launch" },
        cleanup: { object: objects[0].name, action: "Terminate" },
        call: {
          object: objects[1].name,
          action: "Submit Case",
          input: "CaseKey",
          confirmationOutput: "Confirmation",
          expectedConfirmationPrefix: "CONFIRMED:",
          businessRejectionPrefix: "REJECTED:",
        },
      },
      expectedOutcome,
      expectedCounts,
    });
    await save();
  }
  await qualify(state.consumer);
  if (phase === "deploy") {
    log({
      stage: "deployed for Studio review; no items loaded or processed",
      directory,
      processName: state.consumer.processName,
    });
  } else {
    if (state.seed && !state.seedRun) {
      state.seedRun = await run(state.seed, `seed-${state.seed.artifactId}`);
      await save();
    }
    if (
      state.seed &&
      (state.seedRun.state !== "completed" || state.seedRun.verification.status !== "passed")
    )
      throw new Error("Native seed did not pass; reconcile before another seed");
    log({ stage: "seed verified", count: keys.length });
    if (!state.consumerRun) {
      state.consumerRun = await run(state.consumer, `consumer-${state.consumer.artifactId}`);
      await save();
    }
    const observed = state.consumerRun;
    const response = await globalThis.fetch("http://127.0.0.1:8931/records");
    if (!response.ok) throw new Error("Independent receipt service unavailable");
    const receipts = await response.json();
    await writeFile(resolve(directory, "receipts.json"), JSON.stringify(receipts, null, 2));
    for (const [index, key] of keys.entries()) {
      const expectedAttempts =
        scenario === "system-limit" || (scenario === "item-limit" && index >= 2) ? 0 : 1;
      const expectedRecords =
        expectedAttempts === 0 || (scenario === "mixed" && index === 1) ? 0 : 1;
      if (
        (receipts.attempts[key] ?? 0) !== expectedAttempts ||
        receipts.records.filter((r) => r.caseKey === key).length !== expectedRecords
      )
        throw new Error(
          "Independent receipts did not prove the expected effect and exactly one submission per item",
        );
    }
    if (
      observed.state !== "completed" ||
      observed.verification.status !== "passed" ||
      ((scenario === "mixed" || scenario === "system-limit") &&
        !observed.logEvidence?.firstLoggedException)
    )
      throw new Error(
        "The native loop did not complete with verified counts and observed exception evidence",
      );
    state.receiptsVerified = true;
    await save();
    log({
      result: "Native session and receipts PASS; native queue export still required",
      directory,
      scenario,
    });
  }
} finally {
  await client.close();
}
