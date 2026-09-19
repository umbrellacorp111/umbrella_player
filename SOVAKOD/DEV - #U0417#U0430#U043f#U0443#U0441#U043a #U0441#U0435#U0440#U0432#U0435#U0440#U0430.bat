@echo off
cd /d "%~dp0"
py -3 "%~dp0start_player.pyw"
if errorlevel 1 pause
