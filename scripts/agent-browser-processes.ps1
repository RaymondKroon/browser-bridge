Set-StrictMode -Version Latest

function Get-AgentBrowserProcesses {
    [CmdletBinding()]
    param()

    $agentBrowserPattern = '(?<![\w-])agent-browser(?:-win32-x64)?(?:\.exe|\.ps1|\.cmd|\.js)?(?![\w-])'

    return @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.ProcessId -ne $PID -and (
                    $_.Name -match $agentBrowserPattern -or
                    $_.CommandLine -match $agentBrowserPattern
                )
            } |
            Sort-Object ProcessId |
            ForEach-Object {
                [pscustomobject]@{
                    ProcessId = $_.ProcessId
                    ParentProcessId = $_.ParentProcessId
                    Name = $_.Name
                    CommandLine = $_.CommandLine
                }
            }
    )
}
