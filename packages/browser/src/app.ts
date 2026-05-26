import { loadZfa, generateCapability } from "./zfa.js";
import { QOSPeer } from "./peer.js";

// ---------------------------------------------------------------------------
// Room ID from URL hash: #room=cap:..., or generate a new one and set hash.
// ---------------------------------------------------------------------------

function getRoomId(): string {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const existing = params.get("room");
  if (existing) return existing;
  const id = generateCapability("room");
  params.set("room", id);
  window.location.hash = params.toString();
  return id;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const myIdEl       = document.getElementById("my-id")!;
const roomIdEl     = document.getElementById("room-id")!;
const signalUrlEl  = document.getElementById("signal-url") as HTMLInputElement;
const connectBtn   = document.getElementById("connect-btn") as HTMLButtonElement;
const statusDot    = document.getElementById("status-dot")!;
const statusText   = document.getElementById("status-text")!;
const peerList     = document.getElementById("peer-list")!;
const peerCount    = document.getElementById("peer-count")!;
const messagesEl   = document.getElementById("messages")!;
const msgInput     = document.getElementById("msg-input") as HTMLInputElement;
const sendBtn      = document.getElementById("send-btn") as HTMLButtonElement;
const shareLink    = document.getElementById("share-link") as HTMLAnchorElement;
const copyBtn      = document.getElementById("copy-btn") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const peers = new Set<string>();
let qpeer: QOSPeer | null = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(state: "disconnected" | "connecting" | "connected", label: string): void {
  statusDot.className = `status-dot ${state === "disconnected" ? "" : state}`;
  statusText.textContent = label;
  statusText.style.color = state === "connected" ? "#4caf50"
                         : state === "connecting" ? "#ff9800"
                         : "#555";
}

function addMessage(from: string, text: string, kind: "peer" | "self" | "system" = "peer"): void {
  const div = document.createElement("div");
  div.className = `msg${kind === "system" ? " system-line" : ""}`;
  const fromEl = document.createElement("span");
  fromEl.className = `from ${kind}`;
  fromEl.textContent = kind === "system" ? "·" : kind === "self" ? "you" : shortId(from);
  const textEl = document.createElement("span");
  textEl.className = "text";
  textEl.textContent = text;
  div.appendChild(fromEl);
  div.appendChild(textEl);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function shortId(id: string): string {
  // cap:label:hexhex… → show first 8 hex chars
  const parts = id.split(":");
  const hex = parts[2] ?? id;
  return hex.slice(0, 8) + "…";
}

function renderPeers(): void {
  peerCount.textContent = String(peers.size);
  peerList.innerHTML = "";
  if (qpeer) {
    const li = document.createElement("li");
    li.className = "you";
    li.textContent = `${shortId(qpeer.peerId)} (you)`;
    peerList.appendChild(li);
  }
  for (const id of peers) {
    const li = document.createElement("li");
    li.textContent = shortId(id);
    peerList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function connect(): Promise<void> {
  if (qpeer) {
    qpeer.disconnect();
    qpeer = null;
    peers.clear();
    renderPeers();
    msgInput.disabled = true;
    sendBtn.disabled = true;
    connectBtn.textContent = "Connect";
    setStatus("disconnected", "disconnected");
    return;
  }

  const roomId = getRoomId();
  const signalingUrl = signalUrlEl.value.trim();

  setStatus("connecting", "connecting…");
  connectBtn.textContent = "Disconnect";

  qpeer = new QOSPeer({
    signalingUrl,
    roomId,
    onMessage(from, data) {
      const text = typeof data === "object" && data !== null && "text" in data
        ? String((data as any).text)
        : JSON.stringify(data);
      addMessage(from, text, "peer");
    },
    onPeerJoined(id) {
      peers.add(id);
      renderPeers();
      addMessage("", `${shortId(id)} joined`, "system");
    },
    onPeerLeft(id) {
      peers.delete(id);
      renderPeers();
      addMessage("", `${shortId(id)} left`, "system");
    },
  });

  try {
    await qpeer.connect();
    setStatus("connected", `connected · ${signalingUrl}`);
    msgInput.disabled = false;
    sendBtn.disabled = false;
    renderPeers();
    addMessage("", `joined room ${shortId(roomId)}`, "system");
  } catch (err) {
    setStatus("disconnected", `failed: ${err}`);
    connectBtn.textContent = "Connect";
    qpeer = null;
  }
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function send(): void {
  const text = msgInput.value.trim();
  if (!text || !qpeer) return;
  qpeer.broadcast({ text });
  addMessage("", text, "self");
  msgInput.value = "";
}

// ---------------------------------------------------------------------------
// Share link
// ---------------------------------------------------------------------------

function updateShareLink(): void {
  const url = window.location.href;
  shareLink.href = url;
  shareLink.textContent = url.length > 80 ? url.slice(0, 80) + "…" : url;
}

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(window.location.href).then(() => {
    copyBtn.textContent = "copied!";
    setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  await loadZfa();

  const roomId = getRoomId();
  const cap = generateCapability("peer");

  myIdEl.textContent  = cap;
  roomIdEl.textContent = roomId;
  updateShareLink();

  connectBtn.addEventListener("click", connect);
  sendBtn.addEventListener("click", send);
  msgInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  // Read signaling URL from query param ?signal=ws://...
  const qp = new URLSearchParams(window.location.search);
  const sig = qp.get("signal");
  if (sig) signalUrlEl.value = sig;
}

init();
