# Octopus CLI installer (Windows / PowerShell).
#
# Usage:
#   irm https://raw.githubusercontent.com/octopusreview/octopus/master/apps/cli/install/install.ps1 | iex
#
# What it does:
#   1. Detects your CPU architecture
#   2. Fetches the latest `octp-v*` release from GitHub
#   3. Downloads the matching native .exe
#   4. Installs it to $env:USERPROFILE\.octopus\bin\octp.exe (or $env:OCTOPUS_INSTALL_DIR)
#   5. Adds the install directory to your user PATH (idempotent)
#
# After install, run `octp` to launch the first-run onboarding wizard.
#
# Environment variables:
#   $env:OCTOPUS_INSTALL_DIR   Override install directory
#   $env:OCTOPUS_INSTALL_REPO  Override the GitHub repo (default: octopusreview/octopus)
#   $env:OCTOPUS_INSTALL_TAG   Install a specific tag instead of latest

$ErrorActionPreference = "Stop"

$Repo        = if ($env:OCTOPUS_INSTALL_REPO) { $env:OCTOPUS_INSTALL_REPO } else { "octopusreview/octopus" }
$InstallDir  = if ($env:OCTOPUS_INSTALL_DIR)  { $env:OCTOPUS_INSTALL_DIR }  else { Join-Path $env:USERPROFILE ".octopus\bin" }
$BinaryName  = "octp.exe"

# ── Step 1: arch ─────────────────────────────────────────────────────────────

# We only ship x64 today. ARM64 Windows can fall back to x64 emulation; if a
# native ARM64 build is added later, expand this map.
$arch = "x64"
$asset = "octp-windows-${arch}.exe"

# ── Step 2: resolve release tag ──────────────────────────────────────────────

if ($env:OCTOPUS_INSTALL_TAG) {
  $tag = $env:OCTOPUS_INSTALL_TAG
  Write-Host "Installing pinned version: $tag"
} else {
  Write-Host "Looking up latest octp release on $Repo ..."
  # The repo publishes two release trains (web v* and CLI octp-v*) into
  # the same feed. A busy web train can push every octp-v* tag off the
  # first page, so walk pages until we find an octp-v* match.
  $tag = $null
  for ($page = 1; $page -le 5 -and -not $tag; $page++) {
    $url = "https://api.github.com/repos/$Repo/releases?per_page=100&page=$page"
    try {
      $releases = Invoke-RestMethod -Uri $url -Headers @{ "User-Agent" = "octp-installer" }
    } catch {
      break
    }
    if (-not $releases -or $releases.Count -eq 0) { break }
    $candidate = ($releases | Where-Object { $_.tag_name -like "octp-v*" } | Select-Object -First 1)
    if ($candidate) { $tag = $candidate.tag_name }
  }
  if (-not $tag) {
    Write-Error "Could not find any octp-v* release on $Repo. Pin a tag with `$env:OCTOPUS_INSTALL_TAG = 'octp-v0.X.Y'`."
    exit 1
  }
  Write-Host "Latest release: $tag"
}

# ── Step 3: download to a temp file (verified before swapping into place) ────

$downloadUrl = "https://github.com/$Repo/releases/download/$tag/$asset"
Write-Host "Downloading $downloadUrl ..."

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir $BinaryName
# Downloading directly to $target meant a failed upgrade destroyed the
# working install. Stage to a temp file, verify, then swap.
$tmpFile = [System.IO.Path]::GetTempFileName()

try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing
} catch {
  Remove-Item -Path $tmpFile -ErrorAction SilentlyContinue
  Write-Error "Failed to download $asset from $tag. The release might not have a Windows binary."
  exit 1
}

# ── Step 3b: verify SHA256 ───────────────────────────────────────────────────
$sumsUrl = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS.txt"
try {
  $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
  # SHA256SUMS.txt lines look like "<sha>  ./octp-windows-x64.exe" or
  # "<sha>  octp-windows-x64.exe". Match either.
  $expectedLine = ($sums -split "`r?`n") | Where-Object { $_ -match "\s+(\./)?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $expectedLine) {
    Remove-Item -Path $tmpFile -ErrorAction SilentlyContinue
    Write-Error "SHA256SUMS.txt at $sumsUrl has no entry for $asset. Refusing to install."
    exit 1
  }
  $expected = ($expectedLine -split "\s+")[0]
  $got = (Get-FileHash -Algorithm SHA256 -Path $tmpFile).Hash.ToLower()
  if ($got -ne $expected.ToLower()) {
    Remove-Item -Path $tmpFile -ErrorAction SilentlyContinue
    Write-Error "Checksum mismatch for $asset: expected $expected, got $got. Refusing to install."
    exit 1
  }
} catch {
  Write-Warning "Could not fetch $sumsUrl — proceeding without checksum verification."
}

Move-Item -Path $tmpFile -Destination $target -Force

Write-Host ""
Write-Host "Installed octp → $target"

# ── Step 4: PATH ─────────────────────────────────────────────────────────────

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$pathEntries = $userPath -split ";" | Where-Object { $_ -ne "" }
if ($pathEntries -notcontains $InstallDir) {
  $newPath = ($pathEntries + $InstallDir) -join ";"
  [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
  Write-Host "Added $InstallDir to your user PATH."
  Write-Host ""
  Write-Host "Open a new PowerShell window, then run: octp"
} else {
  Write-Host "$InstallDir is already on your PATH."
  Write-Host ""
  Write-Host "Get started: octp"
}
