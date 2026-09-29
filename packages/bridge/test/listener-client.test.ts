import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeListener, type ListenerOptions } from "../src/listener/client.js";
import {
  CredentialsError,
  InvalidArgumentError,
  ListenerConnectionError,
  ToolOutputLimitError,
  ToolTimeoutError,
  UnexpectedOutputError,
} from "../src/errors.js";
import {
  listenerFixture,
  publicErrorText,
  SimulatedListenerSocket,
  type ListenerScript,
} from "./listener-test-helpers.js";

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  connect: connectMock,
}));

const SESSION = "c3abb528-1570-42be-ba95-ad54a5c9bbdc";
let sockets: SimulatedListenerSocket[];
let script: ListenerScript;
let password: string;

function capturedReply(command: string, socket: SimulatedListenerSocket): void {
  const fixture = command.startsWith("user name ")
    ? "user-set"
    : command.startsWith("password ")
      ? "user-authenticated"
      : command.startsWith("outputs ")
        ? "outputs"
        : command.trim();
  socket.receive(listenerFixture(fixture));
}

function listener(options: ListenerOptions = {}): RuntimeListener {
  return new RuntimeListener({
    timeoutMs: 50,
    credentials: { getCredentials: () => Promise.resolve({ user: "tester", password }) },
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  password = "login-secret";
  script = capturedReply;
  connectMock.mockReset().mockImplementation(() => {
    const socket = new SimulatedListenerSocket((command, peer) => {
      script(command, peer);
    });
    sockets.push(socket);
    queueMicrotask(() => {
      socket.emit("connect");
    });
    return socket;
  });
});

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("local-only listener contract", () => {
  it("uses all captured success replies and owns a fresh connection per operation", async () => {
    const client = listener();
    expect(await client.version()).toMatchObject({ version: 4 });
    expect(await client.busy()).toBe(false);
    expect(await client.availability()).toBe("Exclusive");
    expect((await client.status()).sessions).toHaveLength(2);
    expect((await client.outputs(SESSION))[0]?.value).toBe("Claude");
    expect(sockets).toHaveLength(5);
    expect(sockets[4]?.writes).toEqual([
      "user name tester\r\n",
      "password login-secret\r\n",
      `outputs ${SESSION}\r\n`,
    ]);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.2.3.4", "::1"])(
    "pins approved host %s without DNS",
    async (host) => {
      await listener({ host }).busy();
      expect(connectMock).toHaveBeenCalledWith({
        host: host.toLowerCase() === "localhost" ? "127.0.0.1" : host,
        port: 8181,
      });
    },
  );

  it.each([
    "remote.example",
    "192.168.1.2",
    "0.0.0.0",
    "::",
    "::ffff:127.0.0.1",
    "localhost.",
    "localhost.evil",
    "127.1",
    "2130706433",
    "0x7f000001",
    "127.000.0.1",
    " 127.0.0.1",
    "127.0.0.1\n",
  ])("refuses remote/ambiguous host %s before credentials or connect", (host) => {
    expect(() => listener({ host })).toThrow(InvalidArgumentError);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it.each([
    { port: 0 },
    { port: 65_536 },
    { port: 1.5 },
    { timeoutMs: 0 },
    { timeoutMs: NaN },
    { timeoutMs: 2_147_483_648 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 16_777_217 },
  ])("rejects invalid numeric options %j", (options) => {
    expect(() => listener(options)).toThrow(InvalidArgumentError);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe("redaction boundary and credentials", () => {
  it.each(["e", "1", "USER", "OUTPUTS", "USER AUTHENTICATED"])(
    "parses markers before masking password %s",
    async (secret) => {
      password = secret;
      const outputs = await listener().outputs(SESSION);
      expect(outputs).toHaveLength(2);
      expect(outputs[0]?.type).toBe("text");
      expect(sockets[0]?.writes[2]).toBe(`outputs ${SESSION}\r\n`);
    },
  );

  it("propagates startup secrets to status and decoded outputs without changing GUIDs", async () => {
    script = (command, socket) => {
      if (command.startsWith("outputs ")) {
        socket.receive(
          'OUTPUTS:<outputs><output name="X" type="text" value="A&#38;B" /></outputs>\r\n',
        );
      } else capturedReply(command, socket);
    };
    const client = listener({ secrets: ["e", "A&B"] });
    const status = await client.status();
    expect(status.sessions[1]?.sessionId).toBe(SESSION);
    expect(status.sessions[0]?.status).toBe("FAILED");
    expect(status.sessions[0]?.message).not.toContain("e");
    expect((await client.outputs(SESSION))[0]?.value).toBe("***");
  });

  it("masks an entity-encoded login secret in values and XML subtrees", async () => {
    password = "A&B";
    script = (command, socket) => {
      if (command.startsWith("outputs "))
        socket.receive(
          'OUTPUTS:<outputs><output name="X" type="text" value="A&amp;B"><copy>A&#38;B</copy></output></outputs>\r\n',
        );
      else capturedReply(command, socket);
    };
    const outputs = await listener().outputs(SESSION);
    expect(outputs[0]?.value).toBe("***");
    expect(JSON.stringify(outputs)).not.toContain("A&B");
  });

  it.each(["user name", "password"])("never includes a raw %s rejection", async (phase) => {
    script = (command, socket) => {
      if (command.startsWith(phase)) socket.receive("REFUSED private-credential-detail\r\n");
      else capturedReply(command, socket);
    };
    const error = await listener()
      .outputs(SESSION)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CredentialsError);
    expect(publicErrorText(error)).not.toContain("private-credential-detail");
    expect(sockets[0]?.destroyed).toBe(true);
    expect(sockets[0]?.writes.some((line) => line.startsWith("outputs"))).toBe(false);
  });

  it("does not echo an invalid session id or credential provider cause", async () => {
    const badId = await listener()
      .outputs("private-id-input")
      .catch((error: unknown) => error);
    expect(publicErrorText(badId)).not.toContain("private-id-input");
    const provider = { getCredentials: () => Promise.reject(new Error("private-provider-secret")) };
    const error = await listener({ credentials: provider })
      .outputs(SESSION)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CredentialsError);
    expect(publicErrorText(error)).not.toContain("private-provider-secret");
    expect(error).not.toHaveProperty("cause");
    expect(connectMock).not.toHaveBeenCalled();
  });

  it.each(["", "password\r\noutputs injected", "password\0", "p".repeat(16_385)])(
    "refuses empty/injected/oversized credentials",
    async (value) => {
      password = value;
      await expect(listener().outputs(SESSION)).rejects.toThrow(CredentialsError);
      expect(connectMock).not.toHaveBeenCalled();
    },
  );

  it("bounds a stalled credential provider", async () => {
    const client = listener({ credentials: { getCredentials: () => new Promise(() => {}) } });
    const result = client.outputs(SESSION).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(ToolTimeoutError);
    expect(connectMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TCP framing and UTF-8", () => {
  it("handles one-byte fragments across UTF-8, CRLF and notification markers", async () => {
    script = (command, socket) => {
      if (command.startsWith("outputs ")) {
        socket.receiveBytewise(
          '>>STATUS é\r\nOUTPUTS:<outputs><output name="Ville" type="text" value="Montréal 🦊" /></outputs>\r\n',
        );
      } else
        socket.receiveBytewise(
          listenerFixture(command.startsWith("user name") ? "user-set" : "user-authenticated"),
        );
    };
    expect((await listener().outputs(SESSION))[0]?.value).toBe("Montréal 🦊");
  });

  it("collects fragmented status through the explicit terminal line, ignoring notifications", async () => {
    script = (_, socket) => {
      socket.receiveBytewise(
        listenerFixture("status").replace("Total running", ">>STATUS Running:0\r\nTotal running"),
      );
    };
    expect((await listener().status()).sessions).toHaveLength(2);
  });

  it.each(["busy", "status", "outputs"])(
    "accepts a final %s line without newline only on clean EOF",
    async (command) => {
      script = (line, socket) => {
        if (line.startsWith(command)) socket.end(listenerFixture(command).replace(/\r?\n$/, ""));
        else capturedReply(line, socket);
      };
      const client = listener();
      if (command === "busy") expect(await client.busy()).toBe(false);
      else if (command === "status") expect((await client.status()).totalRunning).toBe(2);
      else expect(await client.outputs(SESSION)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not guess completion from a silent unterminated reply", async () => {
    script = (_, socket) => {
      socket.receive("no");
    };
    const result = listener()
      .busy()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(ToolTimeoutError);
    expect(sockets[0]?.destroyed).toBe(true);
  });

  it.each(["USER SET\r\nUSER AUTHENTICATED\r\n", "USER SET\r\nUSER AUTHENTICATED"])(
    "rejects extra/partial frames instead of advancing authentication",
    async (reply) => {
      script = (_, socket) => {
        socket.end(reply);
      };
      await expect(listener().outputs(SESSION)).rejects.toThrow(ListenerConnectionError);
      expect(sockets[0]?.writes).toEqual(["user name tester\r\n"]);
    },
  );

  it("rejects a trailing frame completed in another packet before sending the next command", async () => {
    script = (_, socket) => {
      socket.receive("USER SET\r\nUSER AUTH");
      queueMicrotask(() => {
        socket.receive("ENTICATED\r\n");
      });
    };
    await expect(listener().outputs(SESSION)).rejects.toThrow(ListenerConnectionError);
    expect(sockets[0]?.writes).toHaveLength(1);
  });

  it("can finish a fragmented notification before the next authentication command", async () => {
    script = (command, socket) => {
      if (command.startsWith("user name")) {
        socket.receive("USER SET\r\n>");
        queueMicrotask(() => {
          socket.receive(">STATUS Running:0\r\n");
        });
      } else capturedReply(command, socket);
    };
    expect(await listener().outputs(SESSION)).toHaveLength(2);
  });

  it("refuses a delayed previous acknowledgement in the password phase", async () => {
    script = (command, socket) => {
      if (command.startsWith("password")) socket.receive("USER SET\r\n");
      else capturedReply(command, socket);
    };
    await expect(listener().outputs(SESSION)).rejects.toThrow(CredentialsError);
    expect(sockets[0]?.writes).toHaveLength(2);
  });

  it("refuses multiline XML rather than guessing a payload delimiter", async () => {
    script = (command, socket) => {
      if (command.startsWith("outputs"))
        socket.receive(
          'OUTPUTS:<outputs>\n<output name="X" type="text" value="hidden" /></outputs>\n',
        );
      else capturedReply(command, socket);
    };
    const error = await listener()
      .outputs(SESSION)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ListenerConnectionError);
    expect(publicErrorText(error)).not.toContain("hidden");
  });

  it("refuses undelimited multiline status messages", async () => {
    script = (_, socket) => {
      socket.receive(`RESOURCE UNIT\n - FAILED ${SESSION} - error\nprivate continuation\n`);
    };
    const error = await listener()
      .status()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(UnexpectedOutputError);
    expect(publicErrorText(error)).not.toContain("private continuation");
  });

  it("rejects invalid/truncated UTF-8 rather than replacing it silently", async () => {
    script = (_, socket) => {
      socket.end(Buffer.from([0xc3]));
    };
    await expect(listener().busy()).rejects.toThrow("Invalid UTF-8");
  });

  it("does not accept a reply followed by a partial UTF-8 frame", async () => {
    script = (_, socket) => {
      socket.end(Buffer.concat([Buffer.from("no\r\n"), Buffer.from([0xc3])]));
    };
    await expect(listener().busy()).rejects.toThrow("Invalid UTF-8");
  });

  it("does not treat reset as EOF for an unterminated reply", async () => {
    script = (_, socket) => {
      socket.receive("no");
      socket.destroy();
    };
    await expect(listener().busy()).rejects.toThrow(ListenerConnectionError);
  });

  it("rejects EOF before the status terminal line", async () => {
    script = (_, socket) => {
      socket.end("RESOURCE UNIT\r\n");
    };
    await expect(listener().status()).rejects.toThrow(ListenerConnectionError);
  });
});

describe("transport failure bounds", () => {
  it.each(["error", "close"])("cleans up an asynchronous pre-connect %s", async (event) => {
    const socket = new SimulatedListenerSocket();
    sockets.push(socket);
    connectMock.mockImplementation(() => {
      queueMicrotask(() => {
        socket.emit(event, new Error("private-connection-data"));
      });
      return socket;
    });
    const error = await listener()
      .busy()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ListenerConnectionError);
    expect(publicErrorText(error)).not.toContain("private-connection-data");
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unsolicited replies before sending a command", async () => {
    const socket = new SimulatedListenerSocket();
    sockets.push(socket);
    connectMock.mockImplementation(() => {
      queueMicrotask(() => {
        socket.emit("connect");
        socket.receive("no\r\n");
      });
      return socket;
    });
    await expect(listener().busy()).rejects.toThrow(ListenerConnectionError);
    expect(socket.writes).toEqual([]);
  });

  it("counts UTF-8 bytes rather than characters toward the limit", async () => {
    script = (_, socket) => {
      socket.receive(">>éé\n");
    };
    await expect(listener({ maxResponseBytes: 5 }).busy()).rejects.toThrow(ToolOutputLimitError);
  });

  it("times out and destroys a socket that never connects", async () => {
    const socket = new SimulatedListenerSocket();
    sockets.push(socket);
    connectMock.mockImplementation(() => socket);
    const result = listener()
      .busy()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(ToolTimeoutError);
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connect", "socket", "write"])("suppresses raw %s errors", async (phase) => {
    if (phase === "connect")
      connectMock.mockImplementation(() => {
        throw new Error("private-network-data");
      });
    else
      script = (_, socket) => {
        if (phase === "socket") socket.emit("error", new Error("private-network-data"));
        else {
          throw new Error("private-network-data");
        }
      };
    const error = await listener()
      .busy()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ListenerConnectionError);
    expect(publicErrorText(error)).not.toContain("private-network-data");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend deadlines for notifications or slow fragments", async () => {
    script = (_, socket) => {
      socket.receive(">>STATUS Running:0\n");
      setTimeout(() => {
        socket.receive(">>STATUS Running:0\nn");
      }, 40);
    };
    const result = listener()
      .busy()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeInstanceOf(ToolTimeoutError);
    expect(sockets[0]?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([">>notification-flood", "unterminated-private-data", "no\n>>large-notification"])(
    "bounds every received byte: %s",
    async (reply) => {
      script = (_, socket) => {
        socket.receive(reply);
      };
      const error = await listener({ maxResponseBytes: 8 })
        .busy()
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ToolOutputLimitError);
      expect(error).toMatchObject({ output: "", command: "busy" });
      expect(publicErrorText(error)).not.toContain(reply);
      expect(sockets[0]?.destroyed).toBe(true);
    },
  );

  it("counts bytes across authentication replies and outputs, not just the final response", async () => {
    await expect(listener({ maxResponseBytes: 35 }).outputs(SESSION)).rejects.toThrow(
      ToolOutputLimitError,
    );
    expect(sockets[0]?.writes).toHaveLength(3);
  });

  it("allows exactly the byte budget and clears all timers", async () => {
    expect(await listener({ maxResponseBytes: 4 }).busy()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
