# priVet

Interfaz web simple y amable para usar un servicio de transcripción por IA sin tener que escribir comandos `curl` a mano.

Este proyecto no es el motor de transcripción. Es una UI estática pensada para conectarse a un backend ya existente, por ejemplo un servidor local o privado que expone un endpoint de transcripción de audio/video. La idea es que una persona pueda pegar una URL, subir un audio, elegir idioma/formato y obtener el `.txt` desde una pantalla clara e interactiva.

## Contexto

Privet necesita una forma más cómoda de usar un servicio de IA para transcribir audios. El backend ya hace el trabajo pesado: recibe una URL o archivo, procesa el audio y devuelve texto. Esta UI existe para que el flujo sea más humano:

- evitar escribir `curl` manualmente;
- probar solicitudes contra un servidor local o remoto;
- revisar resultados en una tabla;
- copiar o descargar transcripciones;
- usar un modo mock cuando el backend, VPN o red local no estén disponibles.

## Qué hace la aplicación

- Permite transcribir desde una URL pública de audio/video.
- Permite subir un archivo de audio local.
- Soporta idioma automático o códigos como `es`, `en`, `pt`.
- Permite elegir formato `flat` o `diarized`.
- Genera una vista del `curl` equivalente para depuración.
- Incluye modo mock para probar la UI sin backend.
- Guarda historial local opcional en el navegador.
- Permite copiar y descargar resultados como `.txt`.
- Muestra métricas simples del resultado seleccionado en el panel de Análisis.
- Se puede desplegar como sitio estático con Nginx y Docker.

## Estructura

```text
.
├── index.html
├── assets/
│   ├── css/styles.css
│   ├── img/
│   └── js/
│       ├── app.js
│       ├── runtime-config.js
│       └── runtime-config.template.js
├── docker/
│   └── 40-runtime-config.sh
├── nginx/
│   └── default.conf
├── Dockerfile
└── docker-compose.yml
```

## Ejecutar localmente

Como la app es estática, puedes abrir `index.html` directamente en el navegador.

Para servirla localmente con Node:

```powershell
npx serve .
```

También puedes usar Docker:

```powershell
docker compose up --build
```

Luego abre:

```text
http://localhost:8080
```

## Configurar el backend

La UI llama al endpoint:

```text
{API_BASE_URL}/audio/transcription/
```

Por defecto, `API_BASE_URL` apunta a:

```text
https://whisper-skynet.bourbaki-lab.duckdns.org
```

Para usar otro servidor con Docker Compose:

```powershell
$env:API_BASE_URL="http://tu-servidor-local:puerto"
docker compose up --build
```

O edita directamente `docker-compose.yml`:

```yaml
environment:
  API_BASE_URL: "${API_BASE_URL:-http://tu-servidor-local:puerto}"
```

Si abres `index.html` sin Docker, cambia el valor en:

```text
assets/js/runtime-config.js
```

## Contrato esperado del backend

La UI envía un `POST` con `multipart/form-data`.

Para URL:

```bash
curl -X POST "http://tu-servidor-local:puerto/audio/transcription/" \
  -F "url=https://www.youtube.com/watch?v=..." \
  -F "language=auto" \
  -F "format=flat" \
  -F "output_filename=transcripcion.txt"
```

Para archivo:

```bash
curl -X POST "http://tu-servidor-local:puerto/audio/transcription/" \
  -F "file=@audio.mp3" \
  -F "language=es" \
  -F "format=diarized" \
  -F "output_filename=consulta.txt"
```

La respuesta puede ser texto plano. La UI también intenta leer respuestas JSON con campos comunes como:

- `text`
- `transcription`
- `transcript`
- `result`
- `output`

## Formatos

`flat` devuelve texto corrido, útil cuando no importa separar hablantes.

`diarized` se usa cuando el backend puede separar hablantes o incluir marcas de tiempo.

## Modo mock

Activa **Usar modo mock** para probar la interfaz sin llamar al backend real. Esto es útil si:

- no estás conectado a la VPN;
- el server local está apagado;
- quieres revisar diseño, navegación, historial, copia y descarga;
- estás haciendo cambios de frontend sin gastar procesamiento del servicio de IA.

## Historial local y privacidad

El historial se guarda en `localStorage` del navegador bajo la clave:

```text
privet_history_v1
```

Eso significa que los resultados quedan sólo en el navegador y equipo donde se usó la app. Si las transcripciones contienen datos sensibles, desactiva el historial local o borra los resultados desde la UI.

## Desarrollo

No hay build frontend. Los archivos principales son:

- `index.html`: estructura de la aplicación.
- `assets/css/styles.css`: diseño visual y responsive.
- `assets/js/app.js`: lógica de formulario, requests, historial y análisis.
- `assets/js/runtime-config.js`: configuración local del backend.
- `assets/js/runtime-config.template.js`: plantilla usada por Docker.

Si el backend está en otro dominio, IP o puerto, asegúrate de que tenga CORS configurado para aceptar requests desde la URL donde esté corriendo esta UI.

## Estado del proyecto

Este repositorio contiene una versión simple, estática y enfocada en uso interno. La prioridad es que el flujo sea cómodo para personas que necesitan transcribir, revisar y descargar texto sin interactuar directamente con la API.
