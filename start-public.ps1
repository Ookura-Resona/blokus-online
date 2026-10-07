<#
  角斗士棋 · 一键开公网房间

  做三件事：
    1. 确认游戏服务器在跑（没跑就起来）
    2. 起一条 Cloudflare 快速隧道，把本机 3000 暴露成 https 地址
    3. 把可以直接发群里的链接打出来

  用法（在本目录下）：
      powershell -ExecutionPolicy Bypass -File .\start-public.ps1

  关掉窗口 = 房间关闭。想换地址就重跑一次。
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root    = $PSScriptRoot
$Port    = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$TunDir  = Join-Path (Split-Path $Root -Parent) '.tunnel'
$CfExe   = Join-Path $TunDir 'cloudflared.exe'
$Mirror  = 'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '  角斗士棋 · 开一个公网房间' 'Cyan'
Say '  ────────────────────────────────────────────' 'DarkGray'

# ── 1. 检查 Node ────────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say '  ✗ 找不到 node。请先装 Node 18 或更高版本：https://nodejs.org/' 'Red'
  exit 1
}
Say "  ✓ Node: $((& node --version).Trim())"

# ── 2. 检查 / 下载 cloudflared ──────────────────────────────────
if (-not (Test-Path $CfExe)) {
  $found = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($found) {
    $CfExe = $found.Source
    Say "  ✓ 使用已安装的 cloudflared: $CfExe"
  } else {
    Say '  · 第一次运行，需要下载 cloudflared（约 53 MB，单文件、免安装）'
    New-Item -ItemType Directory -Force -Path $TunDir | Out-Null
    Say "    来源: $Mirror"
    try {
      & curl.exe -L --max-time 300 -o $CfExe $Mirror
    } catch {
      Say "  ✗ 下载失败：$($_.Exception.Message)" 'Red'
      Say '    可以手动下载后放到：' 'Yellow'
      Say "    $CfExe" 'Yellow'
      exit 1
    }
    if (-not (Test-Path $CfExe) -or (Get-Item $CfExe).Length -lt 1MB) {
      Say '  ✗ 下载的文件不完整' 'Red'
      exit 1
    }
    Say "  ✓ 已下载 $( [math]::Round((Get-Item $CfExe).Length/1MB,1) ) MB"
  }
} else {
  Say "  ✓ cloudflared: $((& $CfExe --version 2>&1 | Select-Object -First 1))"
}

# ── 3. 让游戏服务器跑起来 ───────────────────────────────────────
$alive = $false
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3 -UseBasicParsing
  $alive = $r.StatusCode -eq 200
} catch { $alive = $false }

if ($alive) {
  Say "  ✓ 游戏服务器已在 127.0.0.1:$Port 运行，直接复用"
} else {
  Say "  · 启动游戏服务器（会开一个最小化的窗口）…"
  $env:PORT = "$Port"
  Start-Process -FilePath $node.Source -ArgumentList 'server/index.js' `
    -WorkingDirectory $Root -WindowStyle Minimized
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $alive = $true; break }
    } catch { }
  }
  if ($alive) { Say "  ✓ 游戏服务器已就绪" }
  else { Say '  ✗ 服务器 10 秒内没起来，请手动运行 npm start 看看报错' 'Red'; exit 1 }
}

# ── 4. 起隧道，把公网地址抓出来 ─────────────────────────────────
Say '  · 正在向 Cloudflare 申请公网地址…'
$log = Join-Path $env:TEMP "blokus-tunnel-$PID.log"
if (Test-Path $log) { Remove-Item $log -Force }

$proc = Start-Process -FilePath $CfExe `
  -ArgumentList "tunnel --url http://localhost:$Port --no-autoupdate --protocol http2" `
  -RedirectStandardError $log -RedirectStandardOutput "$log.out" `
  -WindowStyle Hidden -PassThru

$url = $null
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
  if ($proc.HasExited) { break }
}

if (-not $url) {
  Say '  ✗ 没能拿到公网地址。cloudflared 的日志最后几行：' 'Red'
  if (Test-Path $log) { Get-Content $log -Tail 12 | ForEach-Object { Say "    $_" 'DarkGray' } }
  exit 1
}

# ── 5. 自检（别把坏链接发给别人）──────────────────────────────────
# 新建的快速隧道 DNS 要几秒到几十秒才生效，刚拿到地址立刻访问会 ENOTFOUND，
# 所以这里必须重试，不能一次失败就判定不可用。
$checkOk = $false
$checkOut = $null
for ($try = 1; $try -le 15; $try++) {
  Say "  · 自检中（第 $try 次：HTTPS / WebSocket / 联机流程）…"
  $checkOut = & node (Join-Path $Root 'tools/check-deploy.js') $url 2>&1
  if ($LASTEXITCODE -eq 0) { $checkOk = $true; break }

  # 只有「DNS 还没生效」才值得重试；别的问题重试也是白等
  $dnsPending = ($checkOut -join "`n") -match 'ENOTFOUND|EAI_AGAIN|ENOTFOUND|超时'
  if (-not $dnsPending) { break }

  Say '    DNS 还没生效，等 6 秒再试…' 'DarkGray'
  Start-Sleep -Seconds 6
}

if ($checkOk) {
  Say '  ✓ 自检通过（HTTPS + WebSocket + 联机流程）' 'Green'
} else {
  Say '  ! 自检没全过，先别急着发。详细输出：' 'Yellow'
  $checkOut | Select-Object -Last 20 | ForEach-Object { Say "    $_" 'DarkGray' }
  Say "    也可以自己再跑一次：node tools/check-deploy.js $url" 'Yellow'
}

# ── 6. 收尾 ────────────────────────────────────────────────────
Say ''
Say '  ════════════════════════════════════════════' 'Green'
Say '   房间已开好，把下面这个链接发到群里：' 'Green'
Say ''
Say "   $url" 'White'
Say ''
Say '   别人点开 → 填个昵称 → 建房或输房号 → 开打' 'Gray'
Say '  ════════════════════════════════════════════' 'Green'
Say ''
Say '   注意：' 'DarkYellow'
Say '   · 这个地址是临时的，关掉本窗口就失效，重开会换新地址' 'DarkYellow'
Say '   · 没有密码，拿到链接的人都能进，别往公开地方贴' 'DarkYellow'
Say '   · 你的电脑要一直开着，游戏才在' 'DarkYellow'
Say ''
Say '   按 Ctrl+C 关闭房间' 'DarkGray'
Say ''

try {
  Wait-Process -Id $proc.Id
} finally {
  Say ''
  Say '  隧道已关闭。' 'DarkGray'
}
