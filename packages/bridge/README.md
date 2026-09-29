# @bpdev/bridge

Typed local adapters for Blue Prism 7.5.1: `AutomateC`, `RuntimeListener`, `NativeProbe`
and `EnvCredentialProvider`. The public entry point exports these adapters and typed errors;
raw transports and protocol parsers stay internal.

```ts
import { AutomateC, EnvCredentialProvider, RuntimeListener } from "@bpdev/bridge";
const credentials = new EnvCredentialProvider();
const bp = new AutomateC({ credentials, dbConnection: "LocalDB Connection" });
const runtime = new RuntimeListener({ credentials });
const idle = !(await runtime.busy());
```

AutomateC lists/imports/exports/publishes, launches sessions, reads status/logs, requests stop,
and creates new namespaced demo queues. Queue creation uses the documented native CLI,
qualified on 7.5.1; importing a release could overwrite existing components.

A /run timeout stops waiting for the CLI, not the robot. A received session GUID remains
usable even if the CLI exits unsuccessfully afterwards. Without acknowledgement or a known
pre-session rejection, RunOutcomeUnknownError means reconcile, never blindly retry.

Commands use argument arrays and /locale en-US. BP_USER and BP_PASSWORD come from the local
environment. Known secrets are filtered after structural parsing, including encoded forms
in CLI diagnostics. Native CLI authentication takes the password as a process argument while
the command runs. No raw child-process output is part of the public API.

The listener accepts loopback addresses only, with deadlines and byte limits. It handles
UTF-8 fragmentation and rejects ambiguous responses. Password values and unqualified
collection payloads are withheld. ListenerOptions.secrets can carry known session secrets.

NativeProbe.validate reports **native XML loading**, not full Studio or business validation.
Tests cover anonymized captured protocols, simulated TCP and bounded child processes.
Native BP execution is opt-in under tools/demo.
