/**
 * MCP Zing MP3 Server cho Xiaozhi AI ESP32
 * Chuẩn kết nối WebSocket Client tới Xiaozhi Cloud
 * Hỗ trợ bộ giải mã Esp32Music trực tiếp trên ESP32
 */

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const zing = require("./zingmp3");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5005;
const DEVICES_FILE = path.join(__dirname, "devices.json");
const connectedDevices = new Map();

// ─── Quản lý lưu trữ thiết bị (devices.json) ──────────────────────────────
function loadSavedDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = fs.readFileSync(DEVICES_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error(`[storage] ❌ Lỗi đọc devices.json: ${e.message}`);
  }
  return [];
}

function saveDevicesToFile(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), "utf-8");
  } catch (e) {
    console.error(`[storage] ❌ Lỗi ghi devices.json: ${e.message}`);
  }
}

function addSavedDevice(deviceName, wssUrl) {
  const devices = loadSavedDevices();
  const idx = devices.findIndex((d) => d.deviceName === deviceName);
  const entry = {
    deviceName,
    wssUrl,
    savedAt: new Date().toISOString(),
    autoConnect: true,
  };
  if (idx >= 0) {
    devices[idx] = { ...devices[idx], ...entry };
  } else {
    devices.push(entry);
  }
  saveDevicesToFile(devices);
}

function removeSavedDevice(deviceName) {
  const devices = loadSavedDevices();
  const filtered = devices.filter((d) => d.deviceName !== deviceName);
  saveDevicesToFile(filtered);
  return filtered.length < devices.length;
}

function updateAutoConnect(deviceName, autoConnect) {
  const devices = loadSavedDevices();
  const dev = devices.find((d) => d.deviceName === deviceName);
  if (dev) {
    dev.autoConnect = autoConnect;
    saveDevicesToFile(devices);
    return true;
  }
  return false;
}

// ─── Định nghĩa MCP Tools chuẩn có đầy đủ inputSchema ─────────────────────
const MCP_TOOLS = [
  {
    name: "search_music",
    description: "Tìm kiếm bài hát, ca sĩ trên Zing MP3 Việt Nam để tra cứu thông tin. LƯU Ý QUAN TRỌNG: Để phát nhạc trực tiếp ra loa của thiết bị, bạn KHÔNG gọi công cụ này mà BẮT BUỘC phải gọi công cụ phần cứng thiết bị 'self.music.play_song'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Tên bài hát hoặc ca sĩ cần tìm (ví dụ: 'sơn tùng', 'lạc trôi')",
        },
        limit: {
          type: "number",
          description: "Số lượng bài cần tìm (mặc định 5)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_song_info",
    description: "Lấy thông tin chi tiết bài hát: tên, ca sĩ, album, thể loại, thời lượng.",
    inputSchema: {
      type: "object",
      properties: {
        encodeId: {
          type: "string",
          description: "Mã bài hát encodeId",
        },
      },
      required: ["encodeId"],
    },
  },
  {
    name: "get_lyrics",
    description: "Lấy lời bài hát (lời đồng bộ thời gian và lời văn bản).",
    inputSchema: {
      type: "object",
      properties: {
        encodeId: {
          type: "string",
          description: "Mã bài hát encodeId",
        },
      },
      required: ["encodeId"],
    },
  },
  {
    name: "get_top_charts",
    description: "Lấy danh sách các bài hát đang thịnh hành (Top Charts) trên Zing MP3.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Số lượng bài hát (mặc định 10)",
          default: 10,
        },
      },
    },
  },
];

// ─── Xử lý các lệnh gọi MCP Tool ─────────────────────────────────────────
async function handleToolCall(name, args = {}) {
  console.log(`[tool_call] 🛠️ Thực thi: ${name} với args:`, JSON.stringify(args));

  if (name === "search_music") {
    const q = args.query || args.q || args.song || "";
    const limit = args.limit || 5;
    const songs = await zing.searchSongs(q, limit);
    return {
      message: songs.length ? `Tìm thấy ${songs.length} bài hát cho "${q}"` : `Không tìm thấy bài hát cho "${q}"`,
      songs,
    };
  }

  if (name === "play_music") {
    const song = args.song || args.query || args.name || "bài hát";
    return {
      message: `Để phát bài hát ra loa thiết bị, bạn hãy gọi công cụ phần cứng 'self.music.play_song' với tham số song_name='${song}'.`,
    };
  }

  if (name === "get_stream_url") {
    const streamUrl = await zing.getStreamUrl(args.encodeId);
    return { encodeId: args.encodeId, streamUrl };
  }

  if (name === "get_song_info") {
    const info = await zing.getSongInfo(args.encodeId);
    return info || { error: "Không tìm thấy bài hát" };
  }

  if (name === "get_lyrics") {
    const lyrics = await zing.getLyrics(args.encodeId);
    return { encodeId: args.encodeId, lyrics };
  }

  if (name === "get_top_charts") {
    const limit = args.limit || 10;
    const charts = await zing.getTopCharts(limit);
    return { charts, message: `🔥 Top ${charts.length} bài hot` };
  }

  throw new Error(`Tool không hỗ trợ: ${name}`);
}

// ─── WebSocket Client tới Xiaozhi Cloud ──────────────────────────────────
function handleXiaozhiMessage(ws, raw, deviceName) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const { id, method, params } = msg;
  if (!method || method.startsWith("notifications/")) return;

  console.log(`[${deviceName}] ← ${method}`);

  if (method === "initialize") {
    const response = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "xiaozhi-vn-music", version: "1.0.0" },
      },
    };
    ws.send(JSON.stringify(response));
    console.log(`[${deviceName}] → initialize OK`);
    return;
  }

  if (method === "tools/list") {
    const response = {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
    ws.send(JSON.stringify(response));
    console.log(`[${deviceName}] → tools/list OK (${MCP_TOOLS.length} tools)`);
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    handleToolCall(name, args)
      .then((toolResult) => {
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
          },
        };
        ws.send(JSON.stringify(response));
        console.log(`[${deviceName}] → tools/call ${name} OK`);
      })
      .catch((err) => {
        console.error(`[${deviceName}] ❌ Lỗi tools/call ${name}:`, err.message);
        const response = {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err.message },
        };
        ws.send(JSON.stringify(response));
      });
    return;
  }

  if (method === "ping") {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    return;
  }
}

function connectToXiaozhi(deviceName, wssUrl) {
  const device = connectedDevices.get(deviceName);
  if (device?.ws && device.ws.readyState === WebSocket.OPEN) {
    device.ws.close();
  }
  if (device?.reconnectTimer) {
    clearTimeout(device.reconnectTimer);
  }

  console.log(`[WSS] Đang kết nối tới Xiaozhi: ${deviceName}`);

  const ws = new WebSocket(wssUrl, {
    headers: {
      "User-Agent": "Xiaozhi-VN-Music/1.0",
      Accept: "application/json",
    },
  });

  connectedDevices.set(deviceName, {
    ws,
    url: wssUrl,
    connectedAt: null,
    status: "connecting",
    reconnectTimer: null,
  });

  ws.on("open", () => {
    const dev = connectedDevices.get(deviceName);
    if (dev) {
      dev.status = "connected";
      dev.connectedAt = new Date().toISOString();
    }
    console.log(`[WSS] ✅ Đã kết nối: ${deviceName}`);
  });

  ws.on("message", (data) => handleXiaozhiMessage(ws, data, deviceName));

  ws.on("close", (code) => {
    const dev = connectedDevices.get(deviceName);
    if (dev) dev.status = "disconnected";
    console.log(`[WSS] ❌ Ngắt kết nối: ${deviceName} (code ${code})`);

    if (code === 4004) {
      console.error(`[WSS] ⛔ Token hết hạn hoặc không hợp lệ: ${deviceName}`);
      return;
    }

    const timer = setTimeout(() => {
      if (connectedDevices.has(deviceName)) {
        console.log(`[WSS] 🔄 Reconnecting: ${deviceName}`);
        connectToXiaozhi(deviceName, wssUrl);
      }
    }, 10000);

    if (connectedDevices.has(deviceName)) {
      connectedDevices.get(deviceName).reconnectTimer = timer;
    }
  });

  ws.on("error", (err) => {
    console.error(`[WSS] ⚠️ Lỗi socket ${deviceName}: ${err.message}`);
  });
}

// ─── Debug API ───────────────────────────────────────────────────────────
app.get("/debug_stream", async (req, res) => {
  const id = req.query.id || "qYD31k5TVTCQ";
  try {
    const info = await zing.getSongInfo(id);
    const stream = await zing.getStreamUrl(id);
    res.json({ id, info, stream });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── API cho Firmware ESP32 (Esp32Music) ───────────────────────────────────
app.get("/stream_pcm", async (req, res) => {
  const song = req.query.song || "";
  const artist = req.query.artist || "";
  const searchQuery = `${song} ${artist}`.trim();

  console.log(`[ESP32] 📻 Yêu cầu bài hát: "${searchQuery}"`);
  if (!searchQuery) {
    return res.status(400).json({ error: "Missing song parameter" });
  }

  try {
    const results = await zing.searchSongs(searchQuery, 1);
    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }

    const firstSong = results[0];
    const responsePayload = {
      title: firstSong.title,
      artist: firstSong.artist,
      audio_url: `/proxy_audio?id=${firstSong.encodeId}`,
      lyric_url: `/proxy_lyric?id=${firstSong.encodeId}`,
      language: "vietnamese",
    };

    console.log(`[ESP32] ✅ Trả về cho thiết bị:`, responsePayload);
    res.json(responsePayload);
  } catch (err) {
    console.error(`[ESP32] ❌ Lỗi stream_pcm:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/proxy_audio", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id");

  try {
    const streamUrl = await zing.getStreamUrl(id);
    if (!streamUrl) {
      return res.status(404).send("Stream URL not found");
    }

    console.log(`[proxy_audio] 📡 Stream MP3 id=${id}`);
    const audioRes = await fetch(streamUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Range: req.headers.range || "bytes=0-",
      },
    });

    res.set({
      "Content-Type": audioRes.headers.get("content-type") || "audio/mpeg",
      "Content-Length": audioRes.headers.get("content-length") || "",
      "Accept-Ranges": "bytes",
    });

    audioRes.body.pipe(res);
  } catch (err) {
    console.error(`[proxy_audio] ❌ Lỗi:`, err.message);
    res.status(500).send(err.message);
  }
});

app.get("/proxy_lyric", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id");

  try {
    const lyrics = await zing.getLyrics(id);
    res.type("text/plain").send(lyrics || "");
  } catch (err) {
    console.error(`[proxy_lyric] ❌ Lỗi:`, err.message);
    res.status(500).send(err.message);
  }
});

// ─── API cho Giao diện Quản lý Web Portal ──────────────────────────────────
app.get("/api/devices", (req, res) => {
  const saved = loadSavedDevices();
  const connected = [];

  for (const [name, dev] of connectedDevices.entries()) {
    connected.push({
      deviceName: name,
      wssUrl: dev.url,
      status: dev.status,
      connectedAt: dev.connectedAt,
    });
  }

  res.json({ connected, saved });
});

app.post("/api/connect", (req, res) => {
  const { deviceName, wssUrl } = req.body;
  if (!deviceName || !wssUrl) {
    return res.status(400).json({ error: "Thiếu deviceName hoặc wssUrl" });
  }

  addSavedDevice(deviceName, wssUrl);
  connectToXiaozhi(deviceName, wssUrl);
  res.json({ success: true, message: `Đang kết nối tới ${deviceName}` });
});

app.post("/api/disconnect", (req, res) => {
  const { deviceName } = req.body;
  const dev = connectedDevices.get(deviceName);
  if (dev) {
    if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
    if (dev.ws) dev.ws.close();
    connectedDevices.delete(deviceName);
    res.json({ success: true, message: `Đã ngắt kết nối ${deviceName}` });
  } else {
    res.status(404).json({ error: "Không tìm thấy thiết bị" });
  }
});

app.delete("/api/devices/:name", (req, res) => {
  const deviceName = req.params.name;
  const dev = connectedDevices.get(deviceName);
  if (dev) {
    if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
    if (dev.ws) dev.ws.close();
    connectedDevices.delete(deviceName);
  }
  removeSavedDevice(deviceName);
  res.json({ success: true });
});

app.patch("/api/devices/:name/auto-connect", (req, res) => {
  const { autoConnect } = req.body;
  updateAutoConnect(req.params.name, autoConnect);
  res.json({ success: true });
});

// ─── Khởi động Server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🎵 Xiaozhi Zing MP3 MCP Server đang chạy tại port ${PORT}`);
  console.log(`🌐 Web UI: http://localhost:${PORT}`);
  console.log(`===============================================`);

  // Tự động kết nối lại các thiết bị đã lưu
  const saved = loadSavedDevices();
  console.log(`[storage] 🔄 Tự động kết nối ${saved.length} thiết bị...`);
  for (const dev of saved) {
    if (dev.autoConnect !== false && dev.wssUrl) {
      connectToXiaozhi(dev.deviceName, dev.wssUrl);
    }
  }
});
