"""Read a finished session's outputs from the local runtime resource (TCP 8181).

Uses the documented listener commands: 'user name <n>', 'password <p>', 'outputs <id>'.
Credentials come from the local .env and are never printed.
"""
import socket
import sys
from pathlib import Path

from dotenv import dotenv_values

ENV = Path(__file__).resolve().parent.parent / "candidates" / "blueprism-mcp-server" / ".env"


def command(sock: socket.socket, line: str) -> str:
    sock.sendall((line + "\r\n").encode("utf-8"))
    chunks = []
    sock.settimeout(3)
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            chunks.append(data.decode("utf-8", errors="replace"))
            if data.endswith(b"\n"):
                break
    except socket.timeout:
        pass
    return "".join(chunks).strip()


def main(session_id: str) -> None:
    env = dotenv_values(ENV)
    with socket.create_connection(("127.0.0.1", 8181), timeout=5) as sock:
        print("user:", command(sock, f"user name {env['BP_USER_NAME']}"))
        print("password:", command(sock, f"password {env['BP_PASSWORD']}").replace(env["BP_PASSWORD"], "***"))
        print("outputs:", command(sock, f"outputs {session_id}"))


if __name__ == "__main__":
    main(sys.argv[1])
