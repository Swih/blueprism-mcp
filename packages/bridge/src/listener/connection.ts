import { connect, type Socket } from "node:net";
import { ListenerConnectionError, ToolOutputLimitError, ToolTimeoutError } from "../errors.js";

interface PendingReply {
  readonly label: string;
  readonly lines: string[];
  readonly complete: (reply: readonly string[]) => boolean;
  readonly resolve: (reply: string[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  completeFrame: boolean;
}

/**
 * Internal raw transport. One request at a time, no pooling, no silence-based framing.
 * Only LF/CRLF and clean EOF terminate a line. Status has its captured terminal line;
 * other captured replies are single-line. Unknown/multiline formats fail closed.
 */
export class ListenerConnection {
  private readonly lineBuffer: Buffer;
  private lineLength = 0;
  private receivedBytes = 0;
  private pending: PendingReply | undefined;
  private failure: Error | undefined;
  private ended = false;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
  ) {
    this.lineBuffer = Buffer.allocUnsafe(maxResponseBytes);
    socket.on("data", (chunk: Buffer) => {
      this.receive(chunk);
    });
    socket.on("end", () => {
      this.ended = true;
      if (this.lineLength > 0) this.consumeLine();
      this.settle();
      this.fail(new ListenerConnectionError("The listener closed the connection"));
    });
    socket.on("close", () => {
      // A close/reset without a clean EOF does not certify an unterminated final line.
      this.fail(new ListenerConnectionError("The listener closed the connection"));
    });
    socket.on("error", () => {
      this.fail(new ListenerConnectionError("Listener socket failure"));
    });
  }

  static open(
    host: string,
    port: number,
    timeoutMs: number,
    maxResponseBytes: number,
  ): Promise<ListenerConnection> {
    return new Promise((resolve, reject) => {
      let socket: Socket;
      try {
        socket = connect({ host, port });
      } catch {
        reject(new ListenerConnectionError("Cannot connect to the local listener"));
        return;
      }
      const connection = new ListenerConnection(socket, timeoutMs, maxResponseBytes);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("connect", connected);
        socket.off("error", failed);
        socket.off("close", failed);
      };
      const connected = (): void => {
        cleanup();
        if (connection.failure) reject(connection.failure);
        else resolve(connection);
      };
      const failed = (): void => {
        cleanup();
        connection.close();
        reject(new ListenerConnectionError("Cannot connect to the local listener"));
      };
      const timer = setTimeout(() => {
        cleanup();
        connection.close();
        reject(new ToolTimeoutError("listener", "connect", timeoutMs));
      }, timeoutMs);
      socket.once("connect", connected);
      socket.once("error", failed);
      socket.once("close", failed);
    });
  }

  request(
    line: string,
    label: string,
    complete: (reply: readonly string[]) => boolean = (reply) => reply.length > 0,
  ): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending || this.lineLength > 0 || this.ended) {
      const error = new ListenerConnectionError("Ambiguous listener response boundary");
      this.fail(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new ToolTimeoutError("listener", label, this.timeoutMs));
      }, this.timeoutMs);
      this.pending = { label, lines: [], complete, resolve, reject, timer, completeFrame: false };
      try {
        this.socket.write(`${line}\r\n`);
      } catch {
        this.fail(new ListenerConnectionError("Cannot write to the listener"));
      }
    });
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.receivedBytes += chunk.length;
    // Includes authentication replies, notifications and unterminated data. The budget
    // never resets on traffic, so notification floods cannot evade the byte/time bounds.
    if (this.receivedBytes > this.maxResponseBytes) {
      this.fail(new ToolOutputLimitError("listener", this.pending?.label ?? "receive", ""));
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      chunk.copy(this.lineBuffer, this.lineLength, offset, end);
      this.lineLength += end - offset;
      if (newline >= 0 && !this.consumeLine()) return;
      offset = end + 1;
    }
    // Inspect the entire chunk before resolving: extra lines or a partial trailing frame
    // must not become the next authentication command's response.
    this.settle();
  }

  private consumeLine(): boolean {
    if (this.failure) return false;
    let line: string;
    try {
      // Decode complete lines, not chunks: UTF-8 code points may span TCP packets.
      line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        this.lineBuffer.subarray(0, this.lineLength),
      );
    } catch {
      this.fail(new ListenerConnectionError("Invalid UTF-8 listener response"));
      return false;
    }
    this.lineLength = 0;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith(">>")) return true;
    if (!this.pending || this.pending.completeFrame) {
      this.fail(new ListenerConnectionError("Ambiguous or unsolicited listener response"));
      return false;
    }
    this.pending.lines.push(line);
    this.pending.completeFrame = this.pending.complete(this.pending.lines);
    return true;
  }

  private settle(): void {
    const pending = this.pending;
    if (!this.failure && pending?.completeFrame && this.lineLength === 0) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(pending.lines);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.lineBuffer.fill(0);
    this.lineLength = 0;
    this.socket.destroy();
  }

  close(): void {
    this.fail(new ListenerConnectionError("The listener connection is closed"));
  }
}
