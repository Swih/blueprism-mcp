# @bpdev/mcp

Local stdio server using MCP TypeScript SDK 2.2.0. Library imports have no environment side
effects; `configuredServer(root, env)` constructs the adapters and `createServer(dependencies)`
supports embedding/tests.

Run after build and local catalogue extraction:

```powershell
node packages/mcp/dist/cli.js C:/path/to/blueprism-mcp
```

Use the same command and absolute arguments in your MCP client. The CLI loads `.env` from
the specified project root; existing environment variables take precedence. Stdout is protocol
only. Secrets stay out of the client configuration.

Tools: `bp_capabilities`, `bp_catalog`, `scan_open`, `scan_observe`, `scan_verify`, `scan_close`,
`bp_prepare`, `bp_validate`, `bp_deploy`, `bp_start`, `bp_inspect`, `bp_request_stop`,
`bp_create_queue`, `bp_prepare_queue_seed`, `bp_prepare_queue_consumer`.

Queue consumers use a bounded native loop within one session: `maxItems` defaults to 100
(1–1000), and `consecutiveSystemExceptionLimit` defaults to 3 (1–100). The loop stops on an
empty Item ID (no eligible item now), a bound or a stop request. There is no automatic retry or replay. Supply
`expectedOutcome` (`Completed`, `CompletedWithExceptions`, `NoAvailableItem` or `Stopped`)
and required `expectedCounts: { completed, businessExceptions, systemExceptions }` with
integer values from 0 to 1000 and total at most 1000. Verification checks the outcome,
each count and the `Processed Count` sum; `Completed` alone is insufficient. Optional
`consumer.call.businessRejectionPrefix` must correlate a rejection with `CaseKey`.
Queue creation still uses one attempt, `CaseKey`, and one seed batch of at most 20 items.

The server embeds guidance and schemas. The [portable skill](../../skills/blueprism-build/SKILL.md)
adds BP-specific reasoning. Validation distinguishes format, native XML/expression checks, execution and
business assertions. DOM prevalidation runs in a separate Chrome session.

Diagnostics return bounded native logs and the first logged exception. Native exception
image retrieval is not implemented: `saveScreenCapture` only requests BP capture and depends
on the operator's BP configuration. No screenshot is inferred from a successful XML import.

Plans cannot select arbitrary executables, flags or JavaScript operations. Deployment refuses
existing names. Launch request keys survive MCP restarts; an uncertain run blocks further
mutations until reconciled. There is no automatic replay after an unknown outcome.

Protocol tests connect the real SDK client/server. The native demo uses the stdio transport
and these same tools, without private spike scripts.
