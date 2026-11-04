param(
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'status'
)

# AI 角色自动生成：开机自启 / 启停 / 状态
# 优先使用 Windows 计划任务（需管理员权限）；当前进程无提权时自动回退到 HKCU Run 开机自启。
$TaskName = 'AIPoseAutoGen'
$RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$root = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $PSScriptRoot 'autogen-supervisor.ps1'
$outDir = Join-Path $root '.auto-gen'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$runValue = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $supervisor + '"'

function Get-SupervisorProcesses {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'autogen-supervisor\.ps1' }
}

function Get-AutogenProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'autogen\.mjs' }
}

function Get-InstalledMethod {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { return 'task' }
  if (Get-ItemProperty -Path $RunKeyPath -Name $TaskName -ErrorAction SilentlyContinue) { return 'runkey' }
  return 'none'
}

function Start-SupervisorHidden {
  # 用 Win32_Process.Create 启动，完全脱离当前终端/进程树，关闭终端不会被带走
  $cmdLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $supervisor + '"'
  $result = ([wmiclass]'Win32_Process').Create($cmdLine)
  if ($result.ReturnValue -ne 0) { Write-Output ('启动守护进程失败，ReturnValue=' + $result.ReturnValue) }
}

switch ($Action) {
  'install' {
    $method = 'none'
    try {
      $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $runValue.Substring('powershell.exe '.Length) -WorkingDirectory $root
      $trigger = New-ScheduledTaskTrigger -AtLogOn
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
      Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Description 'AI 角色三合一：本地 ComfyUI 随机配方 24/7 自动生成' -Force -ErrorAction Stop | Out-Null
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { $method = 'task' }
    } catch {
      $method = 'none'
    }
    if ($method -ne 'task') {
      # 回退 HKCU Run 前，尽量清掉可能残留的旧计划任务，避免登录时双份守护进程
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
      New-Item -Path $RunKeyPath -Force | Out-Null
      Set-ItemProperty -Path $RunKeyPath -Name $TaskName -Value $runValue
      $method = 'runkey'
    }
    if ($method -eq 'task') {
      # 计划任务注册成功后清掉 HKCU Run 旧注册，避免任务与 Run 键双重启动
      Remove-ItemProperty -Path $RunKeyPath -Name $TaskName -ErrorAction SilentlyContinue
      Write-Output '已安装：Windows 计划任务（登录自启 + 崩溃重启）'
    } else {
      Write-Output '已安装：开机自启（HKCU Run，当前用户登录后自动运行；当前无管理员权限，未使用计划任务）'
    }
  }
  'start' {
    if ((Get-InstalledMethod) -eq 'task') {
      Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
    if (@(Get-SupervisorProcesses).Count -eq 0) { Start-SupervisorHidden }
    Start-Sleep -Seconds 2
    Write-Output ('已启动：守护进程 ' + @(Get-SupervisorProcesses).Count + ' 个，生成进程 ' + @(Get-AutogenProcesses).Count + ' 个')
  }
  'stop' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    $nodes = @(Get-AutogenProcesses)
    foreach ($p in $nodes) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    $sups = @(Get-SupervisorProcesses)
    foreach ($p in $sups) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Output ('已停止：清理生成进程 ' + $nodes.Count + ' 个、守护进程 ' + $sups.Count + ' 个')
  }
  'restart' {
    & $PSCommandPath -Action stop
    Start-Sleep -Seconds 2
    & $PSCommandPath -Action start
  }
  'status' {
    Write-Output ('自启方式: ' + (Get-InstalledMethod))
    Write-Output ('守护进程: ' + @(Get-SupervisorProcesses).Count + ' 个，生成进程: ' + @(Get-AutogenProcesses).Count + ' 个')
    $images = @(Get-ChildItem -LiteralPath (Join-Path $outDir 'images') -Filter *.png -ErrorAction SilentlyContinue)
    if ($images.Count -gt 0) {
      $sum = ($images | Measure-Object -Property Length -Sum).Sum
      $latest = $images | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      Write-Output ('已生成: ' + $images.Count + ' 张 / ' + [math]::Round($sum / 1GB, 2) + ' GB')
      Write-Output ('最新: ' + $latest.Name + '  ' + $latest.LastWriteTime.ToString('MM-dd HH:mm:ss'))
    } else {
      Write-Output '已生成: 0 张'
    }
    $logFile = Join-Path $outDir 'autogen.log'
    if (Test-Path -LiteralPath $logFile) {
      Write-Output '--- 最近日志 ---'
      Get-Content -LiteralPath $logFile -Tail 8 -Encoding UTF8
    }
  }
  'uninstall' {
    & $PSCommandPath -Action stop
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunKeyPath -Name $TaskName -ErrorAction SilentlyContinue
    Write-Output '已卸载自启与后台进程（输出目录保留）'
  }
}
