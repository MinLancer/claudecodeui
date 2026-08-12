# =============================================================
#  WeCom CLI Gateway one-click launcher (Windows PowerShell)
#  Starts: claudecodeui server (3001) + gateway (3002)
#  Usage : double-click start.bat, or run start.ps1 in PowerShell
# =============================================================
$ErrorActionPreference = "Continue"

# ---- Config (edit as needed; env vars take precedence) ----
$GatewayDir = Split-Path -Parent $MyInvocation.MyCommand.Path   # gateway dir = script dir
$CcuiDir    = Split-Path -Parent $GatewayDir                   # claudecodeui root = parent of gateway
$CcuiPort   = if ($env:CCUI_PORT) { [int]$env:CCUI_PORT } else { 3001 }
$GatewayPort = if ($env:GATEWAY_PORT) { [int]$env:GATEWAY_PORT } else { 3002 }
$LogDir     = Join-Path $GatewayDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "=============================================="
Write-Host " WeCom CLI Gateway launcher"
Write-Host " claudecodeui : $CcuiDir  -> :$CcuiPort"
Write-Host " gateway      : $GatewayDir  -> :$GatewayPort"
Write-Host " logs        : $LogDir"
Write-Host "=============================================="

# ---- Redis resolution: REDIS_URL env > config.yaml redis.url > default ----
function Get-RedisUrl {
  if ($env:REDIS_URL) { return $env:REDIS_URL }
  $cfg = Join-Path $GatewayDir "config.yaml"
  if (Test-Path $cfg) {
    $inRedis = $false
    foreach ($line in (Get-Content $cfg)) {
      if ($line -match '^redis:') { $inRedis = $true; continue }
      if ($inRedis -and $line -match '^\s+url:\s*(.+?)\s*$') {
        return $Matches[1].Trim('"').Trim("'")
      }
      if ($inRedis -and $line -match '^\S') { $inRedis = $false }
    }
  }
  return "redis://localhost:6379"
}
function Get-RedisHostPort([string]$url) {
  # Emit two values on the pipeline so `$rh, $rp = Get-RedisHostPort $url` destructures correctly
  $m = [regex]::Match($url, 'redis://([^:/@]+)(?::([0-9]+))?')
  if ($m.Success) {
    Write-Output $m.Groups[1].Value
    Write-Output ($(if ($m.Groups[2].Value) { $m.Groups[2].Value } else { '6379' }))
  } else {
    Write-Output '127.0.0.1'
    Write-Output '6379'
  }
}

function Test-Port([string]$hostname, [int]$port) {
  $client = New-Object Net.Sockets.TcpClient
  try { $client.Connect($hostname, $port); return $true }
  catch { return $false }
  finally { $client.Close() }
}

# 1. Check Redis (configurable, not assumed local)
$redisUrl = Get-RedisUrl
$rh, $rp = Get-RedisHostPort $redisUrl
# localhost may resolve to IPv6 (::1) and .NET Connect may miss the IPv4 listener; probe 127.0.0.1
$probeHost = if ($rh -eq "localhost") { "127.0.0.1" } else { $rh }
if (Test-Port $probeHost ([int]$rp)) {
  Write-Host "[1/3] Redis reachable ($redisUrl)"
} else {
  Write-Host "[1/3] WARNING: Redis not reachable at $redisUrl"
  Write-Host "      Gateway needs Redis to store sessions/stream state. Start Redis, set"
  Write-Host "      REDIS_URL, or point redis.url in config.yaml to a reachable server."
}

# 2. Start claudecodeui server
if (Test-Port "127.0.0.1" $CcuiPort) {
  Write-Host "[2/3] Port $CcuiPort already in use, skip (assume running)"
} else {
  Write-Host "[2/3] Starting claudecodeui server (:$CcuiPort) ..."
  $ccuiLog = Join-Path $LogDir "ccui.log"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","cd /d `"$CcuiDir`" && npm run server:dev > `"$ccuiLog`" 2>&1" -WindowStyle Minimized
  Write-Host "      -> log: $ccuiLog"
}

# 3. Start gateway
if (Test-Port "127.0.0.1" $GatewayPort) {
  Write-Host "[3/3] Port $GatewayPort already in use, skip (assume running)"
} else {
  Write-Host "[3/3] Starting gateway (:$GatewayPort) ..."
  $gwLog = Join-Path $LogDir "gateway.log"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c","cd /d `"$GatewayDir`" && npx tsx src/index.ts > `"$gwLog`" 2>&1" -WindowStyle Minimized
  Write-Host "      -> log: $gwLog"
}

Write-Host ""
Write-Host "Done. View logs:"
Write-Host "  claudecodeui: Get-Content '$LogDir\ccui.log' -Wait"
Write-Host "  gateway     : Get-Content '$LogDir\gateway.log' -Wait"
Write-Host "Stop: run stop.bat, or taskkill /F /FI \"IMAGENAME eq node.exe\""
