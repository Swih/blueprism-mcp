import { readFile, unlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runner, RunnerError, type DeploymentRecord } from "../src/index.js";
import { MAX_PUBLICATION_RESUME_ATTEMPTS } from "../src/contracts.js";
import { Store } from "../src/store.js";
import { cleanup, deployed, fixture, SESSION, spec, type Fixture } from "./helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup(f.directory);
});
const evidence =
  "Operator confirmed the publication limit is resolved for this exact imported process.";

async function partialPublication() {
  const artifact = await f.runner.prepare(spec());
  f.fake.automatec.publish.mockRejectedValueOnce(new Error("Synthetic publication limit"));
  await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
    code: "DEPLOYMENT_PARTIAL",
  });
  expect(await f.runner.deployment(artifact.artifactId)).toMatchObject({
    state: "partial",
    imported: artifact.files.map((file) => file.name),
    inFlight: { operation: "publish", name: artifact.processName },
  });
  f.fake.automatec.import.mockClear();
  f.fake.automatec.publish.mockClear();
  return artifact;
}
async function journal(artifactId: string) {
  return f.store.read<DeploymentRecord & { artifactHash: string }>(
    "artifacts",
    artifactId,
    "deployment.json",
  );
}
function noMutation() {
  expect(f.fake.automatec.import).not.toHaveBeenCalled();
  expect(f.fake.automatec.publish).not.toHaveBeenCalled();
  expect(f.fake.automatec.run).not.toHaveBeenCalled();
}

describe("operator-only publication recovery (native adapters are mocked)", () => {
  it.each(["published", "already-published"] as const)(
    "persists evidence first, publishes only the exact process and accepts %s",
    async (outcome) => {
      const artifact = await partialPublication();
      const publish = vi.fn(async (name: string) => {
        expect(name).toBe(artifact.processName);
        const pending = await journal(artifact.artifactId);
        expect(pending).toMatchObject({
          state: "partial",
          inFlight: { operation: "publish", name },
          imported: artifact.files.map((file) => file.name),
          publicationResumes: [
            {
              attempt: 1,
              evidence,
              outcome: "pending",
              requestedAt: expect.any(String) as unknown,
            },
          ],
        });
        expect(pending.publicationResumes?.[0]?.completedAt).toBeUndefined();
        expect(await readFile(f.directory + "/mutation.lock", "utf8")).toBe("");
        return outcome;
      });
      const runner = new Runner({ ...f.options, automatec: { ...f.options.automatec, publish } });
      const result = await runner.resumePublication(artifact.artifactId, evidence);
      expect(result).toMatchObject({
        artifactId: artifact.artifactId,
        state: "deployed",
        imported: artifact.files.map((file) => file.name),
        publicationResumes: [
          {
            attempt: 1,
            evidence,
            outcome,
            requestedAt: expect.any(String) as unknown,
            completedAt: expect.any(String) as unknown,
          },
        ],
      });
      expect(result.inFlight).toBeUndefined();
      expect(publish).toHaveBeenCalledExactlyOnceWith(artifact.processName);
      expect(f.fake.automatec.import).not.toHaveBeenCalled();
      expect(f.fake.automatec.run).not.toHaveBeenCalled();
      expect(await new Runner(f.options).deployment(artifact.artifactId)).toEqual(result);
      await expect(runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
        code: "PUBLICATION_RESUME_UNAVAILABLE",
      });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await f.runner.deploy(artifact.artifactId)).toEqual(result);
      expect(f.fake.automatec.import).not.toHaveBeenCalled();
    },
  );

  it("keeps partial intent and audit on failure, with no replay until another explicit operator call", async () => {
    const artifact = await partialPublication();
    f.fake.automatec.publish.mockRejectedValueOnce(
      new Error("Synthetic private native diagnostic"),
    );
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "DEPLOYMENT_PARTIAL",
      message: expect.not.stringContaining("private native") as unknown,
    });
    const failed = await new Runner(f.options).deployment(artifact.artifactId);
    expect(failed).toMatchObject({
      state: "partial",
      inFlight: { operation: "publish", name: artifact.processName },
      publicationResumes: [
        {
          attempt: 1,
          evidence,
          outcome: "unconfirmed",
          completedAt: expect.any(String) as unknown,
        },
      ],
    });
    await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
      code: "DEPLOYMENT_UNRESOLVED",
    });
    await expect(f.runner.start(artifact.artifactId, "not-yet-published")).rejects.toMatchObject({
      code: "NOT_DEPLOYED",
    });
    expect(f.fake.automatec.publish).toHaveBeenCalledTimes(1);
    const updatedEvidence =
      "Operator rechecked publication capacity after the first recovery failed.";
    const result = await new Runner(f.options).resumePublication(
      artifact.artifactId,
      updatedEvidence,
    );
    expect(result.publicationResumes?.[0]).toEqual(failed.publicationResumes?.[0]);
    expect(result.publicationResumes?.[1]).toMatchObject({
      attempt: 2,
      evidence: updatedEvidence,
      outcome: "published",
    });
    expect(f.fake.automatec.publish.mock.calls).toEqual([
      [artifact.processName],
      [artifact.processName],
    ]);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
    expect(f.fake.automatec.run).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, "", " ".repeat(30), "x".repeat(19), "x".repeat(2001)])(
    "rejects invalid evidence %j without changing the journal",
    async (invalid) => {
      const artifact = await partialPublication(),
        previous = await journal(artifact.artifactId);
      await expect(
        f.runner.resumePublication(artifact.artifactId, invalid as string),
      ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
      expect(await journal(artifact.artifactId)).toEqual(previous);
      noMutation();
    },
  );
  it.each([20, 2000])("accepts the evidence boundary of %s characters", async (count) => {
    const artifact = await partialPublication();
    expect((await f.runner.resumePublication(artifact.artifactId, "x".repeat(count))).state).toBe(
      "deployed",
    );
    expect(f.fake.automatec.publish).toHaveBeenCalledExactlyOnceWith(artifact.processName);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });

  it("rejects interrupted import instead of completing imports or publishing", async () => {
    const artifact = await f.runner.prepare(spec());
    f.fake.automatec.import
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Lost import acknowledgement"));
    await expect(f.runner.deploy(artifact.artifactId)).rejects.toMatchObject({
      code: "DEPLOYMENT_PARTIAL",
    });
    f.fake.automatec.import.mockClear();
    const previous = await journal(artifact.artifactId);
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "PUBLICATION_RESUME_UNAVAILABLE",
    });
    expect(await journal(artifact.artifactId)).toEqual(previous);
    noMutation();
  });
  it.each([
    "missing import",
    "reordered imports",
    "mismatched import",
    "extra import",
    "wrong process",
    "missing intent",
    "import intent",
    "deploying",
    "wrong artifact",
    "wrong hash",
    "legacy partial",
  ])("rejects %s evidence without any native mutation", async (invalid) => {
    const artifact = await partialPublication(),
      previous = await journal(artifact.artifactId);
    const patches: Record<string, object> = {
      "missing import": { imported: previous.imported.slice(0, -1) },
      "reordered imports": { imported: [...previous.imported].reverse() },
      "mismatched import": { imported: ["BPDEV Different Object", artifact.processName] },
      "extra import": { imported: [...previous.imported, "BPDEV Extra"] },
      "wrong process": { inFlight: { operation: "publish", name: "BPDEV Other Process" } },
      "missing intent": { inFlight: undefined },
      "import intent": { inFlight: { operation: "import", name: artifact.processName } },
      deploying: { state: "deploying" },
      "wrong artifact": { artifactId: SESSION },
      "wrong hash": { artifactHash: "0".repeat(64) },
    };
    // Corrupt/incomplete fixture journals model interrupted or inconsistent records only.
    await f.store.write(
      "artifacts",
      artifact.artifactId,
      invalid === "legacy partial"
        ? { state: "partial", imported: previous.imported }
        : { ...previous, ...patches[invalid] },
      "deployment.json",
    );
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toBeInstanceOf(
      RunnerError,
    );
    noMutation();
  });
  it("rejects an artifact that has never been deployed", async () => {
    const artifact = await f.runner.prepare(spec());
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "PUBLICATION_RESUME_UNAVAILABLE",
    });
    expect(await f.store.hasDeployment(artifact.artifactId)).toBe(false);
    noMutation();
  });
  it.each(["object-0.bpobject", "process.bpprocess", "manifest.json"])(
    "rejects a missing or modified artifact file %s",
    async (file) => {
      const artifact = await partialPublication();
      const path = f.store.path("artifacts", artifact.artifactId, file);
      if (file === "object-0.bpobject") await unlink(path);
      else await writeFile(path, "changed");
      await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject(
        { code: "STORE_INTEGRITY" },
      );
      noMutation();
    },
  );

  it.each(["busy", "pending", "unavailable"])(
    "does not audit or publish when the resource is %s",
    async (condition) => {
      const artifact = await partialPublication(),
        previous = await journal(artifact.artifactId);
      if (condition === "busy") f.fake.listener.busy.mockResolvedValue(true);
      if (condition === "pending")
        f.fake.listener.status.mockResolvedValue({
          totalRunning: 1,
          sessions: [{ sessionId: SESSION, status: "PENDING" }],
        });
      if (condition === "unavailable")
        f.fake.listener.status.mockRejectedValue(new Error("Unavailable"));
      await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject(
        {
          code: condition === "unavailable" ? "OBSERVATION_UNAVAILABLE" : "RESOURCE_BUSY",
        },
      );
      expect(await journal(artifact.artifactId)).toEqual(previous);
      noMutation();
    },
  );
  it.each(["running", "unknown", "failed"])(
    "rejects a recorded %s run even when the listener looks idle",
    async (state) => {
      const artifact = await partialPublication();
      const other = await deployed(f);
      if (state === "unknown")
        f.fake.automatec.run.mockRejectedValueOnce(new Error("Lost launch acknowledgement"));
      const run = await f.runner.start(other.artifactId, "active-or-uncertain");
      if (state === "failed") {
        f.fake.automatec.status.mockResolvedValue("Failed");
        await f.runner.inspect(run.runId);
      }
      f.fake.automatec.import.mockClear();
      f.fake.automatec.publish.mockClear();
      f.fake.automatec.run.mockClear();
      await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject(
        { code: "RUN_UNRESOLVED" },
      );
      expect((await journal(artifact.artifactId)).publicationResumes).toBeUndefined();
      noMutation();
    },
  );

  it("holds the mutation lock through publication so concurrent operator calls cannot publish twice", async () => {
    const artifact = await partialPublication();
    let entered: () => void = () => {},
      release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.fake.automatec.publish.mockImplementationOnce(async () => {
      entered();
      await held;
      return "published";
    });
    const first = f.runner.resumePublication(artifact.artifactId, evidence);
    await started;
    try {
      await expect(
        new Runner(f.options).resumePublication(artifact.artifactId, evidence),
      ).rejects.toMatchObject({ code: "MUTATION_BUSY" });
    } finally {
      release();
    }
    expect((await first).state).toBe("deployed");
    expect(f.fake.automatec.publish).toHaveBeenCalledExactlyOnceWith(artifact.processName);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });
  it("never publishes if the write-ahead audit cannot be saved", async () => {
    const artifact = await partialPublication(),
      previous = await journal(artifact.artifactId);
    vi.spyOn(Store.prototype, "write").mockRejectedValueOnce(
      new RunnerError("STORE_UNAVAILABLE", "Synthetic storage failure"),
    );
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
    });
    expect(await journal(artifact.artifactId)).toEqual(previous);
    noMutation();
  });
  it("keeps publication unconfirmed if acknowledgement persistence fails", async () => {
    const artifact = await partialPublication();
    const originalWrite = Store.prototype.write.bind(f.store);
    vi.spyOn(Store.prototype, "write")
      .mockImplementationOnce(originalWrite)
      .mockRejectedValueOnce(
        new RunnerError("STORE_UNAVAILABLE", "Synthetic acknowledgement save failure"),
      );
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "DEPLOYMENT_PARTIAL",
    });
    expect(await f.runner.deployment(artifact.artifactId)).toMatchObject({
      state: "partial",
      inFlight: { operation: "publish", name: artifact.processName },
      publicationResumes: [{ outcome: "unconfirmed" }],
    });
    expect(f.fake.automatec.publish).toHaveBeenCalledExactlyOnceWith(artifact.processName);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });
  it("closes a durable pending attempt as unconfirmed before an explicit idempotent retry", async () => {
    const artifact = await partialPublication();
    const originalWrite = Store.prototype.write.bind(f.store);
    const persistence = vi
      .spyOn(Store.prototype, "write")
      .mockImplementationOnce(originalWrite)
      .mockRejectedValueOnce(new RunnerError("STORE_UNAVAILABLE", "Acknowledgement not saved"))
      .mockRejectedValueOnce(new RunnerError("STORE_UNAVAILABLE", "Failure audit not saved"));
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
    });
    const pending = await new Runner(f.options).deployment(artifact.artifactId);
    expect(pending).toMatchObject({
      state: "partial",
      publicationResumes: [{ attempt: 1, evidence, outcome: "pending" }],
    });
    expect(pending.publicationResumes?.[0]?.completedAt).toBeUndefined();
    persistence.mockRestore();
    const publish = vi.fn(async (name: string): Promise<"already-published"> => {
      expect(name).toBe(artifact.processName);
      expect((await journal(artifact.artifactId)).publicationResumes).toMatchObject([
        {
          attempt: 1,
          evidence,
          outcome: "unconfirmed",
          completedAt: expect.any(String) as unknown,
        },
        { attempt: 2, outcome: "pending" },
      ]);
      return "already-published";
    });
    const restarted = new Runner({ ...f.options, automatec: { ...f.options.automatec, publish } });
    const result = await restarted.resumePublication(
      artifact.artifactId,
      "Operator independently rechecked the prior pending publication attempt.",
    );
    expect(result.state).toBe("deployed");
    expect(result.publicationResumes?.[0]).toMatchObject({
      ...pending.publicationResumes?.[0],
      outcome: "unconfirmed",
      completedAt: expect.any(String) as unknown,
    });
    expect(result.publicationResumes?.[1]?.outcome).toBe("already-published");
    expect(publish).toHaveBeenCalledExactlyOnceWith(artifact.processName);
    expect(await new Runner(f.options).deployment(artifact.artifactId)).toEqual(result);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });
  it("rejects pending interior history before mutating the record", async () => {
    const artifact = await partialPublication(),
      previous = await journal(artifact.artifactId);
    const requestedAt = new Date().toISOString();
    await f.store.write(
      "artifacts",
      artifact.artifactId,
      {
        ...previous,
        publicationResumes: [
          { attempt: 1, requestedAt, evidence, outcome: "pending" },
          { attempt: 2, requestedAt, evidence, outcome: "pending" },
        ],
      },
      "deployment.json",
    );
    const invalid = await journal(artifact.artifactId);
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "STORE_INTEGRITY",
    });
    expect(await journal(artifact.artifactId)).toEqual(invalid);
    noMutation();
  });
  it.each([undefined, "unknown acknowledgement"])(
    "never treats an invalid adapter receipt %s as publication success",
    async (receipt) => {
      const artifact = await partialPublication();
      f.fake.automatec.publish.mockResolvedValueOnce(receipt as "published");
      await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject(
        { code: "DEPLOYMENT_PARTIAL" },
      );
      expect(await f.runner.deployment(artifact.artifactId)).toMatchObject({
        state: "partial",
        publicationResumes: [{ outcome: "unconfirmed" }],
      });
      expect(f.fake.automatec.publish).toHaveBeenCalledExactlyOnceWith(artifact.processName);
      expect(f.fake.automatec.import).not.toHaveBeenCalled();
    },
  );
  it("bounds the audit history and stops at the explicit operator attempt limit", async () => {
    const artifact = await partialPublication();
    f.fake.automatec.publish.mockRejectedValue(new Error("Still unavailable"));
    for (let i = 0; i < MAX_PUBLICATION_RESUME_ATTEMPTS; i++)
      await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject(
        { code: "DEPLOYMENT_PARTIAL" },
      );
    const previous = await journal(artifact.artifactId);
    expect(previous.publicationResumes).toHaveLength(MAX_PUBLICATION_RESUME_ATTEMPTS);
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "PUBLICATION_RESUME_LIMIT",
    });
    expect(await journal(artifact.artifactId)).toEqual(previous);
    expect(f.fake.automatec.publish).toHaveBeenCalledTimes(MAX_PUBLICATION_RESUME_ATTEMPTS);
    expect(f.fake.automatec.import).not.toHaveBeenCalled();
  });
  it("rejects a malformed recovery audit instead of bypassing its bounds", async () => {
    const artifact = await partialPublication(),
      previous = await journal(artifact.artifactId);
    await f.store.write(
      "artifacts",
      artifact.artifactId,
      {
        ...previous,
        publicationResumes: [
          {
            attempt: 2,
            requestedAt: new Date().toISOString(),
            evidence,
            outcome: "pending",
          },
        ],
      },
      "deployment.json",
    );
    await expect(f.runner.resumePublication(artifact.artifactId, evidence)).rejects.toMatchObject({
      code: "STORE_INTEGRITY",
    });
    noMutation();
  });
});
