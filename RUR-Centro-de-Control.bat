@echo off
chcp 65001 >nul
title Centro de Control RUR — UNIPOLI Durango
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Configurar Node.js en PATH
if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "C:\Program Files (x86)\nodejs" set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\node" set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"

set "ROS_DOMAIN_ID=42"
set "RMW_IMPLEMENTATION=rmw_cyclonedds_cpp"
set "PYTHONUNBUFFERED=1"

:: Verificar dependencias
if not exist "%~dp0node_modules" (
    echo [INFO] Instalando módulos npm...
    call npm install
)

:: Verificar si el servidor ya está corriendo en el puerto 3000
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
    start "RUR-Backend" /min node "%~dp0server.js"
    timeout /t 2 /nobreak >nul
)

set "URL=http://127.0.0.1:3000"

:: Abrir en Modo Aplicación Nativa (sin barra de direcciones ni pestañas)
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1440,900
    exit /b 0
)
if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1440,900
    exit /b 0
)
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1440,900
    exit /b 0
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1440,900
    exit /b 0
)

start "" "%URL%"
exit /b 0
