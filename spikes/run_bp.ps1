# Spike helper: import files, publish a process, run it on the local runtime, wait,
# and print status, stage log and the failure reason (read from the session row).
param(
    [string[]]$Import = @(),
    [string]$Process,
    [string]$Resource = "XCP-SNACK",
    [int]$TimeoutSeconds = 120
)
$repo = Split-Path $PSScriptRoot -Parent
$py = Join-Path $repo "candidates\blueprism-mcp-server\.venv\Scripts\python.exe"
$adm = Join-Path $repo "test-fixtures\bp_admin.py"
function Bp { & $py $adm @args /locale en-US }

foreach ($f in $Import) { "import $(Split-Path $f -Leaf): $((Bp /import (Resolve-Path $f).Path /overwrite) -join ' ')" }
if (-not $Process) { return }
"publish: $((Bp /publish $Process) -join ' ')"
$out = (Bp /run $Process /resource $Resource) -join "`n"
$sid = ([regex]'Session: ([0-9a-f-]{36})').Match($out).Groups[1].Value
if (-not $sid) { "run failed: $out"; return }
"session $sid"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do { Start-Sleep -Seconds 2; $st = (Bp /status $sid) -join ' ' } while ($st -match 'Running|Pending' -and (Get-Date) -lt $deadline)
$st
Bp /getlog $sid
$cn = New-Object System.Data.SqlClient.SqlConnection "Server=(localdb)\BluePrismLocalDB;Database=BluePrism;Integrated Security=true"
$cn.Open()
$c = $cn.CreateCommand()
$c.CommandText = "SELECT laststage, exceptiontype, exceptionmessage FROM BPASession WHERE sessionid = @id"
[void]$c.Parameters.AddWithValue("@id", [guid]$sid)
$r = $c.ExecuteReader()
while ($r.Read()) { "laststage=$($r[0]) | exception=$($r[1]) | $($r[2])" }
$cn.Close()
