[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Compile check only (no app launch). Reuses qq_codex toolchain.
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

$cargo = Join-Path (Join-Path $CargoHome 'bin') 'cargo.exe'
& $cargo check --manifest-path (Join-Path $TestRoot 'src-tauri\Cargo.toml') 2>&1
exit $LASTEXITCODE
