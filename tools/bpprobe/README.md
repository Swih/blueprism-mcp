# bpprobe

Small C# console tool that loads the DLLs of the local Blue Prism install **read-only** and
answers questions about them. It never writes to the Blue Prism database, never starts a
session and never modifies the install.

## Build

Compiled with the Roslyn compiler shipped inside Blue Prism (no .NET SDK needed):

```powershell
powershell -File tools/bpprobe/build.ps1 [-BluePrismDir "C:\Program Files\Blue Prism Limited\Blue Prism Automate"]
```

Output: `tools/bpprobe/bin/bpprobe.exe` (gitignored). The install directory used at run time
defaults to the path above; override it with the `BP_INSTALL_DIR` environment variable.

## Commands

- `bpprobe catalog <out.json>`: dumps the browser-mode Application Manager catalogue from
  `AMI.dll` (element types, actions, reads, writes, wait conditions with their arguments,
  and the `w*` web identifiers).
- `bpprobe apptypes <out.json>`: dumps the application types (Launch / Attach variants) and
  the parameters each one declares.
- `bpprobe validate <file>`: loads a process or object XML with Blue Prism's own parser
  (`BluePrismProcess.FromXmlThrowsErrors`) and reports what it read, or where it breaks.
- `bpprobe find <dll> <regex>`: lists public methods whose type or member name matches.
- `bpprobe il <dll> <type-regex> [method-regex]`: crude IL listing (string literals and
  called methods) of the matching methods.

The catalogue and app-type dumps contain SS&C text: keep them out of git (generate them
locally, e.g. under `.bpdev/`).
