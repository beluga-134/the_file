# 部署形态冒烟：从 the_wenjian 根启动 the_file.exe → 截图 → 读窗口标题 → 优雅关闭
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = 'E:\qq_codex\the_wenjian'
$Exe = Join-Path $Root 'the_file.exe'
$Shot = Join-Path $Root 'smoke-shot.png'

# 清残留
Get-Process -Name the_file -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 6

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose(); $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Write-Host ("shot saved; app alive: " + (-not $p.HasExited))

# 优雅关闭（不强制，验证正常退出路径）
[void]$p.CloseMainWindow()
Start-Sleep -Seconds 2
Write-Host ("after close exited: " + $p.HasExited)
Write-Host SMOKE_DONE
