@echo off
title CaseritoView - TradingView Local
cd /d "%~dp0"

echo =======================================================
echo          Iniciando CaseritoView (TradingView Local)
echo =======================================================
echo.

:: Verificar si las dependencias estan listas; si falta alguna, instalarlas
python -c "import fastapi, uvicorn, yfinance, pandas, numpy, sqlalchemy, pydantic" >nul 2>&1
if %errorlevel% neq 0 (
    echo Instalando/verificando dependencias necesarias...
    python -m pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo Hubo un problema al instalar dependencias. Presiona una tecla para salir.
        pause
        exit /b 1
    )
)

echo Dependencias listas.
echo.
echo =======================================================
echo  Servidor listo en: http://127.0.0.1:8000
echo  Abriendo tu navegador web...
echo =======================================================
echo.

:: Abrir el navegador tras 1 segundo
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:8000"

:: Iniciar el servidor local FastAPI con uvicorn
python -m uvicorn main:app --reload --port 8000

pause
