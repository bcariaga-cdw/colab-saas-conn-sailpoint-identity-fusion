$ErrorActionPreference = "Stop"

$repo = "fernando-delosrios-sp/skills"
$binName = "harness-proxy"
$exeName = "$binName.exe"

$arch = "amd64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    $arch = "arm64"
}

$assetName = "$binName-windows-$arch.exe"
$downloadUrl = "https://github.com/$repo/releases/latest/download/$assetName"

$installDir = if ($env:BIN_DIR) { $env:BIN_DIR } else { "$env:LOCALAPPDATA\Programs\$binName" }
if (-not (Test-Path -Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

$targetPath = Join-Path $installDir $exeName

Write-Host "Downloading $binName (windows/$arch) from GitHub Releases..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $targetPath -UseBasicParsing

Write-Host "Successfully installed $binName to $targetPath"

$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
$pathParts = if ($userPath) { $userPath -split ";" } else { @() }
if ($pathParts -notcontains $installDir) {
    Write-Host "Adding $installDir to User PATH..."
    $newUserPath = ($pathParts + $installDir) -join ";"
    [System.Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
    $env:PATH = "$env:PATH;$installDir"
    Write-Host "Updated User PATH. Restart your terminal if running a pre-existing session."
}
