# priVet

Panel web simple para usar el servicio de transcripción de Privet sin escribir comandos `curl` a mano.

La aplicación permite cargar una URL o un archivo de audio, elegir idioma y formato de salida, enviar la solicitud al backend de transcripción y revisar el resultado desde una interfaz más cómoda.

## Qué incluye

- Formulario para transcribir desde URL pública o archivo local.
- Selector de idioma con modo `auto` y opción de código personalizado.
- Selector de formato `flat` o `diarized`.
- Nombre configurable para el archivo `.txt` de salida.
- Vista del `curl` equivalente para depuración.
- Modo mock para probar la interfaz sin backend ni VPN.
- Historial local de resultados en el navegador.
- Copia al portapapeles y descarga del resultado como `.txt`.
- Despliegue estático con Nginx y configuración runtime mediante Docker.

## Estructura del proyecto

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

## Cómo funciona

La UI arma un `FormData` y lo envía por `POST` al endpoint:

```text
{API_BASE_URL}/audio/transcription/
```

Según el modo elegido, la solicitud incluye uno de estos campos:

- `url`: URL pública de audio o video.
- `file`: archivo de audio seleccionado desde el equipo.

Además envía:

- `language`: código de idioma, por ejemplo `auto`, `es`, `en`, `pt`.
- `format`: `flat` o `diarized`.
- `output_filename`: nombre sugerido para el archivo `.txt`.

El backend debe responder con texto plano de la transcripción.

## Ejecutar localmente

Como es una app estática, puedes abrir `index.html` directamente en el navegador.

Para una ejecución más parecida a producción, usa Docker:

```powershell
docker compose up --build
```

Luego abre:

```text
http://localhost:8080
```

## Configurar el backend

Por defecto, el proyecto apunta a:

```text
https://whisper-skynet.bourbaki-lab.duckdns.org
```

Si usas Docker Compose, cambia `API_BASE_URL` en `docker-compose.yml`:

```yaml
environment:
  API_BASE_URL: "http://tu-servidor-local:puerto"
```

Si ejecutas la imagen manualmente, puedes pasar la variable al contenedor:

```powershell
docker build -t privet-ui .
docker run --rm -p 8080:80 -e API_BASE_URL="http://tu-servidor-local:puerto" privet-ui
```

Si abres `index.html` directamente sin Docker, ajusta `assets/js/runtime-config.js`.

## Modo mock

Activa **Usar modo mock** cuando quieras probar la UI sin conexión al backend. En ese modo la app simula una respuesta de transcripción y permite validar navegación, historial, copia y descarga.

## Historial local

Los resultados se guardan en `localStorage` del navegador bajo la clave:

```text
privet_history_v1
```

Esto significa que el historial vive sólo en el navegador y equipo donde se usó la app. Si las transcripciones contienen información sensible, limpia el almacenamiento del navegador cuando corresponda.

## Contrato esperado del backend

Ejemplo con URL:

```bash
curl -X POST "http://tu-servidor-local:puerto/audio/transcription/" \
  -F "url=https://www.youtube.com/watch?v=..." \
  -F "language=auto" \
  -F "format=flat" \
  -F "output_filename=transcripcion.txt"
```

Ejemplo con archivo:

```bash
curl -X POST "http://tu-servidor-local:puerto/audio/transcription/" \
  -F "file=@audio.mp3" \
  -F "language=es" \
  -F "format=diarized" \
  -F "output_filename=consulta.txt"
```

## Notas para desarrollo

- No hay paso de build frontend.
- La lógica principal está en `assets/js/app.js`.
- Los estilos están en `assets/css/styles.css`.
- `runtime-config.template.js` se usa dentro del contenedor para generar `runtime-config.js` al iniciar.
- Si el backend corre en otra máquina o puerto, revisa CORS en el servicio de transcripción.
