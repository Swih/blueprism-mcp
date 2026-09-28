# Build bpprobe.exe with the Roslyn compiler shipped inside Blue Prism (no SDK needed).
# Output: tools/bpprobe/bin/bpprobe.exe (gitignored).
param([string]$BluePrismDir = "C:\Program Files\Blue Prism Limited\Blue Prism Automate")
$ErrorActionPreference = "Stop"
$fw = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $BluePrismDir "roslyn\csc.exe"
$bin = Join-Path $PSScriptRoot "bin"
New-Item -ItemType Directory -Force $bin | Out-Null
$sources = Get-ChildItem $PSScriptRoot -Filter *.cs | ForEach-Object { $_.FullName }
& $csc /nologo /langversion:latest /debug:portable /target:exe /out:"$bin\bpprobe.exe" `
    /r:"$fw\System.Web.Extensions.dll" /r:"$fw\System.Xml.dll" /r:"$fw\System.Core.dll" @sources
if ($LASTEXITCODE -ne 0) { throw "bpprobe build failed" }
