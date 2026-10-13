# Studia Backend (`studia-backend`)

Servidor intermediario (API) en TypeScript para **Studia**, encargado de recibir las consultas del asistente académico desde la aplicación de escritorio, validar las entradas, aplicar límites de uso y comunicarse de forma segura con **Google Gemini API** manteniendo la clave privada (`GEMINI_API_KEY`) exclusivamente en el servidor.

---

## 1. Arquitectura y responsabilidades

```text
studia-backend/
├── src/
│   ├── ai/
│   │   ├── ai.types.ts            # Contratos tipados para mensajes, contexto académico y respuestas
│   │   ├── ai-instructions.ts     # Reglas de estilo, guía de funciones de Studia y sanitización sin emojis
│   │   ├── ai-context.service.ts  # Validación de DTOs y formateo seguro del contexto académico
│   │   ├── ai-topic-guard.ts      # Validación determinista de dominio (Studia y organización académica)
│   │   ├── gemini.client.ts       # Cliente HTTP para Gemini REST API y clasificación de errores
│   │   ├── ai.service.ts          # Orquestación del flujo de IA (guardia de tema + instrucciones + cliente)
│   │   └── ai.controller.ts       # Controlador HTTP POST /api/ai/chat
│   ├── config/
│   │   └── env.config.ts          # Carga y validación estricta de variables de entorno
│   ├── controllers/
│   │   └── health.controller.ts   # Controlador GET /health
│   ├── errors/
│   │   └── app-error.ts           # Errores tipados y sanitización de secretos (scrubSecrets)
│   ├── middleware/
│   │   └── rate-limit.middleware.ts # Limitador de solicitudes por IP y global en memoria
│   ├── app.ts                     # Servidor HTTP, CORS, cabeceras de seguridad y manejo de errores
│   └── main.ts                    # Punto de entrada del servidor
├── test/
│   ├── backend.test.ts            # Pruebas automatizadas con mocks (sin consumir cuota real)
│   └── live-gemini.manual.ts      # Script de prueba manual contra Gemini API real
├── .env.example                   # Plantilla de variables de entorno sin secretos
├── package.json
└── tsconfig.json
```

---

## 2. Requisitos de desarrollo

- **Node.js** `v22.0.0` o superior (incluye soporte nativo de TypeScript y `fetch`).
- **npm** `v10+`.

---

## 3. Variables de entorno

Copia `.env.example` a `.env` para desarrollo local (el archivo `.env` está excluido de Git):

```powershell
Copy-Item .env.example .env
```

| Variable | Obligatoria | Valor por defecto | Descripción |
| :--- | :---: | :--- | :--- |
| `PORT` | No | `3000` | Puerto HTTP en el que escucha el servidor. |
| `GEMINI_API_KEY` | **Sí** | *(vacío)* | Clave privada de Google AI Studio. Nunca se expone al cliente. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash-lite` | Modelo de Gemini a invocar. Puede cambiarse (ej. `gemini-2.5-flash`) si cambia la disponibilidad del proveedor. |
| `GEMINI_TIMEOUT_MS` | No | `20000` | Tiempo máximo de espera (ms) por solicitud a Gemini API. |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Ventana de tiempo (ms) para el limitador de solicitudes. |
| `RATE_LIMIT_MAX_REQUESTS` | No | `15` | Máximo de solicitudes por IP dentro de la ventana. |
| `GLOBAL_RATE_LIMIT_MAX_REQUESTS` | No | `60` | Máximo global de solicitudes en el servidor dentro de la ventana. |
| `MAX_BODY_BYTES` | No | `65536` | Tamaño máximo permitido del cuerpo JSON (64 KB). |
| `CORS_ORIGIN` | No | `*` | Orígenes permitidos para CORS. |

---

## 4. Ejecución local y pruebas en PowerShell

### Ejecutar las pruebas automatizadas (sin consumir cuota de Gemini)
```powershell
cd ..\studia-backend
npm test
```

### Ejecutar el servidor en modo desarrollo
```powershell
cd ..\studia-backend
$env:GEMINI_API_KEY = "TU_CLAVE_PRIVADA_AQUI"
$env:GEMINI_MODEL = "gemini-3.5-flash-lite"
npm run dev
```
El servidor quedará disponible en `http://127.0.0.1:3000`. Puedes comprobar su estado abriendo `http://127.0.0.1:3000/health`.

### Ejecutar la prueba manual de conexión real con Gemini
```powershell
cd ..\studia-backend
$env:GEMINI_API_KEY = "TU_CLAVE_PRIVADA_AQUI"
npm run test:live-gemini
```

---

## 5. Endpoints disponibles

### `GET /health`
Devuelve el estado del servidor y si la clave de IA está configurada (sin revelar la clave):
```json
{
  "ok": true,
  "service": "studia-backend",
  "status": "up",
  "aiConfigured": true,
  "model": "gemini-3.5-flash-lite",
  "timestamp": "2026-10-12T20:30:00.000Z"
}
```

### `POST /api/ai/chat`
Recibe el historial reciente de conversación (máx. 12 mensajes; hasta `4000` caracteres para el mensaje actual del estudiante y recorte automático a `2500` caracteres para mensajes previos del historial) y el resumen académico sanitizado (`academicContext`), y devuelve:
```json
{
  "ok": true,
  "data": {
    "reply": "Respuesta generada por el asistente...",
    "model": "gemini-3.5-flash-lite"
  }
}
```

En caso de error, devuelve siempre una estructura consistente:
```json
{
  "ok": false,
  "error": {
    "code": "MISSING_API_KEY | INVALID_API_KEY | MODEL_UNAVAILABLE | RATE_LIMITED | TIMEOUT | NETWORK_ERROR | PROVIDER_ERROR | EMPTY_RESPONSE | MESSAGE_TOO_LONG | BAD_REQUEST",
    "message": "Descripción segura en español"
  }
}
```

---

## 6. Despliegue en Render (o servicio equivalente)

1. Sube `studia-backend` a tu repositorio o configura un nuevo **Web Service** en [Render](https://render.com) apuntando al directorio `studia-backend`.
2. Configura los comandos del servicio en Render:
   - **Runtime:** `Node` (Node 22+)
   - **Build Command:** `npm install && npm run build` (o `npm start` directamente con `--experimental-strip-types`)
   - **Start Command:** `node --experimental-strip-types src/main.ts` (o `npm start` si ejecutaste `npm run build`)
3. En la sección **Environment Variables** de Render, agrega:
   - `GEMINI_API_KEY` = *(tu clave privada de Google AI Studio)*
   - `GEMINI_MODEL` = `gemini-3.5-flash-lite`
4. Una vez desplegado, verifica que `https://<tu-servicio>.onrender.com/health` responda `"aiConfigured": true`.
5. Copia esa URL pública HTTPS y configúrala en `studia-frontend` antes de generar el instalador de Windows.

---

## 7. Medidas de seguridad y limitaciones conocidas

- **Protección de credenciales:** La clave `GEMINI_API_KEY` vive únicamente en las variables de entorno del servidor, se envía por cabecera HTTP `x-goog-api-key` y pasa por un filtro `scrubSecrets` que impide que aparezca en logs o mensajes de error.
- **Protección contra abuso en demostración académica:** Al no requerir cuentas de usuario ni login para facilitar la evaluación por parte del profesor, el endpoint `/api/ai/chat` protege la cuota mediante:
  1. Límite de tamaño máximo de cuerpo HTTP (`64 KB`).
  2. Límite de longitud para el mensaje actual del usuario (`4000` caracteres), recorte automático de mensajes históricos (`2500` caracteres por mensaje previo, `12000` caracteres de historial total) y cantidad máxima de mensajes (`12`).
  3. Límite de tokens de salida (`maxOutputTokens: 420`).
  4. Rate limiting por dirección IP (`15 req/min`) y límite global del servidor (`60 req/min`).
- **Limitación real:** Sin autenticación de usuarios individuales, cualquier cliente que conozca la URL pública del backend puede realizar solicitudes hasta alcanzar el límite por IP o el límite global del servidor. Para un entorno comercial multiusuario se recomendaría añadir autenticación por sesión/JWT.
