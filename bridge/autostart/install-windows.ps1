# Optional Windows autostart for the bridge server (per-user scheduled task, runs at logon).
#   powershell -ExecutionPolicy RemoteSigned -File bridge\autostart\install-windows.ps1
# Verify: curl http://127.0.0.1:8777/health
# Remove: Unregister-ScheduledTask -TaskName 'BTR Bridge' -Confirm:$false

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node).Source
$server = Join-Path $repo 'bridge\server.js'

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$server`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'BTR Bridge' -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
Start-ScheduledTask -TaskName 'BTR Bridge'
Write-Host "Installed and started. Health check:"
Start-Sleep -Seconds 2
try { (Invoke-WebRequest -Uri 'http://127.0.0.1:8777/health' -UseBasicParsing).Content } catch { Write-Warning "not responding yet: $_" }
