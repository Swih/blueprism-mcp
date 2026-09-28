# Extracts the Blue Prism catalogue of the local install into <repo>/.bpdev/catalog/
# (gitignored: it contains SS&C texts). Builds bpprobe first when it is missing.
# Usage: npm run catalog:extract -w @bpdev/catalog
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$probeDir = Join-Path $repo "tools\bpprobe"
$probe = Join-Path $probeDir "bin\bpprobe.exe"
$out = Join-Path $repo ".bpdev\catalog"

if (-not (Test-Path $probe)) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $probeDir "build.ps1")
    if ($LASTEXITCODE -ne 0) { throw "bpprobe build failed" }
}
New-Item -ItemType Directory -Force $out | Out-Null
& $probe catalog (Join-Path $out "catalog.json")
if ($LASTEXITCODE -ne 0) { throw "bpprobe catalog failed" }
& $probe apptypes (Join-Path $out "apptypes.json")
if ($LASTEXITCODE -ne 0) { throw "bpprobe apptypes failed" }
