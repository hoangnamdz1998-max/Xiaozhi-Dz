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
const extraTools = require("./tools");
const youtube = require("./youtube");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Tự động phát hiện vị trí từ IP Client (GeoIP) ───────────────────────
let lastResolvedIp = "";
let lastIpCheckTime = 0;

async function detectCityFromIp(ip) {
  if (!ip) return;
  if (ip.includes("127.0.0.1") || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.")) return;
  if (ip === lastResolvedIp && Date.now() - lastIpCheckTime < 3600000) return;

  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`, {
      timeout: 5000,
    });
    const data = await res.json();
    if (data && data.status === "success" && data.city) {
      lastResolvedIp = ip;
      lastIpCheckTime = Date.now();
      extraTools.setAutoDetectedLocation(data.city);
      console.log(`[GeoIP] 📍 Đã nhận diện vị trí từ IP ${ip}: ${data.city}, ${data.regionName || ""}, ${data.country || ""}`);
    }
  } catch (err) {
    // ignore
  }
}

app.use((req, res, next) => {
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp = forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
  if (clientIp) {
    detectCityFromIp(clientIp).catch(() => {});
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5005;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";
const DEVICES_FILE = path.join(__dirname, "devices.json");
const connectedDevices = new Map();

// ─── Quản lý lưu trữ thiết bị (devices.json) ──────────────────────────────
function loadSavedDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = fs.readFileSync(DEVICES_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((d) => ({
          ...d,
          isPro: d.isPro !== undefined ? d.isPro : (d.deviceName === "NAM01"), // NAM01 mặc định là Pro
          isApproved: d.isApproved !== undefined ? d.isApproved : true,
        }));
      }
    }
  } catch (e) {
    console.error(`[storage] ❌ Lỗi đọc devices.json: ${e.message}`);
  }
  return [
    {
      deviceName: "NAM01",
      wssUrl: "wss://api.xiaozhi.me/mcp/?token=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEwMzA0NDIsImFnZW50SWQiOjI1Nzk2OTgsImVuZHBvaW50SWQiOiJhZ2VudF8yNTc5Njk4IiwicHVycG9zZSI6Im1jcC1lbmRwb2ludCIsImlhdCI6MTc5MzU2MzY1NiwiZXhwIjoxODI1MTIxMjU2fQ.WtcTayrm3vvlM0C9KxOc_nU1fgh6tI-1kW7p5wdTEhlcz3X2mtdQ93EE4Flfrss7lJ49lNKUVR7krcPSdWQh1Q",
      savedAt: new Date().toISOString(),
      autoConnect: true,
      isPro: true,
      isApproved: true,
    },
  ];
}

function saveDevicesToFile(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), "utf-8");
  } catch (e) {
    console.error(`[storage] ❌ Lỗi ghi devices.json: ${e.message}`);
  }
}

function addSavedDevice(deviceName, wssUrl, requestedPro = false, deviceSecret = "") {
  const devices = loadSavedDevices();
  const idx = devices.findIndex((d) => d.deviceName === deviceName);
  
  const generatedSecret = deviceSecret || (idx >= 0 && devices[idx].deviceSecret ? devices[idx].deviceSecret : Math.random().toString(36).substring(2, 12));

  // Thiết bị đăng ký Pro sẽ vào hàng chờ (isApproved: false, isPro: false) cho đến khi admin duyệt
  const entry = {
    deviceName,
    wssUrl,
    deviceSecret: generatedSecret,
    savedAt: new Date().toISOString(),
    autoConnect: true,
    isPro: requestedPro ? false : false,
    requestedPro: requestedPro,
    isApproved: !requestedPro, // Nếu là Free thì duyệt luôn, Pro thì chờ duyệt
  };

  if (idx >= 0) {
    devices[idx] = { ...devices[idx], ...entry, isPro: devices[idx].isPro };
  } else {
    devices.push(entry);
  }
  saveDevicesToFile(devices);
  return generatedSecret;
}

function approveProDevice(deviceName, approve = true) {
  const devices = loadSavedDevices();
  const dev = devices.find((d) => d.deviceName === deviceName);
  if (dev) {
    dev.isPro = approve;
    dev.isApproved = true;
    dev.requestedPro = false;
    saveDevicesToFile(devices);
    return true;
  }
  return false;
}

function isDevicePro(deviceName) {
  const devices = loadSavedDevices();
  const dev = devices.find((d) => d.deviceName === deviceName);
  return dev ? !!dev.isPro : false;
}

function removeSavedDevice(deviceName, secret = "", isAdmin = false) {
  const devices = loadSavedDevices();
  const target = devices.find((d) => d.deviceName === deviceName);
  if (!target) return false;

  // Nếu là admin hoặc cung cấp đúng secret của máy mình thì cho phép xóa
  if (isAdmin || (secret && target.deviceSecret === secret) || !target.deviceSecret) {
    const filtered = devices.filter((d) => d.deviceName !== deviceName);
    saveDevicesToFile(filtered);
    return true;
  }
  return false;
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
  {
    name: "get_weather",
    description: "Tra cứu thời tiết (nhiệt độ, mưa/nắng, độ ẩm, gió, UV). Nếu người dùng không nói rõ địa điểm hoặc chỉ hỏi 'hôm nay thế nào', 'thời tiết ở đây', hệ thống sẽ tự động tra cứu theo vị trí hiện tại.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "Tên địa điểm cần xem thời tiết (ví dụ: 'Hà Nội', 'TP.HCM', 'Đà Nẵng'). Có thể bỏ trống nếu hỏi thời tiết tại chỗ.",
        },
      },
    },
  },
  {
    name: "get_lunar_calendar",
    description: "Tra cứu âm lịch hôm nay, can chi ngày/tháng/năm, năm con gì theo lịch vạn niên Việt Nam.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Ngày dương lịch cần tra dạng YYYY-MM-DD (để trống nếu muốn xem ngày hôm nay)",
        },
      },
    },
  },
  {
    name: "get_latest_news",
    description: "Điểm tin tức báo chí mới nhất trong ngày từ VnExpress.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Chuyên mục tin tức: 'tin-moi-nhat', 'thoi-su', 'the-gioi', 'kinh-doanh', 'giai-tri', 'the-thao'",
          default: "tin-moi-nhat",
        },
      },
    },
  },
  {
    name: "web_search",
    description: "Tra cứu thông tin trên Internet, Google, Wikipedia và Bách khoa toàn thư. BẮT BUỘC gọi công cụ này khi người dùng hỏi các câu hỏi kiến thức, hỏi 'ai là', 'ở đâu', 'như thế nào', 'hiện tại', 'chủ tịch nước', 'thời sự', 'nhân vật', 'tin tức'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa hoặc câu hỏi cần tra cứu (ví dụ: 'Chủ tịch nước Việt Nam', 'Sơn Tùng M-TP', 'Thời sự')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_gold_price",
    description: "Tra cứu giá vàng trong nước hôm nay (SJC, DOJI, PNJ, vàng 9999, giá mua và giá bán).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Loại vàng muốn tra (mặc định 'all' để xem tổng hợp SJC, PNJ, DOJI)",
          default: "all",
        },
      },
    },
  },
  {
    name: "get_gasoline_price",
    description: "Tra cứu giá xăng dầu Petrolimex Việt Nam hôm nay (giá xăng RON 95, E5 RON 92, dầu DO).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_exchange_rate",
    description: "Tra cứu tỷ giá ngoại tệ ngân hàng Vietcombank (USD, EUR, JPY, GBP, CNY, SGD...).",
    inputSchema: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          description: "Mã ngoại tệ cần tra, ví dụ: 'USD', 'EUR', 'JPY', 'CNY'",
          default: "USD",
        },
      },
    },
  },
  {
    name: "get_crypto_price",
    description: "Tra cứu giá tiền mã hóa, tiền ảo, Bitcoin, Crypto theo thời gian thực từ sàn Binance.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Ký hiệu đồng tiền ảo, ví dụ: 'BTC', 'ETH', 'SOL', 'BNB', 'DOGE'",
          default: "BTC",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_lottery_result",
    description: "Tra cứu kết quả xổ số kiến thiết 3 miền: Miền Bắc (XSMB), Miền Nam (XSMN, xổ số đài TP.HCM, miền Nam), Miền Trung. BẮT BUỘC gọi công cụ này khi người dùng hỏi kết quả xổ số, số đề, đài miền nam, đài miền bắc.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Vùng miền hoặc đài cần xem: 'mb' (miền Bắc), 'mn' hoặc 'nam' (miền Nam), 'mt' (miền Trung)",
          default: "mb",
        },
      },
    },
  },
  {
    name: "listen_radio",
    description: "Nghe đài phát thanh Radio FM trực tuyến: VOV1 (Thời sự FM 100MHz), VOV3 (Âm nhạc FM 102.7MHz), VOV Giao thông (FM 91MHz), VOH FM 99.9MHz (Đài tiếng nói Nhân dân TP.HCM), VOH FM 95.6MHz. BẮT BUỘC gọi công cụ này khi người dùng bảo 'mở đài FM', 'nghe radio', 'bật VOV', 'nghe đài VOV Giao thông', 'nghe đài 99.9'.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Tên kênh radio hoặc tần số FM: 'vov1', 'vov3', 'vov_gt', 'voh_999' (FM 99.9), 'voh_956' (FM 95.6) hoặc 'fm'",
          default: "vov1",
        },
      },
    },
  },
  {
    name: "play_youtube_music",
    description: "Phát bài hát từ YouTube hoặc tự động tìm kiếm khi Zing MP3 không có hoặc người dùng yêu cầu: 'phát nhạc', 'mở bài hát', 'nghe nhạc youtube'. Công cụ này trích xuất luồng âm thanh trực tiếp từ YouTube để phát ra loa thiết bị.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Tên bài hát, ca sĩ hoặc từ khóa nhạc (ví dụ: 'sơn tùng', 'lạc trôi remix', 'nhạc tiktok')",
        },
      },
      required: ["query"],
    },
  },
];

// ─── Phân chia danh sách Tools: Miễn Phí (Free) & Nâng Cao (Pro) ─────────
const FREE_TOOL_NAMES = ["get_gold_price", "get_weather"];
const FREE_MCP_TOOLS = MCP_TOOLS.filter((t) => FREE_TOOL_NAMES.includes(t.name));
const PRO_MCP_TOOLS = MCP_TOOLS;

// ─── Xử lý các lệnh gọi MCP Tool ─────────────────────────────────────────
async function handleToolCall(name, args = {}) {
  console.log(`[tool_call] 🛠️ Thực thi: ${name} với args:`, JSON.stringify(args));

  if (name === "search_music") {
    const q = args.query || args.q || args.song || "";
    const limit = args.limit || 5;
    const songs = await zing.searchSongs(q, limit);
    if (songs && songs.length > 0) {
      return {
        nguon: "Zing MP3",
        message: `Tìm thấy ${songs.length} bài hát trên Zing MP3 cho "${q}"`,
        songs,
      };
    }
    // Fallback sang YouTube nếu Zing MP3 không thấy
    console.log(`[Music] Zing MP3 không có "${q}", tự động fallback sang YouTube...`);
    const ytSongs = await youtube.searchYouTube(q, limit);
    return {
      nguon: "YouTube",
      message: ytSongs.length
        ? `Zing MP3 không có bài này, đã tìm thấy ${ytSongs.length} kết quả trên YouTube cho "${q}"`
        : `Không tìm thấy bài hát cho "${q}"`,
      songs: ytSongs.map((v) => ({
        encodeId: v.videoId,
        title: v.title,
        artist: v.author,
        duration: v.lengthSeconds,
      })),
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

  if (name === "get_weather") {
    const loc = args.location || args.city || "";
    return await extraTools.getWeather(loc);
  }

  if (name === "get_lunar_calendar") {
    return extraTools.getLunarCalendar(args.date);
  }

  if (name === "get_latest_news") {
    const cat = args.category || "tin-moi-nhat";
    return await extraTools.getLatestNews(cat);
  }

  if (name === "web_search") {
    const q = args.query || args.q || "";
    return await extraTools.searchWeb(q);
  }

  if (name === "get_gold_price") {
    return await extraTools.getGoldPrice(args.type);
  }

  if (name === "get_gasoline_price") {
    return await extraTools.getGasolinePrice();
  }

  if (name === "get_exchange_rate") {
    return await extraTools.getExchangeRate(args.currency);
  }

  if (name === "get_crypto_price") {
    return await extraTools.getCryptoPrice(args.symbol);
  }

  if (name === "get_lottery_result") {
    const region = args.region || args.mien || args.dai || "mb";
    return await extraTools.getLotteryResult(region);
  }

  if (name === "listen_radio") {
    const channel = args.channel || args.kenh || args.radio || "vov1";
    return extraTools.getRadioStations(channel);
  }

  if (name === "play_youtube_music") {
    const q = args.query || args.q || args.song || "";
    console.log(`[Music] 🎵 Đang xử lý phát nhạc: "${q}"`);

    // 1. Nếu không chỉ định từ khóa "youtube", thử tìm Zing MP3 trước
    const qLower = q.toLowerCase();
    const isExplicitYouTube = qLower.includes("youtube") || qLower.includes("remix") || qLower.includes("live") || qLower.includes("cover");

    if (!isExplicitYouTube) {
      try {
        const zingSongs = await zing.searchSongs(q, 1);
        if (zingSongs && zingSongs.length > 0) {
          const streamUrl = await zing.getStreamUrl(zingSongs[0].encodeId);
          if (streamUrl) {
            console.log(`[Music] ✅ Phát từ Zing MP3: "${zingSongs[0].title}"`);
            return {
              nguon: "Zing MP3",
              message: `Đang phát "${zingSongs[0].title}" - ${zingSongs[0].artist} từ Zing MP3 ra loa thiết bị.`,
              title: zingSongs[0].title,
              artist: zingSongs[0].artist,
              streamUrl,
            };
          }
        }
      } catch (zingErr) {
        console.warn("[Music] Zing MP3 fallback sang YouTube:", zingErr.message);
      }
    }

    // 2. Tự động fallback sang YouTube nếu Zing MP3 không có hoặc người dùng yêu cầu YouTube
    console.log(`[YouTube] 🔍 Tìm kiếm và phát từ YouTube: "${q}"`);
    const results = await youtube.searchYouTube(q, 3);
    if (!results || results.length === 0) {
      return { message: `Không tìm thấy bài hát "${q}" trên cả Zing MP3 lẫn YouTube.` };
    }
    const topVideo = results[0];
    const audioData = await youtube.getYouTubeAudioUrl(topVideo.videoId);
    if (audioData && audioData.streamUrl) {
      return {
        nguon: "YouTube",
        message: `Đang phát bài hát "${audioData.title}" của ${audioData.author} từ YouTube ra loa thiết bị.`,
        title: audioData.title,
        author: audioData.author,
        streamUrl: audioData.streamUrl,
      };
    }
    return {
      message: `Tìm thấy bài "${topVideo.title}" trên YouTube nhưng luồng âm thanh đang bận. Bạn vui lòng thử lại sau giây lát.`,
    };
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
    const isPro = isDevicePro(deviceName);
    const availableTools = isPro ? PRO_MCP_TOOLS : FREE_MCP_TOOLS;
    const response = {
      jsonrpc: "2.0",
      id,
      result: { tools: availableTools },
    };
    ws.send(JSON.stringify(response));
    console.log(`[${deviceName}] → tools/list OK (${isPro ? "PRO" : "FREE"}: ${availableTools.length} tools)`);
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const isPro = isDevicePro(deviceName);

    // Kiểm tra quyền gọi tool Pro
    if (!isPro && !FREE_TOOL_NAMES.includes(name)) {
      console.log(`[${deviceName}] ⛔ Từ chối gọi tool Pro "${name}" (Tài khoản Free)`);
      const response = {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "TÍNH NĂNG PRO",
                message: `Tính năng "${name}" là đặc quyền của gói PRO. Tài khoản của bạn hiện là gói Miễn Phí (hỗ trợ Tra cứu giá vàng và Thời tiết). Hãy liên hệ quản trị viên để nâng cấp lên PRO!`,
              }),
            },
          ],
        },
      };
      ws.send(JSON.stringify(response));
      return;
    }

    handleToolCall(name, args, deviceName)
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

// API lấy BXH Zing MP3 thời gian thực cho ESP32
app.get("/api/chart", async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  try {
    const charts = await zing.getTopCharts(limit);
    res.json({ success: true, count: charts.length, songs: charts });
  } catch (err) {
    console.error(`[api/chart] ❌ Lỗi:`, err.message);
    res.status(500).json({ success: false, error: err.message });
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
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, message: "Đăng nhập Admin thành công!" });
  }
  res.status(401).json({ success: false, error: "Sai mật khẩu Admin!" });
});

app.get("/api/devices", (req, res) => {
  const saved = loadSavedDevices();
  const devices = [];

  for (const [name, dev] of connectedDevices.entries()) {
    devices.push({
      name: name,
      deviceName: name,
      url: dev.url,
      wssUrl: dev.url,
      status: dev.status,
      connectedAt: dev.connectedAt,
    });
  }

  res.json({ devices, connected: devices, saved });
});

app.get("/api/saved-devices", (req, res) => {
  const saved = loadSavedDevices();
  const savedDevices = saved.map(d => ({
    deviceName: d.deviceName,
    savedAt: d.savedAt,
    autoConnect: d.autoConnect,
    isPro: d.isPro,
    isApproved: d.isApproved,
    requestedPro: d.requestedPro,
    isConnected: connectedDevices.has(d.deviceName) && connectedDevices.get(d.deviceName).status === "connected",
  }));
  res.json({ savedDevices });
});

app.get("/api/chart", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const charts = await zing.getTopCharts(limit);
    const result = charts.map((item) => ({
      rank: item.rank,
      title: item.title,
      artist: item.artist,
      id: item.encodeId,
      duration: item.duration,
      thumbnail: item.thumbnail,
    }));
    res.json(result);
  } catch (err) {
    console.error("[API] /api/chart error:", err.message);
    res.status(500).json({ error: "Không thể lấy bảng xếp hạng", message: err.message });
  }
});

app.get("/api/location", (req, res) => {
  res.json({ location: extraTools.getAutoDetectedLocation() });
});

app.post("/api/location", (req, res) => {
  const { city } = req.body;
  if (city) {
    extraTools.setAutoDetectedLocation(city);
    return res.json({ success: true, location: city });
  }
  res.status(400).json({ error: "Thiếu tên thành phố" });
});

app.post("/api/connect", (req, res) => {
  const { deviceName, wssUrl, requestedPro } = req.body;
  if (!deviceName || !wssUrl) {
    return res.status(400).json({ error: "Thiếu deviceName hoặc wssUrl" });
  }

  const isProReq = !!requestedPro;
  const secret = addSavedDevice(deviceName, wssUrl, isProReq);
  connectToXiaozhi(deviceName, wssUrl);

  const msg = isProReq
    ? `Thiết bị ${deviceName} đã đăng ký gói PRO (đang vào danh sách chờ admin duyệt, tạm thời dùng các tính năng Free).`
    : `Thiết bị ${deviceName} đã kết nối thành công với gói Miễn Phí!`;

  res.json({ success: true, message: msg, requestedPro: isProReq, deviceSecret: secret });
});

app.post("/api/devices/approve-pro", (req, res) => {
  const { deviceName, approve } = req.body;
  if (!deviceName) {
    return res.status(400).json({ error: "Thiếu deviceName" });
  }
  const ok = approveProDevice(deviceName, approve !== false);
  if (ok) {
    // Nếu thiết bị đang kết nối, gửi lại thông báo tools
    const dev = connectedDevices.get(deviceName);
    if (dev && dev.ws) {
      console.log(`[Admin] 👑 Đã duyệt gói PRO cho ${deviceName}, cập nhật quyền...`);
    }
    return res.json({ success: true, message: `Đã ${approve !== false ? 'DUYỆT gói PRO' : 'HỦY gói PRO'} cho ${deviceName}` });
  }
  res.status(404).json({ error: "Không tìm thấy thiết bị" });
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
  const secret = req.headers["x-device-secret"] || req.query.secret || "";
  const isAdmin = req.headers["x-admin-password"] === ADMIN_PASSWORD;

  const ok = removeSavedDevice(deviceName, secret, isAdmin);
  if (!ok) {
    return res.status(403).json({ success: false, error: "Bạn không có quyền xóa thiết bị của người khác!" });
  }

  const dev = connectedDevices.get(deviceName);
  if (dev) {
    if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
    if (dev.ws) dev.ws.close();
    connectedDevices.delete(deviceName);
  }
  res.json({ success: true, message: `Đã xóa thiết bị ${deviceName}` });
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
