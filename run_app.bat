@echo off
setlocal
cd /d "%~dp0"
title OpenCluely Launcher

echo ===================================================
echo Starting OpenCluely (Interactive Desktop Mode)
echo ===================================================
echo Hotkeys:
echo   - Ctrl + Shift + C : Open / Toggle Chat Window
echo   - Ctrl + Shift + V : Toggle Visibility
echo   - Ctrl + Shift + S : Screenshot Capture
echo   - Ctrl + Alt + R   : Toggle Speech (or Ctrl+Shift+R)
echo   - Ctrl + ,         : Settings
echo ===================================================
echo.

:: Clean up any lingering electron instances that may hold the profile lock
taskkill /F /IM electron.exe >nul 2>&1

call .\node_modules\.bin\electron.cmd .
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] OpenCluely exited with error code %ERRORLEVEL%.
)
echo App closed.
pause
