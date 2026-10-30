# DSH RC one-command setup for Windows (PowerShell 5.1 or 7).
#
#   $env:DSHRC_MODE='host'; $env:DSHRC_TAG='<tag>'; irm .../install.ps1 | iex     (the FIRST computer: runs the edge)
#   $env:DSHRC_EDGE='<edge-url>'; $env:DSHRC_TAG='<tag>'; irm https://raw.githubusercontent.com/yeerock/deepseek-harness-remote-control/<tag>/scripts/install.ps1 | iex
#
# Idempotent: safe to run again after any failure. It
#   1. finds Node 24+, or downloads the official Node 24 zip into ~\.dsh-rc\node
#      (checksum verified against nodejs.org SHASUMS256.txt);
#   2. finds git (installs it with winget when missing) and clones or updates
#      ~\dsh-rc; without git it falls back to the release zip;
#   3. runs scripts\join-edge.mjs: build, install into DeepSeek Harness, connect
#      to the edge (auto-approved) and restart DeepSeek Harness.
# The Node download is checked against nodejs.org's SHASUMS256.txt over HTTPS
# (integrity, not a signature check).
# No password, token or secret is used or stored by this script.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$RepoUrl = 'https://github.com/yeerock/deepseek-harness-remote-control'
$RepoApi = 'https://api.github.com/repos/yeerock/deepseek-harness-remote-control'
$Edge = if ($args.Count -gt 0) { $args[0] } else { $env:DSHRC_EDGE }
# DSHRC_MODE=host sets up THIS computer as the host (the edge everyone joins) instead of joining one.
$Mode = if ($env:DSHRC_MODE -eq 'host' -or $Edge -eq 'host') { 'host' } else { 'join' }
if ($Mode -eq 'host') { $Edge = 'http://127.0.0.1:8787' }
$Dest = if ($env:DSHRC_HOME) { $env:DSHRC_HOME } else { Join-Path $HOME 'dsh-rc' }
$State = Join-Path $HOME '.dsh-rc'
$Tag = if ($env:DSHRC_TAG) { $env:DSHRC_TAG } else { '' }

function Say($m) { Write-Host "[dsh-rc setup] $m" }
function Die($m) { Write-Host "[dsh-rc setup] FAILED: $m"; throw $m }

if ($Edge -notmatch '^https?://') { Die "set `$env:DSHRC_EDGE to the edge URL from the setup prompt" }
if ($Tag -and $Tag -notmatch '^v\d+\.\d+\.\d+$') { Die "not a release tag: $Tag" }
New-Item -ItemType Directory -Force -Path $State | Out-Null
# Temporary files live beside the install, so moves never cross drives.
function New-Temp { $t = Join-Path $State ('tmp-' + [Guid]::NewGuid()); New-Item -ItemType Directory -Path $t | Out-Null; return $t }

function Test-Node($exe) {
  if (-not $exe -or -not (Test-Path $exe)) { return $false }
  try { $v = & $exe -p 'process.versions.node' 2>$null; return ([int]($v.Split('.')[0]) -ge 24) } catch { return $false }
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
}

# 1. Node 24+
$Node = $null
$onPath = (Get-Command node -ErrorAction SilentlyContinue).Source
foreach ($c in @($env:DSHRC_NODE, $onPath, (Join-Path $State 'node\node.exe'))) { if (Test-Node $c) { $Node = $c; break } }
if (-not $Node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v24.x'
  Say "downloading Node 24 (win-$arch)"
  $tmp = New-Temp
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "node-v24[0-9.]*-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Die "no Node 24 build listed for win-$arch" }
  $want, $file = ($line.Trim() -split '\s+')
  $zip = Join-Path $tmp $file
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()) { Die 'Node download checksum mismatch' }
  Expand-Archive $zip -DestinationPath $tmp -Force
  $nodeDir = Join-Path $State 'node'
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $nodeDir
  Remove-Item $tmp -Recurse -Force
  $Node = Join-Path $nodeDir 'node.exe'
  if (-not (Test-Node $Node)) { Die 'downloaded Node does not run' }
}
$env:Path = (Split-Path $Node) + ';' + $env:Path
Say "node $(& $Node -v) at $Node"

# 2. Source (git preferred: automatic updates need it)
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  Say 'installing git with winget (current user, no admin prompt)'
  try {
    $w = Start-Process winget -ArgumentList @('install', '--id', 'Git.Git', '-e', '--silent', '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements') -PassThru -WindowStyle Hidden
    if (-not $w.WaitForExit(300000)) { $w.Kill(); Say 'winget took too long; using the release download instead' }
  } catch { Say "winget could not run ($($_.Exception.Message)); using the release download instead" }
  Refresh-Path
  $git = (Get-Command git -ErrorAction SilentlyContinue).Source
}
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
if ($git) {
  if (Test-Path (Join-Path $Dest '.git')) {
    Say "updating $Dest"
    & git -C $Dest fetch --tags --force --quiet origin
    if ($LASTEXITCODE -ne 0) { Die 'git fetch failed (network?)' }
  } else {
    if (Test-Path $Dest) { Move-Item $Dest "$Dest.bak-$stamp" }
    Say "cloning into $Dest"
    & git clone --quiet $RepoUrl $Dest
    if ($LASTEXITCODE -ne 0) { Die 'git clone failed (network?)' }
  }
  # Switch to the release first, so its own (current) installer runs below.
  if (-not $Tag) { $Tag = (& git -C $Dest tag --list 'v*' --sort=-v:refname | Select-Object -First 1) }
  if (-not $Tag) { Die 'no release tag found' }
  if (& git -C $Dest status --porcelain) {
    Say "local changes in $Dest set aside with git stash"
    & git -C $Dest stash push --include-untracked --quiet -m "dsh-rc setup $stamp"
    if ($LASTEXITCODE -ne 0) { Die "could not set aside local changes in $Dest" }
  }
  & git -C $Dest checkout --quiet -f "refs/tags/$Tag"
  if ($LASTEXITCODE -ne 0) { Die "release $Tag not found" }
} elseif ((Test-Path (Join-Path $Dest 'scripts\join-edge.mjs')) -and -not $Tag) {
  Say "git not available; reusing the copy in $Dest"
} else {
  $tag = if ($Tag) { $Tag } else { (Invoke-RestMethod -UseBasicParsing "$RepoApi/releases/latest").tag_name }
  if ($tag -notmatch '^v\d+\.\d+\.\d+$') { Die 'could not read the latest release' }
  Say "git not available; downloading $tag (install git later for automatic updates)"
  $tmp = New-Temp
  Invoke-WebRequest -UseBasicParsing "$RepoUrl/archive/refs/tags/$tag.zip" -OutFile (Join-Path $tmp 'src.zip')
  Expand-Archive (Join-Path $tmp 'src.zip') -DestinationPath (Join-Path $tmp 'src') -Force
  if (Test-Path $Dest) { Move-Item $Dest "$Dest.bak-$stamp" }
  Move-Item (Get-ChildItem (Join-Path $tmp 'src') -Directory | Select-Object -First 1).FullName $Dest
  Remove-Item $tmp -Recurse -Force
}

# 3. Build, install, connect, restart
if ($Mode -eq 'host') {
  $hostArgs = @((Join-Path $Dest 'scripts\host-setup.mjs'))
  if ($Tag) { $hostArgs += @('--tag', $Tag) }
  & $Node @hostArgs
  if ($LASTEXITCODE -ne 0) { Die 'host setup stopped (see above); fix the cause and run this command again' }
  Say 'DONE: this computer is the host. Other computers join with the prompt from Remote Control, Build Setup Prompt.'
  return
}
$joinArgs = @((Join-Path $Dest 'scripts\join-edge.mjs'), $Edge)
if ($Tag) { $joinArgs += @('--tag', $Tag) }
& $Node @joinArgs
if ($LASTEXITCODE -ne 0) { Die 'install step failed (see above); fix the cause and run this command again' }
Say "DONE: DeepSeek Harness restarts now and connects to $Edge by itself."
