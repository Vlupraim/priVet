/**
 * configuracion base de integracion con el backend de transcripcion.
 * API_BASE_URL se resuelve desde window.APP_CONFIG (runtime).
 */
const DEFAULT_API_BASE_URL = "https://whisper-skynet.bourbaki-lab.duckdns.org";

/**
 * obtiene API_BASE_URL desde runtime config (window.APP_CONFIG),
 * con fallback al valor por defecto para uso local.
 */
function resolveApiBaseUrl() {
  const runtimeValue =
    typeof window !== "undefined" && window.APP_CONFIG
      ? window.APP_CONFIG.API_BASE_URL
      : undefined;

  if (typeof runtimeValue !== "string") {
    return DEFAULT_API_BASE_URL;
  }

  const normalized = runtimeValue.trim().replace(/\/+$/, "");
  return normalized || DEFAULT_API_BASE_URL;
}

const CONFIG = {
  API_BASE_URL: resolveApiBaseUrl(),
  TRANSCRIBE_PATH: "/audio/transcription/",
  REQUEST_TIMEOUT_MS: 8 * 60 * 1000,
};

/**
 * clave de almacenamiento local para mantener el historial
 * de tipeos entre recargas del navegador.
 */
const HISTORY_STORAGE_KEY = "privet_history_v1";

/**
 * textos de apoyo para explicar el formato elegido.
 */
const FORMAT_DESCRIPTIONS = {
  flat: "Texto corrido, sin separacion por hablantes.",
  diarized: "Separa por hablantes y puede incluir marcas de tiempo.",
};

/**
 * estado global liviano de la ui.
 * - isloading: evita envios duplicados.
 * - lastresult: texto en el detalle seleccionado.
 * - activepanel: panel visible actualmente.
 * - history: resultados historicos.
 * - selectedhistoryid: registro activo en la tabla.
 * - pagesize/currentpage: control de paginacion.
 */
const state = {
  isLoading: false,
  lastResult: "",
  activePanel: "tipeosPanel",
  history: [],
  selectedHistoryId: null,
  pageSize: 10,
  currentPage: 1,
};

/**
 * duracion de la transicion entre paneles (en ms).
 */
const PANEL_SWITCH_MS = 180;

// -----------------------------
// referencias del dom
// -----------------------------
const logoHomeBtn = document.getElementById("logoHomeBtn");

const form = document.getElementById("transcriptionForm");
const urlGroup = document.getElementById("urlGroup");
const fileGroup = document.getElementById("fileGroup");
const urlInput = document.getElementById("urlInput");
const fileInput = document.getElementById("fileInput");
const languageSelect = document.getElementById("languageSelect");
const customLanguageInput = document.getElementById("customLanguage");
const formatGroup = document.getElementById("formatGroup");
const formatSelect = document.getElementById("formatSelect");
const formatHelpFloating = document.getElementById("formatHelpFloating");
const outputNameInput = document.getElementById("outputNameInput");
const mockModeCheckbox = document.getElementById("mockMode");

const submitBtn = document.getElementById("submitBtn");
const clearBtn = document.getElementById("clearBtn");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

const setupNotice = document.getElementById("setupNotice");
const statusBox = document.getElementById("statusBox");
const loadingBox = document.getElementById("loadingBox");
const resultText = document.getElementById("resultText");
const endpointPreview = document.getElementById("endpointPreview");
const curlPreview = document.getElementById("curlPreview");
const analysisText = document.getElementById("analysisText");
const configSummary = document.getElementById("configSummary");

const historyMeta = document.getElementById("historyMeta");
const pageSizeSelect = document.getElementById("pageSizeSelect");
const historyTableBody = document.getElementById("historyTableBody");
const historyEmpty = document.getElementById("historyEmpty");
const historyPagination = document.getElementById("historyPagination");

const panelViews = Array.from(document.querySelectorAll(".admin-view"));
const sideItems = Array.from(document.querySelectorAll(".side-item"));

let formatHelpHideTimer = null;
let panelSwitchTimer = null;

if (endpointPreview) {
  endpointPreview.textContent = `${CONFIG.API_BASE_URL}${CONFIG.TRANSCRIBE_PATH}`;
}

/**
 * cambia el panel activo del area principal (tipeos/resultados/analisis)
 * y sincroniza el estado visual del menu lateral.
 */
function activatePanel(panelId) {
  if (!panelId) return;

  const nextView = panelViews.find((view) => view.id === panelId);
  if (!nextView) return;

  // si el usuario cambia de pestaña rapido, cancelamos animaciones anteriores.
  if (panelSwitchTimer) {
    clearTimeout(panelSwitchTimer);
    panelSwitchTimer = null;
  }
  panelViews.forEach((view) => {
    view.classList.remove("is-leaving");
  });

  sideItems.forEach((item) => {
    const isActive = item.dataset.target === panelId;
    item.classList.toggle("is-active", isActive);
    item.setAttribute("aria-current", isActive ? "page" : "false");
  });

  const currentView = panelViews.find((view) => view.classList.contains("is-active"));

  // si ya estamos en el panel objetivo, no hacemos transicion.
  if (!currentView || currentView === nextView) {
    panelViews.forEach((view) => {
      view.classList.toggle("is-active", view === nextView);
    });
    state.activePanel = panelId;
    return;
  }

  // transicion suave: primero sale el panel actual, luego entra el nuevo.
  currentView.classList.remove("is-active");
  currentView.classList.add("is-leaving");

  panelSwitchTimer = setTimeout(() => {
    currentView.classList.remove("is-leaving");
    panelViews.forEach((view) => {
      view.classList.toggle("is-active", view === nextView);
    });
    panelSwitchTimer = null;
  }, PANEL_SWITCH_MS);

  state.activePanel = panelId;
}

/**
 * actualiza el mensaje de estado dentro del panel de configuracion.
 */
function setSetupNotice(type, text) {
  if (!setupNotice) return;

  setupNotice.className = `notice notice--${type}`;
  setupNotice.textContent = text;
}

/**
 * obtiene el modo de entrada elegido por el usuario.
 */
function getInputMode() {
  const selected = document.querySelector('input[name="inputMode"]:checked');
  return selected ? selected.value : "url";
}

/**
 * muestra url o archivo segun el modo seleccionado.
 * ademas limpia el campo contrario para cumplir "url o archivo, nunca ambos".
 */
function syncInputModeUI() {
  const urlMode = getInputMode() === "url";

  urlGroup.classList.toggle("hidden", !urlMode);
  fileGroup.classList.toggle("hidden", urlMode);

  if (urlMode) {
    fileInput.value = "";
  } else {
    urlInput.value = "";
  }
}

/**
 * controla si se muestra el input de idioma personalizado.
 */
function syncCustomLanguageUI() {
  const isOther = languageSelect.value === "other";
  customLanguageInput.classList.toggle("hidden", !isOther);

  if (!isOther) {
    customLanguageInput.value = "";
  }
}

/**
 * resuelve el codigo de idioma final que se enviara al backend.
 */
function resolveLanguageValue() {
  if (languageSelect.value !== "other") {
    return languageSelect.value;
  }

  return customLanguageInput.value.trim().toLowerCase();
}

/**
 * limpia el nombre del .txt para evitar caracteres invalidos en archivos.
 */
function sanitizeOutputBaseName(value) {
  return String(value || "")
    .trim()
    .replace(/\.txt$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/**
 * devuelve el nombre de salida final (siempre con extension .txt).
 * - forpreview: evita timestamp variable para mostrar un ejemplo estable.
 */
function resolveOutputFileName({ forPreview = false } = {}) {
  const baseFromInput = sanitizeOutputBaseName(outputNameInput?.value || "");
  if (baseFromInput) {
    return `${baseFromInput}.txt`;
  }

  if (forPreview) {
    return "transcripcion-salida.txt";
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `transcripcion-${timestamp}.txt`;
}

/**
 * genera un comando curl de referencia con la estructura usada por el backend.
 */
function buildCurlPreviewCommand() {
  const endpoint = `${CONFIG.API_BASE_URL}${CONFIG.TRANSCRIBE_PATH}`;
  const language = resolveLanguageValue() || "es";
  const format = formatSelect.value || "diarized";
  const outputFileName = resolveOutputFileName({ forPreview: true });

  if (getInputMode() === "url") {
    const sourceUrl = urlInput.value.trim() || "https://www.youtube.com/watch?v=NHKIBoJkAMM";
    return `curl -X POST "${endpoint}" -F "url=${sourceUrl}" -F "language=${language}" -F "format=${format}" >${outputFileName}`;
  }

  return `curl -X POST "${endpoint}" -F "file=@<audio.mp3>" -F "language=${language}" -F "format=${format}" >${outputFileName}`;
}

/**
 * refresca el preview visual del curl para que refleje la configuracion actual.
 */
function syncCurlPreview() {
  if (!curlPreview) return;
  curlPreview.textContent = buildCurlPreviewCommand();
}

/**
 * refresca el texto de ayuda asociado al formato de salida.
 */
function syncFormatHelp() {
  const selectedFormat = formatSelect.value;
  const description =
    FORMAT_DESCRIPTIONS[selectedFormat] || "Formato de salida de la transcripcion.";

  formatSelect.title = description;

  if (formatHelpFloating) {
    formatHelpFloating.textContent = description;
  }
}

/**
 * fuerza la apertura del tooltip de formato.
 */
function showFormatHelp() {
  if (!formatGroup) return;
  clearTimeout(formatHelpHideTimer);
  syncFormatHelp();
  formatGroup.classList.add("is-help-visible");
}

/**
 * cierra el tooltip con un pequeno delay para evitar parpadeos.
 */
function hideFormatHelp() {
  if (!formatGroup) return;
  clearTimeout(formatHelpHideTimer);
  formatHelpHideTimer = setTimeout(() => {
    formatGroup.classList.remove("is-help-visible");
  }, 120);
}

/**
 * devuelve una etiqueta corta con la fuente seleccionada para resumenes.
 */
function getSourceSummary() {
  if (getInputMode() === "url") {
    return urlInput.value.trim() || "Sin URL cargada";
  }

  return fileInput.files?.[0]?.name || "Sin archivo cargado";
}

/**
 * construye la lista de configuracion mostrada en el panel de analisis.
 */
function syncConfigSummary() {
  if (!configSummary) return;

  const language = resolveLanguageValue() || "Sin definir";
  const sourceMode = getInputMode() === "url" ? "URL" : "Archivo";

  const entries = [
    `Fuente activa: ${sourceMode}`,
    `Detalle fuente: ${getSourceSummary()}`,
    `Idioma: ${language}`,
    `Formato: ${formatSelect.value}`,
    `Salida txt: ${resolveOutputFileName({ forPreview: true })}`,
    `Modo mock: ${mockModeCheckbox.checked ? "Activado" : "Desactivado"}`,
  ];

  configSummary.innerHTML = "";

  entries.forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    configSummary.appendChild(item);
  });
}

/**
 * mantiene el panel de analisis como placeholder mientras
 * esa seccion se implementa completamente.
 */
function syncAnalysisPreview() {
  if (!analysisText) return;
  analysisText.textContent = "Pagina en construccion.";
}

/**
 * compacta un texto para mostrar un preview en tabla.
 */
function buildPreview(text, limit = 85) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

/**
 * formatea fecha de manera legible para la tabla de historial.
 */
function formatDateLabel(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "Sin fecha";

  return date.toLocaleString("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * obtiene un registro del historial por id.
 */
function getHistoryEntryById(id) {
  return state.history.find((entry) => entry.id === id) || null;
}

/**
 * persiste el historial en localstorage.
 */
function saveHistoryToStorage() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.history));
  } catch {
    // si falla almacenamiento, la app sigue operativa en memoria.
  }
}

/**
 * carga historial desde localstorage.
 * incluye saneamiento basico para evitar objetos incompletos.
 */
function loadHistoryFromStorage() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    state.history = parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: String(item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        sourceMode: item.sourceMode === "file" ? "file" : "url",
        sourceLabel: String(item.sourceLabel || "Sin fuente"),
        language: String(item.language || "auto"),
        format: item.format === "diarized" ? "diarized" : "flat",
        executionType: item.executionType === "mock" ? "mock" : "real",
        outputFileName: String(item.outputFileName || ""),
        text: String(item.text || ""),
        preview: String(item.preview || buildPreview(String(item.text || ""))),
      }));
  } catch {
    state.history = [];
  }
}

/**
 * crea un nuevo registro historico al completar una transcripcion.
 */
function createHistoryEntry(transcriptionText, outputFileName) {
  const mode = getInputMode();
  const sourceLabel =
    mode === "url" ? urlInput.value.trim() : fileInput.files?.[0]?.name || "archivo";

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    sourceMode: mode,
    sourceLabel,
    language: resolveLanguageValue(),
    format: formatSelect.value,
    executionType: mockModeCheckbox.checked ? "mock" : "real",
    outputFileName: outputFileName || resolveOutputFileName(),
    text: transcriptionText,
    preview: buildPreview(transcriptionText),
  };
}

/**
 * selecciona un elemento del historial y actualiza el detalle inferior.
 */
function selectHistoryEntry(entryId) {
  const selected = getHistoryEntryById(entryId);

  state.selectedHistoryId = selected ? selected.id : null;
  state.lastResult = selected ? selected.text : "";
  resultText.value = state.lastResult;

  copyBtn.disabled = state.isLoading || !state.lastResult;
  downloadBtn.disabled = state.isLoading || !state.lastResult;

  syncAnalysisPreview();
}

/**
 * devuelve total de paginas segun historial y tamano de pagina.
 */
function getTotalPages() {
  const total = Math.max(1, Math.ceil(state.history.length / state.pageSize));
  return total;
}

/**
 * mantiene pagina actual dentro de limites validos.
 */
function clampCurrentPage() {
  const totalPages = getTotalPages();
  if (state.currentPage > totalPages) state.currentPage = totalPages;
  if (state.currentPage < 1) state.currentPage = 1;
}

/**
 * calcula la lista de paginas visibles para paginacion numerada.
 * usa elipsis cuando hay muchas paginas.
 */
function buildVisiblePages(totalPages, currentPage) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, idx) => idx + 1);
  }

  const pages = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  if (start > 2) pages.push("...");
  for (let page = start; page <= end; page += 1) {
    pages.push(page);
  }
  if (end < totalPages - 1) pages.push("...");

  pages.push(totalPages);
  return pages;
}

/**
 * pinta los botones de paginacion (anterior, numeros, siguiente).
 */
function renderPagination(totalPages) {
  historyPagination.innerHTML = "";

  if (state.history.length === 0) return;

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "pagination-btn";
  prevBtn.textContent = "<";
  prevBtn.disabled = state.currentPage === 1;
  prevBtn.dataset.page = String(state.currentPage - 1);
  historyPagination.appendChild(prevBtn);

  const pages = buildVisiblePages(totalPages, state.currentPage);
  pages.forEach((value) => {
    if (value === "...") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "pagination-ellipsis";
      ellipsis.textContent = "...";
      historyPagination.appendChild(ellipsis);
      return;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pagination-btn${value === state.currentPage ? " is-active" : ""}`;
    btn.textContent = String(value);
    btn.dataset.page = String(value);
    historyPagination.appendChild(btn);
  });

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "pagination-btn";
  nextBtn.textContent = ">";
  nextBtn.disabled = state.currentPage === totalPages;
  nextBtn.dataset.page = String(state.currentPage + 1);
  historyPagination.appendChild(nextBtn);
}

/**
 * renderiza la tabla historica de resultados segun pagina y tamano.
 */
function renderHistoryTable() {
  clampCurrentPage();

  const total = state.history.length;
  const totalPages = getTotalPages();

  historyMeta.textContent = `Total: ${total} resultados | Pagina ${state.currentPage}/${totalPages}`;

  historyTableBody.innerHTML = "";

  if (total === 0) {
    historyEmpty.classList.remove("hidden");
    renderPagination(totalPages);
    selectHistoryEntry(null);
    return;
  }

  historyEmpty.classList.add("hidden");

  const startIndex = (state.currentPage - 1) * state.pageSize;
  const pageItems = state.history.slice(startIndex, startIndex + state.pageSize);

  pageItems.forEach((entry, index) => {
    const row = document.createElement("tr");
    if (entry.id === state.selectedHistoryId) {
      row.classList.add("is-selected");
    }

    const numberCell = document.createElement("td");
    numberCell.textContent = String(startIndex + index + 1);

    const dateCell = document.createElement("td");
    dateCell.textContent = formatDateLabel(entry.createdAt);

    const sourceCell = document.createElement("td");
    sourceCell.textContent = entry.sourceLabel;

    const langCell = document.createElement("td");
    langCell.textContent = entry.language;

    const formatCell = document.createElement("td");
    formatCell.textContent = entry.format;

    const typeCell = document.createElement("td");
    typeCell.textContent = entry.executionType;

    const previewCell = document.createElement("td");
    previewCell.className = "history-preview";
    previewCell.textContent = entry.preview;

    const actionCell = document.createElement("td");
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "history-action";
    viewButton.dataset.historyId = entry.id;
    viewButton.textContent = "Ver";
    actionCell.appendChild(viewButton);

    row.appendChild(numberCell);
    row.appendChild(dateCell);
    row.appendChild(sourceCell);
    row.appendChild(langCell);
    row.appendChild(formatCell);
    row.appendChild(typeCell);
    row.appendChild(previewCell);
    row.appendChild(actionCell);

    historyTableBody.appendChild(row);
  });

  renderPagination(totalPages);
}

/**
 * render completo del modulo historial + detalle seleccionado.
 */
function renderHistory() {
  if (!state.selectedHistoryId && state.history.length > 0) {
    selectHistoryEntry(state.history[0].id);
  }
  renderHistoryTable();
}

/**
 * inserta un nuevo resultado al historial y lo deja seleccionado.
 */
function addHistoryEntry(entry) {
  state.history.unshift(entry);
  state.selectedHistoryId = entry.id;
  state.currentPage = 1;
  saveHistoryToStorage();
  selectHistoryEntry(entry.id);
  renderHistory();
}

/**
 * valida datos de entrada antes de construir el payload.
 */
function validateForm() {
  const mode = getInputMode();
  const language = resolveLanguageValue();
  const format = formatSelect.value;

  if (mode === "url") {
    const url = urlInput.value.trim();

    if (!url) return "Debes ingresar una URL.";

    try {
      new URL(url);
    } catch {
      return "La URL no tiene un formato valido.";
    }
  } else if (!fileInput.files || fileInput.files.length === 0) {
    return "Debes seleccionar un archivo de audio.";
  }

  if (!language) {
    return "Debes indicar un codigo de idioma.";
  }

  if (!/^[a-z]{2,8}(-[a-z]{2,8})?$/i.test(language) && language !== "auto") {
    return "El codigo de idioma no es valido (ej: es, en, pt, fr-ca).";
  }

  if (!["flat", "diarized"].includes(format)) {
    return "Formato no valido. Debe ser flat o diarized.";
  }

  return null;
}

/**
 * crea el formdata respetando el contrato de la api.
 */
function buildPayload(outputFileName) {
  const formData = new FormData();
  const mode = getInputMode();

  if (mode === "url") {
    formData.append("url", urlInput.value.trim());
  } else {
    formData.append("file", fileInput.files[0]);
  }

  formData.append("language", resolveLanguageValue());
  formData.append("format", formatSelect.value);
  formData.append("output_filename", outputFileName || resolveOutputFileName());

  return formData;
}

/**
 * actualiza controles y mensajes del panel de resultados.
 */
function setResultStatus({ loading, statusType, statusText }) {
  state.isLoading = loading;

  submitBtn.disabled = loading;
  clearBtn.disabled = loading;
  copyBtn.disabled = loading || !state.lastResult;
  downloadBtn.disabled = loading || !state.lastResult;

  loadingBox.classList.toggle("hidden", !loading);
  statusBox.className = `status status--${statusType}`;
  statusBox.textContent = statusText;

  if (loading) {
    activatePanel("resultPanel");
  }

  syncAnalysisPreview();
  syncConfigSummary();
}

/**
 * simulacion local para desarrollo cuando no hay acceso al backend real.
 */
async function mockTranscriptionRequest(formData) {
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const language = formData.get("language");
  const format = formData.get("format");
  const hasUrl = formData.has("url");
  const sourceLabel = hasUrl ? formData.get("url") : formData.get("file")?.name || "archivo";

  if (!sourceLabel) {
    throw new Error("Mock: faltan datos para generar la transcripcion.");
  }

  if (format === "diarized") {
    return [
      "[00:00] Hablante 1: Esta es una respuesta simulada en modo mock.",
      `[00:04] Hablante 2: Idioma seleccionado: ${language}.`,
      `[00:08] Hablante 1: Fuente recibida: ${sourceLabel}.`,
      "[00:12] Hablante 2: Conecta a la VPN para usar el servicio real.",
    ].join("\n");
  }

  return [
    "Esta es una transcripcion simulada en modo mock.",
    `Idioma: ${language}.`,
    `Fuente: ${sourceLabel}.`,
    "Activa el endpoint real para obtener resultados de Whisper.",
  ].join(" ");
}

/**
 * solicitud real al backend con timeout para evitar bloqueos largos.
 */
async function realTranscriptionRequest(formData) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.TRANSCRIBE_PATH}`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const possibleError = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status}. ${possibleError || "El backend rechazo la solicitud."}`
      );
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("La solicitud excedio el tiempo maximo de espera.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * flujo principal de envio:
 * 1) valida
 * 2) muestra estado de carga
 * 3) llama a mock o backend real
 * 4) agrega registro al historial
 * 5) publica estado final
 */
async function handleSubmit(event) {
  event.preventDefault();

  if (state.isLoading) return;

  const validationError = validateForm();

  if (validationError) {
    setSetupNotice("error", validationError);
    activatePanel("tipeosPanel");
    return;
  }

  setSetupNotice("loading", "Configuracion valida. Iniciando transcripcion...");

  setResultStatus({
    loading: true,
    statusType: "loading",
    statusText: "Enviando solicitud...",
  });

  const outputFileName = resolveOutputFileName();
  const payload = buildPayload(outputFileName);

  try {
    const useMock = mockModeCheckbox.checked;
    const result = useMock
      ? await mockTranscriptionRequest(payload)
      : await realTranscriptionRequest(payload);

    const historyEntry = createHistoryEntry(result || "", outputFileName);
    addHistoryEntry(historyEntry);

    setSetupNotice(
      "ok",
      useMock
        ? "Transcripcion mock generada correctamente."
        : "Transcripcion recibida correctamente."
    );

    setResultStatus({
      loading: false,
      statusType: "ok",
      statusText: useMock
        ? "Transcripcion mock generada correctamente."
        : "Transcripcion recibida correctamente.",
    });

    activatePanel("resultPanel");
  } catch (error) {
    const message = error?.message || "Ocurrio un error inesperado.";

    setSetupNotice("error", message);

    setResultStatus({
      loading: false,
      statusType: "error",
      statusText: message,
    });

    activatePanel("resultPanel");
  }
}

/**
 * resetea formulario + estado visual y vuelve al panel de tipeos.
 * nota: no borra el historial guardado.
 */
function handleClear() {
  form.reset();
  syncInputModeUI();
  syncCustomLanguageUI();
  syncFormatHelp();
  syncCurlPreview();

  setSetupNotice("idle", "Formulario reiniciado. Listo para nueva transcripcion.");

  setResultStatus({
    loading: false,
    statusType: "idle",
    statusText: "Formulario reiniciado. Esperando una solicitud...",
  });

  activatePanel("tipeosPanel");
}

/**
 * copia la transcripcion del detalle seleccionado al portapapeles.
 */
async function handleCopy() {
  if (!state.lastResult) return;

  try {
    await navigator.clipboard.writeText(state.lastResult);

    setResultStatus({
      loading: false,
      statusType: "ok",
      statusText: "Transcripcion copiada al portapapeles.",
    });
  } catch {
    setResultStatus({
      loading: false,
      statusType: "error",
      statusText: "No se pudo copiar automaticamente. Copia manualmente.",
    });
  }
}

/**
 * descarga la salida seleccionada en un archivo .txt con nombre configurable.
 */
function handleDownload() {
  if (!state.lastResult) return;

  const blob = new Blob([state.lastResult], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const selectedEntry = state.selectedHistoryId
    ? getHistoryEntryById(state.selectedHistoryId)
    : null;
  const preferredName = selectedEntry?.outputFileName || resolveOutputFileName();
  const safeBaseName = sanitizeOutputBaseName(preferredName) || "transcripcion";
  const link = document.createElement("a");

  link.href = url;
  link.download = `${safeBaseName}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

/**
 * registra listeners de paginacion y seleccion de filas del historial.
 */
function bindHistoryEvents() {
  pageSizeSelect.addEventListener("change", () => {
    state.pageSize = Number.parseInt(pageSizeSelect.value, 10) || 10;
    state.currentPage = 1;
    renderHistory();
  });

  historyPagination.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const page = Number.parseInt(target.dataset.page || "", 10);
    if (!Number.isInteger(page)) return;

    state.currentPage = page;
    renderHistory();
  });

  historyTableBody.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const entryId = target.dataset.historyId;
    if (!entryId) return;

    selectHistoryEntry(entryId);
    renderHistoryTable();
  });
}

/**
 * registra todos los listeners de ui general.
 */
function bindEvents() {
  form.addEventListener("submit", handleSubmit);
  clearBtn.addEventListener("click", handleClear);
  copyBtn.addEventListener("click", handleCopy);
  downloadBtn.addEventListener("click", handleDownload);

  // el logo funciona como acceso directo al panel de tipeos.
  if (logoHomeBtn) {
    logoHomeBtn.addEventListener("click", () => {
      activatePanel("tipeosPanel");
    });
  }

  languageSelect.addEventListener("change", () => {
    syncCustomLanguageUI();
    syncConfigSummary();
    syncCurlPreview();
  });

  customLanguageInput.addEventListener("input", () => {
    syncConfigSummary();
    syncCurlPreview();
  });

  mockModeCheckbox.addEventListener("change", syncConfigSummary);

  urlInput.addEventListener("input", () => {
    syncConfigSummary();
    syncCurlPreview();
  });

  fileInput.addEventListener("change", () => {
    syncConfigSummary();
    syncCurlPreview();
  });

  if (outputNameInput) {
    outputNameInput.addEventListener("input", () => {
      syncConfigSummary();
      syncCurlPreview();
    });
  }

  formatSelect.addEventListener("change", () => {
    showFormatHelp();
    syncConfigSummary();
    syncCurlPreview();
    syncAnalysisPreview();
  });
  formatSelect.addEventListener("mouseenter", showFormatHelp);
  formatSelect.addEventListener("focus", showFormatHelp);
  formatSelect.addEventListener("blur", hideFormatHelp);

  if (formatGroup) {
    formatGroup.addEventListener("mouseleave", hideFormatHelp);
  }

  const modeRadios = document.querySelectorAll('input[name="inputMode"]');
  modeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      syncInputModeUI();
      syncConfigSummary();
      syncCurlPreview();
    });
  });

  sideItems.forEach((item) => {
    item.addEventListener("click", () => {
      activatePanel(item.dataset.target);
    });
  });

  bindHistoryEvents();
}

/**
 * inicializa estado y vista por defecto del panel.
 */
function init() {
  bindEvents();
  syncInputModeUI();
  syncCustomLanguageUI();
  syncFormatHelp();
  syncConfigSummary();
  syncCurlPreview();

  loadHistoryFromStorage();

  state.pageSize = Number.parseInt(pageSizeSelect.value, 10) || 10;
  state.currentPage = 1;

  if (state.history.length > 0) {
    selectHistoryEntry(state.history[0].id);
  } else {
    selectHistoryEntry(null);
  }

  renderHistory();
  syncAnalysisPreview();

  activatePanel("tipeosPanel");
  setSetupNotice("idle", "Listo para configurar y transcribir.");

  setResultStatus({
    loading: false,
    statusType: "idle",
    statusText: "Esperando una solicitud...",
  });
}

init();
