[CmdletBinding()]
param(
    [int]$Shot1Seconds = 7,
    [int]$Shot2Seconds = 8
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$TestRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Exe = Join-Path $TestRoot 'the_file.exe'
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
    throw "exe not found: $Exe"
}

function Save-Shot([string]$Path) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved $Path"
}

# clean stale instances (graceful first, force-kill as fallback)
function Stop-App([string]$Name) {
    $procs = Get-Process -Name $Name -ErrorAction SilentlyContinue
    foreach ($p in $procs) { [void]$p.CloseMainWindow() }
    Start-Sleep -Milliseconds 1500
    Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force
}
Stop-App 'the_file'
Start-Sleep -Seconds 1

$p = Start-Process -FilePath $Exe -PassThru
Write-Host ("started pid=" + $p.Id)

Start-Sleep -Seconds $Shot1Seconds
Save-Shot (Join-Path $TestRoot 'verify-shot1.png')

Start-Sleep -Seconds $Shot2Seconds
Save-Shot (Join-Path $TestRoot 'verify-shot2.png')

# keep the app running for the user; just report
Write-Host ("app alive: " + (-not $p.HasExited))
Write-Host 'VERIFY_SHOTS_DONE'
