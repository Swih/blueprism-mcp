# Spike S1: dump Blue Prism's Application Manager catalogue (element types, actions,
# conditions, identifiers) for browser-mode applications, straight from AMI.dll.
# Read-only: loads the installed assemblies, touches no database or runtime.
param(
    [string]$BluePrismDir = "C:\Program Files\Blue Prism Limited\Blue Prism Automate",
    [string]$OutFile = (Join-Path $PSScriptRoot "ami-catalog-browser.json")
)
$ErrorActionPreference = "Stop"
[Environment]::CurrentDirectory = $BluePrismDir
$script:bpDir = $BluePrismDir
[AppDomain]::CurrentDomain.add_AssemblyResolve({
    param($sender, $e)
    $name = (New-Object Reflection.AssemblyName($e.Name)).Name
    $path = Join-Path $script:bpDir "$name.dll"
    if (Test-Path $path) { return [Reflection.Assembly]::LoadFrom($path) }
    return $null
})

$appMan = [Reflection.Assembly]::LoadFrom((Join-Path $BluePrismDir "BluePrism.AppMan.dll"))
$appMan.GetType("BluePrism.AppMan.ContainerInitialiser").GetMethod("SetUpContainer").Invoke($null, @()) | Out-Null

$ami = [Reflection.Assembly]::LoadFrom((Join-Path $BluePrismDir "AMI.dll"))
$clsAMI = $ami.GetType("BluePrism.AMI.clsAMI")
$ati = $ami.GetType("BluePrism.ApplicationManager.AMI.ApplicationTypeInfo")

function Invoke-Static($type, $name, $argList) {
    $m = $type.GetMethods() | Where-Object { $_.Name -eq $name -and $_.IsStatic -and $_.GetParameters().Count -eq $argList.Count } | Select-Object -First 1
    return $m.Invoke($null, $argList)
}

# Build a BrowserLaunch application type info the same way an exported object declares it.
$appXml = [xml]'<apptypeinfo><id>BrowserLaunch</id><parameters /></apptypeinfo>'
$fromXml = $ati.GetMethods() | Where-Object { $_.Name -eq "FromXML" } | Select-Object -First 1
$appInfo = $fromXml.Invoke($null, @($appXml.DocumentElement))

function ArgList($dict) {
    if (-not $dict) { return @() }
    @($dict.Values | ForEach-Object { [ordered]@{ id = $_.ID; name = $_.Name; datatype = $_.DataType; help = $_.HelpText } })
}

$elementTypes = @(Invoke-Static $clsAMI "GetElementTypes" @())
$browserTypes = $elementTypes | Where-Object { "$($_.AppType)" -match "Browser" }
$catalog = [ordered]@{
    source = "AMI.dll $((Get-Item (Join-Path $BluePrismDir 'AMI.dll')).VersionInfo.FileVersion)"
    appTypes = @($elementTypes | ForEach-Object { "$($_.AppType)" } | Sort-Object -Unique)
    elementTypes = @()
}
foreach ($et in $browserTypes) {
    $actions = @(Invoke-Static $clsAMI "GetAllowedActions" @($et, $appInfo))
    $conditions = @(Invoke-Static $clsAMI "GetAllowedConditions" @($et, $appInfo))
    $reads = @(Invoke-Static $clsAMI "GetAllowedReadActions" @($et, $appInfo))
    $write = @(Invoke-Static $clsAMI "GetAllowedWriteAction" @($et))
    $catalog.elementTypes += [ordered]@{
        id = $et.ID; name = $et.Name; appType = "$($et.AppType)"; defaultDataType = $et.DefaultDataType
        help = $et.HelpText
        actions = @($actions | ForEach-Object { [ordered]@{ id = $_.ID; name = $_.Name; returns = $_.ReturnType; args = (ArgList $_.Arguments); outputs = (ArgList $_.Outputs); help = $_.HelpText } })
        readActions = @($reads | ForEach-Object { [ordered]@{ id = $_.ID; name = $_.Name; returns = $_.ReturnType; args = (ArgList $_.Arguments) } })
        writeActions = @($write | ForEach-Object { [ordered]@{ id = $_.ID; name = $_.Name; args = (ArgList $_.Arguments) } })
        conditions = @($conditions | ForEach-Object { [ordered]@{ id = $_.ID; name = $_.Name; datatype = $_.DataType; default = $_.DefaultValue; args = (ArgList $_.Arguments) } })
    }
}
$catalog | ConvertTo-Json -Depth 8 | Set-Content -Path $OutFile -Encoding utf8
"Wrote $OutFile : $($catalog.elementTypes.Count) browser element types"
