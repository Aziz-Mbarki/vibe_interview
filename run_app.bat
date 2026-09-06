@echo off
cd /d "%~dp0"
echo ===================================================
echo Starting OpenCluely (Interactive Desktop Mode)
echo ===================================================
echo Hotkeys:
echo   - Ctrl + Shift + C : Open / Toggle Chat Window
echo   - Ctrl + Shift + V : Toggle Visibility
echo   - Ctrl + Shift + S : Screenshot Capture
echo   - Alt + R          : Toggle Speech
echo   - Ctrl + ,         : Settings
echo ===================================================
.\node_modules\.bin\electron.cmd .
pause
