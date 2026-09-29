import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

export type ListenerScript = (command: string, socket: SimulatedListenerSocket) => void;

/** Simulates Buffer/data/end/error events without any TCP port or BP runtime. */
export class SimulatedListenerSocket extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  writeError: Error | undefined;

  constructor(private readonly script: ListenerScript = () => {}) {
    super();
  }

  write(command: string): boolean {
    if (this.writeError) throw this.writeError;
    this.writes.push(command);
    this.script(command, this);
    return true;
  }

  receive(data: string | Buffer): void {
    if (!this.destroyed) this.emit("data", typeof data === "string" ? Buffer.from(data) : data);
  }

  receiveBytewise(text: string): void {
    for (const byte of Buffer.from(text)) this.receive(Buffer.from([byte]));
  }

  end(data?: string | Buffer): void {
    if (data !== undefined) this.receive(data);
    if (!this.destroyed) this.emit("end");
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
}

export function listenerFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/listener/${name}.txt`, import.meta.url), "utf8");
}

export function listenerFixtureLines(name: string): string[] {
  return listenerFixture(name)
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(">>"));
}

/** Include Error's non-enumerable message/stack and any attached output/cause fields. */
export function publicErrorText(error: unknown): string {
  if (!(error instanceof Error)) throw new Error("Expected an Error");
  return JSON.stringify(
    Object.fromEntries(
      Object.getOwnPropertyNames(error).map((key) => [key, Reflect.get(error, key) as unknown]),
    ),
  );
}
