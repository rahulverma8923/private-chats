const state = {
  id: null,
  roomId: null,
  name: null,
  socket: null,
  joinResolver: null,
  users: [],
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  currentPeerId: null,
  pendingOffer: null,
  pendingCandidates: [],
  ignoredOfferFrom: null,
  micEnabled: true,
  cameraEnabled: true
};

function connectSocket() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(state.socket);
  }

  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    state.socket = ws;
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("Could not connect to private room.")), { once: true });
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        handleSocketEvent(message.event, message.data || {});
      } catch {
        console.warn("Invalid server message");
      }
    });
    ws.addEventListener("close", () => {
      els.statusDot.classList.remove("online");
      els.statusText.textContent = "Disconnected";
    });
  });
}

async function loadConfig() {
  try {
    const response = await fetch("/config", { cache: "no-store" });
    const config = await response.json();
    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      state.iceServers = config.iceServers;
    }
  } catch {
    console.warn("Using default ICE servers");
  }
}

function emit(event, data = {}) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ event, data }));
  }
}

const els = {
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  nameInput: document.querySelector("#nameInput"),
  roomInput: document.querySelector("#roomInput"),
  passwordInput: document.querySelector("#passwordInput"),
  roomPanel: document.querySelector("#roomPanel"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  messages: document.querySelector("#messages"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  timerSelect: document.querySelector("#timerSelect"),
  typing: document.querySelector("#typing"),
  noteInput: document.querySelector("#noteInput"),
  voiceButton: document.querySelector("#voiceButton"),
  videoButton: document.querySelector("#videoButton"),
  acceptCallButton: document.querySelector("#acceptCallButton"),
  muteButton: document.querySelector("#muteButton"),
  cameraButton: document.querySelector("#cameraButton"),
  endCallButton: document.querySelector("#endCallButton"),
  localVideo: document.querySelector("#localVideo"),
  remoteVideo: document.querySelector("#remoteVideo"),
  callStatus: document.querySelector("#callStatus")
};

function setPresence(users) {
  state.users = users;
  const partner = users.find((user) => user.id !== state.id);
  els.statusDot.classList.toggle("online", Boolean(partner));
  els.statusText.textContent = partner ? `${partner.name} online` : "Waiting for partner";
}

function addMessage(message, mine = false) {
  const row = document.createElement("article");
  row.className = `message${mine ? " mine" : ""}`;
  row.dataset.id = message.id;
  row.innerHTML = `
    <div>${escapeHtml(message.text)}</div>
    <div class="message-meta">
      <span>${mine ? "You" : escapeHtml(message.senderName || "Partner")}</span>
      <span data-status>${mine ? "Sending" : "Read"}</span>
    </div>
  `;
  els.messages.append(row);
  els.messages.scrollTop = els.messages.scrollHeight;

  if (message.selfDestruct > 0) {
    setTimeout(() => row.remove(), message.selfDestruct * 1000);
  }

  if (!mine) {
    emit("read", { ids: [message.id] });
  }
}

function updateMessageStatus(id, status) {
  const row = els.messages.querySelector(`[data-id="${CSS.escape(id)}"] [data-status]`);
  if (row) row.textContent = status;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function peerId() {
  return state.users.find((user) => user.id !== state.id)?.id;
}

function createPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: state.iceServers,
    iceTransportPolicy: "all"
  });

  state.remoteStream = new MediaStream();
  els.remoteVideo.srcObject = state.remoteStream;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && state.currentPeerId) {
      emit("call:signal", {
        targetId: state.currentPeerId,
        signal: { type: "candidate", candidate }
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "checking") {
      els.callStatus.textContent = "Connecting video...";
    }
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      els.callStatus.textContent = "Call connected.";
    }
    if (pc.iceConnectionState === "failed") {
      els.callStatus.textContent = "Video connection failed. Add a TURN server in Render settings.";
    }
  };

  pc.ontrack = ({ streams }) => {
    streams[0].getTracks().forEach((track) => state.remoteStream.addTrack(track));
    els.callStatus.textContent = "Call connected.";
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      els.callStatus.textContent = "Call connected.";
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      els.callStatus.textContent = "Connection interrupted. Try ending and calling again.";
    }
  };

  state.localStream?.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
  state.peerConnection = pc;
  return pc;
}

async function startMedia(video) {
  if (state.localStream) {
    const hasVideo = state.localStream.getVideoTracks().length > 0;
    if (!video || hasVideo) {
      return;
    }
    state.localStream.getTracks().forEach((track) => track.stop());
  }

  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video
  });
  els.localVideo.srcObject = state.localStream;
}

async function startCall(video) {
  if (state.pendingOffer) {
    await acceptIncomingCall();
    return;
  }

  const targetId = peerId();
  if (!targetId) {
    els.callStatus.textContent = "Partner needs to be online first.";
    return;
  }

  state.currentPeerId = targetId;
  state.pendingCandidates = [];
  state.ignoredOfferFrom = null;
  await startMedia(video);
  const pc = createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  emit("call:ring", { mode: video ? "video" : "voice" });
  emit("call:signal", { targetId, signal: offer });
  els.callStatus.textContent = video ? "Video call ringing..." : "Voice call ringing...";
}

async function handleSignal({ fromId, fromName, signal }) {
  state.currentPeerId = fromId;

  if (signal.type === "offer") {
    const hasOfferCollision = state.peerConnection && state.peerConnection.signalingState !== "stable";

    if (hasOfferCollision && state.id < fromId) {
      state.ignoredOfferFrom = fromId;
      return;
    }

    if (hasOfferCollision) {
      state.peerConnection.close();
      state.peerConnection = null;
      state.remoteStream = null;
      els.remoteVideo.srcObject = null;
    }

    state.ignoredOfferFrom = null;
    state.pendingCandidates = [];
    state.pendingOffer = { fromId, fromName, signal };
    els.acceptCallButton.classList.remove("hidden");
    els.callStatus.textContent = `${fromName || "Partner"} is calling. Tap Accept.`;
    return;
  }

  if (!state.peerConnection && signal.type === "candidate") {
    state.pendingCandidates.push(signal.candidate);
    return;
  }

  if (!state.peerConnection) return;

  if (signal.type === "answer") {
    await state.peerConnection.setRemoteDescription(signal);
    await addPendingCandidates();
    els.callStatus.textContent = "Call connected.";
    return;
  }

  if (signal.type === "candidate") {
    if (state.ignoredOfferFrom === fromId) return;

    if (!state.peerConnection.remoteDescription) {
      state.pendingCandidates.push(signal.candidate);
      return;
    }

    await state.peerConnection.addIceCandidate(signal.candidate);
  }
}

async function acceptIncomingCall() {
  if (!state.pendingOffer) return;

  const { fromId, fromName, signal } = state.pendingOffer;
  state.pendingOffer = null;
  els.acceptCallButton.classList.add("hidden");

  try {
    const wantsVideo = signal.sdp.includes("m=video");
    await startMedia(wantsVideo);
    const pc = createPeerConnection();
    await pc.setRemoteDescription(signal);
    await addPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    emit("call:signal", { targetId: fromId, signal: answer });
    els.callStatus.textContent = `Connected with ${fromName || "partner"}.`;
  } catch (error) {
    state.pendingOffer = { fromId, fromName, signal };
    els.acceptCallButton.classList.remove("hidden");
    showCallError(error);
  }
}

async function addPendingCandidates() {
  if (!state.peerConnection?.remoteDescription) return;

  const candidates = state.pendingCandidates.splice(0);
  for (const candidate of candidates) {
    await state.peerConnection.addIceCandidate(candidate);
  }
}

function endCall(notify = true) {
  state.peerConnection?.close();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.peerConnection = null;
  state.localStream = null;
  state.remoteStream = null;
  state.currentPeerId = null;
  state.pendingOffer = null;
  state.pendingCandidates = [];
  state.ignoredOfferFrom = null;
  els.localVideo.srcObject = null;
  els.remoteVideo.srcObject = null;
  els.acceptCallButton.classList.add("hidden");
  els.callStatus.textContent = "Call ended.";
  if (notify) emit("call:end");
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    name: els.nameInput.value,
    roomId: els.roomInput.value,
    password: els.passwordInput.value
  };

  try {
    await loadConfig();
    await connectSocket();
  } catch (error) {
    els.loginError.textContent = error.message;
    return;
  }

  const response = await new Promise((resolve) => {
    state.joinResolver = resolve;
    emit("join", payload);
    setTimeout(() => resolve({ ok: false, error: "Connection timed out" }), 6000);
  });

    if (!response?.ok) {
      els.loginError.textContent = response?.error || "Access denied";
      return;
    }

    state.id = response.id;
    state.roomId = payload.roomId;
    state.name = payload.name;
    els.loginPanel.classList.add("hidden");
    els.roomPanel.classList.remove("hidden");
    els.noteInput.value = response.note || "";
    setPresence(response.users);
});

els.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text) return;

  const message = {
    id: crypto.randomUUID(),
    text,
    selfDestruct: Number(els.timerSelect.value),
    senderName: state.name
  };

  addMessage(message, true);
  emit("message", message);
  els.messageInput.value = "";
  emit("typing", { isTyping: false });
});

let typingTimer;
els.messageInput.addEventListener("input", () => {
  emit("typing", { isTyping: els.messageInput.value.length > 0 });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => emit("typing", { isTyping: false }), 900);
});

els.noteInput.addEventListener("input", () => {
  emit("note:update", { note: els.noteInput.value });
});

document.querySelectorAll(".theme-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.body.className = button.dataset.theme === "dark" ? "" : button.dataset.theme;
    document.querySelectorAll(".theme-button").forEach((themeButton) => {
      themeButton.classList.toggle("active", themeButton === button);
    });
  });
});

els.voiceButton.addEventListener("click", () => startCall(false).catch(showCallError));
els.videoButton.addEventListener("click", () => startCall(true).catch(showCallError));
els.acceptCallButton.addEventListener("click", () => acceptIncomingCall().catch(showCallError));
els.endCallButton.addEventListener("click", () => endCall(true));
els.muteButton.addEventListener("click", () => {
  state.micEnabled = !state.micEnabled;
  state.localStream?.getAudioTracks().forEach((track) => { track.enabled = state.micEnabled; });
  els.muteButton.classList.toggle("active", !state.micEnabled);
  els.muteButton.setAttribute("aria-pressed", String(!state.micEnabled));
  els.muteButton.title = state.micEnabled ? "Mute microphone" : "Unmute microphone";
  els.muteButton.setAttribute("aria-label", els.muteButton.title);
});
els.cameraButton.addEventListener("click", () => {
  state.cameraEnabled = !state.cameraEnabled;
  state.localStream?.getVideoTracks().forEach((track) => { track.enabled = state.cameraEnabled; });
  els.cameraButton.classList.toggle("active", !state.cameraEnabled);
  els.cameraButton.setAttribute("aria-pressed", String(!state.cameraEnabled));
  els.cameraButton.title = state.cameraEnabled ? "Turn camera off" : "Turn camera on";
  els.cameraButton.setAttribute("aria-label", els.cameraButton.title);
});

function showCallError(error) {
  els.callStatus.textContent = error?.message || "Call could not start.";
}

function handleSocketEvent(event, data) {
  if (event === "join:result" && state.joinResolver) {
    const resolve = state.joinResolver;
    state.joinResolver = null;
    resolve(data);
  }

  if (event === "presence") setPresence(data.users);
  if (event === "message") addMessage(data, false);
  if (event === "delivered") updateMessageStatus(data.id, "Delivered");
  if (event === "read") data.ids.forEach((id) => updateMessageStatus(id, "Read"));
  if (event === "typing") els.typing.textContent = data.isTyping ? `${data.name} is typing...` : "";
  if (event === "note:update" && document.activeElement !== els.noteInput) els.noteInput.value = data.note;
  if (event === "call:ring") els.callStatus.textContent = `${data.fromName || "Partner"} started a ${data.mode || "private"} call.`;
  if (event === "call:signal") handleSignal(data).catch(showCallError);
  if (event === "call:end") endCall(false);
}
