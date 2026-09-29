import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RunnerError } from "./errors.js";

export const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
type Area = "artifacts" | "runs" | "requests" | "queues";
const areas: readonly Area[] = ["artifacts", "runs", "requests", "queues"];
const MAX_BYTES = 3 * 1024 * 1024;
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Local journal, not a security boundary against its OS account rewriting it. */
export class Store {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true });
      await this.checkLocation(this.root);
      for (const area of areas) {
        await mkdir(join(this.root, area), { recursive: true });
        await this.checkLocation(join(this.root, area));
      }
    } catch {
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot initialize the local runner store");
    }
  }

  path(area: Area, id: string, file: string): string {
    const validFile =
      file === "manifest.json" ||
      (area === "artifacts" &&
        (file === "deployment.json" ||
          file === "process.bpprocess" ||
          /^object-[0-9]+\.bpobject$/.test(file)));
    if (
      !areas.includes(area) ||
      !(["requests", "queues"].includes(area) ? HASH : UUID).test(id) ||
      !validFile
    )
      throw new RunnerError("INVALID_IDENTIFIER", "Invalid runner identifier or internal filename");
    return join(this.root, area, id, file);
  }

  async create(area: "artifacts" | "runs"): Promise<string> {
    const id = randomUUID();
    await this.checkLocation(join(this.root, area));
    try {
      await mkdir(dirname(this.path(area, id, "manifest.json")));
    } catch {
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot create a runner record");
    }
    return id;
  }

  async exists(area: Area, id: string): Promise<boolean> {
    const directory = dirname(this.path(area, id, "manifest.json"));
    await this.checkLocation(join(this.root, area));
    try {
      await lstat(directory);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot inspect runner records");
    }
    await this.checkLocation(directory);
    return true;
  }

  async ids(area: "runs"): Promise<string[]> {
    await this.checkLocation(join(this.root, area));
    try {
      return await readdir(join(this.root, area));
    } catch {
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot enumerate runner records");
    }
  }

  async read<T>(area: Area, id: string, file = "manifest.json"): Promise<T> {
    const raw = await this.readText(this.path(area, id, file));
    try {
      const envelope = JSON.parse(raw) as {
        version?: unknown;
        sha256?: unknown;
        payload?: unknown;
      };
      if (
        envelope.version !== 1 ||
        typeof envelope.sha256 !== "string" ||
        envelope.payload === undefined ||
        fingerprint(JSON.stringify(envelope.payload)) !== envelope.sha256
      )
        throw new Error("integrity");
      return envelope.payload as T;
    } catch {
      throw new RunnerError(
        "STORE_INTEGRITY",
        "Runner record is malformed or its checksum changed",
      );
    }
  }

  async hasDeployment(id: string): Promise<boolean> {
    const file = this.path("artifacts", id, "deployment.json");
    await this.checkLocation(dirname(file));
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot inspect the deployment record");
    }
  }

  async text(area: "artifacts" | "runs", id: string, file: string): Promise<string> {
    return this.readText(this.path(area, id, file));
  }

  async write(
    area: "artifacts" | "runs" | "queues",
    id: string,
    value: unknown,
    file = "manifest.json",
  ): Promise<void> {
    const payload = JSON.stringify(value);
    await this.atomicWrite(
      this.path(area, id, file),
      JSON.stringify({
        version: 1,
        sha256: fingerprint(payload),
        payload: JSON.parse(payload) as unknown,
      }),
    );
  }

  async writeArtifact(id: string, file: string, xml: string): Promise<void> {
    await this.writeNew(this.path("artifacts", id, file), xml);
  }

  /** A directory without a manifest is a reserved, damaged request, never an absent key. */
  async reserve(
    key: string,
    value: unknown,
    area: "requests" | "queues" = "requests",
  ): Promise<boolean> {
    const file = this.path(area, fingerprint(key), "manifest.json");
    await this.checkLocation(join(this.root, area));
    try {
      await mkdir(dirname(file));
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot reserve the launch request");
    }
    const payload = JSON.stringify(value);
    await this.writeNew(
      file,
      JSON.stringify({
        version: 1,
        sha256: fingerprint(payload),
        payload: JSON.parse(payload) as unknown,
      }),
    );
    return true;
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    await this.checkLocation(this.root);
    const file = join(this.root, "mutation.lock");
    const lock = await open(file, "wx", 0o600).catch(() => {
      throw new RunnerError(
        "MUTATION_BUSY",
        "Another operation is active or an interrupted mutation needs reconciliation",
      );
    });
    try {
      await lock.sync();
      return await action();
    } finally {
      await lock.close();
      await unlink(file).catch(() => {
        throw new RunnerError(
          "STORE_INTEGRITY",
          "The runner lock could not be released; reconcile before retrying",
        );
      });
    }
  }

  private async readText(file: string): Promise<string> {
    await this.checkLocation(file);
    try {
      const handle = await open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("invalid file");
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      throw new RunnerError(
        "STORE_INTEGRITY",
        "Runner file is missing, unreadable or exceeds its size limit",
      );
    }
  }

  private async writeNew(file: string, text: string): Promise<void> {
    await this.checkLocation(dirname(file));
    if (Buffer.byteLength(text) > MAX_BYTES)
      throw new RunnerError("STORE_LIMIT", "Runner record exceeds its size limit");
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot persist the runner record");
    }
  }

  private async atomicWrite(file: string, text: string): Promise<void> {
    await this.checkLocation(dirname(file));
    try {
      await lstat(file);
      await this.checkLocation(file);
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      if (codeOf(error) !== "ENOENT")
        throw new RunnerError("STORE_UNAVAILABLE", "Cannot inspect the target runner record");
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    await this.writeNew(temporary, text);
    try {
      await rename(temporary, file);
    } catch {
      throw new RunnerError("STORE_UNAVAILABLE", "Cannot atomically replace the runner record");
    }
  }

  private async checkLocation(path: string): Promise<void> {
    try {
      const root = await realpath(this.root);
      const relativePath = relative(this.root, path);
      if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))
        throw new Error("escape");
      let current = this.root;
      for (const component of ["", ...relativePath.split(sep).filter(Boolean)]) {
        current = component ? join(current, component) : current;
        if ((await lstat(current)).isSymbolicLink()) throw new Error("link");
      }
      const actual = relative(root, await realpath(path));
      if (isAbsolute(actual) || actual === ".." || actual.startsWith(`..${sep}`))
        throw new Error("escape");
    } catch {
      throw new RunnerError(
        "STORE_INTEGRITY",
        "Runner storage is missing or contains an unsafe path",
      );
    }
  }
}
