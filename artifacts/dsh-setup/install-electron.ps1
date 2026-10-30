# Install the Electron runtime binary for the dsh-builtin-browser plugin.
#
# Electron 44+ ships without downloading its ~158 MB runtime at package-install
# time, and the plugin's probe is pure filesystem: it never triggers the lazy
# download. This script does what `install.js` would do, but downloads with
# .NET's HTTP stack (the undici fetch in @electron/get aborted mid-stream here)
# and verifies the artifact against the package's own checksums.json.
#
# Writes exactly the three things install.js's isInstalled() checks:
#   dist/version  == "45.1.0"
#   path.txt      == "electron.exe"
#   dist/electron.exe

$ErrorActionPreference = 'Stop'

$electronDir = 'C:\Users\63088\.dsh\profiles\desktop\node_modules\electron'
$version     = '45.1.0'
$artifact    = "electron-v$version-win32-x64.zip"
$expectSha   = '55eaba17abff7b5bba6c3bbc85068967379024fe742fe9c7fdba9118922ccbe2'
$zip         = Join-Path $env:TEMP $artifact
$dist        = Join-Path $electronDir 'dist'

$mirrors = @(
  "https://npmmirror.com/mirrors/electron/$version/$artifact"
  "https://registry.npmmirror.com/-/binary/electron/$version/$artifact"
  "https://github.com/electron/electron/releases/download/v$version/$artifact"
)

function Test-Zip {
  param([string]$Path, [string]$Expect)
  if (-not (Test-Path $Path)) { return $false }
  $len = (Get-Item $Path).Length
  if ($len -lt 100MB) { Write-Output "  size $([math]::Round($len/1MB,1)) MB - too small, discarding"; return $false }
  Write-Output "  hashing $([math]::Round($len/1MB,1)) MB ..."
  $sha = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower()
  if ($sha -ne $Expect) {
    Write-Output "  sha256 MISMATCH ($sha) - discarding"
    return $false
  }
  Write-Output "  sha256 OK ($sha)"
  return $true
}

Write-Output "== step 1: artifact =="
if (Test-Zip -Path $zip -Expect $expectSha) {
  Write-Output "cached download already valid, skipping fetch"
} else {
  $ok = $false
  foreach ($url in $mirrors) {
    if ($ok) { break }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
      Write-Output "  GET $url"
      if (Test-Path $zip) { Remove-Item $zip -Force }
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 900 -UseBasicParsing
      Write-Output "  downloaded in $([int]$sw.Elapsed.TotalSeconds)s"
      $ok = Test-Zip -Path $zip -Expect $expectSha
    } catch {
      Write-Output "  FAILED after $([int]$sw.Elapsed.TotalSeconds)s: $($_.Exception.Message)"
    }
  }
  if (-not $ok) { throw 'could not obtain a checksum-valid Electron artifact from any mirror' }
}

Write-Output "== step 2: extract -> dist =="
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Expand-Archive -Path $zip -DestinationPath $dist -Force
Write-Output "  extracted $((Get-ChildItem $dist -Recurse -File).Count) files"

Write-Output "== step 3: hoist electron.d.ts (install.js does this) =="
$inDist = Join-Path $dist 'electron.d.ts'
if (Test-Path $inDist) {
  Move-Item -Path $inDist -Destination (Join-Path $electronDir 'electron.d.ts') -Force
  Write-Output '  moved electron.d.ts out of dist'
} else {
  Write-Output '  zip had no electron.d.ts in dist (fine)'
}

Write-Output "== step 4: path.txt =="
Set-Content -Path (Join-Path $electronDir 'path.txt') -Value 'electron.exe' -NoNewline -Encoding ascii
Write-Output '  wrote path.txt = electron.exe'

Write-Output "== step 5: verify against install.js isInstalled() =="
$vPath   = Join-Path $dist 'version'
$ePath   = Join-Path $dist 'electron.exe'
$pPath   = Join-Path $electronDir 'path.txt'
$vOk = (Test-Path $vPath) -and ((Get-Content $vPath -Raw).Trim() -replace '^v','') -eq $version
$pOk = (Test-Path $pPath) -and ((Get-Content $pPath -Raw).Trim() -eq 'electron.exe')
$eOk = Test-Path $ePath
Write-Output "  dist/version   : $(if($vOk){'OK (' + (Get-Content $vPath -Raw).Trim() + ')'}else{'FAIL'})"
Write-Output "  path.txt       : $(if($pOk){'OK (electron.exe)'}else{'FAIL'})"
Write-Output "  dist/electron.exe : $(if($eOk){'OK (' + [math]::Round((Get-Item $ePath).Length/1MB,1) + ' MB)'}else{'FAIL'})"
if (-not ($vOk -and $pOk -and $eOk)) { throw 'verification failed' }
Write-Output 'ALL CHECKS PASSED'
