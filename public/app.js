const topicsElement = document.querySelector("#topics");
const roomsElement = document.querySelector("#rooms");
const feedElement = document.querySelector("#feed");
const metricsElement = document.querySelector("#metrics");
const generatedAtElement = document.querySelector("#generated-at");
const scenarioButtonsElement = document.querySelector("#scenario-buttons");
const viewerSelect = document.querySelector("#viewer-select");
const chatroomElement = document.querySelector("#chatroom");
const chatroomTitle = document.querySelector("#chatroom-title");
const chatroomContext = document.querySelector("#chatroom-context");
const roomMessages = document.querySelector("#room-messages");
const chatroomError = document.querySelector("#chatroom-error");
const roomForm = document.querySelector("#room-form");
const roomInput = document.querySelector("#room-input");
const inputStatus = document.querySelector("#input-status");
const invitationElement = document.querySelector("#invitation-floater");
const inviteTitle = document.querySelector("#invite-title");
const inviteTopic = document.querySelector("#invite-topic");
const inviteMembers = document.querySelector("#invite-members");
const inviteExpiry = document.querySelector("#invite-expiry");
const identityGate = document.querySelector("#identity-gate");
const reportDialog = document.querySelector("#report-dialog");
const reportForm = document.querySelector("#report-form");
const reportError = document.querySelector("#report-error");

const pageParameters = new URLSearchParams(window.location.search);
const extensionMode = Boolean(window.Twitch?.ext?.onAuthorized &&
  (pageParameters.has("anchor") || pageParameters.get("extensionMode") === "1"));
const configuredApiBase = document.querySelector('meta[name="sidechat-api-base"]')?.content.trim().replace(/\/$/, "") ?? "";
const apiUrl = (path) => extensionMode && configuredApiBase ? configuredApiBase + path : path;
let extensionToken = null;
let extensionIdentity = null;
let lastState = null;
let openRoomId = null;
let invitationRoomId = null;

if (extensionMode) document.body.classList.add("extension-mode");

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function requestHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (extensionToken) headers["x-extension-jwt"] = extensionToken;
  return headers;
}

function selectedViewer(rooms = lastState?.rooms ?? []) {
  const userId = extensionMode ? extensionIdentity?.userId : viewerSelect.value;
  if (!userId) return null;
  for (const room of rooms) {
    const viewer = room.members.find((member) => member.userId === userId);
    if (viewer) return viewer;
  }
  return extensionMode ? { userId, displayName: "Twitch viewer" } : null;
}

function viewerBody(extra = {}) {
  if (extensionMode) return extra;
  const viewer = selectedViewer();
  return { ...extra, userId: viewer?.userId, displayName: viewer?.displayName };
}

async function roomAction(roomId, action, body = {}) {
  const response = await fetch(apiUrl("/api/rooms/" + encodeURIComponent(roomId) + "/" + action), {
    method: "POST", headers: requestHeaders(), body: JSON.stringify(viewerBody(body))
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Room action failed");
  return result;
}

function updateViewerOptions(rooms) {
  if (extensionMode) return;
  const previous = viewerSelect.value;
  const viewers = new Map();
  rooms.forEach((room) => room.members.forEach((member) => viewers.set(member.userId, member)));
  if (!viewers.size) {
    viewerSelect.innerHTML = "<option>Waiting for invitations</option>";
    viewerSelect.disabled = true;
    return;
  }
  viewerSelect.disabled = false;
  viewerSelect.innerHTML = [...viewers.values()].map((viewer) =>
    '<option value="' + escapeHtml(viewer.userId) + '">' + escapeHtml(viewer.displayName) + "</option>"
  ).join("");
  if (viewers.has(previous)) viewerSelect.value = previous;
}

function renderRooms(rooms) {
  if (extensionMode) return;
  updateViewerOptions(rooms);
  const viewer = selectedViewer(rooms);
  roomsElement.className = rooms.length ? "rooms" : "rooms empty-rooms";
  roomsElement.innerHTML = rooms.length ? rooms.map((room) => {
    const invited = room.members.some((member) => member.userId === viewer?.userId);
    const joined = room.joinedMembers?.some((member) => member.userId === viewer?.userId);
    return '<article class="room">' +
      '<div class="topic-top"><h3>' + escapeHtml(room.name ?? room.viewpoint) + '</h3><span class="badge">' + (joined ? "joined" : "invite") + '</span></div>' +
      '<p class="room-topic">' + escapeHtml(room.topicTitle) + '</p>' +
      '<div class="members">' + room.members.map((member) =>
        '<span title="' + Math.round(member.confidence * 100) + '% confidence">' + escapeHtml(member.displayName) + "</span>"
      ).join("") + '</div>' +
      '<div class="room-actions"><p class="consent-note">' + room.members.length + ' invited · ' + (room.joinedMembers?.length ?? 0) + ' joined</p>' +
      '<button class="join-room" data-room-id="' + escapeHtml(room.id) + '" ' + (invited ? "" : "disabled") + ">" +
      (invited ? (joined ? "Open chat" : "Join room") : "Not matched") + "</button></div>" +
    "</article>";
  }).join("") : "Trends can appear above; rooms require a coherent shared moment from several viewers.";
}

function renderInvitation(rooms) {
  const viewer = selectedViewer(rooms);
  const room = viewer ? rooms.find((item) => item.members.some((member) => member.userId === viewer.userId)) : null;
  if (!room || openRoomId === room.id) {
    invitationRoomId = null;
    invitationElement.classList.add("hidden");
    return;
  }
  invitationRoomId = room.id;
  const joined = room.joinedMembers?.some((member) => member.userId === viewer.userId);
  inviteTitle.textContent = room.name ?? room.viewpoint;
  inviteTopic.textContent = room.topicTitle + " · " + room.viewpoint;
  inviteMembers.textContent = room.members.length + " viewers";
  document.querySelector("#accept-invite").textContent = joined ? "Open the room" : "Join the room";
  invitationElement.classList.remove("hidden");
  updateExpiry(room);
}

function updateExpiry(room) {
  const seconds = Math.max(0, Math.ceil((Date.parse(room.expiresAt) - Date.now()) / 1000));
  inviteExpiry.textContent = seconds ? seconds + "s left" : "ending";
}

function renderChatroom(room) {
  if (!room || !openRoomId) return;
  const viewer = selectedViewer();
  chatroomTitle.textContent = room.name ?? room.viewpoint + " room";
  chatroomContext.textContent = room.topicTitle + " · " + room.joinedMembers.length + " joined";
  roomMessages.innerHTML = room.messages.length ? room.messages.map((message) => {
    const classes = ["room-message"];
    if (message.type === "system") classes.push("system");
    if (message.userId && message.userId === viewer?.userId) classes.push("mine");
    return '<div class="' + classes.join(" ") + '">' +
      (message.type === "system" ? "" : "<strong>" + escapeHtml(message.displayName) + "</strong>") +
      escapeHtml(message.text) + "</div>";
  }).join("") : '<div class="room-message system">The room is ready. Start the conversation.</div>';
  roomMessages.scrollTop = roomMessages.scrollHeight;
  chatroomElement.classList.remove("hidden");
}

function renderDashboard(state) {
  if (extensionMode) return;
  const input = state.input ?? { status: "ready", label: "Replay input" };
  inputStatus.className = "live-pill input-" + escapeHtml(input.status);
  inputStatus.querySelector("b").textContent = input.label + (input.messagesReceived ? " · " + input.messagesReceived : "");
  inputStatus.title = input.error ?? "";
  const metrics = [
    ["Messages", state.totals.received], ["Substantive", state.totals.substantive],
    ["Filtered", state.totals.filtered], ["Viewers", state.totals.uniqueViewers],
    ["Queue", state.pipeline?.queued ?? 0], ["Batch ms", state.pipeline?.lastBatchMs ?? 0]
  ];
  metricsElement.innerHTML = metrics.map(([label, value]) =>
    '<div class="metric"><span>' + label + "</span><strong>" + value + "</strong></div>"
  ).join("");
  generatedAtElement.textContent = "Updated " + new Date(state.generatedAt).toLocaleTimeString();
  if (state.topics.length === 0) {
    topicsElement.className = "topics empty-state";
    topicsElement.textContent = "Waiting for a meaningful conversation…";
  } else {
    topicsElement.className = "topics";
    topicsElement.innerHTML = state.topics.map((topic) =>
      '<article class="topic ' + escapeHtml(topic.status) + '">' +
        '<div class="topic-top"><h3>' + escapeHtml(topic.title) + '</h3><span class="badge">' + escapeHtml(topic.status) + "</span></div>" +
        '<div class="topic-meta"><span>' + topic.uniqueViewers + " viewers</span><span>" + topic.messageCount +
        " messages</span><span>" + Math.round(topic.score * 100) + " signal</span><span>" + escapeHtml(topic.sentiment) + "</span></div>" +
        '<div class="bar"><span style="width:' + Math.round(topic.score * 100) + '%"></span></div>' +
        '<div class="samples">' + topic.sampleMessages.slice(-3).map((sample) =>
          '<p class="sample"><strong>' + escapeHtml(sample.user) + ":</strong> " + escapeHtml(sample.text) + "</p>"
        ).join("") + "</div></article>"
    ).join("");
  }
  feedElement.innerHTML = state.recentMessages.map((message) =>
    '<div class="message ' + (message.filterReason ? "filtered" : "") + '">' +
    (message.filterReason ? '<span class="filter-tag">' + escapeHtml(message.filterReason) + "</span>" : "") +
    "<strong>" + escapeHtml(message.displayName) + "</strong>" + escapeHtml(message.text) + "</div>"
  ).join("");
}

function render(state) {
  lastState = state;
  const rooms = state.rooms ?? [];
  renderDashboard(state);
  renderRooms(rooms);
  renderInvitation(rooms);
  if (openRoomId) renderChatroom(rooms.find((room) => room.id === openRoomId));
}

async function joinAndOpen(roomId) {
  chatroomError.textContent = "";
  const room = await roomAction(roomId, "join");
  openRoomId = room.id;
  const index = lastState.rooms.findIndex((item) => item.id === room.id);
  if (index >= 0) lastState.rooms[index] = room;
  render(lastState);
  renderChatroom(room);
  roomInput.focus();
}

async function loadScenarios() {
  const scenarios = await fetch(apiUrl("/api/scenarios")).then((response) => response.json());
  scenarioButtonsElement.innerHTML = scenarios.map((scenario) =>
    '<button data-scenario="' + escapeHtml(scenario.id) + '">' + escapeHtml(scenario.name) + "</button>"
  ).join("");
}

async function loadViewerState() {
  if (!extensionToken || !extensionIdentity?.linked) return;
  const response = await fetch(apiUrl("/api/viewer/state"), { headers: requestHeaders() });
  const state = await response.json();
  if (!response.ok) {
    identityGate.classList.remove("hidden");
    return;
  }
  identityGate.classList.add("hidden");
  render({ ...state, rooms: state.rooms ?? [] });
}

function initializeExtension() {
  window.Twitch.ext.onAuthorized(async (auth) => {
    extensionToken = auth.token;
    const response = await fetch(apiUrl("/api/identity"), { headers: requestHeaders() });
    const identity = await response.json();
    if (!response.ok) {
      identityGate.querySelector("p:not(.label)").textContent = identity.error ?? "Extension identity is unavailable.";
      identityGate.classList.remove("hidden");
      return;
    }
    extensionIdentity = identity;
    identityGate.classList.toggle("hidden", identity.linked);
    if (identity.linked) await loadViewerState();
  });
  setInterval(() => void loadViewerState(), 1_500);
}

scenarioButtonsElement.addEventListener("click", async (event) => {
  const id = event.target.dataset.scenario;
  if (id) await fetch(apiUrl("/api/simulate/" + encodeURIComponent(id)), { method: "POST" });
});

viewerSelect.addEventListener("change", () => {
  openRoomId = null;
  chatroomElement.classList.add("hidden");
  if (lastState) render(lastState);
});

roomsElement.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-room-id]");
  if (!button) return;
  try { await joinAndOpen(button.dataset.roomId); }
  catch (error) { chatroomError.textContent = error.message; }
});

document.querySelector("#accept-invite").addEventListener("click", async () => {
  if (!invitationRoomId) return;
  try { await joinAndOpen(invitationRoomId); }
  catch (error) { chatroomError.textContent = error.message; }
});

document.querySelector("#dismiss-invite").addEventListener("click", async () => {
  if (!invitationRoomId) return;
  try {
    await roomAction(invitationRoomId, "dismiss");
    invitationElement.classList.add("hidden");
    if (extensionMode) await loadViewerState();
  } catch (error) { chatroomError.textContent = error.message; }
});

roomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = roomInput.value.trim();
  if (!openRoomId || !text) return;
  try {
    const room = await roomAction(openRoomId, "messages", { text });
    roomInput.value = "";
    chatroomError.textContent = "";
    const index = lastState.rooms.findIndex((item) => item.id === room.id);
    if (index >= 0) lastState.rooms[index] = room;
    renderChatroom(room);
  } catch (error) { chatroomError.textContent = error.message; }
});

document.querySelector("#close-chatroom").addEventListener("click", () => {
  openRoomId = null;
  chatroomElement.classList.add("hidden");
  if (lastState) renderInvitation(lastState.rooms ?? []);
});

document.querySelector("#leave-room").addEventListener("click", async () => {
  if (!openRoomId) return;
  try {
    await roomAction(openRoomId, "leave");
    openRoomId = null;
    chatroomElement.classList.add("hidden");
    if (extensionMode) await loadViewerState();
  } catch (error) { chatroomError.textContent = error.message; }
});

document.querySelector("#mute-topic").addEventListener("click", async () => {
  if (!openRoomId) return;
  try {
    await roomAction(openRoomId, "mute");
    openRoomId = null;
    chatroomElement.classList.add("hidden");
    if (extensionMode) await loadViewerState();
  } catch (error) { chatroomError.textContent = error.message; }
});

document.querySelector("#report-room").addEventListener("click", () => {
  reportError.textContent = "";
  reportDialog.showModal();
});
document.querySelector("#cancel-report").addEventListener("click", () => reportDialog.close());
reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = new FormData(reportForm).get("reason");
  if (!reason || !openRoomId) return;
  try {
    await roomAction(openRoomId, "report", { reason });
    reportDialog.close();
    openRoomId = null;
    chatroomElement.classList.add("hidden");
    if (extensionMode) await loadViewerState();
  } catch (error) { reportError.textContent = error.message; }
});

document.querySelector("#share-identity").addEventListener("click", () => {
  window.Twitch?.ext?.actions?.requestIdShare();
});

document.querySelector("#reset").addEventListener("click", () => {
  openRoomId = null;
  chatroomElement.classList.add("hidden");
  fetch(apiUrl("/api/reset"), { method: "POST" });
});

setInterval(() => {
  if (!invitationRoomId || !lastState) return;
  const room = lastState.rooms?.find((item) => item.id === invitationRoomId);
  if (room) updateExpiry(room);
}, 1_000);

if (extensionMode) {
  initializeExtension();
} else {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => render(JSON.parse(event.data)));
  events.addEventListener("input", (event) => {
    if (!lastState) return;
    lastState.input = JSON.parse(event.data);
    render(lastState);
  });
  events.addEventListener("room", (event) => {
    const room = JSON.parse(event.data);
    if (!lastState) return;
    const index = lastState.rooms.findIndex((item) => item.id === room.id);
    if (index >= 0) lastState.rooms[index] = room;
    render(lastState);
  });
  await loadScenarios();
  render(await fetch(apiUrl("/api/state")).then((response) => response.json()));
}
