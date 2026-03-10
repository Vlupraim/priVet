/**
 * plantilla usada por docker para inyectar variables de entorno al frontend.
 */
window.APP_CONFIG = Object.freeze({
  API_BASE_URL: "${API_BASE_URL}",
});
