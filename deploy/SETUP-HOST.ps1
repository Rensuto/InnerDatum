<#
.SYNOPSIS
  One-time provisioning for an Inner Datum game host.

.DESCRIPTION
  Run this ON THE HOST, in an Administrator PowerShell, from the repo root.

  It is idempotent: safe to re-run after every deploy. Each step checks whether
  it is already done and skips rather than repeating.

  It does NOT open the router port and it does NOT touch the Discord portal —
  those are the two things only a human can do.

.EXAMPLE
  cd <repo root>        # wherever you cloned it
  .\deploy\SETUP-HOST.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    ok   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    warn $msg" -ForegroundColor Yellow }

$admin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in an Administrator PowerShell.' }

# ---------------------------------------------------------------------------
Step 1 'Toolchain'
# ---------------------------------------------------------------------------
# Node 24.12+ is REQUIRED, not preferred: the server runs TypeScript directly
# via native type stripping and there is no build step for server code. An
# older Node does not merely warn — it cannot load src/server/main.ts at all.
#
# typescript is pinned to 5.9.x and @types/node to 24.x in package.json. Do not
# "upgrade" them: typescript-eslint declares `typescript <6.1.0`, and a
# @types/node major above the runtime describes APIs this Node does not have.
if (-not $SkipInstall) {
  $needNode = $true
  try {
    $v = (node --version) -replace '^v', ''
    $major = [int]($v -split '\.')[0]
    $minor = [int]($v -split '\.')[1]
    if ($major -gt 24 -or ($major -eq 24 -and $minor -ge 12)) { $needNode = $false; Ok "node $v" }
    else { Warn "node $v is too old (need >= 24.12)" }
  } catch { Warn 'node not found' }

  if ($needNode) {
    Write-Host '    installing Node 24 LTS...'
    winget install --id OpenJS.NodeJS.LTS --exact --source winget `
      --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')
    Ok "node $(node --version)"
  }

  try { caddy version | Out-Null; Ok "caddy $((caddy version) -split ' ' | Select-Object -First 1)" }
  catch {
    Write-Host '    installing Caddy...'
    winget install --id CaddyServer.Caddy --exact --source winget `
      --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')
    Ok 'caddy installed'
  }
}

# ---------------------------------------------------------------------------
Step 2 'Secrets'
# ---------------------------------------------------------------------------
if (Test-Path .env) {
  Ok '.env present'
} else {
  Copy-Item .env.example .env
  Warn '.env created from .env.example — FILL IT IN before starting the server:'
  Write-Host '           DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, SESSION_SECRET'
  Write-Host '           SESSION_SECRET:  node -e "console.log(require(''node:crypto'').randomBytes(32).toString(''base64url''))"'
}

# ---------------------------------------------------------------------------
Step 3 'Dependencies'
# ---------------------------------------------------------------------------
# `npm ci`, never `npm install`: ci installs exactly the committed lockfile and
# fails on drift, which is the property you want on the machine that faces the
# internet. install would silently resolve something new.
#
# NPM_CONFIG_MIN_RELEASE_AGE=0 only silences a no-op warning; .npmrc's 7-day
# quarantine is a RESOLUTION control and ci does not resolve.
$env:NPM_CONFIG_MIN_RELEASE_AGE = '0'
npm ci --no-audit --no-fund
Ok 'node_modules installed from lockfile'

# ---------------------------------------------------------------------------
Step 4 'Build the client'
# ---------------------------------------------------------------------------
npm run build:client
if (-not (Test-Path 'client\dist\index.html')) { throw 'client build produced no index.html' }
Ok 'client/dist built'

# ---------------------------------------------------------------------------
Step 5 'Verify before exposing anything'
# ---------------------------------------------------------------------------
npm run check:secrets
Ok 'no secret reaches the browser bundle'

npm run smoke
Ok 'server boots and /healthz answers'

# ---------------------------------------------------------------------------
Step 6 'Firewall'
# ---------------------------------------------------------------------------
# Scoped to the Caddy BINARY rather than opening the port globally, and there is
# deliberately NO rule for 3000: the game binds 127.0.0.1 and must only ever be
# reachable through Caddy. There is likewise no rule for 3001 — the ops panel is
# loopback-only, and this repo is public so its routes are known.
$caddyExe = (Get-Command caddy -ErrorAction SilentlyContinue).Source
if ($caddyExe) {
  if (-not (Get-NetFirewallRule -DisplayName 'Inner Datum Caddy HTTPS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Inner Datum Caddy HTTPS' -Direction Inbound `
      -Protocol TCP -LocalPort 443 -Action Allow -Program $caddyExe -Profile Any | Out-Null
    Ok 'inbound TCP 443 allowed for caddy.exe only'
  } else { Ok 'firewall rule already present' }
} else { Warn 'caddy not on PATH — open a new shell and re-run' }

# ---------------------------------------------------------------------------
Step 7 'Do not sleep'
# ---------------------------------------------------------------------------
# A sleeping host presents to a friend as a blank iframe with no error, which
# reads as "the game is broken" rather than "the PC is asleep".
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Ok 'sleep and hibernate disabled on AC power'

# ---------------------------------------------------------------------------
Write-Host "`n=== provisioned ===" -ForegroundColor Green
Write-Host @'

WHAT ONLY YOU CAN DO NOW:

  1. ROUTER — forward TCP 443 to this machine's LAN address.
     Give it a DHCP reservation too; a lease change silently breaks the forward
     weeks later, and that failure looks like a game bug.

  2. CADDY — start it and WATCH THE LOG:
       caddy run --config deploy\Caddyfile
     Success prints `certificate obtained successfully`.
     THIS IS ALSO THE INBOUND-443 TEST. If your ISP filters 443, it fails here,
     loudly, at setup — not silently on a Friday night.

  3. VERIFY FROM OUTSIDE — phone, wifi OFF, on cellular:
       https://<your-host>/healthz
     Testing from inside the LAN proves nothing: most consumer routers lack NAT
     hairpinning, so it can fail when the service is fine, or succeed via a
     local shortcut the outside world never takes.

  4. DISCORD PORTAL — Activities -> URL Mappings:
       prefix  /
       target  <your-host>
     No protocol, no path, no trailing slash.

  5. START THE GAME (a second terminal):
       npm start

'@
