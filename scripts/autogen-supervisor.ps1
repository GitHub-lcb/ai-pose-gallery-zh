# AI 角色自动生成：守护进程（随 Windows 登录自启，崩溃自动重启）
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root '.auto-gen'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log = Join-Path $outDir 'supervisor.log'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = $null
if ($nodeCmd) { $node = $nodeCmd.Source }
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $fallback = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $fallback) { $node = $fallback }
}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [supervisor] 找不到 node.exe，退出"
  exit 1
}

$script = Join-Path $PSScriptRoot 'autogen.mjs'
Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [supervisor] 启动 node=$node" -Encoding UTF8
while ($true) {
  & $node $script
  $code = $LASTEXITCODE
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [supervisor] autogen 退出 code=$code，20 秒后重启" -Encoding UTF8
  Start-Sleep -Seconds 20
}
