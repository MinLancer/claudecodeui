# =============================================================
#  WeCom CLI Gateway stopper (Windows PowerShell)
#  Stops: gateway (tsx src/index.ts) + claudecodeui server
#  Only kills node processes whose command line matches our services,
#  so unrelated node processes are NOT touched.
# =============================================================
$ErrorActionPreference = "Continue"

# gateway runs via tsx loader: "...src/index.ts"; ccui server via "server/index.ts"
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'src/index\.ts' -or $_.CommandLine -match 'server/index\.ts'
}

if (-not $targets) {
  Write-Host "No gateway / claudecodeui server processes found."
  exit 0
}

foreach ($p in $targets) {
  Write-Host ("Stopping PID {0}: {1}" -f $p.ProcessId, $p.CommandLine)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Done."
