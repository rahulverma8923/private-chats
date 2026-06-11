const fs = require("fs");
const http = require("http");
const path = require("path");
const { createHash, randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;
const SECRET_PASSWORD = process.env.SECRET_PASSWORD || "AaravRiya2026";
const MAX_USERS_PER_ROOM = 2;
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const rooms = new Map();
const clients = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    sendJson(res, { ok: true });
    return;
  }

  if (req.url === "/config") {
    sendJson(res, { iceServers: getIceServers() });
    return;
  }

  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^[/\\]+/, "");
  const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: randomUUID(),
    socket,
    roomId: null,
    name: null,
    buffer: Buffer.alloc(0)
  };

  clients.set(client.id, client);
  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => leaveRoom(client));
  socket.on("error", () => leaveRoom(client));
});

function sendJson(res, value) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function getIceServers() {
  if (!process.env.ICE_SERVERS_JSON) {
    return DEFAULT_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { users: new Map(), note: "" });
  }
  return rooms.get(roomId);
}

function publicUsers(room) {
  return [...room.users.values()].map(({ id, name }) => ({ id, name }));
}

function send(client, event, data = {}) {
  if (!client.socket.writable) return;
  const payload = Buffer.from(JSON.stringify({ event, data }), "utf8");
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 65535) {
    header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  client.socket.write(Buffer.concat([header, payload]));
}

function broadcast(roomId, event, data, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const user of room.users.values()) {
    if (user.id !== exceptId) {
      const client = clients.get(user.id);
      if (client) send(client, event, data);
    }
  }
}

function handleSocketData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const secondByte = client.buffer[1];
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const bigLength = client.buffer.readBigUInt64BE(2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        closeClient(client);
        return;
      }
      length = Number(bigLength);
      offset = 10;
    }

    const masked = Boolean(secondByte & 0x80);
    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + maskLength + length;
    if (client.buffer.length < frameEnd) return;

    const opcode = client.buffer[0] & 0x0f;
    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = client.buffer.subarray(offset, frameEnd);
    client.buffer = client.buffer.subarray(frameEnd);

    if (opcode === 0x8) {
      closeClient(client);
      return;
    }

    if (opcode !== 0x1) continue;

    const decoded = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      decoded[i] = mask ? payload[i] ^ mask[i % 4] : payload[i];
    }

    try {
      const message = JSON.parse(decoded.toString("utf8"));
      routeEvent(client, message.event, message.data || {});
    } catch {
      send(client, "error", { error: "Invalid message" });
    }
  }
}

function routeEvent(client, event, data) {
  if (event === "join") {
    joinRoom(client, data);
    return;
  }

  if (!client.roomId) return;

  if (event === "message") {
    const message = {
      id: String(data.id || randomUUID()),
      text: String(data.text || "").slice(0, 2000),
      selfDestruct: Number(data.selfDestruct || 0),
      senderId: client.id,
      senderName: client.name,
      sentAt: Date.now()
    };
    broadcast(client.roomId, "message", message, client.id);
    send(client, "delivered", { id: message.id, at: Date.now() });
  }

  if (event === "read" && Array.isArray(data.ids)) {
    broadcast(client.roomId, "read", { ids: data.ids, readerId: client.id, at: Date.now() }, client.id);
  }

  if (event === "typing") {
    broadcast(client.roomId, "typing", {
      userId: client.id,
      name: client.name,
      isTyping: Boolean(data.isTyping)
    }, client.id);
  }

  if (event === "note:update") {
    const room = getRoom(client.roomId);
    room.note = String(data.note || "").slice(0, 1000);
    broadcast(client.roomId, "note:update", { note: room.note }, client.id);
  }

  if (event === "call:signal" && data.targetId && data.signal) {
    const target = clients.get(data.targetId);
    if (target) {
      send(target, "call:signal", {
        fromId: client.id,
        fromName: client.name,
        signal: data.signal
      });
    }
  }

  if (event === "call:ring") {
    broadcast(client.roomId, "call:ring", {
      fromId: client.id,
      fromName: client.name,
      mode: data.mode
    }, client.id);
  }

  if (event === "call:end") {
    broadcast(client.roomId, "call:end", {}, client.id);
  }
}

function joinRoom(client, data) {
  const roomId = String(data.roomId || "love-room").trim().slice(0, 48);
  const name = String(data.name || "Love").trim().slice(0, 24);

  if (data.password !== SECRET_PASSWORD) {
    send(client, "join:result", { ok: false, error: "Access denied" });
    return;
  }

  const room = getRoom(roomId);
  if (room.users.size >= MAX_USERS_PER_ROOM) {
    send(client, "join:result", { ok: false, error: "Room is full" });
    return;
  }

  client.roomId = roomId;
  client.name = name;
  room.users.set(client.id, { id: client.id, name });

  send(client, "join:result", {
    ok: true,
    id: client.id,
    users: publicUsers(room),
    note: room.note
  });

  broadcast(roomId, "presence", {
    users: publicUsers(room),
    joined: { id: client.id, name }
  }, client.id);
}

function leaveRoom(client) {
  clients.delete(client.id);
  if (!client.roomId) return;

  const room = rooms.get(client.roomId);
  if (!room) return;

  room.users.delete(client.id);
  broadcast(client.roomId, "presence", {
    users: publicUsers(room),
    left: client.id
  }, client.id);

  if (room.users.size === 0) {
    rooms.delete(client.roomId);
  }
}

function closeClient(client) {
  leaveRoom(client);
  client.socket.end();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Private Couple Chat running on http://localhost:${PORT}`);
});
