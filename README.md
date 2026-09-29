# blueprism-mcp

Build, run and diagnose Blue Prism browser automations through a local MCP server.
An LLM observes the requested website, proposes a typed plan, and gets native Blue Prism
objects and processes with dynamic XPath, state-based Waits and business assertions.

[Présentation courte en français](docs/09-presentation.md)

This is an original implementation started from scratch, not a fork of another Blue Prism
MCP server. Blue Prism remains the execution engine; the model does not write arbitrary XML
or Code Stages. The project is independent of SS&C.

**Experimental preview:** Windows, Blue Prism Enterprise 7.5.1 and Chrome with the official
BP extension in a dedicated robot profile. Tested on a local trial environment with synthetic
data; this is not a production qualification.

| Native proof                      | Result                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| RPA Challenge                     | Three rounds, dynamic fields, seven passing value assertions.                                                                |
| Four-item queue in one BP session | 2 Completed, 1 Business Exception, 1 System Exception; next-item continuation, one HTTP attempt per key, no remaining locks. |
| Stopping and recovery             | Empty queue, item limit, consecutive-system-error limit and fatal cleanup tested.                                            |
| Maintainable BP deliverables      | Separate lifecycle/screen objects, reusable helpers, original 14-page template; zero Studio errors with objects included.    |

[Recorded native-log demonstration](docs/assets/demo-replay.html) ·
[Detailed evidence and limitations](docs/10-qualification-status.md) ·
[Template design and SS&C sources](docs/11-template-quality.md)

The demonstration is an interactive replay of recorded native events, not a browser video.
Download the repository and open the HTML locally to use its playback controls.

## Implemented

- Typed objects with shared Attach/helpers, dynamic selectors and bounded Waits.
- DOM observation and XPath prevalidation in a separate temporary Chrome session.
- Native XML and offline expression checks, guarded import/publish, persistent launch keys and run tracking.
- Status, bounded logs and scalar assertions: Completed alone is not business success.
- Local MCP stdio tools and a [portable skill](skills/blueprism-build/SKILL.md).
- Native queue creation, verified seeding and an original bounded processing loop.

Objects are ordinary, editable BP artifacts: separate lifecycle and screen objects, reusable
Attach/field pages, meaningful stage names, and separate Wait-success/timeout branches.
Their structure is designed for maintenance in Studio, without requiring the LLM at runtime.

Existing names are preserved; deploy a new version instead of overwriting a Studio object.
Native XML and expression checks do not replace full Studio/dependency validation. DOM verification does not prove
BP extension compatibility. Listener collection payloads are withheld until decoding is
qualified. General API workflows, credential management, merging into existing objects,
Citrix/SAP and a replacement RPA runtime are outside this first release.

## Local setup

1. Install Node 24, Blue Prism and Chrome. Configure a local BP connection and runtime.
2. Prepare a dedicated Chrome user-data directory with the official BP extension.
3. Clone this repository and run:

   ```powershell
   npm ci
   npm run build
   powershell -File tools/bpprobe/build.ps1
   npm run catalog:extract -w @bpdev/catalog
   Copy-Item .env.example .env
   ```

4. Fill .env locally: BP_USER, BP_PASSWORD, BP_RESOURCE_NAME, connection name and
   BP_ROBOT_PROFILE_DIR. The default listener is loopback port 8181. Keep the runtime idle
   before deployment; use a separate profile from normal browsing.
5. Configure a stdio MCP client: executable node, arguments containing the absolute path to
   packages/mcp/dist/cli.js and the absolute repository directory.

For clients using mcpServers JSON:

```json
{
  "mcpServers": {
    "blueprism": {
      "command": "node",
      "args": ["C:/path/to/blueprism-mcp/packages/mcp/dist/cli.js", "C:/path/to/blueprism-mcp"]
    }
  }
}
```

The CLI loads .env; existing environment variables take precedence. No secret is needed in
the MCP client configuration. Extracted AMI catalogues and BP binaries are local dependencies,
not redistributed assets.

## Workflow

Read bp_capabilities and bp_catalog. Observe with scan_open and verify candidate selectors
with scan_verify. Use bp_prepare, bp_validate, bp_deploy, then bp_start with a stable request
key. Poll bp_inspect for status, logs and assertions.

Reuse the same request key after a lost response. An unknown launch needs reconciliation.
After a submission timeout, check the business effect before retrying. Stop acknowledgement
does not mean the robot has stopped.
Failed/stopped sessions and unverified business results block subsequent mutations until
an operator records independent evidence with the runner's reconciliation API. This override
is deliberately absent from the MCP tool surface. Queue loading is limited to one batch
per queue created by this runner; a different request key does not permit reseeding it.
The process itself consumes items until none is eligible or a stopping limit is reached:
100 items by default (maximum 1,000), three consecutive System Exceptions by default, or an
operator stop request. It finalizes each item before continuing and performs no item retries.
An empty Item ID means no eligible item now, not that the queue has no remaining rows.

## Verification and demonstration

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Latest full suite: **823 passed, 14 optional tests skipped**; lint, typecheck and build passed.
The 14 real-Chrome scanner tests also passed in a separate targeted run.
Native operator-stop and queue-finalization-failure injection remain explicit backlog items;
their unit guards are covered, but no native pass is claimed. Exception screenshot retrieval
is not implemented. See the qualification record for the fresh-agent trial and interventions.

CI runs without Blue Prism. The native demo imports new BPDEV versions and uses synthetic
data on RPA Challenge. Enable it explicitly:

```powershell
$env:BP_INTEGRATION = '1'
node tools/demo/run-rpa.js
```

It uses the public MCP protocol from generation through inspection. Local evidence goes to
.bpdev/demo. Start the original service-request fixture with:

```powershell
node tools/demo/site.js
```

With that local target running, `node tools/demo/run-service-desk.js` repeats the qualified
browser scenario (`BP_INTEGRATION=1` required). The queue scenario separates deployment
for Studio inspection from execution. Choose a fresh suite ID once:

```powershell
$env:BP_INTEGRATION = '1'
$env:BPDEMO_SCENARIO = 'mixed'
$env:BPDEMO_QUEUE_ID = $env:BPDEMO_SCENARIO + '-' + (Get-Date -Format 'yyyyMMddHHmmss')
$env:BPDEMO_PHASE = 'deploy'
node tools/demo/run-queue.js
```

This prepares, validates, imports and publishes the objects, consumer and seed when needed; it does not
load or process queue items. Inspect the process and its objects in Studio and require zero
errors before proceeding. Trial published-process limits can block this deployment phase.
Choose `BPDEMO_SCENARIO` from `mixed`, `empty`, `item-limit` or `system-limit` (default: `mixed`).
Use a fresh suite ID for each new scenario; IDs accept letters, digits and hyphens, up to 40
characters. `empty` creates no seed. Keep the same scenario, suite ID and local target running
between deploy and run:

```powershell
$env:BPDEMO_PHASE = 'run'
node tools/demo/run-queue.js
node tools/demo/export-queue.js
```

The run phase verifies the seed count when applicable and the expected aggregate results. The operator-only
export uses native `/exportqueue` to save a CSV under `.bpdev/demo/<suite-id>/`; it does not
modify or clear queue items. Review it alongside `/records`. Failed or uncertain runs need
reconciliation; changing the suite ID or repeating a seed is not a recovery procedure.
The [qualification record](docs/10-qualification-status.md) identifies the passing mixed,
empty, item-limit and system-limit scenarios, their evidence and the guard cases still to be tested.

Its input IDs/order change on each load, confirmation is delayed, and /records independently
counts submissions. It binds only to 127.0.0.1:8931. Use synthetic demo-* case references.

Before publishing, run node tools/security/audit-public.js with any additional local .env
paths as arguments. It checks public files and historical Git blobs without printing matched
secret values. Review findings require inspection; a clean scan cannot prove the absence of
every unknown secret. Local .env, .bpdev, reference releases and vendor catalogues stay out of Git.

## Structure

| Package   | Responsibility                                |
| --------- | --------------------------------------------- |
| model     | Lossless XML document and typed views         |
| catalog   | Installed AMI contracts                       |
| generator | Typed plans to native BP XML                  |
| bridge    | AutomateC, local listener and native parser   |
| scanner   | Bounded DOM evidence and XPath prevalidation  |
| runner    | Artifacts, durable execution and verification |
| mcp       | Typed stdio tools for a general-purpose LLM   |

## Contributors and license

- **Swih** — project author, product direction and Blue Prism expertise.
- **Codex** — AI-assisted implementation, tests and integration.
- **Claude** — AI-assisted design review and strategic feedback.

[MIT](LICENSE), copyright 2026 Swih. Third-party dependencies retain their own licenses.
Blue Prism, its extension and its libraries are not included in this license or repository.
