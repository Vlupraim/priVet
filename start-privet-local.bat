@echo off
setlocal

cd /d "%~dp0"

if "%PRIVET_PORT%"=="" set "PRIVET_PORT=8787"
if "%PRIVET_API_BASE_URL%"=="" set "PRIVET_API_BASE_URL=https://whisper-skynet.bourbaki-lab.duckdns.org"
if "%PRIVET_OUTPUT_DIR%"=="" set "PRIVET_OUTPUT_DIR=C:\Users\kuqui\OneDrive\Escritorio\alejandria"

echo Iniciando Privet local en http://127.0.0.1:%PRIVET_PORT%/
echo Backend: %PRIVET_API_BASE_URL%/audio/transcription/
echo Salida: %PRIVET_OUTPUT_DIR%
echo.
echo Deja esta ventana abierta mientras uses la pagina.
echo Presiona Ctrl+C para apagarla.
echo.

start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 1; Start-Process 'http://127.0.0.1:%PRIVET_PORT%/'"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0local-server.py"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    python "%~dp0local-server.py"
  ) else (
    echo No se encontro Python. Usando servidor PowerShell incluido en Windows.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server.ps1"
  )
)

pause
