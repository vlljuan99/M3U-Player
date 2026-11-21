@echo off
REM ============================================================
REM  M3U Player para Windows. Requiere Node.js 18+ (https://nodejs.org)
REM  Por defecto SOLO funciona en este PC (http://localhost:8080).
REM ============================================================
cd /d "%~dp0"

REM Solo accesible desde este PC. Nadie de tu Wi-Fi ni de Internet puede entrar.
set HOST=127.0.0.1
set PORT=8080
REM El proxy solo se conecta a tu proveedor IPTV.
set IPTV_HOSTS=line1.psp-49.xyz

REM --- Opcional: usarlo tambien desde el iPhone en tu Wi-Fi de casa ---
REM Quita "REM" de estas dos lineas y pon una clave larga (16+ caracteres):
REM set HOST=0.0.0.0
REM set ACCESS_KEY=pon-aqui-una-clave-larga

where node >nul 2>nul || (echo Node.js no esta instalado. Descargalo de https://nodejs.org y vuelve a abrir este archivo. & pause & exit /b 1)

REM Abre el navegador cuando el servidor ya este arrancado.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
echo Deja esta ventana abierta mientras uses el reproductor. Cierrala para apagarlo.
node server\server.js
pause
