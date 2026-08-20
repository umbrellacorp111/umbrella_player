@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Update yt-dlp to latest version
echo ============================================
echo.

REM --- Find Python ---
set "PY="

if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
if not defined PY if exist "venv\Scripts\python.exe" set PY=venv\Scripts\python.exe

if not defined PY (
  py -3 --version >nul 2>&1
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  python --version >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  python3 --version >nul 2>&1
  if not errorlevel 1 set "PY=python3"
)

if not defined PY (
  echo [ERROR] Python not found.
  pause
  exit /b 1
)

echo Using Python: %PY%
echo.

echo Updating yt-dlp...
%PY% -m pip install --upgrade yt-dlp

if errorlevel 1 (
  echo.
  echo [ERROR] Failed to update yt-dlp
  pause
  exit /b 1
)

echo.
echo ============================================
echo   yt-dlp successfully updated!
echo ============================================
echo.

%PY% -m yt_dlp --version
echo.

pause
endlocal
