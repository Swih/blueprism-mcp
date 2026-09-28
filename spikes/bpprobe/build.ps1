# Build bpprobe.exe with the Roslyn compiler shipped inside Blue Prism (no SDK needed).
param([string]$BluePrismDir = "C:\Program Files\Blue Prism Limited\Blue Prism Automate")
$ErrorActionPreference = "Stop"
$fw = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $BluePrismDir "roslyn\csc.exe"
$sources = Get-ChildItem $PSScriptRoot -Filter *.cs | ForEach-Object { $_.FullName }
& $csc /nologo /langversion:latest /debug:portable /target:exe /out:"$PSScriptRoot\bpprobe.exe" `
    /r:"$fw\System.Web.Extensions.dll" /r:"$fw\System.Xml.dll" /r:"$fw\System.Core.dll" @sources
if ($LASTEXITCODE -ne 0) { throw "bpprobe build failed" }
