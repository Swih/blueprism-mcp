import { isIP } from "node:net";
import { isGuid } from "../automatec/parsers.js";
import type { BpCredentials, CredentialProvider } from "../credentials.js";
import { CredentialsError, InvalidArgumentError, ToolTimeoutError } from "../errors.js";
import { ListenerConnection } from "./connection.js";
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
  /** Plain TCP is local only: localhost (pinned to 127.0.0.1), strict 127/8 literals or ::1. */
  readonly host?: string;
  /** Default 8181. */
  readonly port?: number;
  /** Connect, credential lookup and each reply have a fixed deadline. Default 10 000 ms. */
  readonly timeoutMs?: number;
  /** Total received bytes per connection, including notifications/auth. Default 1 MiB, max 16 MiB. */
  readonly maxResponseBytes?: number;
  /** Needed by {@link RuntimeListener.outputs} only. */
  readonly credentials?: CredentialProvider;
  /** Additional known session/startup secrets to redact from decoded data and diagnostics. */
  readonly secrets?: readonly string[];
}

/**
 * Local runtime listener client. Each operation owns a fresh connection; outputs performs
 * three strictly ordered requests on it. Replies remain raw only inside this implementation.
 * Only captured single-line output XML is supported; multiline/ambiguous replies fail closed.
 */
export class RuntimeListener {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly secrets: readonly string[];

  constructor(private readonly options: ListenerOptions = {}) {
    const host = options.host ?? "127.0.0.1";
    if (host.toLowerCase() === "localhost") this.host = "127.0.0.1";
    else if (host === "::1" || (isIP(host) === 4 && host.startsWith("127."))) this.host = host;
    else
      throw new InvalidArgumentError("Plain TCP listener connections must use a loopback literal");
    this.port = boundedInteger(options.port ?? 8181, 65_535, "port");
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 2_147_483_647, "timeoutMs");
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 1_048_576,
      16_777_216,
      "maxResponseBytes",
    );
    this.secrets = [...(options.secrets ?? [])];
  }

  async version(): Promise<ListenerVersion> {
    return parseVersion(await this.ask("version"));
  }

  /** Sessions the runtime holds in memory (with registered secrets redacted from messages). */
  async status(): Promise<ListenerStatus> {
    return parseListenerStatus(await this.ask("status", isStatusReplyComplete), this.secrets);
  }

  async busy(): Promise<boolean> {
    return parseBusy(await this.ask("busy"));
  }

  async availability(): Promise<ListenerAvailability> {
    return parseAvailability(await this.ask("availability"));
  }

  /** Login with `user name`, then `password`, then read sanitized session outputs. */
  async outputs(sessionId: string): Promise<SessionOutput[]> {
    if (!isGuid(sessionId)) throw new InvalidArgumentError("A session id (GUID) is required");
    const { user, password } = await this.getCredentials();
    const connection = await this.open();
    try {
      const userReply = await connection.request(`user name ${user}`, "user name");
      if (userReply.length !== 1 || userReply[0] !== "USER SET") {
        throw new CredentialsError("Listener refused the user name");
      }
      const passwordReply = await connection.request(`password ${password}`, "password");
      if (passwordReply.length !== 1 || passwordReply[0] !== "USER AUTHENTICATED") {
        throw new CredentialsError("Listener refused the login");
      }
      return parseOutputs(await connection.request(`outputs ${sessionId}`, "outputs"), [
        ...this.secrets,
        password,
      ]);
    } finally {
      connection.close();
    }
  }

  private async getCredentials(): Promise<BpCredentials> {
    const provider = this.options.credentials;
    if (!provider) throw new CredentialsError("outputs needs a credential provider");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const credentials = await Promise.race([
        Promise.resolve().then(() => provider.getCredentials()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ToolTimeoutError("listener", "credentials", this.timeoutMs));
          }, this.timeoutMs);
        }),
      ]);
      const { user, password } = credentials;
      if (
        typeof user !== "string" ||
        typeof password !== "string" ||
        user === "" ||
        password === "" ||
        /[\r\n\0]/.test(user + password) ||
        Buffer.byteLength(user + password, "utf8") > 16_384
      ) {
        throw new CredentialsError("Invalid listener credentials");
      }
      return { user, password };
    } catch (error) {
      if (error instanceof ToolTimeoutError && error.command === "credentials") {
        throw new ToolTimeoutError("listener", "credentials", this.timeoutMs);
      }
      // A provider error may contain a secret in its message, properties or cause.
      throw new CredentialsError("Cannot obtain valid listener credentials");
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(
    command: string,
    complete?: (reply: readonly string[]) => boolean,
  ): Promise<string[]> {
    const connection = await this.open();
    try {
      return await connection.request(command, command, complete);
    } finally {
      connection.close();
    }
  }

  private open(): Promise<ListenerConnection> {
    return ListenerConnection.open(this.host, this.port, this.timeoutMs, this.maxResponseBytes);
  }
}

function boundedInteger(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new InvalidArgumentError(`Invalid listener ${label}`);
  }
  return value;
}
