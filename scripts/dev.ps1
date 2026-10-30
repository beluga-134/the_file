[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Reuse qq_codex portable toolchain (node / cargo / MSVC env detection)
# env.ps1 兼容两种布局：test/scripts（旧 PoC）与 <仓库根>/scripts（部署后）
$EnvScript = @(
    (Join-Path $PSScriptRoot '..\..\..\qq_codex\scripts\env.ps1'),
    (Join-Path $PSScriptRoot '..\..\qq_codex\scripts\env.ps1')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $EnvScript) {
    throw 'env.ps1 not found (looked 2 and 3 levels up for qq_codex/scripts)'
}
. $EnvScript -RequireNode -RequireRust -RequireBuildTools

if (-not (Test-WebView2Runtime)) {
    throw 'Microsoft Edge WebView2 Runtime is missing.'
}

$TestRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:CARGO_TARGET_DIR = Join-Path $TestRoot 'src-tauri\target'

if (-not (Test-Path (Join-Path $TestRoot 'node_modules\.bin\tauri.cmd') -PathType Leaf)) {
    Write-Host 'Installing npm dependencies...' -ForegroundColor Cyan
    Push-Location $TestRoot
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

$TauriCommand = Join-Path $TestRoot 'node_modules\.bin\tauri.cmd'
Push-Location $TestRoot
try {
    & $TauriCommand @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
