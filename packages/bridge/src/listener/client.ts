import { connect, type Socket } from "node:net";
import { isGuid } from "../automatec/parsers.js";
import type { CredentialProvider } from "../credentials.js";
import {
  CredentialsError,
  InvalidArgumentError,
  ListenerConnectionError,
  ToolTimeoutError,
} from "../errors.js";
import { maskSecrets } from "../process.js";
import {
  isStatusReplyComplete,
  parseAvailability,
  parseBusy,
  parseListenerStatus,
  parseOutputs,
  parseVersion,
  type ListenerAvailability,
  type ListenerStatus,
  type ListenerVersion,
  type SessionOutput,
} from "./parsers.js";

export interface ListenerOptions {
  /** Default `127.0.0.1`. */
  readonly host?: string;
  /** Default 8181. */
  readonly port?: number;
  /** Connection and per-reply timeout. Default 10 000 ms. */
  readonly timeoutMs?: number;
  /** Needed by {@link RuntimeListener.outputs} only. */
  readonly credentials?: CredentialProvider;
}

/**
 * Client of a runtime resource's listener (plain-text protocol over TCP, UTF-8, one command
 * per line). Each call opens its own connection. Lines starting with `>>` are notifications
 * the listener pushes to every client; they are skipped.
 */
export class RuntimeListener {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ListenerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8181;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async version(): Promise<ListenerVersion> {
    return parseVersion(await this.ask("version"));
  }

  /** Sessions the runtime holds in memory, with their state. */
  async status(): Promise<ListenerStatus> {
    return parseListenerStatus(await this.ask("status", isStatusReplyComplete));
  }

  async busy(): Promise<boolean> {
    return parseBusy(await this.ask("busy"));
  }

  async availability(): Promise<ListenerAvailability> {
    return parseAvailability(await this.ask("availability"));
  }

  /**
   * Outputs of a finished session. Logs in first with `user name <name>` then
   * `password <pwd>` (`user <x>` expects a user GUID).
   */
  async outputs(sessionId: string): Promise<SessionOutput[]> {
    if (!isGuid(sessionId)) {
      throw new InvalidArgumentError(`Not a session id (GUID expected): ${sessionId}`);
    }
    if (!this.options.credentials) {
      throw new CredentialsError("outputs needs a credential provider");
    }
    const { user, password } = await this.options.credentials.getCredentials();
    if (/[\r\n]/.test(user + password)) {
      throw new CredentialsError("Credentials cannot contain line breaks");
    }
    const connection = await this.open([password]);
    try {
      const userReply = await connection.request(`user name ${user}`, "user name");
      if (userReply.join("\n") !== "USER SET") {
        throw new CredentialsError(`Listener refused the user name: ${userReply.join(" | ")}`);
      }
      const passwordReply = await connection.request(`password ${password}`, "password");
      if (passwordReply.join("\n") !== "USER AUTHENTICATED") {
        throw new CredentialsError(`Listener refused the login: ${passwordReply.join(" | ")}`);
      }
      return parseOutputs(await connection.request(`outputs ${sessionId}`, "outputs"));
    } finally {
      connection.close();
    }
  }

  private async ask(
    command: string,
    complete?: (reply: readonly string[]) => boolean,
  ): Promise<string[]> {
    const connection = await this.open([]);
    try {
      return await connection.request(command, command, complete);
    } finally {
      connection.close();
    }
  }

  private open(secrets: readonly string[]): Promise<Connection> {
    return Connection.open(this.host, this.port, this.timeoutMs, secrets);
  }
}

/** One TCP connection: sends a line, collects reply lines until the reply is complete. */
class Connection {
  private buffer = "";
  private lines: string[] = [];
  private closedError: ListenerConnectionError | undefined;
  private onChange: (() => void) | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
    private readonly secrets: readonly string[],
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      const parts = this.buffer.split("\n");
      this.buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = maskSecrets(part.replace(/\r$/, ""), this.secrets);
        if (!line.startsWith(">>")) this.lines.push(line);
      }
      this.onChange?.();
    });
    const closed = (): void => {
      this.closedError ??= new ListenerConnectionError("The listener closed the connection");
      this.onChange?.();
    };
    socket.on("close", closed);
    socket.on("error", closed);
  }

  static open(
    host: string,
    port: number,
    timeoutMs: number,
    secrets: readonly string[],
  ): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ToolTimeoutError("listener", `connect ${host}:${port}`, timeoutMs));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve(new Connection(socket, timeoutMs, secrets));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new ListenerConnectionError(
            `Cannot reach the listener at ${host}:${port}: ${error.code ?? error.message}`,
          ),
        );
      });
    });
  }

  /**
   * Sends one command line and resolves with its reply lines: the first line, or until
   * `complete` says the reply is whole. `label` names the command in errors (never the
   * line itself, which may hold a password).
   */
  request(
    line: string,
    label: string,
    complete: (reply: readonly string[]) => boolean = (reply) => reply.length > 0,
  ): Promise<string[]> {
    if (this.closedError) return Promise.reject(this.closedError);
    this.lines = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(new ToolTimeoutError("listener", label, this.timeoutMs));
      }, this.timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        this.onChange = undefined;
      };
      this.onChange = () => {
        if (complete(this.lines)) {
          finish();
          resolve(this.lines);
        } else if (this.closedError) {
          finish();
          reject(this.closedError);
        }
      };
      this.socket.write(`${line}\r\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}
