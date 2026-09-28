"""Run AutomateC.exe with the credentials from the local .env, masking the password.

Usage: python bp_admin.py /listprocesses
       python bp_admin.py /import "MCP Test - Echo.bpprocess"
"""
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

ENV_PATH = Path(__file__).resolve().parent.parent / "candidates" / "blueprism-mcp-server" / ".env"
AUTOMATEC = r"C:\Program Files\Blue Prism Limited\Blue Prism Automate\AutomateC.exe"
DB_CONNECTION = "LocalDB Connection"


def main() -> int:
    env = dotenv_values(ENV_PATH)
    user, password = env.get("BP_USER_NAME"), env.get("BP_PASSWORD")
    if not user or not password:
        print(f"BP_USER_NAME / BP_PASSWORD missing in {ENV_PATH}")
        return 2
    cmd = [AUTOMATEC, "/user", user, password, "/dbconname", DB_CONNECTION, *sys.argv[1:]]
    result = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    print((result.stdout + result.stderr).replace(password, "***").strip())
    print(f"[exit {result.returncode}]")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
