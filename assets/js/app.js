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
  LOCAL_OUTPUT_DIR:
    typeof window !== "undefined" && window.APP_CONFIG
      ? window.APP_CONFIG.LOCAL_OUTPUT_DIR || ""
      : "",
  TRANSCRIBE_PATH: "/audio/transcription/",
  REQUEST_TIMEOUT_MS: 2 * 60 * 60 * 1000,
};

/**
 * clave de almacenamiento local para mantener el historial
 * de tipeos entre recargas del navegador.
 */
const HISTORY_STORAGE_KEY = "privet_history_v1";
const MAX_HISTORY_ITEMS = 200;

/**
 * textos de apoyo para explicar el formato elegido.
 */
const FORMAT_DESCRIPTIONS = {
  flat: "Texto corrido, sin separación por hablantes.",
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
  selectedFiles: [],
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
const fileDropZone = document.getElementById("fileDropZone");
const filePickBtn = document.getElementById("filePickBtn");
const fileList = document.getElementById("fileList");
const languageSelect = document.getElementById("languageSelect");
const customLanguageInput = document.getElementById("customLanguage");
const formatGroup = document.getElementById("formatGroup");
const formatSelect = document.getElementById("formatSelect");
const formatHelpFloating = document.getElementById("formatHelpFloating");
const outputNameInput = document.getElementById("outputNameInput");
const mockModeCheckbox = document.getElementById("mockMode");
const saveHistoryCheckbox = document.getElementById("saveHistory");

const submitBtn = document.getElementById("submitBtn");
const clearBtn = document.getElementById("clearBtn");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

const setupNotice = document.getElementById("setupNotice");
const statusBox = document.getElementById("statusBox");
const loadingBox = document.getElementById("loadingBox");
const resultText = document.getElementById("resultText");
const endpointPreview = document.getElementById("endpointPreview");
const curlPreview = document.getElementById("curlPreview");
const analysisText = document.getElementById("analysisText");
const analysisMetrics = document.getElementById("analysisMetrics");
const analysisMetaList = document.getElementById("analysisMetaList");
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
    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
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

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function updateFileList() {
  if (!fileList) return;

  fileList.innerHTML = "";

  state.selectedFiles.forEach((file) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const size = document.createElement("small");

    name.textContent = file.name;
    size.textContent = formatFileSize(file.size);

    item.appendChild(name);
    item.appendChild(size);
    fileList.appendChild(item);
  });
}

function setSelectedFiles(files) {
  state.selectedFiles = Array.from(files || []).filter((file) => file instanceof File);
  updateFileList();
  syncConfigSummary();
  syncCurlPreview();
}

function clearSelectedFiles() {
  state.selectedFiles = [];
  if (fileInput) {
    fileInput.value = "";
  }
  updateFileList();
}

function setInputMode(mode) {
  const radio = document.querySelector(`input[name="inputMode"][value="${mode}"]`);
  if (radio instanceof HTMLInputElement) {
    radio.checked = true;
  }

  syncInputModeUI();
  syncConfigSummary();
  syncCurlPreview();
  syncAnalysisPreview();
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
    clearSelectedFiles();
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

function getFileBaseName(file) {
  if (!file?.name) return "";
  return sanitizeOutputBaseName(file.name.replace(/\.[^.]+$/, ""));
}

/**
 * devuelve el nombre de salida final (siempre con extension .txt).
 * - forpreview: evita timestamp variable para mostrar un ejemplo estable.
 */
function resolveOutputFileName({ forPreview = false, sourceFile = null, index = 0, total = 1 } = {}) {
  const baseFromInput = sanitizeOutputBaseName(outputNameInput?.value || "");
  if (baseFromInput) {
    if (total > 1 && sourceFile) {
      const fileBase = getFileBaseName(sourceFile) || `archivo-${index + 1}`;
      return `${baseFromInput}-${fileBase}.txt`;
    }

    return `${baseFromInput}.txt`;
  }

  if (forPreview) {
    return sourceFile ? `${getFileBaseName(sourceFile) || "archivo"}.txt` : "transcripcion-salida.txt";
  }

  if (sourceFile) {
    return `${getFileBaseName(sourceFile) || `archivo-${index + 1}`}.txt`;
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
  const previewFile = getInputMode() === "file" ? state.selectedFiles[0] : null;
  const outputFileName = resolveOutputFileName({ forPreview: true, sourceFile: previewFile });

  if (getInputMode() === "url") {
    const sourceUrl = urlInput.value.trim() || "https://www.youtube.com/watch?v=NHKIBoJkAMM";
    return `curl -X POST "${endpoint}" -F "url=${sourceUrl}" -F "language=${language}" >${outputFileName}`;
  }

  const sourceFile = state.selectedFiles[0]?.name || "<audio-o-video.mp4>";
  return `curl -X POST "${endpoint}" -F "file=@${sourceFile}" -F "language=${language}" >${outputFileName}`;
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
    FORMAT_DESCRIPTIONS[selectedFormat] || "Formato de salida de la transcripción.";

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

  if (state.selectedFiles.length === 0) {
    return "Sin archivos cargados";
  }

  if (state.selectedFiles.length === 1) {
    return state.selectedFiles[0].name;
  }

  return `${state.selectedFiles.length} archivos cargados`;
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
    `Carpeta local: ${CONFIG.LOCAL_OUTPUT_DIR || "segun servidor local"}`,
    `Modo mock: ${mockModeCheckbox.checked ? "Activado" : "Desactivado"}`,
    `Historial local: ${saveHistoryCheckbox?.checked ? "Activado" : "Desactivado"}`,
  ];

  configSummary.innerHTML = "";

  entries.forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    configSummary.appendChild(item);
  });
}

function createMetricItem(label, value) {
  const item = document.createElement("div");
  item.className = "metric-item";

  const valueNode = document.createElement("strong");
  valueNode.textContent = String(value);

  const labelNode = document.createElement("span");
  labelNode.textContent = label;

  item.appendChild(valueNode);
  item.appendChild(labelNode);
  return item;
}

function createMetaItem(label, value) {
  const term = document.createElement("dt");
  const description = document.createElement("dd");

  term.textContent = label;
  description.textContent = value;

  return [term, description];
}

function countDetectedSpeakers(text) {
  const matches = String(text || "").match(/\b(?:hablante|speaker)\s*\d+\b/gi) || [];
  const normalized = matches.map((match) => match.toLowerCase().replace(/\s+/g, " "));
  return new Set(normalized).size;
}

/**
 * mantiene el panel de análisis sincronizado con el resultado activo.
 */
function syncAnalysisPreview() {
  const selectedEntry = state.selectedHistoryId
    ? getHistoryEntryById(state.selectedHistoryId)
    : null;
  const text = selectedEntry?.text || state.lastResult || "";
  const normalizedText = text.trim();
  const words = normalizedText ? normalizedText.split(/\s+/).length : 0;
  const lines = normalizedText
    ? normalizedText.split(/\r?\n/).filter((line) => line.trim()).length
    : 0;
  const speakerCount = countDetectedSpeakers(normalizedText);

  if (analysisText) {
    analysisText.textContent = normalizedText
      ? buildPreview(normalizedText, 360)
      : "Selecciona o genera un resultado para ver su análisis.";
  }

  if (analysisMetrics) {
    analysisMetrics.innerHTML = "";
    [
      ["Palabras", words],
      ["Caracteres", normalizedText.length],
      ["Líneas", lines],
      ["Hablantes", speakerCount || "N/D"],
    ].forEach(([label, value]) => {
      analysisMetrics.appendChild(createMetricItem(label, value));
    });
  }

  if (analysisMetaList) {
    analysisMetaList.innerHTML = "";

    const metaEntries = selectedEntry
      ? [
          ["Fuente", selectedEntry.sourceLabel || "Sin fuente"],
          ["Idioma", selectedEntry.language || "auto"],
          ["Formato", selectedEntry.format || "flat"],
          ["Tipo", selectedEntry.executionType === "mock" ? "Mock" : "Real"],
          ["Estado", selectedEntry.persisted === false ? "Temporal" : "Guardado local"],
          ["Fecha", formatDateLabel(selectedEntry.createdAt)],
        ]
      : [
          ["Fuente", "Sin resultado seleccionado"],
          ["Idioma", resolveLanguageValue() || "Sin definir"],
          ["Formato", formatSelect.value || "flat"],
          ["Tipo", mockModeCheckbox.checked ? "Mock" : "Real"],
          ["Estado", saveHistoryCheckbox?.checked ? "Guardado local" : "Temporal"],
          ["Fecha", "Sin fecha"],
        ];

    metaEntries.forEach(([label, value]) => {
      const [term, description] = createMetaItem(label, value);
      analysisMetaList.appendChild(term);
      analysisMetaList.appendChild(description);
    });
  }
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
    const persistedHistory = state.history
      .filter((entry) => entry.persisted !== false)
      .slice(0, MAX_HISTORY_ITEMS);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(persistedHistory));
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
      .slice(0, MAX_HISTORY_ITEMS)
      .map((item) => ({
        id: String(item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        sourceMode: item.sourceMode === "file" ? "file" : "url",
        sourceLabel: String(item.sourceLabel || "Sin fuente"),
        language: String(item.language || "auto"),
        format: item.format === "diarized" ? "diarized" : "flat",
        executionType: item.executionType === "mock" ? "mock" : "real",
        outputFileName: String(item.outputFileName || ""),
        savedPath: String(item.savedPath || ""),
        text: String(item.text || ""),
        preview: String(item.preview || buildPreview(String(item.text || ""))),
        persisted: item.persisted === false ? false : true,
      }));
  } catch {
    state.history = [];
  }
}

/**
 * crea un nuevo registro historico al completar una transcripcion.
 */
function createHistoryEntry(transcriptionText, outputFileName, options = {}) {
  const mode = getInputMode();
  const sourceLabel =
    options.sourceLabel ||
    (mode === "url" ? urlInput.value.trim() : state.selectedFiles[0]?.name || "archivo");

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    sourceMode: mode,
    sourceLabel,
    language: resolveLanguageValue(),
    format: formatSelect.value,
    executionType: mockModeCheckbox.checked ? "mock" : "real",
    outputFileName: outputFileName || resolveOutputFileName(),
    savedPath: options.savedPath || "",
    text: transcriptionText,
    preview: buildPreview(transcriptionText),
    persisted: saveHistoryCheckbox?.checked !== false,
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
  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = state.isLoading || !selected;
  }

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

  historyMeta.textContent = `Total: ${total} resultados | Página ${state.currentPage}/${totalPages}`;
  if (clearHistoryBtn) {
    clearHistoryBtn.disabled = state.isLoading || total === 0;
  }

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
    typeCell.textContent =
      entry.persisted === false ? `${entry.executionType} / temporal` : entry.executionType;

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
  state.history = state.history.slice(0, MAX_HISTORY_ITEMS);
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
      return "La URL no tiene un formato válido.";
    }
  } else if (state.selectedFiles.length === 0) {
    return "Debes seleccionar o arrastrar al menos un archivo de audio o video.";
  }

  if (!language) {
    return "Debes indicar un código de idioma.";
  }

  if (!/^[a-z]{2,8}(-[a-z]{2,8})?$/i.test(language) && language !== "auto") {
    return "El código de idioma no es válido (ej: es, en, pt, fr-ca).";
  }

  if (!["flat", "diarized"].includes(format)) {
    return "Formato no válido. Debe ser flat o diarized.";
  }

  return null;
}

/**
 * crea el formdata respetando el contrato de la api.
 */
function buildPayload(outputFileName, sourceFile = null, { includeBackendExtras = false } = {}) {
  const formData = new FormData();
  const mode = getInputMode();

  if (mode === "url") {
    formData.append("url", urlInput.value.trim());
  } else {
    formData.append("file", sourceFile || state.selectedFiles[0]);
  }

  formData.append("language", resolveLanguageValue());

  if (includeBackendExtras) {
    formData.append("format", formatSelect.value);
    formData.append("output_filename", outputFileName || resolveOutputFileName());
  }

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
  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = loading || !state.selectedHistoryId;
  }
  if (clearHistoryBtn) {
    clearHistoryBtn.disabled = loading || state.history.length === 0;
  }

  loadingBox.classList.toggle("hidden", !loading);
  loadingBox.setAttribute("aria-hidden", loading ? "false" : "true");
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
    throw new Error("Mock: faltan datos para generar la transcripción.");
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
    "Esta es una transcripción simulada en modo mock.",
    `Idioma: ${language}.`,
    `Fuente: ${sourceLabel}.`,
    "Activa el endpoint real para obtener resultados de Whisper.",
  ].join(" ");
}

function normalizeTranscriptionResponse(responseText) {
  const rawText = String(responseText || "");

  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed === "string") return parsed;

    if (parsed && typeof parsed === "object") {
      const candidates = [
        parsed.text,
        parsed.transcription,
        parsed.transcript,
        parsed.result,
        parsed.output,
      ];
      const textValue = candidates.find((value) => typeof value === "string" && value.trim());
      if (textValue) return textValue;
    }
  } catch {
    // el backend actual responde texto plano; JSON es solo compatibilidad extra.
  }

  return rawText;
}

function decodeResponseHeader(value) {
  if (!value) return "";

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function shouldSendLocalSaveHeaders() {
  return (
    typeof window !== "undefined" &&
    CONFIG.API_BASE_URL === window.location.origin &&
    !mockModeCheckbox.checked
  );
}

/**
 * solicitud real al backend con timeout para evitar bloqueos largos.
 */
async function realTranscriptionRequest(formData, outputFileName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  const requestOptions = {
    method: "POST",
    body: formData,
    signal: controller.signal,
  };

  if (shouldSendLocalSaveHeaders()) {
    requestOptions.headers = {
      "X-Privet-Output-Filename": encodeURIComponent(outputFileName || "transcripcion.txt"),
    };
  }

  try {
    const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.TRANSCRIBE_PATH}`, requestOptions);

    if (!response.ok) {
      const possibleError = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status}. ${possibleError || "El backend rechazó la solicitud."}`
      );
    }

    const responseText = await response.text();
    return {
      text: normalizeTranscriptionResponse(responseText),
      savedPath: decodeResponseHeader(response.headers.get("X-Privet-Saved-Path")),
      saveError: decodeResponseHeader(response.headers.get("X-Privet-Save-Error")),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("La solicitud excedió el tiempo máximo de espera.");
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

  setSetupNotice("loading", "Configuración válida. Iniciando transcripción...");

  setResultStatus({
    loading: true,
    statusType: "loading",
    statusText: "Enviando solicitud...",
  });

  const mode = getInputMode();
  const jobs = mode === "file" ? state.selectedFiles : [null];
  const useMock = mockModeCheckbox.checked;
  const savedPaths = [];
  const saveErrors = [];
  let completedCount = 0;

  try {
    for (const [index, sourceFile] of jobs.entries()) {
      const outputFileName = resolveOutputFileName({
        sourceFile,
        index,
        total: jobs.length,
      });
      const sourceLabel = sourceFile?.name || urlInput.value.trim();
      const payload = buildPayload(outputFileName, sourceFile, {
        includeBackendExtras: useMock,
      });

      setResultStatus({
        loading: true,
        statusType: "loading",
        statusText:
          jobs.length > 1
            ? `Transcribiendo ${index + 1}/${jobs.length}: ${sourceLabel}`
            : `Transcribiendo: ${sourceLabel}`,
      });

      const responseResult = useMock
        ? { text: await mockTranscriptionRequest(payload), savedPath: "", saveError: "" }
        : await realTranscriptionRequest(payload, outputFileName);
      const resultTextValue = responseResult.text || "";

      if (responseResult.savedPath) {
        savedPaths.push(responseResult.savedPath);
      }
      if (responseResult.saveError) {
        saveErrors.push(responseResult.saveError);
      }

      const historyEntry = createHistoryEntry(resultTextValue, outputFileName, {
        sourceLabel,
        savedPath: responseResult.savedPath,
      });
      addHistoryEntry(historyEntry);
      completedCount += 1;
    }

    const savedMessage =
      savedPaths.length > 0
        ? ` Guardado en: ${savedPaths.length === 1 ? savedPaths[0] : CONFIG.LOCAL_OUTPUT_DIR}.`
        : "";
    const saveWarning =
      saveErrors.length > 0 ? ` No se pudo guardar localmente: ${saveErrors[0]}` : "";
    const transcriptionLabel = completedCount === 1 ? "transcripción lista" : "transcripciones listas";
    const okMessage = useMock
      ? "Transcripción mock generada correctamente."
      : `${completedCount} ${transcriptionLabel}.${savedMessage}${saveWarning}`;

    setSetupNotice("ok", okMessage);

    setResultStatus({
      loading: false,
      statusType: "ok",
      statusText: okMessage,
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
  clearSelectedFiles();
  syncInputModeUI();
  syncCustomLanguageUI();
  syncFormatHelp();
  syncCurlPreview();

  setSetupNotice("idle", "Formulario reiniciado. Listo para nueva transcripción.");

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
      statusText: "Transcripción copiada al portapapeles.",
    });
  } catch {
    setResultStatus({
      loading: false,
      statusType: "error",
      statusText: "No se pudo copiar automáticamente. Copia manualmente.",
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
 * elimina solo el registro seleccionado del historial visible.
 */
function handleDeleteSelected() {
  if (!state.selectedHistoryId) return;

  const selectedIndex = state.history.findIndex((entry) => entry.id === state.selectedHistoryId);
  if (selectedIndex < 0) return;

  state.history.splice(selectedIndex, 1);

  const nextEntry = state.history[Math.min(selectedIndex, state.history.length - 1)] || null;
  state.selectedHistoryId = nextEntry ? nextEntry.id : null;

  saveHistoryToStorage();

  if (nextEntry) {
    selectHistoryEntry(nextEntry.id);
  } else {
    selectHistoryEntry(null);
  }

  renderHistory();

  setResultStatus({
    loading: false,
    statusType: "ok",
    statusText: "Resultado eliminado del historial.",
  });
}

/**
 * limpia historial local y resultados temporales de la sesión.
 */
function handleClearHistory() {
  if (state.history.length === 0) return;

  const shouldClear = window.confirm("¿Borrar todo el historial de este navegador?");
  if (!shouldClear) return;

  state.history = [];
  state.selectedHistoryId = null;
  state.currentPage = 1;

  saveHistoryToStorage();
  selectHistoryEntry(null);
  renderHistory();

  setResultStatus({
    loading: false,
    statusType: "idle",
    statusText: "Historial borrado. Esperando una solicitud...",
  });
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
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener("click", handleDeleteSelected);
  }
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", handleClearHistory);
  }

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
    syncAnalysisPreview();
  });

  customLanguageInput.addEventListener("input", () => {
    syncConfigSummary();
    syncCurlPreview();
    syncAnalysisPreview();
  });

  mockModeCheckbox.addEventListener("change", () => {
    syncConfigSummary();
    syncAnalysisPreview();
  });
  if (saveHistoryCheckbox) {
    saveHistoryCheckbox.addEventListener("change", () => {
      syncConfigSummary();
      syncAnalysisPreview();
    });
  }

  urlInput.addEventListener("input", () => {
    syncConfigSummary();
    syncCurlPreview();
  });

  fileInput.addEventListener("change", () => {
    setSelectedFiles(fileInput.files);
  });

  if (filePickBtn) {
    filePickBtn.addEventListener("click", () => {
      setInputMode("file");
      fileInput.click();
    });
  }

  if (fileDropZone) {
    fileDropZone.addEventListener("click", (event) => {
      if (event.target === filePickBtn) return;
      setInputMode("file");
      fileInput.click();
    });

    fileDropZone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setInputMode("file");
      fileInput.click();
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      fileDropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        fileDropZone.classList.add("is-dragover");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      fileDropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        fileDropZone.classList.remove("is-dragover");
      });
    });

    fileDropZone.addEventListener("drop", (event) => {
      const droppedFiles = event.dataTransfer?.files;
      if (!droppedFiles || droppedFiles.length === 0) return;

      setInputMode("file");
      setSelectedFiles(droppedFiles);
    });
  }

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
      syncAnalysisPreview();
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
