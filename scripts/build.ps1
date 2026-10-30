[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Full release build, entirely on the Windows toolchain:
#   npm install (win32 binaries) -> vite build -> cargo build --release -> copy exe to app root
# env.ps1 兼容两种布局：test/scripts（旧 PoC）与 <仓库根>/scripts（部署后）
$EnvScript = @(
    (Join-Path $PSScriptRoot '..\..\..\qq_codex\scripts\env.ps1'),
    (Join-Path $PSScriptRoot '..\..\qq_codex\scripts\env.ps1')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $EnvScript) {
    throw 'env.ps1 not found (looked 2 and 3 levels up for qq_codex/scripts)'
}
. $EnvScript -RequireNode -RequireRust -RequireBuildTools

$TestRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:CARGO_TARGET_DIR = Join-Path $TestRoot 'src-tauri\target'

# 1) npm dependencies with real win32 platform binaries
if (-not (Test-Path (Join-Path $TestRoot 'node_modules\.bin\vite.cmd') -PathType Leaf)) {
    Write-Host 'Installing npm dependencies (Windows)...' -ForegroundColor Cyan
    Push-Location $TestRoot
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# 2) frontend build (tsc + vite) on Windows
Write-Host 'Building frontend (tsc + vite)...' -ForegroundColor Cyan
Push-Location $TestRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed: $LASTEXITCODE" }
} finally {
    Pop-Location
}
$DistIndex = Join-Path $TestRoot 'dist\index.html'
if (-not (Test-Path -LiteralPath $DistIndex -PathType Leaf)) {
    throw "dist/index.html missing after frontend build"
}

# 3) tauri build --no-bundle (PRODUCTION).
#    Direct `cargo build --release` compiles with cfg(dev) -> at runtime the
#    webview tries devUrl 127.0.0.1:1421 -> ERR_CONNECTION_REFUSED (hit once).
#    Must go through the tauri CLI so frontendDist gets embedded.
$Tauri = Join-Path $TestRoot 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path -LiteralPath $Tauri -PathType Leaf)) {
    throw "tauri.cmd missing: $Tauri (run npm install first)"
}
$TauriLog = Join-Path $TestRoot 'build-tauri.log'
Write-Host 'tauri build --no-bundle (output -> build-tauri.log)...' -ForegroundColor Cyan
$CmdLine = 'cd /d "' + $TestRoot + '" && call "' + $Tauri + '" build --no-bundle > "' + $TauriLog + '" 2>&1'
cmd /c $CmdLine
$TauriExit = $LASTEXITCODE
if (Test-Path -LiteralPath $TauriLog -PathType Leaf) {
    Get-Content -LiteralPath $TauriLog -Tail 25
}
if ($TauriExit -ne 0) {
    Write-Host "BUILD_FAIL exit=$TauriExit"
    exit $TauriExit
}

# 4) copy exe into test root
$BuiltExe = Join-Path $env:CARGO_TARGET_DIR 'release\the_file.exe'
if (-not (Test-Path -LiteralPath $BuiltExe -PathType Leaf)) {
    throw "release exe not found: $BuiltExe"
}
Copy-Item -LiteralPath $BuiltExe -Destination (Join-Path $TestRoot 'the_file.exe') -Force
$Out = Get-Item (Join-Path $TestRoot 'the_file.exe')
Write-Host ("BUILD_OK {0} bytes ({1:N1} MB)" -f $Out.Length, ($Out.Length / 1MB))
exit 0
