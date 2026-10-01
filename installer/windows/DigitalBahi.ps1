# Digital Bahi on Windows: gets what the launcher needs when this computer
# does not have it, then runs launcher.mjs (start, stop, restart, status).
#
#  - Node.js 22 or newer: the one already installed, else Node.js 22 downloaded
#    once from nodejs.org (checked against its SHA-256) into the data folder.
#  - The Microsoft Visual C++ runtime, which PostgreSQL for Windows needs:
#    installed from Microsoft (aka.ms) after a Windows permission prompt, only
#    if it is missing.
#
# Written for Windows PowerShell 5.1 (Windows 10 and 11), run by DigitalBahi.cmd:
#   powershell -NoProfile -ExecutionPolicy Bypass -File launcher\DigitalBahi.ps1 start
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$LauncherArgs)

$ErrorActionPreference = 'Stop'
# The progress bar slows downloads down many times in Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$NodeVersion = '22.23.3'
$NodeSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'

if (-not $LauncherArgs -or $LauncherArgs.Count -eq 0) { $LauncherArgs = @('start') }
$Command = $LauncherArgs[0]

if ($env:DIGITALBAHI_HOME) { $DataHome = $env:DIGITALBAHI_HOME } else { $DataHome = Join-Path $env:LOCALAPPDATA 'DigitalBahi' }
# The launcher uses the same folder.
$env:DIGITALBAHI_HOME = $DataHome
$Runtime = Join-Path $DataHome 'runtime'

function Write-Step($Message) { Write-Host "  $Message" }

function Test-Node($Exe) {
  try {
    $major = & $Exe -p "process.versions.node.split('.')[0]" 2>$null
    return ([int]$major -ge 22)
  } catch {
    return $false
  }
}

function Expand-Zip($Zip, $Into) {
  # Windows 10 and 11 have tar.exe, many times faster than Expand-Archive for Node.js's thousands of files.
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    & $tar -xf $Zip -C $Into
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Zip" }
  } else {
    Expand-Archive -Path $Zip -DestinationPath $Into -Force
  }
}

function Get-Node {
  $local = Join-Path $Runtime "node-v$NodeVersion-win-x64\node.exe"
  if (Test-Path $local) { return $local }
  $installed = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($installed -and (Test-Node $installed.Source)) { return $installed.Source }
  if ($Command -ne 'start' -and $Command -ne 'restart') { return $null }

  if ([Environment]::Is64BitOperatingSystem -eq $false) { throw 'Digital Bahi needs 64-bit Windows.' }
  Write-Step "Downloading Node.js $NodeVersion (about 30 MB, only this once)..."
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  $zip = Join-Path $Runtime "node-v$NodeVersion-win-x64.zip"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
  } catch {
    throw "Could not download Node.js ($($_.Exception.Message)). Check the internet connection, then start Digital Bahi again."
  }
  $hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($hash -ne $NodeSha256) {
    Remove-Item $zip -Force
    throw 'The Node.js download is damaged (its checksum does not match). Start Digital Bahi again to download it again.'
  }
  Expand-Zip $zip $Runtime
  Remove-Item $zip -Force
  if (-not (Test-Path $local)) { throw "Node.js was not unpacked to $local" }
  return $local
}

function Test-VCRuntime {
  foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') {
    if (-not (Test-Path (Join-Path $env:SystemRoot "System32\$dll"))) { return $false }
  }
  return $true
}

function Install-VCRuntime {
  Write-Step 'PostgreSQL needs the Microsoft Visual C++ runtime. Downloading it from Microsoft...'
  $exe = Join-Path $env:TEMP 'vc_redist.x64.exe'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $exe
  } catch {
    throw "Could not download the Visual C++ runtime ($($_.Exception.Message)). Check the internet connection, then start Digital Bahi again."
  }
  $signature = Get-AuthenticodeSignature -FilePath $exe
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    Remove-Item $exe -Force
    throw 'The Visual C++ runtime download is not signed by Microsoft; it was not installed.'
  }
  Write-Step 'Installing it: answer Yes when Windows asks for permission.'
  try {
    $process = Start-Process -FilePath $exe -ArgumentList '/install', '/quiet', '/norestart' -Verb RunAs -Wait -PassThru
  } catch {
    throw 'The Visual C++ runtime was not installed (permission was not given). Start Digital Bahi again and answer Yes.'
  } finally {
    Remove-Item $exe -Force -ErrorAction SilentlyContinue
  }
  # 3010: installed, a restart completes it (the files are usable already).
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010 -and $process.ExitCode -ne 1638) {
    throw "The Visual C++ runtime installer failed (code $($process.ExitCode))."
  }
}

try {
  $node = Get-Node
  if (-not $node) {
    Write-Host 'Digital Bahi has not been set up on this computer yet.'
    exit 0
  }
  if (($Command -eq 'start' -or $Command -eq 'restart') -and -not (Test-VCRuntime)) { Install-VCRuntime }
} catch {
  Write-Host ''
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# Downloads trust the computer's certificates too (antivirus that checks HTTPS adds its own).
$nodeFlags = @()
try {
  & $node --use-system-ca -e 0 2>$null
  if ($LASTEXITCODE -eq 0) { $nodeFlags = @('--use-system-ca') }
} catch { }

& $node @nodeFlags (Join-Path $PSScriptRoot 'launcher.mjs') @LauncherArgs
exit $LASTEXITCODE
