. $PSScriptRoot\agent-browser-processes.ps1

$ErrorActionPreference = "Stop"

$processes = Get-AgentBrowserProcesses

if ($processes.Count -eq 0) {
    Write-Output "No agent-browser processes found."
    exit 0
}

$processes | Format-Table -AutoSize ProcessId, ParentProcessId, Name, CommandLine
