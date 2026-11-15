const state = {
  currentPath: "",
  parentPath: null,
  items: [],
  visibleItems: [],
  selected: new Set(),
  primary: null,
  locations: [],
  config: { destinations: {}, labels: {} },
  filter: "all",
  query: "",
  zoomMode: "fit",
  zoomScale: 1,
  pan: { x: 0, y: 0 },
  dragging: false,
  dragOrigin: null,
  goChord: false,
  toastTimer: null,
  renderLimit: 180,
  recentFolders: JSON.parse(localStorage.getItem("quick-sort-recent-folders") || "[]"),
  dragMoved: false,
  selectionAnchor: null,
  hoverTimer: null,
  hoverPath: null,
  review: {},
  reviewFilter: "all",
  compareZoom: 1,
  indexTimer: null,
  sortBy: localStorage.getItem("quick-sort-sort-by") || "name",
  sortDirection: localStorage.getItem("quick-sort-sort-direction") || "asc",
  groupBy: localStorage.getItem("quick-sort-group-by") || "none",
  duplicateGroups: [],
  duplicateJob: null,
  duplicateTimer: null,
  duplicateNotified: new Set(),
  duplicateCompareGroup: null,
  duplicateCompareZoom: 1,
  locationTree: new Map(),
  expandedLocations: new Set(),
  preloadedNextPath: null,
  preloadController: null,
  seekPreviewTimer: null,
  mediaStates: JSON.parse(localStorage.getItem("quick-sort-media-states") || "{}"),
  mediaSaveTimer: null,
  audioAnalysis: null,
  sprite: null,
  scrub: JSON.parse(localStorage.getItem("quick-sort-scrub") || '{"normal":5,"fast":30,"fine":1}'),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const imagePreview = $("#image-preview");
const videoPreview = $("#video-preview");
const stage = $("#stage");
const hoverPreview = $("#hover-preview");
const hoverPreviewImage = $("#hover-preview-image");
const hoverPreviewVideo = $("#hover-preview-video");
const nextVideoPreload = $("#next-video-preload");

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function endpoint(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return `${url.pathname}${url.search}`;
}

async function api(path, options = {}) {
  const request = () => fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options,
  });
  let response;
  try {
    response = await request();
  } catch (error) {
    const method = (options.method || "GET").toUpperCase();
    if (method !== "GET") throw new Error("The local server was interrupted before the action finished. Nothing was retried; please try again.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { response = await request(); }
    catch (_) { throw new Error("The local server is restarting or unavailable. Please try again in a moment."); }
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).detail || message; } catch (_) { /* no JSON body */ }
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function currentMediaState() {
  if (!state.primary) return { resume: 0, loopIn: null, loopOut: null, loop: false, markers: [] };
  return state.mediaStates[state.primary.path] || { resume: 0, loopIn: null, loopOut: null, loop: false, markers: [] };
}

function saveMediaState(changes = {}) {
  if (!state.primary || !["video", "audio"].includes(state.primary.preview_type)) return;
  const record = { ...currentMediaState(), ...changes, updated: Date.now() };
  state.mediaStates[state.primary.path] = record;
  const entries = Object.entries(state.mediaStates).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0)).slice(0, 500);
  state.mediaStates = Object.fromEntries(entries);
  clearTimeout(state.mediaSaveTimer);
  state.mediaSaveTimer = setTimeout(() => localStorage.setItem("quick-sort-media-states", JSON.stringify(state.mediaStates)), 150);
  if (Object.keys(changes).some((key) => key !== "resume")) renderTimelineOverlays();
}

function renderTimelineOverlays() {
  const overlays = $("#timeline-overlays");
  const duration = videoPreview.duration;
  if (!Number.isFinite(duration) || !duration) { overlays.innerHTML = ""; return; }
  const record = currentMediaState();
  const parts = [];
  (state.audioAnalysis?.silence || []).forEach(([start, end]) => parts.push(`<span class="silence-range" style="left:${start / duration * 100}%;width:${Math.max(0, end - start) / duration * 100}%" title="Silent ${formatTime(start)}–${formatTime(end)}"></span>`));
  if (Number.isFinite(record.loopIn) && Number.isFinite(record.loopOut) && record.loopOut > record.loopIn) {
    parts.push(`<span class="loop-range" style="left:${record.loopIn / duration * 100}%;width:${(record.loopOut - record.loopIn) / duration * 100}%"></span>`);
  }
  (record.markers || []).forEach((marker, index) => parts.push(`<button class="timeline-marker" data-marker-index="${index}" style="left:${marker.time / duration * 100}%" title="${escapeHtml(marker.label || `Bookmark ${index + 1}`)} · ${formatTime(marker.time)}"></button>`));
  overlays.innerHTML = parts.join("");
  $$('[data-marker-index]').forEach((button) => button.addEventListener("click", () => {
    videoPreview.currentTime = record.markers[Number(button.dataset.markerIndex)].time;
  }));
  $("#loop-button").classList.toggle("active", Boolean(record.loop));
}

function setLoopPoint(kind) {
  if (!Number.isFinite(videoPreview.duration)) return;
  const record = currentMediaState();
  const value = videoPreview.currentTime;
  if (kind === "in") saveMediaState({ loopIn: value, loopOut: Number.isFinite(record.loopOut) && record.loopOut > value ? record.loopOut : null, loop: false });
  else saveMediaState({ loopOut: value, loopIn: Number.isFinite(record.loopIn) && record.loopIn < value ? record.loopIn : null, loop: false });
  showToast(`${kind === "in" ? "In" : "Out"} point set at ${formatTime(value)}`);
}

function toggleLoopRange() {
  const record = currentMediaState();
  if (!Number.isFinite(record.loopIn) || !Number.isFinite(record.loopOut) || record.loopOut <= record.loopIn) {
    showToast("Set an In point and an Out point first"); return;
  }
  saveMediaState({ loop: !record.loop });
}

function addBookmark() {
  if (!Number.isFinite(videoPreview.duration)) return;
  const record = currentMediaState();
  const markers = [...(record.markers || []), { time: videoPreview.currentTime, label: `Bookmark ${(record.markers || []).length + 1}` }].sort((a, b) => a.time - b.time);
  saveMediaState({ markers });
  showToast(`Bookmark added at ${formatTime(videoPreview.currentTime)}`);
}

function drawWaveform() {
  const canvas = $("#waveform");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const samples = state.audioAnalysis?.waveform || [];
  if (!samples.length) return;
  context.fillStyle = "rgba(76, 179, 240, .78)";
  const middle = canvas.height / 2;
  samples.forEach((value, index) => {
    const x = index / samples.length * canvas.width;
    const height = Math.max(1, value * canvas.height * .9);
    context.fillRect(x, middle - height / 2, Math.max(1, canvas.width / samples.length), height);
  });
}

async function loadAudioAnalysis(path) {
  state.audioAnalysis = null;
  drawWaveform();
  try {
    const analysis = await api(endpoint("/api/audio-analysis", { path }));
    if (state.primary?.path !== path) return;
    state.audioAnalysis = analysis;
    drawWaveform(); renderTimelineOverlays();
  } catch (_) { /* Some media containers do not contain an audio stream. */ }
}

function prepareVideoSprite(path) {
  state.sprite = null;
  if (!Number.isFinite(videoPreview.duration) || videoPreview.duration < 60) return;
  const image = new Image();
  const url = endpoint("/api/video-sprite", { path, count: 40 });
  image.onload = () => { if (state.primary?.path === path) state.sprite = { url, count: 40, columns: 10, rows: 4 }; };
  image.src = url;
}

function shortLabel(name) {
  const matches = name.match(/[A-Za-z0-9]/g) || ["•"];
  return matches.slice(0, 2).join("").toUpperCase();
}

const DEFAULT_KEYBINDINGS = {
  previous: "ArrowUp", next: "ArrowDown", open_folder: "Enter", filter: "/", palette: "Ctrl+K", shortcuts: "?",
  play: "Space", zoom_in: "+", zoom_out: "-", fit: "0", mute: "M", fullscreen: "F",
  speed_down: "[", speed_up: "]", jump_back: "J", jump_forward: "L", jump_back_30: "Shift+J", jump_forward_30: "Shift+L",
  keep: "K", reject: "X", trash: "Delete", undo: "Ctrl+Z",
};

function bindingFor(action, fallback = "") {
  return state.config.keybindings?.[action] || DEFAULT_KEYBINDINGS[action] || fallback;
}

function shortcutFromEvent(event) {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return null;
  let key = event.key === " " ? "Space" : event.key;
  if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && /^[A-Z]$/.test(key)) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function shortcutDefinitions() {
  const destinations = Object.keys(state.config.destinations || {}).slice(0, 9).map((key, index) => ({ id: `move:${key}`, label: `Move to ${state.config.labels?.[key] || key}`, fallback: String(index + 1) }));
  return [
    { title: "Navigate", actions: [
      { id: "previous", label: "Previous file" }, { id: "next", label: "Next file" }, { id: "open_folder", label: "Open folder" },
      { id: "filter", label: "Filter files" }, { id: "palette", label: "Command palette" }, { id: "shortcuts", label: "Keyboard map" },
    ] },
    { title: "Inspect", actions: [
      { id: "play", label: "Play / pause" }, { id: "zoom_in", label: "Zoom in" }, { id: "zoom_out", label: "Zoom out" }, { id: "fit", label: "Fit" },
      { id: "mute", label: "Mute" }, { id: "fullscreen", label: "Fullscreen" }, { id: "speed_down", label: "Slower" }, { id: "speed_up", label: "Faster" },
      { id: "jump_back", label: "Back 10 seconds" }, { id: "jump_forward", label: "Forward 10 seconds" },
      { id: "jump_back_30", label: "Back 30 seconds" }, { id: "jump_forward_30", label: "Forward 30 seconds" },
    ] },
    { title: "Review & sort", actions: [
      { id: "keep", label: "Keep and advance" }, { id: "reject", label: "Reject and advance" }, { id: "trash", label: "Recycle Bin" }, { id: "undo", label: "Undo move" }, ...destinations,
    ] },
  ];
}

function renderShortcutEditor() {
  $("#shortcut-editor").innerHTML = shortcutDefinitions().map((section) => `
    <section class="shortcut-section"><h3>${escapeHtml(section.title)}</h3>${section.actions.map((action) => `
      <label class="shortcut-row"><span>${escapeHtml(action.label)}</span><input readonly data-shortcut="${escapeHtml(action.id)}" value="${escapeHtml(bindingFor(action.id, action.fallback || ""))}" aria-label="Shortcut for ${escapeHtml(action.label)}"></label>
    `).join("")}</section>
  `).join("");
  $$('[data-shortcut]').forEach((input) => input.addEventListener("keydown", (event) => {
    event.preventDefault(); event.stopPropagation();
    const shortcut = shortcutFromEvent(event);
    if (shortcut) input.value = shortcut;
  }));
}

function updateShortcutLabels() {
  $("#keep-button kbd").textContent = bindingFor("keep");
  $("#reject-button kbd").textContent = bindingFor("reject");
  $("#quick-trash-button kbd").textContent = bindingFor("trash");
}

async function loadInitialData() {
  const data = await api("/api/locations");
  state.locations = data.locations;
  state.config = data.config;
  renderLocations();
  renderDestinations();
  renderSettings();
  renderShortcutEditor();
  updateShortcutLabels();
  const downloads = state.locations.find((location) => location.name === "Downloads");
  const linkedPath = new URLSearchParams(window.location.search).get("path");
  const rememberedPath = localStorage.getItem("quick-sort-last-path");
  await loadFolder(linkedPath || rememberedPath || downloads?.path || state.locations[0]?.path);
  await resumeDuplicateJobs();
}

function renderLocations() {
  const nodeMarkup = (location, depth = 0, root = false) => {
    const key = normalizedPath(location.path);
    const expanded = state.expandedLocations.has(key);
    const children = state.locationTree.get(key) || [];
    const canExpand = location.has_children !== false && location.available !== false;
    return `<div class="location-node" data-depth="${depth}">
      <div class="nav-location-row" style="--location-depth:${depth}">
        <button class="location-disclosure ${canExpand ? "" : "empty"}" data-expand-location="${escapeHtml(location.path)}" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(location.name)}">${expanded ? "⌄" : "›"}</button>
        <button class="nav-item ${normalizedPath(location.path) === normalizedPath(state.currentPath) ? "active" : ""} ${location.available === false ? "unavailable" : ""}"
          data-path="${escapeHtml(location.path)}" data-short="${escapeHtml(shortLabel(location.name))}" title="${escapeHtml(location.path)}">
          <span>${escapeHtml(location.name)}</span>${location.hotkey ? `<kbd>G ${escapeHtml(location.hotkey)}</kbd>` : ""}
        </button>
        ${root && location.source === "saved" ? `<button class="remove-location" data-remove-location="${escapeHtml(location.path)}" title="Remove saved folder" aria-label="Remove ${escapeHtml(location.name)}">×</button>` : ""}
      </div>
      ${expanded ? `<div class="location-children">${children.map((child) => nodeMarkup(child, depth + 1)).join("")}</div>` : ""}
    </div>`;
  };
  $("#locations").innerHTML = state.locations.map((location) => nodeMarkup(location, 0, true)).join("");
  $$("#locations .nav-item").forEach((button) => button.addEventListener("click", () => {
    if (button.classList.contains("unavailable")) return showToast("This drive or folder is not currently available");
    loadFolder(button.dataset.path);
  }));
  $$('[data-expand-location]').forEach((button) => button.addEventListener("click", () => toggleLocationFolder(button.dataset.expandLocation)));
  $$('[data-remove-location]').forEach((button) => button.addEventListener("click", () => removeSavedLocation(button.dataset.removeLocation)));
  bindLocationDrops();
}

async function toggleLocationFolder(path) {
  const key = normalizedPath(path);
  if (state.expandedLocations.has(key)) {
    state.expandedLocations.delete(key);
    renderLocations();
    return;
  }
  try {
    if (!state.locationTree.has(key)) {
      const response = await api(endpoint("/api/subfolders", { path }));
      state.locationTree.set(key, response.folders || []);
    }
    state.expandedLocations.add(key);
    renderLocations();
  } catch (error) { showToast(error.message); }
}

function bindLocationDrops() {
  $$("#locations .nav-item[data-path]").forEach((button) => {
    button.addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes("application/x-quick-sort-paths")) { event.preventDefault(); button.classList.add("drop-target"); } });
    button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drop-target");
      const paths = JSON.parse(event.dataTransfer.getData("application/x-quick-sort-paths") || "[]");
      if (paths.length) movePathsToDestination(paths, button.dataset.path);
    });
  });
}

async function savePickedLocation(path) {
  const saved = [...(state.config.saved_locations || [])];
  if (!saved.some((location) => normalizedPath(location.path) === normalizedPath(path))) {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
    saved.push({ name, path });
  }
  state.config = await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({ destinations: state.config.destinations, labels: state.config.labels, keybindings: state.config.keybindings, saved_locations: saved }),
  });
  const data = await api("/api/locations");
  state.locations = data.locations;
  renderLocations();
}

async function removeSavedLocation(path) {
  const saved = (state.config.saved_locations || []).filter((location) => normalizedPath(location.path) !== normalizedPath(path));
  try {
    state.config = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ destinations: state.config.destinations, labels: state.config.labels, keybindings: state.config.keybindings, saved_locations: saved }),
    });
    const data = await api("/api/locations");
    state.locations = data.locations;
    renderLocations();
    showToast("Saved folder removed");
  } catch (error) { showToast(error.message); }
}

function renderDestinations() {
  const defaults = { apps: "Apps", videos: "Media", images: "Images", files: "Files" };
  const keys = [...new Set([...Object.keys(state.config.destinations || {}), ...Object.keys(defaults)])].slice(0, 9);
  const labels = { ...defaults, ...(state.config.labels || {}) };
  const markup = keys.map((category, index) => `
    <button class="destination-item" draggable="true" data-move="${category}" data-short="${index + 1}">
      <span>${escapeHtml(labels[category] || category)}</span><kbd>${escapeHtml(bindingFor(`move:${category}`, String(index + 1)))}</kbd><span class="quick-edit" data-edit-destination="${category}" title="Choose folder">•••</span>
    </button>
  `).join("");
  $("#destinations").innerHTML = markup;
  $("#action-destinations").innerHTML = keys.map((category, index) => `
    <button data-move="${category}" title="${escapeHtml(state.config.destinations?.[category] || "")}">
      <span data-role="destination-label">${escapeHtml(labels[category] || category)}</span><kbd>${escapeHtml(bindingFor(`move:${category}`, String(index + 1)))}</kbd>
    </button>
  `).join("");
  $$("[data-move]").forEach((button) => {
    const category = button.dataset.move;
    const label = labels[category] || category;
    const labelNode = button.querySelector('[data-role="destination-label"]');
    if (labelNode) labelNode.textContent = label;
    button.title = state.config.destinations?.[category] ? `${label} → ${state.config.destinations[category]}` : `Set ${label} folder`;
  });
  $$("#destinations [data-move]").forEach(bindMoveButton);
  $$("#action-destinations [data-move]").forEach(bindMoveButton);
  bindDestinationDrops();
}

function renderSettings() {
  const defaults = { apps: "Apps", videos: "Media", images: "Images", files: "Files" };
  const keys = [...new Set([...Object.keys(state.config.destinations || {}), ...Object.keys(defaults)])].slice(0, 9);
  $("#settings-fields").innerHTML = keys.map((category, index) => `
    <div class="settings-field" data-settings-category="${category}">
      <label for="label-${category}">${index + 1}</label>
      <input id="label-${category}" data-destination-label="${category}" aria-label="Shortcut ${index + 1} name" value="${escapeHtml(state.config.labels?.[category] || defaults[category] || category)}">
      <input id="destination-${category}" data-destination="${category}" value="${escapeHtml(state.config.destinations?.[category] || "")}">
      <button type="button" data-browse-destination="${category}">Choose…</button>
    </div>
  `).join("");
  $$('[data-browse-destination]').forEach((button) => button.addEventListener("click", () => chooseDestination(button.dataset.browseDestination, false)));
  $("#scrub-normal").value = state.scrub.normal ?? 5;
  $("#scrub-fast").value = state.scrub.fast ?? 30;
  $("#scrub-fine").value = state.scrub.fine ?? 1;
}

function bindDestinationDrops() {
  $$("[data-move]").forEach((button) => {
    if (button.closest("#destinations")) button.addEventListener("dragstart", (event) => event.dataTransfer.setData("application/x-quick-sort-destination", button.dataset.move));
    button.addEventListener("dragover", (event) => { event.preventDefault(); button.classList.add("drop-target"); });
    button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drop-target");
      const sourceKey = event.dataTransfer.getData("application/x-quick-sort-destination");
      if (sourceKey && sourceKey !== button.dataset.move) {
        reorderDestinations(sourceKey, button.dataset.move);
        return;
      }
      const paths = JSON.parse(event.dataTransfer.getData("application/x-quick-sort-paths") || "[]");
      if (paths.length) {
        state.selected = new Set(paths);
        moveSelected(button.dataset.move);
      }
    });
  });
}

async function reorderDestinations(sourceKey, targetKey) {
  const keys = Object.keys(state.config.destinations);
  keys.splice(keys.indexOf(sourceKey), 1);
  keys.splice(keys.indexOf(targetKey), 0, sourceKey);
  const destinations = Object.fromEntries(keys.map((key) => [key, state.config.destinations[key]]));
  const labels = Object.fromEntries(keys.map((key) => [key, state.config.labels[key] || key]));
  try {
    state.config = await api("/api/config", { method: "PUT", body: JSON.stringify({ destinations, labels }) });
    renderDestinations(); renderSettings();
  } catch (error) { showToast(error.message); }
}

function bindMoveButton(button) {
  if (button.dataset.moveBound) return;
  button.dataset.moveBound = "true";
  button.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-destination]");
    if (edit) {
      event.stopPropagation();
      chooseDestination(edit.dataset.editDestination, true);
      return;
    }
    moveSelected(button.dataset.move);
  });
}

async function chooseDestination(category, saveImmediately) {
  try {
    const result = await api("/api/pick-folder", { method: "POST", body: "{}" });
    if (!result.path) return;
    if (!saveImmediately) {
      $(`[data-destination="${category}"]`).value = result.path;
      return;
    }
    const destinations = { ...state.config.destinations, [category]: result.path };
    state.config = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ destinations, labels: state.config.labels }),
    });
    renderDestinations();
    renderSettings();
    showToast(`Shortcut ${category} now sends to ${result.path}`);
  } catch (error) { showToast(error.message); }
}

async function loadFolder(path) {
  if (!path) return;
  try {
    $("#folder-name").textContent = "Loading…";
    $("#file-count").textContent = "Reading this folder";
    $("#file-list").innerHTML = '<div class="empty-list">Indexing files and preparing thumbnails…</div>';
    const [data, reviewData] = await Promise.all([
      api(endpoint("/api/list", { path })),
      api(endpoint("/api/review", { folder: path })),
    ]);
    state.currentPath = data.path;
    localStorage.setItem("quick-sort-last-path", data.path);
    state.recentFolders = [data.path, ...state.recentFolders.filter((value) => value !== data.path)].slice(0, 8);
    localStorage.setItem("quick-sort-recent-folders", JSON.stringify(state.recentFolders));
    state.parentPath = data.parent;
    state.items = data.items;
    state.review = reviewData.records || {};
    state.selected.clear();
    state.primary = null;
    state.renderLimit = 180;
    renderLocations();
    renderBreadcrumbs();
    renderFiles();
    showPreview(null);
    updateProgress();
    api("/api/index", { method: "POST", body: JSON.stringify({ path: data.path }) }).catch(() => {});
    monitorIndex();
    const rememberedSelection = localStorage.getItem(`quick-sort-selection:${data.path}`);
    if (rememberedSelection && state.items.some((item) => item.path === rememberedSelection)) selectItem(rememberedSelection);
  } catch (error) {
    showToast(error.message);
  }
}

function pathParts(path) {
  const separator = path.includes("\\") ? "\\" : "/";
  const rawParts = path.split(/[\\/]/).filter(Boolean);
  if (separator === "\\") {
    return rawParts.map((name, index) => ({
      name,
      path: index === 0 && /^[A-Za-z]:$/.test(name) ? `${name}\\` : rawParts.slice(0, index + 1).join("\\"),
    }));
  }
  return rawParts.map((name, index) => ({ name, path: `/${rawParts.slice(0, index + 1).join("/")}` }));
}

function renderBreadcrumbs() {
  const parts = pathParts(state.currentPath);
  $("#breadcrumbs").innerHTML = parts.map((part, index) => `
    ${index ? '<span class="breadcrumb-separator">/</span>' : ""}
    <button class="breadcrumb" data-path="${escapeHtml(part.path)}">${escapeHtml(part.name)}</button>
  `).join("");
  $$("#breadcrumbs .breadcrumb").forEach((button) => button.addEventListener("click", () => loadFolder(button.dataset.path)));
  $("#folder-name").textContent = parts.at(-1)?.name || state.currentPath;
  $("#parent-folder").disabled = !state.parentPath;
}

function editDistance(left, right) {
  const previous = [...Array(right.length + 1).keys()];
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]; previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function fuzzyTokenScore(query, candidate) {
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80;
  if (candidate.includes(query)) return 65;
  let position = 0;
  for (const character of candidate) if (character === query[position]) position += 1;
  if (position === query.length) return 42;
  const distance = editDistance(query, candidate);
  return distance <= Math.max(1, Math.floor(query.length * .3)) ? 30 - distance : 0;
}

function searchScore(item) {
  if (!state.query.trim()) return 1;
  const record = state.review[item.path] || {};
  const synonyms = {
    images: "image images photo photos picture pictures jpg jpeg png", videos: "video videos movie movies clip clips media mp4 mov",
    apps: "app apps application installer exe msi", files: "file files document documents other", keep: "keep kept favorite favorites approved",
    reject: "reject rejected discard review", folder: "folder directory",
  };
  const text = [item.name, item.kind, item.extension, item.category, record.status, record.rating ? `rating ${record.rating} ${record.rating}-star` : "", ...(record.tags || []), synonyms[item.category] || "", synonyms[record.status] || ""].join(" ").toLowerCase();
  const candidates = text.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
  const queries = state.query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const query of queries) {
    const best = Math.max(0, ...candidates.map((candidate) => fuzzyTokenScore(query, candidate)));
    if (!best) return 0;
    total += best;
  }
  return total;
}

function itemMatches(item) {
  const queryMatch = searchScore(item) > 0;
  const categoryMatch = state.filter === "all" || item.is_dir || item.category === state.filter;
  const status = state.review[item.path]?.status || "unreviewed";
  const reviewMatch = state.reviewFilter === "all" || (!item.is_dir && status === state.reviewFilter);
  return queryMatch && categoryMatch && reviewMatch;
}

function groupLabel(item) {
  if (item.is_dir) return "Folders";
  const record = state.review[item.path] || {};
  if (state.groupBy === "type") return item.category === "videos" && item.preview_type === "audio" ? "Audio" : item.kind;
  if (state.groupBy === "date") return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(item.modified * 1000));
  if (state.groupBy === "rating") return record.rating ? `${record.rating} star${record.rating === 1 ? "" : "s"}` : "Unrated";
  if (state.groupBy === "status") return (record.status || "unreviewed").replace(/^./, (letter) => letter.toUpperCase());
  if (state.groupBy === "extension") return item.extension ? item.extension.slice(1).toUpperCase() : "No extension";
  if (state.groupBy === "size") {
    if (item.size < 1024 * 1024) return "Under 1 MB";
    if (item.size < 100 * 1024 * 1024) return "1–100 MB";
    if (item.size < 1024 * 1024 * 1024) return "100 MB–1 GB";
    return "Over 1 GB";
  }
  return "";
}

function sortItems(items) {
  const direction = state.sortDirection === "desc" ? -1 : 1;
  const statusOrder = { keep: 0, unreviewed: 1, reject: 2 };
  const value = (item) => {
    const record = state.review[item.path] || {};
    if (state.sortBy === "modified") return item.modified;
    if (state.sortBy === "size") return item.size;
    if (state.sortBy === "type") return `${item.category}:${item.kind}`;
    if (state.sortBy === "rating") return record.rating || 0;
    if (state.sortBy === "status") return statusOrder[record.status || "unreviewed"];
    return item.name;
  };
  return [...items].sort((left, right) => {
    if (state.groupBy !== "none") {
      const groupCompare = groupLabel(left).localeCompare(groupLabel(right), undefined, { numeric: true });
      if (groupCompare) return groupCompare;
    }
    if (left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1;
    const leftValue = value(left); const rightValue = value(right);
    const comparison = typeof leftValue === "number" ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" });
    return comparison * direction;
  });
}

function hideHoverPreview() {
  clearTimeout(state.hoverTimer);
  state.hoverTimer = null;
  state.hoverPath = null;
  hoverPreview.classList.add("hidden");
  hoverPreview.setAttribute("aria-hidden", "true");
  hoverPreviewImage.classList.add("hidden");
  hoverPreviewImage.removeAttribute("src");
  hoverPreviewVideo.pause();
  hoverPreviewVideo.classList.add("hidden");
  hoverPreviewVideo.removeAttribute("src");
  hoverPreviewVideo.removeAttribute("poster");
  hoverPreviewVideo.load();
}

function queueHoverPreview(item, row) {
  hideHoverPreview();
  const isImage = item.category === "images";
  const isVideo = item.category === "videos" && item.kind.toLowerCase().includes("video");
  if (!isImage && !isVideo) return;
  state.hoverTimer = setTimeout(() => {
    if (!row.isConnected || !row.matches(":hover")) return;
    state.hoverPath = item.path;
    const rect = row.getBoundingClientRect();
    const width = Math.min(640, window.innerWidth - 28);
    const left = Math.min(rect.right + 14, window.innerWidth - width - 14);
    const top = Math.max(14, Math.min(rect.top, window.innerHeight - Math.min(620, window.innerHeight - 28)));
    hoverPreview.style.left = `${Math.max(14, left)}px`;
    hoverPreview.style.top = `${top}px`;
    $("#hover-preview-name").textContent = item.name;
    $("#hover-preview-kind").textContent = `${item.kind} · ${formatBytes(item.size)}`;
    if (isVideo) {
      hoverPreviewVideo.poster = endpoint("/api/thumbnail", { path: item.path });
      hoverPreviewVideo.src = endpoint("/api/media", { path: item.path });
      hoverPreviewVideo.classList.remove("hidden");
      hoverPreviewVideo.play().catch(() => { /* Unsupported codecs still retain the static thumbnail. */ });
    } else {
      hoverPreviewImage.src = endpoint(item.browser_native ? "/api/media" : "/api/rendered-image", { path: item.path });
      hoverPreviewImage.alt = item.name;
      hoverPreviewImage.classList.remove("hidden");
    }
    hoverPreview.classList.remove("hidden");
    hoverPreview.setAttribute("aria-hidden", "false");
  }, 180);
}

function renderFiles({ preserveScroll = false } = {}) {
  state.visibleItems = state.items.filter(itemMatches);
  state.visibleItems = state.query.trim()
    ? [...state.visibleItems].sort((left, right) => searchScore(right) - searchScore(left))
    : sortItems(state.visibleItems);
  const list = $("#file-list");
  const previousScroll = preserveScroll ? list.scrollTop : 0;
  const countLabel = `${state.visibleItems.length} ${state.visibleItems.length === 1 ? "item" : "items"}`;
  $("#file-count").textContent = state.query || state.filter !== "all" || state.reviewFilter !== "all" ? `${countLabel} in this view` : countLabel;
  if (!state.visibleItems.length) {
    list.innerHTML = `<div class="empty-list">Nothing matches this view.<br>Clear the filter or open another folder.</div>`;
    return;
  }
  const renderedItems = state.visibleItems.slice(0, state.renderLimit);
  let previousGroup = null;
  list.innerHTML = renderedItems.map((item) => {
    const review = state.review[item.path] || {};
    const currentGroup = state.groupBy === "none" ? null : groupLabel(item);
    const groupHeader = currentGroup !== null && currentGroup !== previousGroup ? `<div class="group-header">${escapeHtml(currentGroup)}</div>` : "";
    previousGroup = currentGroup;
    let thumbnail;
    if (item.is_dir) {
      thumbnail = '<span class="thumbnail folder-thumb"><i class="folder-shape"></i></span>';
    } else if (item.thumbnail) {
      thumbnail = `<span class="thumbnail" data-ext="${escapeHtml((item.extension || "file").replace(".", "").slice(0, 5).toUpperCase())}"><img loading="lazy" src="${endpoint("/api/thumbnail", { path: item.path })}" alt=""></span>`;
    } else {
      thumbnail = `<span class="thumbnail">${escapeHtml((item.extension || "file").replace(".", "").slice(0, 5).toUpperCase())}</span>`;
    }
    return `${groupHeader}
      <button class="file-row ${state.selected.has(item.path) ? "selected" : ""} status-${review.status || "unreviewed"}" role="option"
        draggable="${!item.is_dir}" aria-selected="${state.selected.has(item.path)}" data-path="${escapeHtml(item.path)}">
        ${thumbnail}
        <span class="file-copy"><span class="file-name">${escapeHtml(item.name)}</span><span class="file-kind">${escapeHtml(item.kind)}${review.rating ? ` · ${"★".repeat(review.rating)}` : ""}</span></span>
        <span class="file-size">${formatBytes(item.size)}</span>
      </button>`;
  }).join("") + (renderedItems.length < state.visibleItems.length ? `
    <div class="load-more" role="status">Showing ${renderedItems.length.toLocaleString()} of ${state.visibleItems.length.toLocaleString()} · scroll for more</div>
  ` : "");
  $$(".file-row").forEach((row) => {
    const item = state.items.find((candidate) => candidate.path === row.dataset.path);
    row.addEventListener("click", (event) => {
      const toggle = event.metaKey || event.ctrlKey;
      if (item?.is_dir && !toggle && !event.shiftKey) loadFolder(item.path);
      else selectItem(row.dataset.path, toggle, event.shiftKey);
    });
    row.addEventListener("mouseenter", () => { if (item) queueHoverPreview(item, row); });
    row.addEventListener("mouseleave", hideHoverPreview);
    row.addEventListener("dragstart", (event) => {
      if (!item || item.is_dir) return event.preventDefault();
      if (!state.selected.has(item.path)) {
        state.selected = new Set([item.path]);
        state.primary = item;
      }
      event.dataTransfer.setData("application/x-quick-sort-paths", JSON.stringify([...state.selected]));
      event.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging-file");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging-file"));
  });
  $$(".thumbnail img").forEach((image) => image.addEventListener("error", () => image.closest(".thumbnail").classList.add("thumb-failed")));
  if (preserveScroll) list.scrollTop = previousScroll;
}

function selectItem(path, multi = false, range = false) {
  const item = state.items.find((candidate) => candidate.path === path);
  if (!item) return;
  if (range && state.selectionAnchor) {
    const anchorIndex = state.visibleItems.findIndex((candidate) => candidate.path === state.selectionAnchor);
    const itemIndex = state.visibleItems.findIndex((candidate) => candidate.path === path);
    if (anchorIndex >= 0 && itemIndex >= 0) {
      if (!multi) state.selected.clear();
      const [start, end] = [anchorIndex, itemIndex].sort((a, b) => a - b);
      state.visibleItems.slice(start, end + 1).forEach((candidate) => state.selected.add(candidate.path));
    }
  } else {
    if (!multi) state.selected.clear();
    if (multi && state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    state.selectionAnchor = path;
  }
  state.primary = state.selected.has(path) ? item : state.items.find((candidate) => state.selected.has(candidate.path)) || null;
  renderFiles();
  showPreview(state.primary);
  updateActionBar();
  localStorage.setItem(`quick-sort-selection:${state.currentPath}`, state.primary?.path || "");
  requestAnimationFrame(() => document.querySelector(`.file-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" }));
}

function selectedItems() {
  return state.items.filter((item) => state.selected.has(item.path));
}

function updateActionBar() {
  const count = state.selected.size;
  $("#action-bar").classList.toggle("hidden", !count);
  $("#selection-count").textContent = `${count} selected`;
}

function updateProgress() {
  const files = state.items.filter((item) => !item.is_dir);
  const reviewed = files.filter((item) => ["keep", "reject"].includes(state.review[item.path]?.status)).length;
  $("#review-progress").textContent = `${reviewed.toLocaleString()} / ${files.length.toLocaleString()} reviewed`;
}

async function monitorIndex() {
  clearTimeout(state.indexTimer);
  try {
    const job = await api(endpoint("/api/index", { path: state.currentPath }));
    if (job.status === "running" || job.status === "queued") {
      $("#review-progress").title = `Preparing thumbnails ${job.done} / ${job.total}`;
      state.indexTimer = setTimeout(monitorIndex, 1800);
    } else {
      $("#review-progress").title = "Folder thumbnails ready";
    }
  } catch (_) { /* Background indexing is an optimization only. */ }
}

function resetPreviewElements() {
  imagePreview.classList.add("hidden");
  videoPreview.classList.add("hidden");
  $("#empty-preview").classList.add("hidden");
  $("#file-preview").classList.add("hidden");
  $("#document-preview").classList.add("hidden");
  $("#document-preview").removeAttribute("src");
  $("#text-preview").classList.add("hidden");
  $("#text-preview").textContent = "";
  $("#transport").classList.add("hidden");
  $("#filmstrip").classList.add("hidden");
  $("#filmstrip").innerHTML = "";
  $("#zoom-controls").classList.add("hidden");
  $("#pixel-badge").classList.add("hidden");
  videoPreview.pause();
  videoPreview.removeAttribute("src");
  videoPreview.load();
  state.audioAnalysis = null;
  state.sprite = null;
  drawWaveform();
  $("#timeline-overlays").innerHTML = "";
  state.zoomMode = "fit";
  state.zoomScale = 1;
  state.pan = { x: 0, y: 0 };
}

function showPreview(item) {
  resetPreviewElements();
  if (!item) {
    document.body.classList.remove("inspecting");
    $("#empty-preview").classList.remove("hidden");
    $("#selected-name").textContent = "Select a file";
    $("#selected-meta").textContent = "Images and video open here at full fidelity.";
    $("#review-bar").classList.add("hidden");
    updateActionBar();
    clearNextVideoPreload();
    return;
  }
  if (!item.is_dir) document.body.classList.add("inspecting");
  $("#review-bar").classList.toggle("hidden", item.is_dir);
  renderReviewControls(item);
  $("#selected-name").textContent = item.name;
  $("#selected-meta").textContent = `${item.kind} · ${formatBytes(item.size)} · ${new Date(item.modified * 1000).toLocaleString()}`;
  if (item.is_dir) {
    showFileFallback(item, "FOLDER");
  } else if (item.preview_type === "image") {
    imagePreview.alt = item.name;
    imagePreview.src = endpoint(item.browser_native ? "/api/media" : "/api/rendered-image", { path: item.path });
    imagePreview.classList.remove("hidden");
    $("#zoom-controls").classList.remove("hidden");
  } else if (item.preview_type === "video" || item.preview_type === "audio") {
    videoPreview.autoplay = true;
    videoPreview.playsInline = true;
    videoPreview.classList.toggle("audio-player", item.preview_type === "audio");
    if (item.preview_type === "audio") videoPreview.poster = endpoint("/api/thumbnail", { path: item.path });
    else videoPreview.removeAttribute("poster");
    videoPreview.src = endpoint("/api/media", { path: item.path });
    videoPreview.classList.remove("hidden");
    $("#transport").classList.remove("hidden");
    $("#zoom-controls").classList.toggle("hidden", item.preview_type === "audio");
    videoPreview.play().catch(() => { /* Browser may require one click before audio playback. */ });
    loadAudioAnalysis(item.path);
  } else if (item.preview_type === "pdf") {
    $("#document-preview").src = endpoint("/api/media", { path: item.path });
    $("#document-preview").classList.remove("hidden");
  } else if (item.preview_type === "text" || item.preview_type === "archive") {
    showTextualPreview(item);
  } else {
    showFileFallback(item, (item.extension || "FILE").replace(".", "").toUpperCase());
  }
  updateActionBar();
  preloadNextVideo();
}

async function showTextualPreview(item) {
  const preview = $("#text-preview");
  preview.classList.remove("hidden");
  preview.textContent = "Loading preview…";
  try {
    if (item.preview_type === "archive") {
      const data = await api(endpoint("/api/archive-preview", { path: item.path }));
      preview.textContent = data.supported ? data.entries.join("\n") + (data.truncated ? "\n\n…more entries" : "") : data.message;
    } else {
      const data = await api(endpoint("/api/text-preview", { path: item.path }));
      preview.textContent = data.content + (data.truncated ? "\n\n…preview truncated" : "");
    }
  } catch (error) { preview.textContent = error.message; }
}

function showFileFallback(item, extension) {
  $("#file-preview").classList.remove("hidden");
  $("#file-extension").textContent = extension || "FILE";
  $("#file-preview-name").textContent = item.name;
}

function renderReviewControls(item) {
  const record = state.review[item.path] || { status: "unreviewed", rating: 0, tags: [] };
  $("#keep-button").classList.toggle("active", record.status === "keep");
  $("#reject-button").classList.toggle("active", record.status === "reject");
  $$("#rating [data-rating]").forEach((button) => button.classList.toggle("active", Number(button.dataset.rating) <= (record.rating || 0)));
  $("#tags").value = (record.tags || []).join(", ");
}

async function updateReview(changes, { advance = false } = {}) {
  if (!state.primary || state.primary.is_dir) return;
  const item = state.primary;
  try {
    const targets = selectedItems().filter((candidate) => !candidate.is_dir);
    const records = await Promise.all(targets.map((target) => api("/api/review", { method: "PUT", body: JSON.stringify({ path: target.path, ...changes }) })));
    targets.forEach((target, index) => { state.review[target.path] = records[index]; });
    const record = state.review[item.path];
    renderReviewControls(item);
    updateProgress();
    renderFiles({ preserveScroll: true });
    if (advance) selectRelative(1);
  } catch (error) { showToast(error.message); }
}

function buildFilmstrip() {
  if (!state.primary || !state.primary.kind.toLowerCase().includes("video") || !Number.isFinite(videoPreview.duration) || !videoPreview.duration) return;
  const times = Array.from({ length: 10 }, (_, index) => {
    const ratio = index / 9 * .98;
    return Math.max(0, videoPreview.duration * ratio);
  });
  $("#filmstrip").innerHTML = times.map((seconds) => `
    <button data-film-time="${seconds}" title="${formatTime(seconds)}"><img loading="lazy" src="${endpoint("/api/video-frame", { path: state.primary.path, time: seconds })}" alt="Frame at ${formatTime(seconds)}"></button>
  `).join("");
  $("#filmstrip").classList.remove("hidden");
  $$("#filmstrip [data-film-time]").forEach((button) => button.addEventListener("click", () => { videoPreview.currentTime = Number(button.dataset.filmTime); }));
}

function nextVideoInLine() {
  if (!state.primary || state.primary.preview_type !== "video") return null;
  const videos = state.visibleItems.filter((item) => item.preview_type === "video");
  const index = videos.findIndex((item) => item.path === state.primary.path);
  return index >= 0 ? videos[index + 1] || null : null;
}

function clearNextVideoPreload() {
  state.preloadController?.abort();
  state.preloadController = null;
  state.preloadedNextPath = null;
  nextVideoPreload.pause();
  nextVideoPreload.removeAttribute("src");
  nextVideoPreload.load();
}

function preloadNextVideo() {
  const next = nextVideoInLine();
  if (!next) return clearNextVideoPreload();
  if (state.preloadedNextPath === next.path) return;
  clearNextVideoPreload();
  state.preloadedNextPath = next.path;
  const controller = new AbortController();
  state.preloadController = controller;
  nextVideoPreload.src = endpoint("/api/media", { path: next.path });
  nextVideoPreload.load();
  nextVideoPreload.addEventListener("loadedmetadata", async () => {
    if (state.preloadedNextPath !== next.path || controller.signal.aborted || !Number.isFinite(nextVideoPreload.duration)) return;
    const times = Array.from({ length: 10 }, (_, index) => nextVideoPreload.duration * (index / 9 * .98));
    for (let index = 0; index < times.length; index += 2) {
      if (controller.signal.aborted) return;
      await Promise.allSettled(times.slice(index, index + 2).map((time) => fetch(endpoint("/api/video-frame", { path: next.path, time }), { signal: controller.signal, cache: "force-cache" })));
    }
  }, { once: true });
}

function updateSeekVisuals() {
  const duration = Number.isFinite(videoPreview.duration) ? videoPreview.duration : 0;
  const played = duration ? videoPreview.currentTime / duration * 100 : 0;
  let buffered = played;
  if (duration && videoPreview.buffered.length) buffered = videoPreview.buffered.end(videoPreview.buffered.length - 1) / duration * 100;
  $("#seek").style.setProperty("--seek-played", `${Math.max(0, Math.min(100, played))}%`);
  $("#seek").style.setProperty("--seek-buffered", `${Math.max(played, Math.min(100, buffered))}%`);
}

function positionSeekPreview(seconds, clientX) {
  const rect = $("#seek").getBoundingClientRect();
  const preview = $("#seek-preview");
  preview.style.left = `${Math.max(83, Math.min(window.innerWidth - 83, clientX))}px`;
  preview.style.top = `${Math.max(10, rect.top - 121)}px`;
  $("#seek-preview-time").textContent = formatTime(seconds);
  preview.classList.remove("hidden");
  clearTimeout(state.seekPreviewTimer);
  const path = state.primary.path;
  const image = $("#seek-preview-image");
  const visual = $("#seek-preview-visual");
  if (state.sprite && state.primary.preview_type === "video") {
    const index = Math.min(state.sprite.count - 1, Math.round(seconds / videoPreview.duration * (state.sprite.count - 1)));
    const column = index % state.sprite.columns;
    const row = Math.floor(index / state.sprite.columns);
    visual.style.backgroundImage = `url("${state.sprite.url}")`;
    visual.style.backgroundSize = `${state.sprite.columns * 100}% ${state.sprite.rows * 100}%`;
    visual.style.backgroundPosition = `${column / (state.sprite.columns - 1) * 100}% ${row / (state.sprite.rows - 1) * 100}%`;
    image.classList.add("hidden");
    return;
  }
  visual.style.backgroundImage = "";
  image.classList.remove("hidden");
  state.seekPreviewTimer = setTimeout(() => {
    if (state.primary?.path !== path) return;
    image.dataset.fallback = "";
    image.src = endpoint("/api/video-frame", { path, time: Math.round(seconds * 2) / 2 });
  }, 90);
}

function showSeekPreview(event) {
  if (!Number.isFinite(videoPreview.duration) || !videoPreview.duration || !state.primary) return;
  const rect = $("#seek").getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  positionSeekPreview(videoPreview.duration * ratio, event.clientX);
}

function scrubWithWheel(event) {
  if (!Number.isFinite(videoPreview.duration) || !videoPreview.duration) return;
  event.preventDefault();
  const direction = Math.sign(event.deltaY || event.deltaX);
  if (!direction) return;
  const step = event.altKey ? Math.max(1, Number(state.scrub.fine) || 1) / 30 : event.shiftKey ? Math.max(1, Number(state.scrub.fast) || 30) : Math.max(.1, Number(state.scrub.normal) || 5);
  const target = Math.max(0, Math.min(videoPreview.duration, videoPreview.currentTime + direction * step));
  if (event.shiftKey && typeof videoPreview.fastSeek === "function") videoPreview.fastSeek(target);
  else videoPreview.currentTime = target;
  $("#seek").value = Math.round(target / videoPreview.duration * 1000);
  updateSeekVisuals();
  const rect = $("#seek").getBoundingClientRect();
  positionSeekPreview(target, rect.left + target / videoPreview.duration * rect.width);
}

function stepFrame(direction) {
  if (videoPreview.classList.contains("hidden")) return;
  videoPreview.pause();
  videoPreview.currentTime = Math.max(0, Math.min(videoPreview.duration || 0, videoPreview.currentTime + direction / 30));
}

function activeMedia() {
  if (!imagePreview.classList.contains("hidden")) return imagePreview;
  if (!videoPreview.classList.contains("hidden")) return videoPreview;
  return null;
}

function mediaDimensions(media) {
  if (media === imagePreview) return { width: media.naturalWidth, height: media.naturalHeight };
  return { width: media.videoWidth, height: media.videoHeight };
}

function fitScale(media) {
  const dimensions = mediaDimensions(media);
  if (!dimensions.width || !dimensions.height) return 1;
  return Math.min((stage.clientWidth - 40) / dimensions.width, (stage.clientHeight - 40) / dimensions.height, 1);
}

function applyZoom() {
  const media = activeMedia();
  if (!media) return;
  const scale = state.zoomMode === "fit" ? fitScale(media) : state.zoomScale;
  media.style.transform = `translate(-50%, -50%) translate(${state.pan.x}px, ${state.pan.y}px) scale(${scale})`;
  media.classList.toggle("pixelated", scale >= 3);
  stage.classList.toggle("pannable", scale > fitScale(media) + 0.01);
  $("#pixel-badge").classList.toggle("hidden", scale < 3);
  $("#zoom-value").textContent = state.zoomMode === "fit" ? "Fit" : `${Math.round(scale * 100)}%`;
}

function setZoom(action) {
  const media = activeMedia();
  if (!media) return;
  const levels = [0.25, 0.5, 1, 2, 4, 8];
  if (action === "fit") {
    state.zoomMode = "fit";
    state.pan = { x: 0, y: 0 };
  } else if (action === "actual") {
    state.zoomMode = "scale";
    state.zoomScale = 1;
    state.pan = { x: 0, y: 0 };
  } else {
    const current = state.zoomMode === "fit" ? fitScale(media) : state.zoomScale;
    state.zoomMode = "scale";
    if (action === "in") state.zoomScale = levels.find((level) => level > current + 0.01) || levels.at(-1);
    else state.zoomScale = [...levels].reverse().find((level) => level < current - 0.01) || levels[0];
  }
  applyZoom();
}

function toggleVideo() {
  if (videoPreview.classList.contains("hidden")) return;
  if (videoPreview.paused) videoPreview.play(); else videoPreview.pause();
}

function jumpVideo(seconds) {
  if (videoPreview.classList.contains("hidden")) return;
  videoPreview.currentTime = Math.max(0, Math.min(videoPreview.duration || 0, videoPreview.currentTime + seconds));
}

function toggleMute() {
  if (videoPreview.classList.contains("hidden")) return;
  videoPreview.muted = !videoPreview.muted;
  localStorage.setItem("quick-sort-muted", String(videoPreview.muted));
}

function adjustSpeed(direction) {
  if (videoPreview.classList.contains("hidden")) return;
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const current = speeds.indexOf(videoPreview.playbackRate);
  const next = Math.max(0, Math.min(speeds.length - 1, (current < 0 ? 2 : current) + direction));
  videoPreview.playbackRate = speeds[next];
  $("#speed").value = String(speeds[next]);
  localStorage.setItem("quick-sort-playback-rate", String(speeds[next]));
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $(".inspector-pane").requestFullscreen();
  } catch (error) { showToast("Fullscreen is not available in this browser"); }
}

async function togglePictureInPicture() {
  if (videoPreview.classList.contains("hidden") || !document.pictureInPictureEnabled) return;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await videoPreview.requestPictureInPicture();
  } catch (_) { showToast("Picture in picture is not available for this video"); }
}

async function releaseVideoElement(element) {
  element.pause();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      element.removeEventListener("emptied", finish);
      resolve();
    };
    element.addEventListener("emptied", finish, { once: true });
    element.removeAttribute("src");
    element.load();
    setTimeout(finish, 250);
  });
}

async function releaseVideosForMove(paths) {
  const activeMatches = !videoPreview.classList.contains("hidden") && state.primary && paths.includes(state.primary.path);
  const hoverMatches = state.hoverPath && paths.includes(state.hoverPath) && !hoverPreviewVideo.classList.contains("hidden");
  const preloadMatches = state.preloadedNextPath && paths.includes(state.preloadedNextPath);
  if (!activeMatches && !hoverMatches && !preloadMatches) return false;
  if (document.pictureInPictureElement === videoPreview) {
    try { await document.exitPictureInPicture(); } catch (_) { /* Continue releasing the file handle. */ }
  }
  const releases = [];
  if (activeMatches) releases.push(releaseVideoElement(videoPreview));
  if (hoverMatches) {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = null;
    state.hoverPath = null;
    hoverPreview.classList.add("hidden");
    hoverPreview.setAttribute("aria-hidden", "true");
    hoverPreviewVideo.classList.add("hidden");
    hoverPreviewVideo.removeAttribute("poster");
    releases.push(releaseVideoElement(hoverPreviewVideo));
  }
  if (preloadMatches) {
    state.preloadController?.abort();
    state.preloadedNextPath = null;
    releases.push(releaseVideoElement(nextVideoPreload));
  }
  await Promise.all(releases);
  return activeMatches;
}

async function moveSelected(category) {
  const paths = selectedItems().filter((item) => !item.is_dir || category === "files").map((item) => item.path);
  const destination = state.config.destinations?.[category];
  if (!paths.length) return showToast("Select at least one file first");
  if (!destination) return $("#settings").showModal();
  await movePathsToDestination(paths, destination);
}

async function movePathsToDestination(paths, destination) {
  const allFiles = state.visibleItems.filter((item) => !item.is_dir);
  const sameType = state.primary ? allFiles.filter((item) => item.category === state.primary.category) : [];
  const queue = sameType.length > 1 ? sameType : allFiles;
  const currentIndex = state.primary ? queue.findIndex((item) => item.path === state.primary.path) : -1;
  const remaining = new Set(paths);
  const nextItem = [
    ...queue.slice(Math.max(0, currentIndex + 1)),
    ...queue.slice(0, Math.max(0, currentIndex)).reverse(),
  ].find((item) => !remaining.has(item.path));
  const releasedVideo = await releaseVideosForMove(paths);
  try {
    const result = await api("/api/move", { method: "POST", body: JSON.stringify({ paths, destination }) });
    showToast(`Moved ${result.moved} item${result.moved === 1 ? "" : "s"} · Ctrl+Z to undo`);
    await loadFolder(state.currentPath);
    const queued = nextItem && state.items.find((item) => item.path === nextItem.path);
    const fallback = state.visibleItems.find((item) => !item.is_dir);
    if (queued || fallback) selectItem((queued || fallback).path);
  } catch (error) {
    if (releasedVideo && state.primary) showPreview(state.primary);
    showToast(error.message);
  }
}

async function undoMove() {
  try {
    const result = await api("/api/undo", { method: "POST", body: "{}" });
    showToast(result.restored ? `Restored ${result.restored} item${result.restored === 1 ? "" : "s"}` : "Nothing to undo");
    await loadFolder(state.currentPath);
    const restoredPath = (result.paths || []).find((path) => state.items.some((item) => item.path === path));
    if (restoredPath) selectItem(restoredPath);
  } catch (error) { showToast(error.message); }
}

function askToTrash() {
  if (!state.selected.size) return showToast("Select at least one item first");
  const count = state.selected.size;
  $("#trash-message").textContent = `${count} selected ${count === 1 ? "item" : "items"} can be restored from your operating system’s Recycle Bin or Trash.`;
  $("#confirm-trash").showModal();
}

async function trashSelected() {
  const paths = selectedItems().map((item) => item.path);
  try {
    const result = await api("/api/trash", { method: "POST", body: JSON.stringify({ paths }) });
    showToast(`Moved ${result.trashed} item${result.trashed === 1 ? "" : "s"} to the Recycle Bin`);
    await loadFolder(state.currentPath);
  } catch (error) { showToast(error.message); }
}

async function revealSelected() {
  if (!state.primary) return;
  try {
    await api("/api/reveal", { method: "POST", body: JSON.stringify({ path: state.primary.path }) });
  } catch (error) { showToast(error.message); }
}

async function openSelected() {
  if (!state.primary) return;
  try {
    await api("/api/open", { method: "POST", body: JSON.stringify({ path: state.primary.path }) });
  } catch (error) { showToast(error.message); }
}

function openCompare() {
  const items = selectedItems().filter((item) => ["images", "videos"].includes(item.category));
  if (items.length !== 2) return showToast("Select exactly two images or videos to compare");
  state.compareZoom = 1;
  $("#compare-grid").innerHTML = items.map((item) => {
    const media = item.category === "images"
      ? `<img src="${endpoint("/api/media", { path: item.path })}" alt="${escapeHtml(item.name)}">`
      : `<video src="${endpoint("/api/media", { path: item.path })}" muted loop playsinline></video>`;
    return `<div class="compare-cell">${media}<span>${escapeHtml(item.name)}</span></div>`;
  }).join("");
  $("#tools").close();
  $("#compare").showModal();
}

function updateCompareZoom(delta) {
  state.compareZoom = Math.max(.5, Math.min(8, state.compareZoom * delta));
  $$("#compare-grid img, #compare-grid video").forEach((media) => { media.style.transform = `scale(${state.compareZoom})`; });
}

function toggleComparePlayback() {
  const videos = $$("#compare-grid video");
  if (!videos.length) return;
  const shouldPlay = videos.some((video) => video.paused);
  videos.forEach((video) => { if (shouldPlay) video.play().catch(() => {}); else video.pause(); });
  $("#compare-play").textContent = shouldPlay ? "Pause both" : "Play both";
}

function duplicateMetricClass(value, values) {
  const numeric = values.filter((candidate) => Number.isFinite(candidate));
  if (!Number.isFinite(value) || numeric.length < 2 || Math.max(...numeric) === Math.min(...numeric)) return "";
  if (value === Math.max(...numeric)) return "metric-best";
  if (value === Math.min(...numeric)) return "metric-worst";
  return "";
}

function duplicateResolution(metadata) {
  return Number(metadata?.width || 0) * Number(metadata?.height || 0);
}

function renderDuplicateComparisonMetadata(groupIndex, metadata) {
  const group = state.duplicateGroups[groupIndex];
  if (!group || state.duplicateCompareGroup !== groupIndex) return;
  const resolutions = metadata.map(duplicateResolution);
  const bitrates = metadata.map((item) => Number.parseFloat(item?.bitrate || "0"));
  const sizes = group.files.map((file) => Number(file.size));
  const dates = group.files.map((file) => Number(file.modified));
  const ranked = group.files.map((file, index) => ({ index, score: [resolutions[index], bitrates[index], sizes[index], dates[index]] }))
    .sort((a, b) => {
      for (let position = 0; position < a.score.length; position += 1) {
        if (a.score[position] !== b.score[position]) return b.score[position] - a.score[position];
      }
      return 0;
    });
  const recommendedIndex = ranked[0]?.index ?? 0;
  group.keeper = group.files[recommendedIndex].path;
  group.files.forEach((file, index) => {
    const item = metadata[index] || {};
    const resolution = resolutions[index];
    const values = [
      ["Resolution", item.width && item.height ? `${item.width} × ${item.height}` : "Unknown", duplicateMetricClass(resolution, resolutions)],
      ["File size", formatBytes(file.size), duplicateMetricClass(sizes[index], sizes)],
      ["Bitrate", item.bitrate ? `${Math.round(bitrates[index]).toLocaleString()} kbps` : "—", duplicateMetricClass(bitrates[index], bitrates)],
      ["Modified", new Date(file.modified * 1000).toLocaleString(), duplicateMetricClass(dates[index], dates)],
      ["Codec", [item.video_codec, item.audio_codec].filter(Boolean).join(" / ") || item.kind || "—", ""],
      ["Location", file.path, ""],
    ];
    const card = $(`[data-duplicate-compare-card="${index}"]`);
    if (!card) return;
    card.querySelector(".duplicate-metrics").innerHTML = values.map(([label, value, className]) => `<dt>${label}</dt><dd class="${className}">${escapeHtml(value)}</dd>`).join("");
    card.querySelector(".recommended-badge").classList.toggle("hidden", index !== recommendedIndex);
  });
  chooseDuplicateKeeper(groupIndex, recommendedIndex, { quiet: true, selectOthers: group.kind === "exact" });
}

async function openDuplicateComparison(groupIndex, focusIndex = 0) {
  const group = state.duplicateGroups[groupIndex];
  if (!group) return;
  state.duplicateCompareGroup = groupIndex;
  state.duplicateCompareZoom = 1;
  const label = { exact: "Exact copies", similar_image: "Visually similar images", similar_video: "Visually similar videos" }[group.kind] || "Possible duplicates";
  $("#duplicate-compare-summary").textContent = `${label} · ${group.confidence}% match · compare quality before choosing a keeper`;
  $("#duplicate-compare-grid").innerHTML = group.files.map((file, index) => {
    const media = file.category === "videos"
      ? `<video src="${endpoint("/api/media", { path: file.path })}" muted loop playsinline preload="metadata"></video>`
      : `<img src="${endpoint(file.browser_native === false ? "/api/rendered-image" : "/api/media", { path: file.path })}" alt="${escapeHtml(file.name)}">`;
    return `<article class="duplicate-compare-card ${file.path === group.keeper ? "recommended" : ""}" data-duplicate-compare-card="${index}">
      <div class="duplicate-compare-media">${media}</div>
      <div class="duplicate-compare-info">
        <div class="duplicate-compare-title"><strong>${escapeHtml(file.name)}</strong><span class="recommended-badge ${file.path === group.keeper ? "" : "hidden"}">Recommended keeper</span></div>
        <dl class="duplicate-metrics"><dt>Loading</dt><dd>Reading metadata…</dd></dl>
      </div>
      <div class="duplicate-compare-actions"><button class="keep-choice" data-keep-duplicate="${index}">Keep this one</button><button class="remove-choice" data-remove-duplicate="${index}">Mark for Recycle Bin</button></div>
    </article>`;
  }).join("");
  $("#duplicate-compare-seek").value = 0;
  $("#duplicate-compare-seek").disabled = group.files.every((file) => file.category !== "videos");
  $("#duplicate-compare-play").classList.toggle("hidden", group.files.every((file) => file.category !== "videos"));
  $$('[data-keep-duplicate]').forEach((button) => button.addEventListener("click", () => chooseDuplicateKeeper(groupIndex, Number(button.dataset.keepDuplicate))));
  $$('[data-remove-duplicate]').forEach((button) => button.addEventListener("click", () => toggleDuplicateRemoval(groupIndex, Number(button.dataset.removeDuplicate))));
  const videos = $$("#duplicate-compare-grid video");
  videos[0]?.addEventListener("timeupdate", () => {
    if (Number.isFinite(videos[0].duration) && videos[0].duration) $("#duplicate-compare-seek").value = Math.round(videos[0].currentTime / videos[0].duration * 1000);
  });
  if (!$("#duplicate-compare").open) $("#duplicate-compare").showModal();
  requestAnimationFrame(() => $(`[data-duplicate-compare-card="${focusIndex}"]`)?.scrollIntoView({ inline: "center", block: "nearest" }));
  const metadata = await Promise.all(group.files.map((file) => api(endpoint("/api/metadata", { path: file.path })).catch(() => ({}))));
  renderDuplicateComparisonMetadata(groupIndex, metadata);
}

function chooseDuplicateKeeper(groupIndex, keeperIndex, { quiet = false, selectOthers = true } = {}) {
  const group = state.duplicateGroups[groupIndex];
  if (!group) return;
  group.keeper = group.files[keeperIndex].path;
  group.files.forEach((file, index) => {
    const checkbox = $(`[data-duplicate-check="${groupIndex}:${index}"]`);
    if (checkbox && selectOthers) checkbox.checked = index !== keeperIndex;
    const card = $(`[data-duplicate-compare-card="${index}"]`);
    card?.classList.toggle("recommended", index === keeperIndex);
    card?.querySelector(".recommended-badge")?.classList.toggle("hidden", index !== keeperIndex);
    $(`[data-duplicate-keeper-badge="${groupIndex}:${index}"]`)?.classList.toggle("hidden", index !== keeperIndex);
    card?.querySelector(".remove-choice")?.classList.toggle("active", Boolean(checkbox?.checked));
  });
  updateDuplicateSelection();
  if (!quiet) showToast(`${group.files[keeperIndex].name} will be kept`);
}

function toggleDuplicateRemoval(groupIndex, fileIndex) {
  const checkbox = $(`[data-duplicate-check="${groupIndex}:${fileIndex}"]`);
  if (!checkbox) return;
  checkbox.checked = !checkbox.checked;
  $(`[data-duplicate-compare-card="${fileIndex}"] .remove-choice`)?.classList.toggle("active", checkbox.checked);
  updateDuplicateSelection();
}

function adjustDuplicateCompareZoom(factor) {
  state.duplicateCompareZoom = Math.max(.5, Math.min(8, state.duplicateCompareZoom * factor));
  $$("#duplicate-compare-grid img, #duplicate-compare-grid video").forEach((media) => { media.style.transform = `scale(${state.duplicateCompareZoom})`; });
}

function toggleDuplicateComparePlayback() {
  const videos = $$("#duplicate-compare-grid video");
  const shouldPlay = videos.some((video) => video.paused);
  videos.forEach((video) => { if (shouldPlay) video.play().catch(() => {}); else video.pause(); });
  $("#duplicate-compare-play").textContent = shouldPlay ? "Pause all" : "Play all";
}

function renderDuplicateResult(result) {
  state.duplicateGroups = result.groups || [];
  const labels = { exact: "Exact copies", similar_image: "Similar images", similar_video: "Similar videos" };
  $("#duplicates-summary").textContent = `${state.duplicateGroups.length} group${state.duplicateGroups.length === 1 ? "" : "s"} · ${result.scanned} files scanned · up to ${formatBytes(result.reclaimable)} reclaimable`;
  $("#duplicates-results").innerHTML = state.duplicateGroups.length ? state.duplicateGroups.map((group, groupIndex) => `
      <section class="duplicate-group">
        <div class="duplicate-group-head"><div><strong>${labels[group.kind] || "Possible duplicates"}</strong><button class="duplicate-compare-button" data-compare-duplicate-group="${groupIndex}">Compare side by side</button></div><span>${group.confidence}% match · ${formatBytes(group.reclaimable)} reclaimable</span></div>
        ${group.files.map((file, fileIndex) => {
          const keeper = file.path === group.keeper;
          const thumbnail = ["images", "videos"].includes(file.category) ? endpoint("/api/thumbnail", { path: file.path }) : "";
          return `<label class="duplicate-file">
            <input type="checkbox" data-duplicate-check="${groupIndex}:${fileIndex}" ${!keeper && group.kind === "exact" ? "checked" : ""} aria-label="Remove ${escapeHtml(file.name)}">
            <button type="button" class="duplicate-thumb" data-duplicate-preview="${groupIndex}:${fileIndex}" title="Preview ${escapeHtml(file.name)}">${thumbnail ? `<img src="${thumbnail}" alt="">` : `<span>${escapeHtml(file.name.split(".").at(-1).toUpperCase())}</span>`}</button>
            <span class="duplicate-copy"><strong>${escapeHtml(file.name)}</strong><span>${new Date(file.modified * 1000).toLocaleString()}</span><span class="keeper-badge ${keeper ? "" : "hidden"}" data-duplicate-keeper-badge="${groupIndex}:${fileIndex}">Suggested keeper</span></span>
            <span class="duplicate-size">${formatBytes(file.size)}</span>
          </label>`;
        }).join("")}
      </section>
  `).join("") : '<div class="empty-list">No duplicate images or videos found in this folder.</div>';
  $$('[data-duplicate-check]').forEach((checkbox) => checkbox.addEventListener("change", updateDuplicateSelection));
  $$('[data-compare-duplicate-group]').forEach((button) => button.addEventListener("click", () => openDuplicateComparison(Number(button.dataset.compareDuplicateGroup))));
  $$('[data-duplicate-preview]').forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    const [groupIndex, fileIndex] = button.dataset.duplicatePreview.split(":").map(Number);
    openDuplicateComparison(groupIndex, fileIndex);
  }));
  updateDuplicateSelection();
}

function renderDuplicateProgress(job) {
  const status = job.status === "queued" ? "Queued" : "Scanning";
  $("#duplicates-summary").textContent = `${status} ${job.name || "this folder"} in the background…`;
  $("#duplicates-space").textContent = "—";
  $("#duplicates-trash").disabled = true;
  $("#duplicates-results").innerHTML = '<div class="empty-list">You can close this window and keep sorting. We’ll alert you when the scan is ready.</div>';
}

function updateDuplicateJobCard(job, { force = false } = {}) {
  state.duplicateJob = job;
  const card = $("#background-job");
  card.classList.remove("ready", "error");
  if (job.status === "complete") {
    const groups = job.result?.groups?.length || 0;
    card.classList.add("ready");
    $("#background-job-message").textContent = `Duplicate scan ready · ${groups} group${groups === 1 ? "" : "s"}`;
  } else if (job.status === "error") {
    card.classList.add("error");
    $("#background-job-message").textContent = `Duplicate scan failed · ${job.error || "Unknown error"}`;
  } else {
    $("#background-job-message").textContent = `Scanning ${job.name || "folder"} for duplicates…`;
  }
  if (force || job.status !== "idle") card.classList.remove("hidden");
}

function announceDuplicateCompletion(job) {
  if (state.duplicateNotified.has(job.id)) return;
  state.duplicateNotified.add(job.id);
  updateDuplicateJobCard(job, { force: true });
  const groups = job.result?.groups?.length || 0;
  showToast(`Duplicate scan finished · ${groups} group${groups === 1 ? "" : "s"} found`);
  document.title = `✓ Duplicates ready · Quick Sort Player`;
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("Quick Sort Player", { body: `Duplicate scan finished: ${groups} group${groups === 1 ? "" : "s"} found.` });
  }
}

async function pollDuplicateJob(path) {
  clearTimeout(state.duplicateTimer);
  try {
    const job = await api(endpoint("/api/duplicates/status", { path }));
    updateDuplicateJobCard(job);
    if (job.status === "queued" || job.status === "running") {
      if ($("#duplicates").open && $("#duplicates").dataset.path === path) renderDuplicateProgress(job);
      state.duplicateTimer = setTimeout(() => pollDuplicateJob(path), 1200);
    } else if (job.status === "complete") {
      announceDuplicateCompletion(job);
      if ($("#duplicates").open && $("#duplicates").dataset.path === path) renderDuplicateResult(job.result);
    } else if (job.status === "error") {
      if ($("#duplicates").open) $("#duplicates-results").innerHTML = `<div class="empty-list">${escapeHtml(job.error || "The scan failed")}</div>`;
    }
  } catch (error) {
    state.duplicateTimer = setTimeout(() => pollDuplicateJob(path), 1800);
  }
}

async function startDuplicateScan(path) {
  const job = await api("/api/duplicates/start", { method: "POST", body: JSON.stringify({ path }) });
  updateDuplicateJobCard(job, { force: true });
  renderDuplicateProgress(job);
  pollDuplicateJob(path);
}

async function openDuplicates() {
  if ($("#tools").open) $("#tools").close();
  const path = state.currentPath;
  $("#duplicates").dataset.path = path;
  $("#duplicates").showModal();
  try {
    const job = await api(endpoint("/api/duplicates/status", { path }));
    if (job.status === "complete") {
      state.duplicateJob = job;
      renderDuplicateResult(job.result);
    } else if (job.status === "queued" || job.status === "running") {
      updateDuplicateJobCard(job, { force: true });
      renderDuplicateProgress(job);
      pollDuplicateJob(path);
    } else {
      await startDuplicateScan(path);
    }
  } catch (error) {
    $("#duplicates-results").innerHTML = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
  }
}

async function viewDuplicateJob() {
  const job = state.duplicateJob;
  if (!job?.path) return;
  if (normalizedPath(state.currentPath) !== normalizedPath(job.path)) await loadFolder(job.path);
  await openDuplicates();
  document.title = "Quick Sort Player";
}

async function resumeDuplicateJobs() {
  try {
    const response = await api("/api/duplicates/jobs");
    const jobs = response.jobs || [];
    const job = jobs.find((candidate) => ["queued", "running"].includes(candidate.status)) || jobs[0];
    if (job) {
      updateDuplicateJobCard(job, { force: true });
      pollDuplicateJob(job.path);
    }
  } catch (_) { /* Background job discovery is optional. */ }
}

function duplicateSelectedFiles() {
  return $$('[data-duplicate-check]:checked').map((checkbox) => {
    const [groupIndex, fileIndex] = checkbox.dataset.duplicateCheck.split(":").map(Number);
    return state.duplicateGroups[groupIndex].files[fileIndex];
  }).filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index);
}

function updateDuplicateSelection() {
  const files = duplicateSelectedFiles();
  $("#duplicates-space").textContent = formatBytes(files.reduce((total, file) => total + file.size, 0));
  $("#duplicates-trash").disabled = files.length === 0;
  $("#duplicates-trash").textContent = files.length ? `Move ${files.length} to Recycle Bin` : "Move selected to Recycle Bin";
}

function trashDuplicateSelection() {
  const files = duplicateSelectedFiles();
  if (!files.length) return;
  state.selected = new Set(files.map((file) => file.path));
  state.primary = state.items.find((item) => state.selected.has(item.path)) || null;
  $("#duplicates").close();
  renderFiles(); showPreview(state.primary); updateActionBar();
  askToTrash();
}

function renameValue(item, index, pattern) {
  const date = new Date(item.modified * 1000).toISOString().slice(0, 10);
  const stem = item.name.replace(/\.[^.]+$/, "");
  return pattern.replaceAll("{name}", stem).replaceAll("{index}", String(index + 1).padStart(3, "0")).replaceAll("{date}", date) + item.extension;
}

function renderRenamePreview() {
  const pattern = $("#rename-pattern").value;
  $("#rename-preview").innerHTML = selectedItems().map((item, index) => `<div><span>${escapeHtml(item.name)}</span><b>→</b><span>${escapeHtml(renameValue(item, index, pattern))}</span></div>`).join("");
}

function openRename() {
  if (!state.selected.size) return showToast("Select files to rename first");
  $("#tools").close();
  renderRenamePreview();
  $("#rename").showModal();
}

async function showMetadata() {
  if (!state.primary) return;
  $("#tools").close();
  $("#metadata-grid").innerHTML = '<dt>Status</dt><dd>Loading…</dd>';
  $("#metadata").showModal();
  try {
    const data = await api(endpoint("/api/metadata", { path: state.primary.path }));
    const labels = { name: "Name", path: "Location", kind: "Kind", size: "Size", created: "Created", modified: "Modified", extension: "Extension", width: "Width", height: "Height", camera: "Camera", maker: "Maker", captured: "Captured", lens: "Lens", duration: "Duration (seconds)", bitrate: "Bitrate", video_codec: "Video codec", audio_codec: "Audio codec" };
    $("#metadata-grid").innerHTML = Object.entries(data).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => {
      let display = key === "size" ? formatBytes(value) : value;
      if (["created", "modified"].includes(key)) display = new Date(value * 1000).toLocaleString();
      return `<dt>${escapeHtml(labels[key] || key)}</dt><dd>${escapeHtml(display)}</dd>`;
    }).join("");
  } catch (error) { showToast(error.message); }
}

function togglePanel(panel) {
  const className = panel === "library" ? "library-collapsed" : "files-collapsed";
  const collapsed = document.body.classList.toggle(className);
  localStorage.setItem(`quick-sort-${className}`, String(collapsed));
  $(`#toggle-${panel}`).setAttribute("aria-pressed", String(!collapsed));
  requestAnimationFrame(applyZoom);
}

function addDestination() {
  const count = Object.keys(state.config.destinations || {}).length;
  if (count >= 9) return showToast("A maximum of nine numbered shortcuts is supported");
  const key = `shortcut${count + 1}`;
  state.config.destinations[key] = "";
  state.config.labels[key] = `Shortcut ${count + 1}`;
  renderSettings();
}

async function pickFolder() {
  try {
    const result = await api("/api/pick-folder", { method: "POST", body: "{}" });
    if (result.path) {
      await savePickedLocation(result.path);
      await loadFolder(result.path);
      showToast("Folder added to Places");
    }
  } catch (error) { showToast(error.message); }
}

function selectRelative(delta) {
  if (!state.visibleItems.length) return;
  const current = state.primary ? state.visibleItems.findIndex((item) => item.path === state.primary.path) : -1;
  const next = Math.max(0, Math.min(state.visibleItems.length - 1, current + delta));
  if (next >= state.renderLimit) {
    state.renderLimit = Math.min(state.visibleItems.length, state.renderLimit + 180);
    renderFiles({ preserveScroll: true });
  }
  selectItem(state.visibleItems[next].path);
}

function buildCommands() {
  const destinationCommands = Object.keys(state.config.destinations || {}).slice(0, 9).map((key, index) => ({
    label: `Move selected to ${state.config.labels?.[key] || key}`, hint: String(index + 1), run: () => moveSelected(key),
  }));
  const commands = [
    { label: "Open another folder", hint: "Picker", run: pickFolder },
    ...state.locations.map((location) => ({ label: `Go to ${location.name}`, hint: `G ${location.hotkey}`, run: () => loadFolder(location.path) })),
    ...state.recentFolders.slice(0, 5).map((path) => ({ label: `Recent: ${path.split(/[\\/]/).filter(Boolean).at(-1) || path}`, hint: path, run: () => loadFolder(path) })),
    { label: "Reveal selected in system explorer", hint: "", run: revealSelected },
    { label: "Open selected in default app", hint: "", run: openSelected },
    ...destinationCommands,
    { label: "Keep selected", hint: "K", run: () => updateReview({ status: "keep" }, { advance: true }) },
    { label: "Reject selected", hint: "X", run: () => updateReview({ status: "reject" }, { advance: true }) },
    { label: "Compare selected", hint: "", run: openCompare },
    { label: "Find duplicates", hint: "", run: openDuplicates },
    { label: "Batch rename selected", hint: "", run: openRename },
    { label: "Show file information", hint: "", run: showMetadata },
    { label: "Move selected to Recycle Bin", hint: "Ctrl Backspace", run: askToTrash },
    { label: "Undo last move", hint: "Ctrl Z", run: undoMove },
    { label: "Edit sort destinations", hint: "", run: () => $("#settings").showModal() },
    { label: "Show keyboard map", hint: "?", run: () => $("#shortcuts").showModal() },
  ];
  return commands;
}

function renderPalette() {
  const query = $("#palette-input").value.toLowerCase();
  const commands = buildCommands().filter((command) => command.label.toLowerCase().includes(query));
  $("#palette-results").innerHTML = commands.map((command, index) => `
    <button type="button" class="palette-result ${index === 0 ? "active" : ""}" data-command="${index}">
      <span>${escapeHtml(command.label)}</span><span>${escapeHtml(command.hint)}</span>
    </button>
  `).join("");
  $$(".palette-result").forEach((button) => button.addEventListener("click", () => {
    $("#palette").close();
    commands[Number(button.dataset.command)].run();
  }));
}

function openPalette() {
  $("#palette-input").value = "";
  renderPalette();
  $("#palette").showModal();
  requestAnimationFrame(() => $("#palette-input").focus());
}

function handleGoChord(key) {
  const location = state.locations.find((candidate) => candidate.hotkey && candidate.hotkey.toLowerCase() === key.toLowerCase());
  state.goChord = false;
  if (location) loadFolder(location.path);
  else showToast("No location uses that key");
}

function isTyping(event) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable;
}

function handleKeydown(event) {
  if (state.goChord && !isTyping(event)) {
    event.preventDefault();
    handleGoChord(event.key);
    return;
  }
  const key = event.key.toLowerCase();
  const focusedSeek = event.target === $("#seek");
  if ((isTyping(event) && !focusedSeek) || $("dialog[open]")) return;
  // A mouse click leaves the range input focused. Keep its native precision keys,
  // but let sorting and player shortcuts continue to work without an extra click.
  if (focusedSeek && ["arrowleft", "arrowright", "home", "end", "pageup", "pagedown"].includes(key)) return;
  if (key === "g") {
    state.goChord = true;
    showToast("Go to: D Downloads · P Pictures · V Videos · H Home · B Desktop");
    setTimeout(() => { state.goChord = false; }, 1800);
    return;
  }
  if (event.altKey && /^[1-5]$/.test(key)) { event.preventDefault(); updateReview({ rating: Number(key) }); return; }
  if (!videoPreview.classList.contains("hidden") && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (key === "b") { event.preventDefault(); addBookmark(); return; }
    if (key === "i") { event.preventDefault(); setLoopPoint("in"); return; }
    if (key === "o") { event.preventDefault(); setLoopPoint("out"); return; }
    if (key === "l" && event.shiftKey) { event.preventDefault(); toggleLoopRange(); return; }
  }
  const shortcut = shortcutFromEvent(event);
  const actions = [
    ["previous", () => selectRelative(-1)], ["next", () => selectRelative(1)], ["open_folder", () => { if (state.primary?.is_dir) loadFolder(state.primary.path); }],
    ["filter", () => $("#search").focus()], ["palette", openPalette], ["shortcuts", () => { renderShortcutEditor(); $("#shortcuts").showModal(); }],
    ["play", toggleVideo], ["zoom_in", () => setZoom("in")], ["zoom_out", () => setZoom("out")], ["fit", () => setZoom("fit")],
    ["mute", toggleMute], ["fullscreen", toggleFullscreen], ["speed_down", () => adjustSpeed(-1)], ["speed_up", () => adjustSpeed(1)],
    ["jump_back", () => jumpVideo(-10)], ["jump_forward", () => jumpVideo(10)], ["jump_back_30", () => jumpVideo(-30)], ["jump_forward_30", () => jumpVideo(30)],
    ["keep", () => updateReview({ status: "keep" }, { advance: true })], ["reject", () => updateReview({ status: "reject" }, { advance: true })],
    ["trash", askToTrash], ["undo", undoMove],
    ...Object.keys(state.config.destinations || {}).slice(0, 9).map((destination, index) => [`move:${destination}`, () => moveSelected(destination), String(index + 1)]),
  ];
  const match = actions.find(([action, , fallback]) => bindingFor(action, fallback).toLowerCase() === shortcut?.toLowerCase());
  if (match) { event.preventDefault(); match[1](); }
}

function bindEvents() {
  $("#sort-by").value = state.sortBy;
  $("#group-by").value = state.groupBy;
  $("#sort-direction").textContent = state.sortDirection === "asc" ? "↑" : "↓";
  $("#toggle-library").addEventListener("click", () => togglePanel("library"));
  $("#toggle-files").addEventListener("click", () => togglePanel("files"));
  $("#collapse-library").addEventListener("click", () => togglePanel("library"));
  $("#collapse-files").addEventListener("click", () => togglePanel("files"));
  $$('[data-collapse-section]').forEach((button) => button.addEventListener("click", () => {
    const section = $("#" + button.dataset.collapseSection);
    const collapsed = section.classList.toggle("section-collapsed");
    localStorage.setItem(`quick-sort-section:${section.id}`, String(collapsed));
  }));
  $("#open-folder").addEventListener("click", pickFolder);
  $("#add-location").addEventListener("click", pickFolder);
  $("#open-palette").addEventListener("click", openPalette);
  $("#parent-folder").addEventListener("click", () => loadFolder(state.parentPath));
  $("#back-browser").addEventListener("click", () => document.body.classList.remove("inspecting"));
  $("#settings-button").addEventListener("click", () => $("#settings").showModal());
  $("#shortcuts-button").addEventListener("click", () => { renderShortcutEditor(); $("#shortcuts").showModal(); });
  $("#undo-button").addEventListener("click", undoMove);
  $("#reveal-button").addEventListener("click", revealSelected);
  $("#open-default-button").addEventListener("click", openSelected);
  $("#trash-button").addEventListener("click", askToTrash);
  $("#quick-trash-button").addEventListener("click", askToTrash);
  $("#tools-button").addEventListener("click", () => $("#tools").showModal());
  $("#keep-button").addEventListener("click", () => updateReview({ status: "keep" }, { advance: true }));
  $("#reject-button").addEventListener("click", () => updateReview({ status: "reject" }, { advance: true }));
  $$("#rating [data-rating]").forEach((button) => button.addEventListener("click", () => updateReview({ rating: Number(button.dataset.rating) })));
  $("#tags").addEventListener("change", (event) => updateReview({ tags: event.target.value.split(",") }));
  $("#compare-button").addEventListener("click", openCompare);
  $("#compare-play").addEventListener("click", toggleComparePlayback);
  $("#compare-zoom-in").addEventListener("click", () => updateCompareZoom(2));
  $("#compare-zoom-out").addEventListener("click", () => updateCompareZoom(.5));
  $("#duplicates-button").addEventListener("click", openDuplicates);
  $("#duplicates-rescan").addEventListener("click", () => startDuplicateScan($("#duplicates").dataset.path || state.currentPath).catch((error) => showToast(error.message)));
  $("#duplicates-trash").addEventListener("click", trashDuplicateSelection);
  $("#duplicate-compare-play").addEventListener("click", toggleDuplicateComparePlayback);
  $("#duplicate-compare-zoom-in").addEventListener("click", () => adjustDuplicateCompareZoom(1.5));
  $("#duplicate-compare-zoom-out").addEventListener("click", () => adjustDuplicateCompareZoom(1 / 1.5));
  $("#duplicate-compare-full").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $("#duplicate-compare").requestFullscreen();
    } catch (_) { showToast("Fullscreen is not available in this browser"); }
  });
  $("#duplicate-compare-seek").addEventListener("input", (event) => {
    const ratio = Number(event.target.value) / 1000;
    $$("#duplicate-compare-grid video").forEach((video) => {
      if (Number.isFinite(video.duration)) video.currentTime = ratio * video.duration;
    });
  });
  $("#duplicate-compare").addEventListener("close", () => {
    $$("#duplicate-compare-grid video").forEach((video) => video.pause());
    state.duplicateCompareGroup = null;
  });
  $("#background-job-view").addEventListener("click", () => viewDuplicateJob().catch((error) => showToast(error.message)));
  $("#background-job-dismiss").addEventListener("click", () => $("#background-job").classList.add("hidden"));
  $("#rename-button").addEventListener("click", openRename);
  $("#metadata-button").addEventListener("click", showMetadata);
  $("#rename-pattern").addEventListener("input", renderRenamePreview);
  $("#add-destination").addEventListener("click", addDestination);
  $("#reset-shortcuts").addEventListener("click", () => {
    shortcutDefinitions().flatMap((section) => section.actions).forEach((action) => {
      const input = $(`[data-shortcut="${CSS.escape(action.id)}"]`);
      if (input) input.value = DEFAULT_KEYBINDINGS[action.id] || action.fallback || "";
    });
  });
  $("#save-shortcuts").addEventListener("click", async () => {
    const keybindings = Object.fromEntries($$('[data-shortcut]').map((input) => [input.dataset.shortcut, input.value]));
    const assigned = Object.values(keybindings).map((value) => value.toLowerCase()).filter(Boolean);
    const duplicate = assigned.find((value, index) => assigned.indexOf(value) !== index);
    if (duplicate) return showToast(`Shortcut ${duplicate} is assigned more than once`);
    if (Object.values(keybindings).some((value) => !value)) return showToast("Every action needs a shortcut");
    try {
      state.config = await api("/api/config", { method: "PUT", body: JSON.stringify({ destinations: state.config.destinations, labels: state.config.labels, keybindings }) });
      renderDestinations(); updateShortcutLabels(); $("#shortcuts").close(); showToast("Keyboard shortcuts saved");
    } catch (error) { showToast(error.message); }
  });
  $("#play-button").addEventListener("click", toggleVideo);
  $("#back-10").addEventListener("click", () => jumpVideo(-10));
  $("#frame-back").addEventListener("click", () => stepFrame(-1));
  $("#forward-10").addEventListener("click", () => jumpVideo(10));
  $("#frame-forward").addEventListener("click", () => stepFrame(1));
  $("#mark-button").addEventListener("click", addBookmark);
  $("#in-button").addEventListener("click", () => setLoopPoint("in"));
  $("#out-button").addEventListener("click", () => setLoopPoint("out"));
  $("#loop-button").addEventListener("click", toggleLoopRange);
  $("#clear-range-button").addEventListener("click", () => saveMediaState({ loopIn: null, loopOut: null, loop: false }));
  $("#mute-button").addEventListener("click", toggleMute);
  $("#volume").addEventListener("input", (event) => {
    videoPreview.volume = Number(event.target.value);
    videoPreview.muted = videoPreview.volume === 0;
    localStorage.setItem("quick-sort-volume", event.target.value);
    localStorage.setItem("quick-sort-muted", String(videoPreview.muted));
  });
  $("#speed").addEventListener("change", (event) => {
    videoPreview.playbackRate = Number(event.target.value);
    localStorage.setItem("quick-sort-playback-rate", event.target.value);
  });
  $("#pip-button").addEventListener("click", togglePictureInPicture);
  $("#fullscreen-button").addEventListener("click", toggleFullscreen);
  $("#seek").addEventListener("input", (event) => {
    if (Number.isFinite(videoPreview.duration)) videoPreview.currentTime = videoPreview.duration * Number(event.target.value) / 1000;
    updateSeekVisuals();
  });
  $("#seek").addEventListener("pointermove", showSeekPreview);
  $("#seek").addEventListener("pointerleave", () => { clearTimeout(state.seekPreviewTimer); $("#seek-preview").classList.add("hidden"); });
  $("#seek").addEventListener("pointerdown", showSeekPreview);
  $("#seek").addEventListener("pointerup", (event) => event.currentTarget.blur());
  $("#seek").addEventListener("wheel", scrubWithWheel, { passive: false });
  $("#seek-preview-image").addEventListener("error", (event) => {
    if (!state.primary || event.target.dataset.fallback === "true") return;
    event.target.dataset.fallback = "true";
    event.target.src = endpoint("/api/thumbnail", { path: state.primary.path });
  });
  $("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    state.renderLimit = 180;
    renderFiles();
  });
  $("#sort-by").addEventListener("change", (event) => {
    state.sortBy = event.target.value; localStorage.setItem("quick-sort-sort-by", state.sortBy); state.renderLimit = 180; renderFiles();
  });
  $("#group-by").addEventListener("change", (event) => {
    state.groupBy = event.target.value; localStorage.setItem("quick-sort-group-by", state.groupBy); state.renderLimit = 180; renderFiles();
  });
  $("#sort-direction").addEventListener("click", () => {
    state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
    localStorage.setItem("quick-sort-sort-direction", state.sortDirection);
    $("#sort-direction").textContent = state.sortDirection === "asc" ? "↑" : "↓";
    renderFiles();
  });
  $("#file-list").addEventListener("scroll", (event) => {
    const list = event.currentTarget;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 240 && state.renderLimit < state.visibleItems.length) {
      state.renderLimit = Math.min(state.visibleItems.length, state.renderLimit + 180);
      renderFiles({ preserveScroll: true });
    }
  });
  $("#category-filters").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter], button[data-review-filter]");
    if (!button) return;
    if (button.dataset.filter) { state.filter = button.dataset.filter; state.reviewFilter = "all"; }
    else { state.reviewFilter = button.dataset.reviewFilter; state.filter = "all"; }
    state.renderLimit = 180;
    $$("#category-filters button").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderFiles();
  });
  $$("[data-zoom]").forEach((button) => button.addEventListener("click", () => setZoom(button.dataset.zoom)));
  $$(".action-buttons [data-move]").forEach(bindMoveButton);
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
  $("#palette-input").addEventListener("input", renderPalette);
  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const destinations = Object.fromEntries($$("[data-destination]").map((input) => [input.dataset.destination, input.value]));
    const labels = Object.fromEntries($$("[data-destination-label]").map((input) => [input.dataset.destinationLabel, input.value.trim() || input.dataset.destinationLabel]));
    state.scrub = {
      normal: Math.max(.1, Number($("#scrub-normal").value) || 5),
      fast: Math.max(1, Number($("#scrub-fast").value) || 30),
      fine: Math.max(1, Number($("#scrub-fine").value) || 1),
    };
    localStorage.setItem("quick-sort-scrub", JSON.stringify(state.scrub));
    try {
      state.config = await api("/api/config", { method: "PUT", body: JSON.stringify({ destinations, labels }) });
      renderDestinations();
      renderSettings();
      renderShortcutEditor();
      $("#settings").close();
      showToast("Sort destinations saved");
    } catch (error) { showToast(error.message); }
  });
  $("#rename-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/rename", { method: "POST", body: JSON.stringify({ paths: selectedItems().map((item) => item.path), pattern: $("#rename-pattern").value }) });
      $("#rename").close(); showToast("Files renamed"); await loadFolder(state.currentPath);
    } catch (error) { showToast(error.message); }
  });
  $("#confirm-trash").addEventListener("close", () => { if ($("#confirm-trash").returnValue === "confirm") trashSelected(); });
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", applyZoom);
  imagePreview.addEventListener("load", () => {
    const dimensions = mediaDimensions(imagePreview);
    $("#selected-meta").textContent += ` · ${dimensions.width} × ${dimensions.height}px`;
    applyZoom();
  });
  videoPreview.addEventListener("loadedmetadata", () => {
    videoPreview.volume = Number(localStorage.getItem("quick-sort-volume") ?? "0.8");
    videoPreview.muted = localStorage.getItem("quick-sort-muted") === "true";
    videoPreview.playbackRate = Number(localStorage.getItem("quick-sort-playback-rate") ?? "1");
    $("#volume").value = String(videoPreview.volume);
    $("#speed").value = String(videoPreview.playbackRate);
    const dimensions = mediaDimensions(videoPreview);
    if (dimensions.width) $("#selected-meta").textContent += ` · ${dimensions.width} × ${dimensions.height}px`;
    applyZoom();
    const record = currentMediaState();
    if (Number.isFinite(record.resume) && record.resume > 0 && record.resume < videoPreview.duration - 2) videoPreview.currentTime = record.resume;
    buildFilmstrip();
    prepareVideoSprite(state.primary.path);
    renderTimelineOverlays();
    updateSeekVisuals();
  });
  videoPreview.addEventListener("timeupdate", () => {
    const record = currentMediaState();
    if (record.loop && Number.isFinite(record.loopIn) && Number.isFinite(record.loopOut) && videoPreview.currentTime >= record.loopOut) videoPreview.currentTime = record.loopIn;
    $("#seek").value = Number.isFinite(videoPreview.duration) && videoPreview.duration ? Math.round(videoPreview.currentTime / videoPreview.duration * 1000) : 0;
    $("#time-value").textContent = `${formatTime(videoPreview.currentTime)} / ${formatTime(videoPreview.duration)}`;
    updateSeekVisuals();
    saveMediaState({ resume: videoPreview.currentTime });
  });
  videoPreview.addEventListener("ended", () => saveMediaState({ resume: 0 }));
  videoPreview.addEventListener("progress", updateSeekVisuals);
  videoPreview.addEventListener("durationchange", updateSeekVisuals);
  videoPreview.addEventListener("play", () => { $("#play-button").textContent = "Pause"; });
  videoPreview.addEventListener("pause", () => { $("#play-button").textContent = "Play"; });
  videoPreview.addEventListener("volumechange", () => {
    $("#volume").value = String(videoPreview.muted ? 0 : videoPreview.volume);
    $("#mute-button").textContent = videoPreview.muted || videoPreview.volume === 0 ? "Unmute" : "Mute";
  });
  videoPreview.addEventListener("click", () => {
    if (!state.dragMoved) toggleVideo();
    state.dragMoved = false;
  });
  stage.addEventListener("wheel", (event) => {
    if (!activeMedia()) return;
    event.preventDefault();
    setZoom(event.deltaY < 0 ? "in" : "out");
  }, { passive: false });
  stage.addEventListener("pointerdown", (event) => {
    if (!stage.classList.contains("pannable")) return;
    state.dragging = true;
    state.dragMoved = false;
    state.dragOrigin = { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y };
    stage.classList.add("dragging");
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    if (Math.abs(event.clientX - state.dragOrigin.x - state.pan.x) > 4 || Math.abs(event.clientY - state.dragOrigin.y - state.pan.y) > 4) state.dragMoved = true;
    state.pan = { x: event.clientX - state.dragOrigin.x, y: event.clientY - state.dragOrigin.y };
    applyZoom();
  });
  stage.addEventListener("pointerup", () => { state.dragging = false; stage.classList.remove("dragging"); });
  document.addEventListener("fullscreenchange", () => {
    $("#fullscreen-button").textContent = document.fullscreenElement ? "Exit full" : "Full";
  });
  $("#pip-button").hidden = !document.pictureInPictureEnabled;
}

function restoreLayout() {
  for (const panel of ["library", "files"]) {
    const className = panel === "library" ? "library-collapsed" : "files-collapsed";
    const collapsed = localStorage.getItem(`quick-sort-${className}`) === "true";
    document.body.classList.toggle(className, collapsed);
    $(`#toggle-${panel}`).setAttribute("aria-pressed", String(!collapsed));
  }
  for (const sectionId of ["places-section", "sort-section"]) {
    $("#" + sectionId).classList.toggle("section-collapsed", localStorage.getItem(`quick-sort-section:${sectionId}`) === "true");
  }
}

function startLiveReload() {
  let lastSeen = sessionStorage.getItem("quick-sort-version");
  setInterval(async () => {
    try {
      const response = await fetch(`/api/health?now=${Date.now()}`, { cache: "no-store" });
      const data = await response.json();
      if (lastSeen && data.version !== lastSeen) {
        sessionStorage.setItem("quick-sort-version", data.version);
        window.location.reload();
        return;
      }
      lastSeen = data.version;
      sessionStorage.setItem("quick-sort-version", data.version);
    } catch (_) {
      // A short failure is expected while the development server restarts.
    }
  }, 900);
}

restoreLayout();
bindEvents();
startLiveReload();
loadInitialData().catch((error) => showToast(error.message));
