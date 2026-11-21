@echo off
REM Arranca M3U Player en Windows. Requiere Node.js 18+ (https://nodejs.org)
cd /d "%~dp0"
REM Opcional: limita el proxy a tu proveedor y protege con clave
REM set IPTV_HOSTS=mi-proveedor.com:8080
REM set ACCESS_KEY=una-clave-larga
where node >nul 2>nul || (echo Node.js no esta instalado. Descargalo de https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8080
node server\server.js
pause
