@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1" %*
set "TE_HOST_POC_EXIT=%ERRORLEVEL%"
endlocal & exit /b %TE_HOST_POC_EXIT%
