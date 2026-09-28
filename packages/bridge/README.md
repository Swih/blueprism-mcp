# @bpdev/bridge — work in progress

Local integration foundations for AutomateC and the runtime resource listener. Source modules
contain typed command/reply parsers, a native credential provider, a child-process runner,
an AutomateC client and a TCP listener client. The package entry point does not expose a
public API yet.

Protocol fixtures with anonymized machine names and paths are included for future bridge
tests. This package currently
passes TypeScript and lint checks; executable bridge tests and integration through its
public API remain to be added. The native RPA Challenge runs recorded in the project docs
used the existing Python/PowerShell validation scripts, not this unfinished package API.

`EnvCredentialProvider` expects `BP_USER` and `BP_PASSWORD`. The AutomateC adapter selects
`/locale en-US`, masks registered secrets in captured output and uses an argument array
without a shell. Native CLI authentication still exposes its password in the OS process
arguments while the command runs. The listener client currently uses plain TCP and is
intended for the local development runtime.

Before exposing agent tools: complete public exports and parser/transport tests, handle
secret outputs explicitly, and validate queue, credential and environment-variable operations
against isolated synthetic resources.
