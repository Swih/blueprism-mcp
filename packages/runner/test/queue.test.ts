import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childElements, firstChild, getAttr, listStages, parseBpXml } from "@bpdev/model";
import { Runner, type QueueBuildSpec } from "../src/index.js";
import { cleanup, deployed, fixture, SESSION, spec, type Fixture } from "./helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await cleanup(f.directory);
});
const queueName = "BPDEV Queue Test";
function queueRunner(createQueue = vi.fn(() => Promise.resolve(SESSION))) {
  return {
    createQueue,
    runner: new Runner({ ...f.options, automatec: { ...f.options.automatec, createQueue } }),
  };
}
function consumerSpec(): QueueBuildSpec {
  const object = spec().objects[0];
  if (!object?.actions[0]) throw new Error("Fixture has no action");
  object.actions[0].inputs = [{ name: "CaseKey", type: "text", description: "" }];
  return {
    objects: [object],
    consumer: {
      name: "BPDEV Queue Consumer Test",
      queueName,
      call: {
        object: object.name,
        action: "Observe",
        input: "CaseKey",
        confirmationOutput: "Answer",
        expectedConfirmationPrefix: "CONFIRMED:",
      },
    },
    expectedOutcome: "Completed",
    expectedCounts: { completed: 2, businessExceptions: 0, systemExceptions: 0 },
  };
}
describe("native queues through the product runner", () => {
  it("creates once across restarts and does not overwrite an existing queue", async () => {
    const { runner, createQueue } = queueRunner();
    expect(await runner.createQueue(queueName)).toMatchObject({
      state: "created",
      queueId: SESSION,
    });
    await runner.createQueue(queueName.toLowerCase().replace("bpdev", "BPDEV"));
    expect(createQueue).toHaveBeenCalledExactlyOnceWith(queueName, "CaseKey", 1);
  });
  it("never replays a creation with lost acknowledgement", async () => {
    const { runner, createQueue } = queueRunner(
      vi.fn(() => Promise.reject(new Error("lost acknowledgement"))),
    );
    expect(await runner.createQueue(queueName)).toMatchObject({ state: "unknown" });
    await expect(runner.createQueue(queueName)).rejects.toMatchObject({ code: "QUEUE_UNRESOLVED" });
    expect(createQueue).toHaveBeenCalledTimes(1);
  });
  it("validates, deploys and verifies a standalone native seed, then prevents duplicate seed even with another key", async () => {
    const { runner } = queueRunner();
    await runner.createQueue(queueName);
    const seed = await runner.prepareQueueSeed({
      name: "BPDEV Queue Seed Test",
      queueName,
      items: [{ CaseKey: "demo-one" }, { CaseKey: "demo-two" }],
    });
    expect(seed.files).toHaveLength(1);
    expect((await runner.validate(seed.artifactId)).valid).toBe(true);
    await runner.deploy(seed.artifactId);
    const run = await runner.start(seed.artifactId, "seed-once");
    f.fake.automatec.status.mockResolvedValue("Completed");
    f.fake.listener.outputs.mockResolvedValue([{ name: "Seed Count", type: "number", value: "2" }]);
    expect((await runner.inspect(run.runId)).run.verification.status).toBe("passed");
    expect((await runner.start(seed.artifactId, "seed-once")).runId).toBe(run.runId);
    await expect(runner.start(seed.artifactId, "duplicate")).rejects.toMatchObject({
      code: "SEED_UNRESOLVED",
    });
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });
  it("generates a native consumer with an aggregate outcome and all four count assertions", async () => {
    const artifact = await f.runner.prepareQueueConsumer(consumerSpec());
    expect(artifact.queue).toEqual({ name: queueName, role: "consumer" });
    expect(artifact.assertions.assertions).toMatchObject([
      { outputName: "Outcome", type: "text", expected: "Completed" },
      { outputName: "Completed Count", type: "number", expected: "2" },
      { outputName: "Business Exception Count", type: "number", expected: "0" },
      { outputName: "System Exception Count", type: "number", expected: "0" },
      { outputName: "Processed Count", type: "number", expected: "2" },
    ]);
    const xml = await f.store.text("artifacts", artifact.artifactId, "process.bpprocess");
    const end = listStages(parseBpXml(xml).root).find(
      (stage) => stage.type === "End" && stage.pageId === undefined,
    );
    const outputs = end && firstChild(end.element, "outputs");
    expect(outputs).toBeDefined();
    const resultContract =
      outputs &&
      childElements(outputs).map((output) => ({
        name: getAttr(output, "name"),
        type: getAttr(output, "type"),
      }));
    expect(resultContract).toHaveLength(9);
    expect(resultContract).toEqual(
      expect.arrayContaining([
        { name: "Outcome", type: "text" },
        { name: "Completed Count", type: "number" },
        { name: "Business Exception Count", type: "number" },
        { name: "System Exception Count", type: "number" },
        { name: "Processed Count", type: "number" },
        { name: "Stop Reason", type: "text" },
        { name: "Last Item ID", type: "text" },
        { name: "Last Case Key", type: "text" },
        { name: "Failure Detail", type: "text" },
      ]),
    );
    expect((await f.runner.validate(artifact.artifactId)).valid).toBe(true);
    expect(f.fake.automatec.run).not.toHaveBeenCalled();
  });
  it.each<QueueBuildSpec["expectedOutcome"]>([
    "Completed",
    "CompletedWithExceptions",
    "NoAvailableItem",
    "Stopped",
  ])("accepts aggregate outcome %s and inclusive control/count bounds", async (expectedOutcome) => {
    const input = consumerSpec();
    const artifact = await f.runner.prepareQueueConsumer({
      ...input,
      expectedOutcome,
      expectedCounts: { completed: 998, businessExceptions: 1, systemExceptions: 1 },
      consumer: {
        ...input.consumer,
        maxItems: 1000,
        consecutiveSystemExceptionLimit: 100,
        call: { ...input.consumer.call, businessRejectionPrefix: "REJECTED:" },
      },
    });
    expect(artifact.assertions.assertions[0]?.expected).toBe(expectedOutcome);
    expect(artifact.assertions.assertions.at(-1)?.expected).toBe("1000");
  });
  it.each([
    undefined,
    null,
    {},
    [],
    "2",
    2,
    { completed: 1, businessExceptions: 0 },
    { completed: 1, businessExceptions: 0, systemExceptions: 0, extra: 0 },
    { completed: 999, businessExceptions: 1, systemExceptions: 1 },
    ...["completed", "businessExceptions", "systemExceptions"].flatMap((key) =>
      [-1, 1001, 0.5, NaN, Infinity, "1", true, null, undefined].map((value) => ({
        completed: 0,
        businessExceptions: 0,
        systemExceptions: 0,
        [key]: value,
      })),
    ),
  ])("rejects invalid direct API counts %j", async (expectedCounts) => {
    await expect(
      f.runner.prepareQueueConsumer({
        ...consumerSpec(),
        expectedCounts,
      } as unknown as QueueBuildSpec),
    ).rejects.toMatchObject({ code: "INVALID_SPEC" });
    expect(f.fake.automatec.run).not.toHaveBeenCalled();
  });
  it.each([
    ...[0, -1, 1001, 1.5, NaN, Infinity, "2", true, null].map((maxItems) => ({ maxItems })),
    ...[0, -1, 101, 1.5, NaN, Infinity, "3", true, null].map((consecutiveSystemExceptionLimit) => ({
      consecutiveSystemExceptionLimit,
    })),
    { retryPolicy: "always" },
    { retryPolicy: null },
  ])("rejects invalid direct API controls %j", async (controls) => {
    const input = consumerSpec();
    await expect(
      f.runner.prepareQueueConsumer({
        ...input,
        consumer: { ...input.consumer, ...controls },
      } as unknown as QueueBuildSpec),
    ).rejects.toMatchObject({ code: "INVALID_SPEC" });
  });
  it.each([undefined, null, "BusinessException", "SystemException", "TechnicalException", ""])(
    "rejects missing or obsolete aggregate outcome %s",
    async (expectedOutcome) => {
      await expect(
        f.runner.prepareQueueConsumer({
          ...consumerSpec(),
          expectedOutcome,
        } as unknown as QueueBuildSpec),
      ).rejects.toMatchObject({ code: "INVALID_SPEC" });
    },
  );
  it.each([undefined, null, [], 1])("rejects malformed direct API build %j", async (input) => {
    await expect(
      f.runner.prepareQueueConsumer(input as unknown as QueueBuildSpec),
    ).rejects.toMatchObject({ code: "INVALID_SPEC" });
  });
  it.each([undefined, null, {}, 1])(
    "rejects malformed direct API consumer %j",
    async (consumer) => {
      await expect(
        f.runner.prepareQueueConsumer({ ...consumerSpec(), consumer } as unknown as QueueBuildSpec),
      ).rejects.toMatchObject({ code: "INVALID_SPEC" });
    },
  );
  it.each(["", "CONFIRMED:", "rejected\n", 1])(
    "rejects invalid rejection prefix %j",
    async (businessRejectionPrefix) => {
      const input = consumerSpec();
      await expect(
        f.runner.prepareQueueConsumer({
          ...input,
          consumer: {
            ...input.consumer,
            call: { ...input.consumer.call, businessRejectionPrefix },
          },
        } as unknown as QueueBuildSpec),
      ).rejects.toMatchObject({ code: "INVALID_SPEC" });
    },
  );
  it("verifies a multi-item aggregate in one session and never launches once per item", async () => {
    const artifact = await f.runner.prepareQueueConsumer({
      ...consumerSpec(),
      expectedOutcome: "CompletedWithExceptions",
      expectedCounts: { completed: 2, businessExceptions: 1, systemExceptions: 1 },
    });
    await f.runner.deploy(artifact.artifactId);
    const run = await f.runner.start(artifact.artifactId, "bounded-loop");
    f.fake.automatec.status.mockResolvedValue("Completed");
    f.fake.listener.outputs.mockResolvedValue([
      { name: "Outcome", type: "text", value: "CompletedWithExceptions" },
      { name: "Completed Count", type: "number", value: "2" },
      { name: "Business Exception Count", type: "number", value: "1" },
      { name: "System Exception Count", type: "number", value: "1" },
      { name: "Processed Count", type: "number", value: "4" },
    ]);
    expect((await f.runner.inspect(run.runId)).run.verification.status).toBe("passed");
    expect((await f.runner.start(artifact.artifactId, "bounded-loop")).runId).toBe(run.runId);
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });
  it.each([
    "missing counts",
    "Completed Count",
    "Business Exception Count",
    "System Exception Count",
    "Processed Count",
  ])("does not accept Completed with %s wrong", async (invalid) => {
    const artifact = await f.runner.prepareQueueConsumer(consumerSpec());
    await f.runner.deploy(artifact.artifactId);
    const run = await f.runner.start(artifact.artifactId, "counts-required");
    f.fake.automatec.status.mockResolvedValue("Completed");
    const outputs = [
      { name: "Outcome", type: "text", value: "Completed" },
      { name: "Completed Count", type: "number", value: "2" },
      { name: "Business Exception Count", type: "number", value: "0" },
      { name: "System Exception Count", type: "number", value: "0" },
      { name: "Processed Count", type: "number", value: "2" },
    ];
    f.fake.listener.outputs.mockResolvedValue(
      invalid === "missing counts"
        ? outputs.slice(0, 1)
        : outputs.map((output) => (output.name === invalid ? { ...output, value: "9" } : output)),
    );
    const observed = await f.runner.inspect(run.runId);
    expect(observed.run.state).toBe("completed");
    expect(observed.run.verification.status).toBe("failed");
    expect(observed.run.verification.assertions).toContainEqual(
      expect.objectContaining({
        outputName: invalid === "missing counts" ? "Completed Count" : invalid,
        status: "failed",
      }),
    );
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });
  it("accepts zero counts and the minimum loop bounds for an empty queue", async () => {
    const input = consumerSpec();
    const artifact = await f.runner.prepareQueueConsumer({
      ...input,
      expectedOutcome: "NoAvailableItem",
      expectedCounts: { completed: 0, businessExceptions: 0, systemExceptions: 0 },
      consumer: { ...input.consumer, maxItems: 1, consecutiveSystemExceptionLimit: 1 },
    });
    expect(
      artifact.assertions.assertions.slice(1).every((assertion) => assertion.expected === "0"),
    ).toBe(true);
  });
});
describe("runtime identity and uncertain business results", () => {
  it("persists the port and rejects the same key on another runtime", async () => {
    const artifact = await deployed(f);
    const runner = new Runner({ ...f.options, resourcePort: 8182 });
    const run = await runner.start(artifact.artifactId, "port-bound");
    expect(run.resourcePort).toBe(8182);
    expect(f.fake.automatec.run).toHaveBeenCalledWith(artifact.processName, {
      resource: "TEST-ROBOT",
      port: 8182,
    });
    await expect(f.runner.start(artifact.artifactId, "port-bound")).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    await expect(f.runner.inspect(run.runId)).rejects.toMatchObject({ code: "RESOURCE_MISMATCH" });
  });
  it("a failed session blocks new requests until an operator records independent business evidence", async () => {
    const artifact = await deployed(f);
    const run = await f.runner.start(artifact.artifactId, "first");
    await f.runner.inspect(run.runId);
    f.fake.automatec.status.mockResolvedValue("Failed");
    const previousLogs = await f.fake.automatec.getLog();
    f.fake.automatec.getLog.mockResolvedValue([
      ...previousLogs,
      {
        time: "2026-09-29 12:01:00",
        stageId: SESSION,
        stageName: "Wait",
        result: "ERROR: System Exception : Confirmation missing",
      },
    ]);
    const observed = await f.runner.inspect(run.runId);
    expect(observed.run.reconciliationRequired).toBe(true);
    expect(observed.run.logEvidence?.firstLoggedException?.detail).toBe("Confirmation missing");
    await expect(f.runner.start(artifact.artifactId, "second")).rejects.toMatchObject({
      code: "RUN_UNRESOLVED",
    });
    await f.runner.recordReconciliation(
      run.runId,
      "Synthetic receipt service independently confirms one effect; item must not be replayed.",
    );
    expect((await f.runner.inspect(run.runId)).run.reconciliationRequired).toBe(false);
    await f.runner.start(artifact.artifactId, "next-work");
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(2);
  });
});
