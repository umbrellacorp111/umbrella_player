@echo off
title Остановка Umbrella Player
echo Остановка сервера на порту 8000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do (
    echo Завершение процесса PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 >nul
echo Готово. Можно закрывать это окно.
timeout /t 3
