[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param()

. $PSScriptRoot\agent-browser-processes.ps1

$ErrorActionPreference = "Stop"

$processes = Get-AgentBrowserProcesses

if ($processes.Count -eq 0) {
    Write-Output "No agent-browser processes found."
    exit 0
}

$stoppedProcessIds = @()

foreach ($process in $processes) {
    if ($PSCmdlet.ShouldProcess("PID $($process.ProcessId) ($($process.Name))", "Stop agent-browser process")) {
        Stop-Process -Id $process.ProcessId -Force
        $stoppedProcessIds += $process.ProcessId
    }
}

if ($stoppedProcessIds.Count -eq 0) {
    Write-Output "No processes were stopped."
    exit 0
}

Start-Sleep -Milliseconds 500

$remainingProcesses = Get-AgentBrowserProcesses

Write-Output "Stopped agent-browser PIDs: $($stoppedProcessIds -join ', ')"

if ($remainingProcesses.Count -eq 0) {
    Write-Output "No agent-browser processes remain."
    exit 0
}

Write-Output "Remaining agent-browser processes:"
$remainingProcesses | Format-Table -AutoSize ProcessId, ParentProcessId, Name, CommandLine
