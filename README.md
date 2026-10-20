# 📈 CaseritoView Pro

Una alternativa local, ultraliviana y privada a **TradingView** para análisis técnico, bitácora de notas y anotaciones interactivas sobre acciones del mercado estadounidense (NYSE/NASDAQ) y activos locales (BYMA).

Construido con **FastAPI** en el backend, almacenamiento local en **SQLite** y la librería oficial interactiva **TradingView Lightweight Charts (v4.2.1)** en el frontend.

---

## 🚀 Características Principales

- **Gráfico Interactivo de Velas Japonesas:** Renderizado fluido y veloz con *Lightweight Charts* en modo oscuro.
- **Multi-Timeframe On-The-Fly:** Alterná instantáneamente entre **1D (Diario)**, **1W (Semanal)** y **1M (Mensual)**. Los resamples e indicadores se recalculan dinámicamente en memoria con Pandas sin duplicar tablas.
- **Indicadores Técnicos Listos para Usar:**
  - **Medias Móviles:** EMA 9, EMA 21, EMA 50, EMA 100, EMA 200, SMA 200 y WMA 200.
  - **Presets Rápidos:** *⚡ Vista Swing* (EMA 9, 21, 50) y *🏛️ Vista Posicional* (EMA 50, 100, 200, SMA 200, WMA 200).
  - **Sub-gráfico de RSI (14 períodos):** Suavizado de Wilder con niveles 70/50/30, sincronizado en crosshair, scroll y zoom lógico con el gráfico principal.
- **Herramientas de Dibujo y Medición:**
  - 📏 **Regla de Medición / Rango:** Medí variaciones porcentuales (+/- %), diferencia en USD y tiempo transcurrido. Podés mover las cajas libremente hacia los costados para sacarlas del medio sin perder los precios de referencia.
  - 📈 **Líneas de Tendencia:** Trazado de dos puntos con proyección al futuro.
  - ➖ **Soportes y Resistencias:** Líneas horizontales con imán magnético (*snap*) automático de 6px.
  - 📐 **Retroceso de Fibonacci:** Con zona dorada sombreada (0.50 – 0.618).
  - ⠿ **Barra de Edición Flotante:** Personalizá colores, precios exactos, etiquetas o borrá dibujos. La barra es arrastrable a cualquier posición y recuerda su ubicación.
- **Persistencia Local en SQLite:** Todas tus notas de bitácora y dibujos quedan guardados en tu propia computadora (`caseritoview.db`), sin enviar tus análisis a la nube.
- **Descarga Histórica y Caché Inteligente:** Descarga 10 años ajustados (`auto_adjust=True`) vía `yfinance`, sincroniza solo los días nuevos y cuenta con botón de *Sync Completo* (anti-splits y dividendos).
- **Panel Lateral Redimensionable y Buscador:** Lista de activos ordenada alfabéticamente (A–Z), buscador en tiempo real y paneles ajustables en altura y ancho.

---

## 📁 Estructura del Proyecto

```text
CaseritoView/
├── main.py              # Backend FastAPI (endpoints, caché incremental, resample e indicadores)
├── database.py          # Modelos y conexión SQLite (SQLAlchemy)
├── index.html           # Interfaz gráfica completa en modo oscuro
├── app.js               # Lógica del frontend, Lightweight Charts, interacción y SVG overlay
├── styles.css           # Estilos oscuros, paneles redimensionables y barra flotante
├── requirements.txt     # Dependencias de Python
├── start.bat            # Script de inicio en 1 clic (Windows)
├── .gitignore           # Excluye la base SQLite local y cachés de Python
└── README.md            # Documentación y guía de uso
```

---

## 🛠️ Requisitos Previos

- **Python 3.10** o superior instalado en tu sistema.
- Conexión a Internet (para descargar la historia de cotizaciones desde Yahoo Finance y cargar Lightweight Charts vía CDN).

---

## ⚡ Instalación y Uso Rápido

### En Windows (con `start.bat`)
Hacé doble click en el archivo **`start.bat`**. 
El script verificará e instalará automáticamente las dependencias faltantes de `requirements.txt`, levantará el servidor en `http://127.0.0.1:8000` y abrirá tu navegador por defecto.

---

### En Linux / macOS / Manual en Terminal

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/TU_USUARIO/CaseritoView.git
   cd CaseritoView
   ```

2. **(Opcional pero recomendado) Crear un entorno virtual:**
   ```bash
   python -m venv venv
   # En Windows:
   venv\Scripts\activate
   # En macOS/Linux:
   source venv/bin/activate
   ```

3. **Instalar dependencias:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Iniciar la aplicación:**
   ```bash
   python -m uvicorn main:app --reload --port 8000
   ```

5. Abrí tu navegador en: **`http://127.0.0.1:8000`**

---

## 🛡️ Información Sensible y Base de Datos

- **No hay API Keys ni contraseñas:** El proyecto consume datos públicos a través de `yfinance` y no requiere credenciales pagas ni tokens privados.
- **Tu base de datos local (`caseritoview.db`):** 
  - Este archivo contiene tu historial de precios descargado y, principalmente, **tus notas personales de bitácora y tus dibujos**.
  - Está expresamente excluido en el `.gitignore` para proteger tu privacidad.
  - **No necesitas subir ninguna base de datos al repositorio:** cuando un nuevo usuario ejecuta el proyecto por primera vez, `database.py` crea una base de datos SQLite limpia y vacía automáticamente.

---

## 🤖 Guía para Resolver Faltantes con IA (Prompts Listos para Usar)

Si clonaste este repositorio y tenés algún inconveniente en tu entorno, o querés expandir las funciones, copiá y pegá cualquiera de estos prompts a tu asistente de IA favorito (ChatGPT, Claude, Gemini, etc.):

### 1. Si Python o Pip no están instalados o fallan en PATH
> *"Estoy intentando correr un proyecto local en Python (FastAPI) y al ejecutar `python` o `start.bat` en mi terminal de [Windows / macOS / Linux] me dice que el comando no se reconoce o pip falla. Guiame paso a paso para solucionarlo y agregar Python a las variables de entorno PATH."*

### 2. Si el puerto 8000 está ocupado por otra aplicación
> *"Tengo un proyecto FastAPI que intenta levantarse en el puerto 8000 (`uvicorn main:app --port 8000`), pero el puerto está ocupado por otro servicio. ¿Cómo puedo cambiarlo para que corra en el puerto 8080 tanto en el comando de `start.bat` como en las llamadas del frontend si fuera necesario?"*

### 3. Si querés agregar nuevos tickers predeterminados
> *"Quiero agregar una lista personalizada de tickers a mi watchlist de CaseritoView (por ejemplo: `['MELI', 'GLOB', 'SPY', 'QQQ']`). ¿Qué línea debo modificar en `main.py` para que aparezcan automáticamente al iniciar?"*

### 4. Si querés agregar un indicador nuevo (ej: Bandas de Bollinger, MACD)
> *"Tengo este proyecto con FastAPI y Lightweight Charts donde los indicadores se calculan on-the-fly en `main.py` sobre un DataFrame de Pandas (`compute_indicators_on_the_fly`). Quiero agregar el indicador [MACD / Bandas de Bollinger]. ¿Qué cálculo debo agregar en `main.py` y cómo creo la serie en `app.js` de Lightweight Charts para mostrarlo?"*

### 5. Si querés empaquetarlo en Docker
> *"Tengo este proyecto compuesto por `main.py`, `database.py`, `index.html`, `app.js`, `styles.css` y `requirements.txt`. Escribime un `Dockerfile` y un `docker-compose.yml` livianos para levantarlo en un contenedor de Docker montando un volumen para la base SQLite `caseritoview.db`."*

---

## 📄 Licencia

Este proyecto está bajo la licencia MIT. Podés utilizarlo, modificarlo y compartirlo libremente.
