import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandFailedError, RunOutcomeUnknownError, ToolTimeoutError } from "@bpdev/bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runner, RunnerError } from "../src/index.js";
import { fingerprint, Store } from "../src/store.js";
import { cleanup, deployed, fixture, log, SESSION, spec, type Fixture } from "./helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup(f.directory);
});

describe("durable launch idempotency", () => {
  it("starts when requests is empty, persists the session and reuses the key after restart", async () => {
    const artifact = await deployed(f);
    const first = await f.runner.start(artifact.artifactId, "same-key");
    expect(first).toMatchObject({
      state: "running",
      bpSessionId: SESSION,
      verification: { status: "not_run" },
    });
    const restarted = new Runner(f.options);
    await restarted.initialize();
    expect(await restarted.start(artifact.artifactId, "same-key")).toEqual(first);
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });

  it("supports the checksummed initial native deployment format without rewriting it", async () => {
    const artifact = await f.runner.prepare(spec());
    const legacy = {
      ...artifact,
      files: artifact.files.map((file, i) => ({
        name: file.name,
        sha256: file.sha256,
        file: file.kind === "process" ? "process.bpprocess" : `object-${i}.bpobject`,
      })),
    };
    await f.store.write("artifacts", artifact.artifactId, legacy);
    await f.store.write(
      "artifacts",
      artifact.artifactId,
      {
        state: "deployed",
        imported: artifact.files.map((file) => file.name),
        at: artifact.createdAt,
      },
      "deployment.json",
    );
    const before = await readFile(
      f.store.path("artifacts", artifact.artifactId, "manifest.json"),
      "utf8",
    );
    expect(await f.runner.deployment(artifact.artifactId)).toMatchObject({ state: "deployed" });
    const result = await f.runner.start(artifact.artifactId, "native-existing-artifact");
    expect(result.bpSessionId).toBe(SESSION);
    expect(
      await readFile(f.store.path("artifacts", artifact.artifactId, "manifest.json"), "utf8"),
    ).toBe(before);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });

  it("rejects a reused key for another artifact without calling the runtime", async () => {
    const artifact = await deployed(f);
    await f.runner.start(artifact.artifactId, "key");
    const second = await f.runner.prepare(spec());
    await expect(f.runner.start(second.artifactId, "key")).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    new RunOutcomeUnknownError("PRIVATE PATH", null),
    new ToolTimeoutError("AutomateC", "/run", 100),
    new Error("C:\\private\\secret.xml"),
  ])("never repeats an ambiguous start, even with a fresh key", async (error) => {
    const artifact = await deployed(f);
    f.fake.automatec.run.mockRejectedValueOnce(error);
    const first = await f.runner.start(artifact.artifactId, "ambiguous");
    expect(first).toMatchObject({ state: "unknown", reconciliationRequired: true });
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE PATH|secret\.xml/);
    expect((await new Runner(f.options).start(artifact.artifactId, "ambiguous")).runId).toBe(
      first.runId,
    );
    await expect(f.runner.start(artifact.artifactId, "new-key")).rejects.toMatchObject({
      code: "RUN_UNRESOLVED",
    });
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });

  it("records a known rejection but never resubmits that request key", async () => {
    const artifact = await deployed(f);
    f.fake.automatec.run.mockRejectedValueOnce(
      new CommandFailedError("AutomateC", "/run", "rejected"),
    );
    const first = await f.runner.start(artifact.artifactId, "rejected");
    expect(first.state).toBe("failed");
    expect((await f.runner.start(artifact.artifactId, "rejected")).runId).toBe(first.runId);
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });

  it("a reservation directory without a manifest is damaged, not missing", async () => {
    const artifact = await deployed(f);
    await mkdir(join(f.directory, "requests", fingerprint("interrupted")));
    await expect(f.runner.start(artifact.artifactId, "interrupted")).rejects.toMatchObject({
      code: "STORE_INTEGRITY",
    });
    expect(f.fake.automatec.run).not.toHaveBeenCalled();
  });

  it("a reservation pointing to a missing run never permits a second launch", async () => {
    const artifact = await deployed(f);
    const first = await f.runner.start(artifact.artifactId, "key");
    await unlink(f.store.path("runs", first.runId, "manifest.json"));
    await expect(new Runner(f.options).start(artifact.artifactId, "key")).rejects.toMatchObject({
      code: "STORE_INTEGRITY",
    });
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });

  it("losing the session persistence after acknowledgement leaves an unreplayable request", async () => {
    const artifact = await deployed(f);
    const original = Store.prototype.write.bind(f.store);
    vi.spyOn(Store.prototype, "write").mockImplementation(async function (
      this: Store,
      area,
      id,
      value,
      file,
    ) {
      if (area === "runs" && (value as { state?: string }).state === "running")
        throw new RunnerError("STORE_UNAVAILABLE", "Injected failure");
      return original(area, id, value, file);
    });
    await expect(f.runner.start(artifact.artifactId, "ack-lost")).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
    });
    vi.restoreAllMocks();
    expect(await new Runner(f.options).start(artifact.artifactId, "ack-lost")).toMatchObject({
      state: "unknown",
      reconciliationRequired: true,
    });
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });

  it("concurrent runner instances cannot launch twice", async () => {
    const artifact = await deployed(f);
    let release: (value: string) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fake.automatec.run.mockImplementationOnce(async () => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const first = f.runner.start(artifact.artifactId, "concurrent");
    await started;
    await expect(
      new Runner(f.options).start(artifact.artifactId, "concurrent"),
    ).rejects.toMatchObject({ code: "MUTATION_BUSY" });
    release(SESSION);
    const record = await first;
    expect((await new Runner(f.options).start(artifact.artifactId, "concurrent")).runId).toBe(
      record.runId,
    );
    expect(f.fake.automatec.run).toHaveBeenCalledTimes(1);
  });
});

describe("deployment and idle boundary", () => {
  it("validates all files before imports and rejects a name conflict ignoring case", async () => {
    const artifact = await f.runner.prepare(spec());
    f.fake.automatec.listProcesses.mockResolvedValue([artifact.processName.toLowerCase()]);
    await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
      code: "DEPLOYMENT_CONFLICT",
    });
    expect(f.fake.probe.validate).toHaveBeenCalledTimes(2);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });

  it("sanitizes validation rejection and unexpected native identity", async () => {
    const artifact = await f.runner.prepare(spec());
    f.fake.probe.validate.mockResolvedValueOnce({
      level: "native-parse",
      valid: true,
      name: "C:\\private\\object.xml",
      kind: "Object",
      stages: 10,
      expressionsChecked: 0,
    });
    const validation = await f.runner.validate(artifact.artifactId);
    expect(validation.valid).toBe(false);
    expect(JSON.stringify(validation)).not.toContain("private");
    f.fake.probe.validate.mockRejectedValueOnce(new Error("C:\\private\\file.xml"));
    await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
      code: "VALIDATION_UNAVAILABLE",
    });
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });

  it("refuses a parser-only legacy probe before importing anything", async () => {
    const artifact = await f.runner.prepare(spec());
    const original = f.fake.probe.validate.getMockImplementation();
    if (!original) throw new Error("Fixture probe implementation is required");
    f.fake.probe.validate.mockImplementation(async (file) => {
      const value = await original(file);
      return { ...value, expressionsChecked: Number.NaN };
    });
    await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
      code: "NATIVE_VALIDATION_FAILED",
    });
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });

  it.each(["import", "publish"] as const)(
    "persists %s ambiguity and refuses replay or launch",
    async (operation) => {
      const artifact = await f.runner.prepare(spec());
      if (operation === "import")
        f.fake.automatec.import
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("private XML path"));
      else f.fake.automatec.publish.mockRejectedValueOnce(new Error("private XML path"));
      await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
        code: "DEPLOYMENT_PARTIAL",
      });
      const record = await new Runner(f.options).deployment(artifact.artifactId);
      expect(record).toMatchObject({ state: "partial", inFlight: { operation } });
      expect(record.imported).toHaveLength(operation === "import" ? 1 : 2);
      const count = f.fake.automatec.import.mock.calls.length;
      await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
        code: "DEPLOYMENT_UNRESOLVED",
      });
      await expect(f.runner.start(artifact.artifactId, "key")).rejects.toMatchObject({
        code: "NOT_DEPLOYED",
      });
      expect(f.fake.automatec.import).toHaveBeenCalledTimes(count);
      expect(f.fake.automatec.run).not.toHaveBeenCalled();
    },
  );

  it("repeated successful deployment returns evidence without importing again", async () => {
    const artifact = await deployed(f);
    const before = await f.runner.deployment(artifact.artifactId);
    expect(await f.runner.deploy(artifact.artifactId)).toEqual(before);
    expect(f.fake.automatec.import).toHaveBeenCalledTimes(2);
  });

  it.each(["busy", "running", "pending", "unavailable"] as const)(
    "fails closed when the resource is %s",
    async (condition) => {
      const artifact = await deployed(f);
      if (condition === "busy") f.fake.listener.busy.mockResolvedValue(true);
      if (condition === "running")
        f.fake.listener.status.mockResolvedValue({
          totalRunning: 1,
          sessions: [{ sessionId: SESSION, status: "RUNNING" }],
        });
      if (condition === "pending")
        f.fake.listener.status.mockResolvedValue({
          totalRunning: 0,
          sessions: [{ sessionId: SESSION, status: "PENDING" }],
        });
      if (condition === "unavailable")
        f.fake.listener.status.mockRejectedValue(new Error("Private credentials/path"));
      await expect(f.runner.start(artifact.artifactId, condition)).rejects.toMatchObject({
        code: condition === "unavailable" ? "OBSERVATION_UNAVAILABLE" : "RESOURCE_BUSY",
      });
      expect(f.fake.automatec.run).not.toHaveBeenCalled();
    },
  );
});

describe("observation, verification and stop acknowledgement", () => {
  async function running() {
    const artifact = await deployed(f);
    return f.runner.start(artifact.artifactId, "run");
  }

  it("Completed with a wrong output is failed verification", async () => {
    const run = await running();
    f.fake.automatec.status.mockResolvedValue("Completed");
    f.fake.listener.outputs.mockResolvedValue([{ name: "Answer", type: "text", value: "wrong" }]);
    const observed = await f.runner.inspect(run.runId);
    expect(observed.run).toMatchObject({
      state: "completed",
      verification: { status: "failed", assertions: [{ reason: "value_mismatch" }] },
    });
    expect(observed.run.verifiedAt).toBeDefined();
  });

  it("unavailable outputs cannot create success and cannot erase earlier evidence", async () => {
    const run = await running();
    f.fake.automatec.status.mockResolvedValue("Completed");
    f.fake.listener.outputs.mockRejectedValueOnce(new Error("private"));
    const missing = await f.runner.inspect(run.runId);
    expect(missing).toMatchObject({
      observationHealth: "unavailable",
      run: { state: "completed", verification: { status: "not_run" } },
    });
    const good = await f.runner.inspect(run.runId);
    expect(good.run.verification.status).toBe("passed");
    f.fake.listener.outputs.mockRejectedValueOnce(new Error("private"));
    const later = await new Runner(f.options).inspect(run.runId);
    expect(later.observationHealth).toBe("unavailable");
    expect(later.run.verification).toEqual(good.run.verification);
    expect(later.run.verifiedAt).toBe(good.run.verifiedAt);
    f.fake.automatec.status.mockRejectedValueOnce(new Error("private"));
    expect((await f.runner.inspect(run.runId)).run.verification).toEqual(good.run.verification);
  });

  it("conflicting final outputs preserve evidence and require reconciliation", async () => {
    const run = await running();
    f.fake.automatec.status.mockResolvedValue("Completed");
    const good = await f.runner.inspect(run.runId);
    f.fake.listener.outputs.mockResolvedValue([{ name: "Answer", type: "text", value: "wrong" }]);
    const conflict = await f.runner.inspect(run.runId);
    expect(conflict).toMatchObject({
      observationHealth: "unavailable",
      run: { reconciliationRequired: true },
    });
    expect(conflict.run.verification).toEqual(good.run.verification);
  });

  it("archived or unavailable status never manufactures completion", async () => {
    const run = await running();
    f.fake.automatec.status.mockResolvedValue("Archived");
    expect(await f.runner.inspect(run.runId)).toMatchObject({
      observationHealth: "unavailable",
      run: { state: "running", verification: { status: "not_run" } },
    });
    expect(f.fake.listener.outputs).not.toHaveBeenCalled();
  });

  it("persists cursors, detects shrinking/replaced logs and keeps the cursor on failure", async () => {
    const run = await running();
    const first = await f.runner.inspect(run.runId, 0, 2);
    expect(first).toMatchObject({ nextCursor: 2, more: true, observationHealth: "fresh" });
    expect(first.logs).toHaveLength(2);
    const second = await new Runner(f.options).inspect(run.runId, 2, 2);
    expect(second).toMatchObject({ nextCursor: 3, more: false });
    f.fake.automatec.getLog.mockRejectedValueOnce(new Error("unavailable"));
    expect(await f.runner.inspect(run.runId, 3)).toMatchObject({
      nextCursor: 3,
      observationHealth: "unavailable",
      logs: [],
    });
    f.fake.automatec.getLog.mockResolvedValue([log(0)]);
    expect(await f.runner.inspect(run.runId, 3)).toMatchObject({
      nextCursor: 0,
      observationHealth: "unavailable",
      logs: [],
    });
    expect((await f.runner.inspect(run.runId, 0)).logs).toHaveLength(1);
    f.fake.automatec.getLog.mockResolvedValue([log(99)]);
    expect(await f.runner.inspect(run.runId, 1)).toMatchObject({
      nextCursor: 0,
      observationHealth: "unavailable",
    });
  });

  it("stop acknowledgement does not mean stopped and is not reissued", async () => {
    const run = await running();
    expect(await f.runner.requestStop(run.runId)).toEqual({
      requested: true,
      acknowledged: true,
      runId: run.runId,
    });
    expect((await f.runner.run(run.runId)).state).toBe("running");
    expect((await new Runner(f.options).requestStop(run.runId)).acknowledged).toBe(true);
    expect(f.fake.automatec.requestStop).toHaveBeenCalledTimes(1);
    f.fake.automatec.status.mockResolvedValue("Stopped");
    expect((await f.runner.inspect(run.runId)).run.state).toBe("stopped");
  });

  it("lost stop acknowledgement stays unknown without automatic replay", async () => {
    const run = await running();
    f.fake.automatec.requestStop.mockRejectedValueOnce(new Error("private"));
    await expect(f.runner.requestStop(run.runId)).rejects.toMatchObject({
      code: "STOP_OUTCOME_UNKNOWN",
    });
    expect(await new Runner(f.options).requestStop(run.runId)).toMatchObject({
      acknowledged: false,
    });
    expect((await f.runner.run(run.runId)).state).toBe("running");
    expect(f.fake.automatec.requestStop).toHaveBeenCalledTimes(1);
  });
});

describe("store integrity and public surface", () => {
  it("allows an idle runtime retaining completed sessions in Total running", async () => {
    f.fake.listener.status.mockResolvedValue({
      totalRunning: 1,
      sessions: [{ sessionId: SESSION, status: "COMPLETED" }],
    });
    const artifact = await deployed(f);
    expect((await f.runner.start(artifact.artifactId, "retained-completed")).state).toBe("running");
  });
  it("never exposes artifact XML filenames or host paths", async () => {
    const artifact = await deployed(f);
    expect(JSON.stringify(artifact)).not.toMatch(
      /object-0\.bpobject|process\.bpprocess|Robot Profiles/,
    );
    expect(artifact.files.map((file) => file.kind)).toEqual(["object", "process"]);
  });

  it("detects changes to XML and checksummed assertions", async () => {
    const artifact = await f.runner.prepare(spec());
    const path = f.store.path("artifacts", artifact.artifactId, "object-0.bpobject");
    await writeFile(path, "<changed/>");
    await expect(f.runner.artifact(artifact.artifactId)).rejects.toMatchObject({
      code: "STORE_INTEGRITY",
    });
    const second = await f.runner.prepare(spec());
    const manifest = f.store.path("artifacts", second.artifactId, "manifest.json");
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace('"expected":"ok"', '"expected":"wrong"'),
    );
    await expect(f.runner.artifact(second.artifactId)).rejects.toMatchObject({
      code: "STORE_INTEGRITY",
    });
  });

  it("refuses unsafe internal identifiers and filenames", () => {
    for (const id of ["..", "-".repeat(36), "a".repeat(36)])
      expect(() => f.store.path("runs", id, "manifest.json")).toThrow(RunnerError);
    for (const file of ["..", ".", "../secret", "a.xml", "C:\\private.xml"])
      expect(() => f.store.path("artifacts", SESSION, file)).toThrow(RunnerError);
  });
});
