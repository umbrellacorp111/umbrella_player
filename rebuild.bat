@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Umbrella Player - пересборка .exe
echo ============================================
echo.

REM --- 1. Закрываем запущенный плеер, иначе dist будет занят ---
taskkill /f /im "Umbrella Player.exe" >nul 2>&1
timeout /t 1 >nul

REM --- 2. Проверяем, что рядом лежит .spec ---
if not exist "Umbrella Player.spec" (
  echo [ОШИБКА] Рядом с этим .bat нет файла "Umbrella Player.spec".
  echo Положи rebuild.bat в корень проекта playerTG ^(туда же, где .spec^).
  pause
  exit /b 1
)

REM --- 3. Ищем рабочий Python: venv -> py -> python -> python3 ---
set "PY="

if exist ".venv\Scripts\python.exe" set PY="%CD%\.venv\Scripts\python.exe"
if not defined PY if exist "venv\Scripts\python.exe" set PY="%CD%\venv\Scripts\python.exe"

if not defined PY (
  py -3 -c "print()" >nul 2>&1 && set "PY=py -3"
)
if not defined PY (
  python -c "print()" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  python3 -c "print()" >nul 2>&1 && set "PY=python3"
)

if not defined PY (
  echo [ОШИБКА] Не нашёл рабочий Python.
  echo.
  echo Что доступно в системе:
  where py 2>nul
  where python 2>nul
  echo.
  echo Варианты решения:
  echo   - установи Python с python.org с галочкой "Add python.exe to PATH", или
  echo   - положи рядом с проектом окружение в папку .venv или venv, или
  echo   - впиши полный путь к python.exe вручную в строке ниже.
  echo     Пример: set PY="C:\Users\Имя\AppData\Local\Programs\Python\Python311\python.exe"
  pause
  exit /b 1
)

echo Использую Python: %PY%
%PY% -c "import sys; print('Версия:', sys.version.split()[0])"
echo.

REM --- 4. Проверяем PyInstaller, при отсутствии ставим ---
%PY% -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
  echo PyInstaller не найден - устанавливаю...
  %PY% -m pip install pyinstaller
  if errorlevel 1 (
    echo [ОШИБКА] Не удалось установить PyInstaller.
    pause
    exit /b 1
  )
)

REM --- 5. Собираем ---
echo.
echo Собираю... это займёт минуту-другую, не закрывай окно.
echo.
%PY% -m PyInstaller "Umbrella Player.spec" --noconfirm --clean
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Сборка не удалась - смотри сообщения выше.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Готово!  dist\Umbrella Player.exe обновлён
echo ============================================
echo.

REM --- 6. Предлагаем сразу запустить ---
choice /c YN /m "Запустить плеер сейчас"
if errorlevel 2 goto end
start "" "dist\Umbrella Player.exe"

:end
endlocal
