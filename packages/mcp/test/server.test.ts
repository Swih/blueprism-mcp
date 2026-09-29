import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { loadCatalog } from "@bpdev/catalog";
import { createServer, MAX_TOOL_INPUT_BYTES, type ServerDependencies } from "../src/server.js";
import { configuredServer } from "../src/config.js";
import { publicRedactor } from "../src/redaction.js";

const catalog = loadCatalog(join(import.meta.dirname, "../../catalog/test/fixtures"));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function connected(secrets = ["synthetic-secret"]) {
  const runner = {
    prepare: vi.fn<ServerDependencies["runner"]["prepare"]>(),
    validate: vi.fn<ServerDependencies["runner"]["validate"]>(),
    deploy: vi.fn<ServerDependencies["runner"]["deploy"]>(),
    start: vi.fn<ServerDependencies["runner"]["start"]>(),
    inspect: vi.fn<ServerDependencies["runner"]["inspect"]>(),
    requestStop: vi.fn<ServerDependencies["runner"]["requestStop"]>(),
    createQueue: vi.fn<ServerDependencies["runner"]["createQueue"]>(),
    prepareQueueSeed: vi.fn<ServerDependencies["runner"]["prepareQueueSeed"]>(),
    prepareQueueConsumer: vi.fn<ServerDependencies["runner"]["prepareQueueConsumer"]>(),
  };
  const app = createServer({ runner, catalog, secrets });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "protocol-test", version: "1" });
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await app.close();
  });
  return { client, runner };
}

describe("MCP protocol", () => {
  it("preserves frame references and typed metadata while masking page-authored IDs", () => {
    const id = "52d2420c-ac93-4ac9-81e8-b81f2800b66c";
    const result = publicRedactor(["1", "e"]).value({
      frames: [{ id, url: "secret" }],
      elements: [{ id: "secret", frameId: id }],
      type: "text",
      sha256: "1".repeat(64),
      createdAt: "2026-09-29T00:00:00Z",
    });
    expect(result).toEqual({
      frames: [{ id, url: "s[REDACTED]cr[REDACTED]t" }],
      elements: [{ id: "s[REDACTED]cr[REDACTED]t", frameId: id }],
      type: "text",
      sha256: "1".repeat(64),
      createdAt: "2026-09-29T00:00:00Z",
    });
  });
  it("negotiates tools with real SDK client and exposes typed schemas", async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "scan_verify",
        "bp_prepare",
        "bp_start",
        "bp_inspect",
        "bp_create_queue",
        "bp_prepare_queue_seed",
        "bp_prepare_queue_consumer",
      ]),
    );
    expect(tools.find((tool) => tool.name === "bp_prepare")?.inputSchema.required).toContain(
      "objects",
    );
    const result = await client.callTool({ name: "bp_capabilities", arguments: {} });
    expect(JSON.stringify(result)).toContain("Completed alone is not success");
    // A runner allowlist entry is not a capability of every installed AMI catalogue.
    expect(
      catalog.elementTypes.some((type) => type.conditions.some((op) => op.id === "WebCheckText")),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain("WebCheckText");
    expect(JSON.stringify(result)).toContain("WebCheckExists");
  });
  it("rejects invalid run IDs before any launch", async () => {
    const { client, runner } = await connected();
    const result = await client.callTool({
      name: "bp_start",
      arguments: { artifactId: "../../secret", requestKey: "test" },
    });
    expect(result.isError).toBe(true);
    expect(runner.start).not.toHaveBeenCalled();
  });
  it("routes observation cursor defaults and masks errors", async () => {
    const { client, runner } = await connected();
    runner.inspect.mockRejectedValue(new Error("Unavailable synthetic-secret"));
    const id = "52d2420c-ac93-4ac9-81e8-b81f2800b66c";
    const result = await client.callTool({ name: "bp_inspect", arguments: { runId: id } });
    expect(runner.inspect).toHaveBeenCalledWith(id, 0, 100);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(JSON.stringify(result)).toContain("REDACTED");
  });
  it("does not reveal invalid config values", async () => {
    await expect(configuredServer(".", { BP_LISTENER_PORT: "synthetic-secret" })).rejects.toThrow(
      "BP_LISTENER_PORT",
    );
    await expect(
      configuredServer(".", { BP_LISTENER_PORT: "synthetic-secret" }),
    ).rejects.not.toThrow("synthetic-secret");
  });
  it("requires an observation before verification", async () => {
    const { client } = await connected();
    expect(
      (await client.callTool({ name: "scan_verify", arguments: { xpath: "//input" } })).isError,
    ).toBe(true);
  });

  it("redacts decoded success data and encoded errors through the real SDK", async () => {
    const secret = 'synthetic"quoted\\credential&';
    const { client, runner } = await connected([secret]);
    const id = "52d2420c-ac93-4ac9-81e8-b81f2800b66c";
    runner.inspect.mockResolvedValue({
      run: {
        runId: id,
        artifactId: id,
        processName: "BPDEV Test",
        resource: "TEST",
        createdAt: "2026-09-29T00:00:00Z",
        updatedAt: "2026-09-29T00:00:00Z",
        state: "running",
        verification: { status: "not_run", assertions: [] },
      },
      logs: [
        { result: secret },
        { result: encodeURIComponent(secret) },
        { result: JSON.stringify(secret).slice(1, -1) },
      ].map((row) => ({ ...row, time: "2026-09-29 00:00:00", stageId: id, stageName: "Read" })),
      nextCursor: 3,
      more: false,
      observationHealth: "fresh",
    });
    const reply = await client.callTool({ name: "bp_inspect", arguments: { runId: id } });
    const body = reply.content as { type: "text"; text: string }[];
    expect(JSON.parse(body[0]?.text ?? "")).toMatchObject({
      run: { runId: id, state: "running" },
      logs: Array.from({ length: 3 }, () => ({ result: "[REDACTED]" })),
    });
    runner.inspect.mockRejectedValue(new Error(`Error ${encodeURIComponent(secret)}`));
    const error = await client.callTool({ name: "bp_inspect", arguments: { runId: id } });
    expect(JSON.stringify(error)).not.toContain(encodeURIComponent(secret));
    expect(JSON.stringify(error)).toContain("[REDACTED]");
  });

  it.each(["1", "e", "*", "completed"])(
    "preserves structural JSON with short secret %s",
    async (secret) => {
      const { client, runner } = await connected([secret, secret]);
      const id = "52d2420c-ac93-4ac9-81e8-b81f2800b66c";
      runner.inspect.mockResolvedValue({
        run: {
          runId: id,
          artifactId: id,
          processName: "BPDEV Test",
          resource: "TEST",
          createdAt: "2026-09-29T00:00:00Z",
          updatedAt: "2026-09-29T00:00:00Z",
          bpSessionId: id,
          state: "completed",
          bpStatus: "Completed",
          verification: { status: "passed", assertions: [] },
        },
        logs: [{ stageId: id, result: secret, time: "2026-09-29 00:00:00", stageName: "Read" }],
        nextCursor: 1,
        more: false,
        observationHealth: "fresh",
      });
      const reply = await client.callTool({ name: "bp_inspect", arguments: { runId: id } });
      const data = JSON.parse((reply.content as { text: string }[])[0]?.text ?? "") as Record<
        string,
        unknown
      >;
      expect(data).toMatchObject({
        run: {
          runId: id,
          bpSessionId: id,
          state: "completed",
          bpStatus: "Completed",
          verification: { status: "passed" },
        },
        logs: [{ stageId: id, result: "[REDACTED]" }],
        nextCursor: 1,
        more: false,
      });
    },
  );

  it("never echoes secret-bearing unknown keys, invalid fields or tool names", async () => {
    const secret = 'synthetic"credential';
    const { client, runner } = await connected([secret]);
    for (const request of [
      {
        name: "bp_inspect",
        arguments: { runId: "52d2420c-ac93-4ac9-81e8-b81f2800b66c", [secret]: true },
      },
      { name: "bp_inspect", arguments: { runId: secret } },
      { name: secret, arguments: {} },
    ]) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic");
    }
    expect(runner.inspect).not.toHaveBeenCalled();
  });

  it("rejects oversized plans before generation, including UTF-8 bytes", async () => {
    const { client, runner } = await connected();
    for (const payload of [
      "x".repeat(8 * 1024 * 1024),
      "é".repeat(MAX_TOOL_INPUT_BYTES / 2),
      Array<string>(70000).fill("x"),
    ]) {
      const result = await client.callTool({
        name: "bp_prepare",
        arguments: { objects: [], harness: { payload } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("256 KiB");
    }
    expect(runner.prepare).not.toHaveBeenCalled();
  });

  it("routes the queue workflow through advertised typed tools without native execution", async () => {
    const { client, runner } = await connected();
    const name = "BPDEV SDK Queue";
    runner.createQueue.mockResolvedValue({
      name,
      state: "created",
      queueId: "52d2420c-ac93-4ac9-81e8-b81f2800b66c",
      createdAt: "2026-09-29T00:00:00Z",
    });
    const created = await client.callTool({ name: "bp_create_queue", arguments: { name } });
    expect(created.isError).not.toBe(true);
    expect(runner.createQueue).toHaveBeenCalledWith(name);
    const artifact = {
      artifactId: "52d2420c-ac93-4ac9-81e8-b81f2800b66c",
      createdAt: "2026-09-29T00:00:00Z",
      processName: "BPDEV SDK Seed",
      files: [],
      assertions: { version: 1 as const, processName: "BPDEV SDK Seed", assertions: [] },
    };
    runner.prepareQueueSeed.mockResolvedValue(artifact);
    const seed = { name: artifact.processName, queueName: name, items: [{ CaseKey: "demo-001" }] };
    expect(
      (await client.callTool({ name: "bp_prepare_queue_seed", arguments: seed })).isError,
    ).not.toBe(true);
    expect(runner.prepareQueueSeed).toHaveBeenCalledWith(seed);
    runner.prepareQueueConsumer.mockResolvedValue(artifact);
    const input = {
      objects: [
        {
          name: "BPDEV SDK Form",
          description: "Synthetic",
          runMode: "Exclusive",
          application: { kind: "BrowserAttach", name: "Browser" },
          elements: [],
          actions: [],
        },
      ],
      consumer: {
        name: "BPDEV SDK Consumer",
        queueName: name,
        call: {
          object: "BPDEV SDK Form",
          action: "Submit",
          input: "CaseKey",
          confirmationOutput: "Confirmation",
          expectedConfirmationPrefix: "CONFIRMED:",
        },
      },
      expectedOutcome: "Completed",
      expectedCounts: { completed: 2, businessExceptions: 0, systemExceptions: 0 },
    };
    expect(
      (await client.callTool({ name: "bp_prepare_queue_consumer", arguments: input })).isError,
    ).not.toBe(true);
    expect(runner.prepareQueueConsumer).toHaveBeenCalledWith({
      ...input,
      consumer: {
        ...input.consumer,
        maxItems: 100,
        consecutiveSystemExceptionLimit: 3,
        retryPolicy: "never",
      },
    });
    const { expectedCounts: _, ...withoutCounts } = input;
    const invalidInputs = [
      withoutCounts,
      ...[
        null,
        {},
        [],
        { completed: 1, businessExceptions: 0 },
        { completed: 999, businessExceptions: 1, systemExceptions: 1 },
        { completed: 1, businessExceptions: 0, systemExceptions: 0, extra: 0 },
        ...["completed", "businessExceptions", "systemExceptions"].flatMap((key) =>
          [-1, 1001, 0.5, "1", true, null].map((value) => ({
            completed: 0,
            businessExceptions: 0,
            systemExceptions: 0,
            [key]: value,
          })),
        ),
      ].map((expectedCounts) => ({ ...input, expectedCounts })),
      ...["BusinessException", "SystemException", "TechnicalException", ""].map(
        (expectedOutcome) => ({ ...input, expectedOutcome }),
      ),
      ...[
        ...[0, -1, 1001, 1.5, "2", null].map((maxItems) => ({ maxItems })),
        ...[0, -1, 101, 1.5, "3", null].map((consecutiveSystemExceptionLimit) => ({
          consecutiveSystemExceptionLimit,
        })),
        { retryPolicy: "always" },
      ].map((controls) => ({ ...input, consumer: { ...input.consumer, ...controls } })),
      ...["", "CONFIRMED:", "rejected\n", 1].map((businessRejectionPrefix) => ({
        ...input,
        consumer: { ...input.consumer, call: { ...input.consumer.call, businessRejectionPrefix } },
      })),
    ];
    for (const arguments_ of invalidInputs) {
      expect(
        (await client.callTool({ name: "bp_prepare_queue_consumer", arguments: arguments_ }))
          .isError,
      ).toBe(true);
    }
    expect(runner.prepareQueueConsumer).toHaveBeenCalledTimes(1);
    for (const expectedOutcome of [
      "Completed",
      "CompletedWithExceptions",
      "NoAvailableItem",
      "Stopped",
    ]) {
      const explicit = {
        ...input,
        expectedOutcome,
        expectedCounts: { completed: 998, businessExceptions: 1, systemExceptions: 1 },
        consumer: {
          ...input.consumer,
          maxItems: 1000,
          consecutiveSystemExceptionLimit: 100,
          retryPolicy: "never",
          call: { ...input.consumer.call, businessRejectionPrefix: "REJECTED:" },
        },
      };
      expect(
        (await client.callTool({ name: "bp_prepare_queue_consumer", arguments: explicit })).isError,
      ).not.toBe(true);
      expect(runner.prepareQueueConsumer).toHaveBeenLastCalledWith(explicit);
    }
    const tools = (await client.listTools()).tools;
    const schema = tools.find((tool) => tool.name === "bp_prepare_queue_consumer")?.inputSchema;
    expect(schema?.required).toEqual(expect.arrayContaining(["expectedOutcome", "expectedCounts"]));
    const capabilities = await client.callTool({ name: "bp_capabilities", arguments: {} });
    expect(JSON.parse((capabilities.content as { text: string }[])[0]?.text ?? "")).toMatchObject({
      queuePolicy: {
        maxItemsPerRun: 1000,
        defaultMaxItems: 100,
        defaultConsecutiveSystemExceptionLimit: 3,
        loop: "native",
        maxAttempts: 1,
        retryPolicy: "never",
        maxSeedItems: 20,
        seedBatchesPerCreatedQueue: 1,
        keyField: "CaseKey",
      },
    });
  });
  it.each(["Completed", "CompletedWithExceptions", "NoAvailableItem", "Stopped"])(
    "preserves the structural queue outcome %s during redaction",
    (expectedOutcome) => {
      expect(
        publicRedactor([expectedOutcome]).value({ expectedOutcome, detail: expectedOutcome }),
      ).toEqual({
        expectedOutcome,
        detail: "[REDACTED]",
      });
    },
  );
  it("does not preserve the obsolete BusinessException aggregate as an enum", () => {
    expect(
      publicRedactor(["BusinessException"]).value({ expectedOutcome: "BusinessException" }),
    ).toEqual({
      expectedOutcome: "[REDACTED]",
    });
  });
});
