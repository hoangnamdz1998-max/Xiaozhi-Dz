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
const { MongoClient } = require("mongodb");
const zing = require("./zingmp3");
const extraTools = require("./tools");
const youtube = require("./youtube");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Tự động phát hiện vị trí từ IP Client (GeoIP) ───────────────────────
const ipCache = new Map(); // Cache IP đã nhận diện để không spam request

async function detectCityFromIp(ip) {
  if (!ip) return;
  if (ip.includes("127.0.0.1") || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.")) return;

  const now = Date.now();
  const cachedTime = ipCache.get(ip);
  // Nếu IP này đã được nhận diện trong 24h qua, bỏ qua không gọi lại
  if (cachedTime && (now - cachedTime < 86400000)) return;

  ipCache.set(ip, now);

  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city`, {
      timeout: 5000,
    });
    const data = await res.json();
    if (data && data.status === "success" && data.city) {
      // Chỉ nhận diện các IP thuộc lãnh thổ Việt Nam để tránh bot nước ngoài ghi đè vị trí của loa
      const isVietnam = data.countryCode === "VN" || data.country === "Vietnam" || (data.country && data.country.toLowerCase().includes("vietnam"));
      if (isVietnam) {
        extraTools.setAutoDetectedLocation(data.city);
        console.log(`[GeoIP] 📍 Đã nhận diện vị trí từ IP ${ip}: ${data.city}, ${data.regionName || ""}, ${data.country || ""}`);
      } else {
        console.log(`[GeoIP] 🛡️ Bỏ qua IP ngoài lãnh thổ Việt Nam (${data.country || ""}, ${data.city || ""}) để tránh làm sai lệch vị trí loa`);
      }
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

// ─── Quản lý lưu trữ thiết bị (Hỗ trợ MongoDB Atlas & Fallback devices.json) ───
let cachedDevices = null;
let mongoDbCollection = null;

function loadDevicesFromFile() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = fs.readFileSync(DEVICES_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((d) => ({
          ...d,
          isPro: d.isPro !== undefined ? d.isPro : (d.deviceName === "NAM01"),
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

function loadSavedDevices() {
  if (cachedDevices && Array.isArray(cachedDevices)) {
    return cachedDevices;
  }
  cachedDevices = loadDevicesFromFile();
  return cachedDevices;
}

function saveDevicesToFile(devices) {
  cachedDevices = devices;
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), "utf-8");
  } catch (e) {
    console.error(`[storage] ❌ Lỗi ghi devices.json: ${e.message}`);
  }
}

async function syncDeviceToMongo(dev) {
  if (!mongoDbCollection || !dev || !dev.deviceName) return;
  try {
    await mongoDbCollection.updateOne(
      { deviceName: dev.deviceName },
      { $set: dev },
      { upsert: true }
    );
  } catch (e) {
    console.warn(`[DB] Lỗi đồng bộ thiết bị ${dev.deviceName} lên MongoDB:`, e.message);
  }
}

async function deleteDeviceFromMongo(deviceName) {
  if (!mongoDbCollection || !deviceName) return;
  try {
    await mongoDbCollection.deleteOne({ deviceName });
  } catch (e) {
    console.warn(`[DB] Lỗi xóa thiết bị ${deviceName} trên MongoDB:`, e.message);
  }
}

async function initMongoDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("[DB] ℹ️ Đang chạy chế độ lưu trữ file cục bộ (devices.json).");
    console.log("[DB] 💡 Mẹo: Thiết lập biến MONGODB_URI trên Render để lưu trữ đám mây vĩnh viễn!");
    cachedDevices = loadDevicesFromFile();
    return;
  }

  try {
    console.log("[DB] ⏳ Đang kết nối tới Cloud Database (MongoDB Atlas)...");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 6000 });
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "xiaozhi");
    mongoDbCollection = db.collection("devices");
    console.log("[DB] ✅ Kết nối MongoDB Atlas thành công!");

    const docs = await mongoDbCollection.find({}).toArray();
    if (docs && docs.length > 0) {
      cachedDevices = docs.map((d) => ({
        deviceName: d.deviceName,
        wssUrl: d.wssUrl,
        deviceSecret: d.deviceSecret || "",
        savedAt: d.savedAt || new Date().toISOString(),
        autoConnect: d.autoConnect !== false,
        isPro: !!d.isPro,
        isApproved: d.isApproved !== undefined ? d.isApproved : true,
        requestedPro: !!d.requestedPro,
        location: d.location || "",
      }));
      console.log(`[DB] 📦 Đã nạp ${cachedDevices.length} thiết bị từ Cloud MongoDB!`);
      saveDevicesToFile(cachedDevices);
    } else {
      cachedDevices = loadDevicesFromFile();
      for (const d of cachedDevices) {
        await syncDeviceToMongo(d);
      }
      console.log(`[DB] 🚀 Đã đồng bộ ${cachedDevices.length} thiết bị ban đầu lên MongoDB!`);
    }
  } catch (err) {
    console.error(`[DB] ❌ Lỗi kết nối MongoDB (${err.message}). Tự động fallback sang devices.json`);
    cachedDevices = loadDevicesFromFile();
  }
}

function addSavedDevice(deviceName, wssUrl, requestedPro = false, deviceSecret = "", location = "") {
  const devices = loadSavedDevices();
  const idx = devices.findIndex((d) => d.deviceName === deviceName);
  
  const generatedSecret = deviceSecret || (idx >= 0 && devices[idx].deviceSecret ? devices[idx].deviceSecret : Math.random().toString(36).substring(2, 12));
  const finalWssUrl = (wssUrl && wssUrl !== "reconnect") ? wssUrl : (idx >= 0 ? devices[idx].wssUrl : "");
  const existingLoc = idx >= 0 ? devices[idx].location : "";
  const finalLoc = location || existingLoc || "";

  const entry = {
    deviceName,
    wssUrl: finalWssUrl,
    deviceSecret: generatedSecret,
    savedAt: new Date().toISOString(),
    autoConnect: true,
    isPro: requestedPro ? false : (idx >= 0 ? devices[idx].isPro : false),
    requestedPro: requestedPro,
    isApproved: !requestedPro,
    location: finalLoc,
  };

  if (idx >= 0) {
    devices[idx] = { ...devices[idx], ...entry, isPro: devices[idx].isPro };
  } else {
    devices.push(entry);
  }
  saveDevicesToFile(devices);
  const updatedDev = idx >= 0 ? devices[idx] : devices[devices.length - 1];
  syncDeviceToMongo(updatedDev).catch(() => {});
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
    syncDeviceToMongo(dev).catch(() => {});
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

  if (isAdmin || (secret && target.deviceSecret === secret) || !target.deviceSecret) {
    const filtered = devices.filter((d) => d.deviceName !== deviceName);
    saveDevicesToFile(filtered);
    deleteDeviceFromMongo(deviceName).catch(() => {});
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
    syncDeviceToMongo(dev).catch(() => {});
    return true;
  }
  return false;
}

// ─── Quản lý & Tự động ghi nhớ vị trí riêng của từng thiết bị Loa ────────
function getDeviceLocation(deviceName) {
  if (!deviceName) return extraTools.getAutoDetectedLocation() || "Hà Nội";
  const devices = loadSavedDevices();
  const dev = devices.find((d) => d.deviceName === deviceName);
  if (dev && dev.location && dev.location.trim()) {
    return dev.location.trim();
  }

  // Tự động nhận diện nếu tên thiết bị có chứa tên tỉnh/thành
  const nameLower = (deviceName || "").toLowerCase();
  const provinceAliases = {
    "hanoi": "Hà Nội", "ha noi": "Hà Nội", "hn": "Hà Nội",
    "saigon": "Hồ Chí Minh", "sai gon": "Hồ Chí Minh", "hcm": "Hồ Chí Minh", "hcmc": "Hồ Chí Minh", "tphcm": "Hồ Chí Minh",
    "danang": "Đà Nẵng", "da nang": "Đà Nẵng", "dng": "Đà Nẵng",
    "haiphong": "Hải Phòng", "hai phong": "Hải Phòng", "hp": "Hải Phòng",
    "cantho": "Cần Thơ", "can tho": "Cần Thơ",
    "nhatrang": "Nha Trang", "nha trang": "Nha Trang",
    "dalat": "Đà Lạt", "da lat": "Đà Lạt",
    "vungtau": "Vũng Tàu", "vung tau": "Vũng Tàu",
    "hue": "Huế",
    "quangninh": "Quảng Ninh", "quang ninh": "Quảng Ninh", "halong": "Hạ Long",
    "bacninh": "Bắc Ninh", "bac ninh": "Bắc Ninh",
    "binhduong": "Bình Dương", "binh duong": "Bình Dương",
    "dongnai": "Đồng Nai", "dong nai": "Đồng Nai",
    "nghean": "Nghệ An", "nghe an": "Nghệ An", "vinh": "Vinh",
    "thanhhoa": "Thanh Hóa", "thanh hoa": "Thanh Hóa"
  };

  for (const [k, v] of Object.entries(provinceAliases)) {
    const regex = new RegExp(`(^|[_\\-\\s])${k}([_\\-\\s]|$)`, "i");
    if (regex.test(nameLower) || nameLower.includes(k)) {
      return v;
    }
  }

  return extraTools.getAutoDetectedLocation() || "Hà Nội";
}

function setDeviceLocation(deviceName, location) {
  if (!deviceName || !location) return false;
  const cleanLoc = location.trim();
  if (!cleanLoc) return false;
  const devices = loadSavedDevices();
  const dev = devices.find((d) => d.deviceName === deviceName);
  if (dev) {
    if (dev.location !== cleanLoc) {
      dev.location = cleanLoc;
      saveDevicesToFile(devices);
      syncDeviceToMongo(dev).catch(() => {});
      console.log(`[${deviceName}] 📍 Đã tự động cập nhật & ghi nhớ vị trí riêng của loa: "${cleanLoc}"`);
    }
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
  // ─── 10 Gia sư ngoại ngữ ────────────────────────────────────────────────
  {
    name: "tutor_english",
    description: "Gia sư Tiếng Anh bản xứ: Luyện phát âm, học từ vựng, giao tiếp đàm thoại tiếng Anh thường ngày hoặc phỏng vấn.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề muốn học hoặc câu tiếng Anh cần kiểm tra", default: "giao tiếp cơ bản" } } }
  },
  {
    name: "tutor_chinese",
    description: "Gia sư Tiếng Trung (Mandarin): Học phiên âm Pinyin, chữ Hán, khẩu ngữ giao tiếp, văn hóa Trung Hoa.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề tiếng Trung muốn luyện tập", default: "chào hỏi và mua sắm" } } }
  },
  {
    name: "tutor_japanese",
    description: "Gia sư Tiếng Nhật: Luyện nghe nói tiếng Nhật (Romaji, Hiragana, Kanji), đàm thoại anime, đời sống Nhật Bản.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề tiếng Nhật muốn học", default: "giao tiếp hàng ngày" } } }
  },
  {
    name: "tutor_korean",
    description: "Gia sư Tiếng Hàn: Luyện phát âm Hangul, giao tiếp phim ảnh K-Drama, K-Pop, đàm thoại tiếng Hàn chuẩn Seoul.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề tiếng Hàn cần luyện tập", default: "chào hỏi và sở thích" } } }
  },
  {
    name: "tutor_french",
    description: "Gia sư Tiếng Pháp: Phát âm giọng chuẩn Paris, từ vựng du lịch Pháp, văn phong lãng mạn thanh lịch.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề học tiếng Pháp", default: "giao tiếp du lịch" } } }
  },
  {
    name: "tutor_german",
    description: "Gia sư Tiếng Đức: Học ngữ pháp, từ vựng du học Đức, giao tiếp công việc và đời sống tại Đức.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề học tiếng Đức", default: "giao tiếp cơ bản" } } }
  },
  {
    name: "tutor_russian",
    description: "Gia sư Tiếng Nga: Luyện đọc bảng chữ cái Kirin, đàm thoại tiếng Nga giao tiếp và văn hóa Nga.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề học tiếng Nga", default: "chào hỏi và làm quen" } } }
  },
  {
    name: "tutor_spanish",
    description: "Gia sư Tiếng Tây Ban Nha: Học ngôn ngữ sôi động phổ biến toàn cầu, giao tiếp du lịch Mỹ Latinh và Tây Ban Nha.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề học tiếng Tây Ban Nha", default: "giao tiếp tự nhiên" } } }
  },
  {
    name: "tutor_thai",
    description: "Gia sư Tiếng Thái: Học câu giao tiếp du lịch Thái Lan, mua sắm ở Bangkok, phát âm chuẩn ngữ điệu.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề học tiếng Thái", default: "du lịch và ẩm thực" } } }
  },
  {
    name: "tutor_italian",
    description: "Gia sư Tiếng Ý: Học tiếng Ý chuẩn phong cách ẩm thực, nghệ thuật, du lịch Rome, Florence.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề học tiếng Ý", default: "giao tiếp ẩm thực và du lịch" } } }
  },
  // ─── Bói toán, Thần số học & Tâm linh vui ─────────────────────────────
  {
    name: "numerology_reading",
    description: "Tra cứu Thần Số Học Pitago: Tính con số chủ đạo (Life Path), phân tích tính cách, điểm mạnh, vận mệnh theo họ tên và ngày sinh.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Họ và tên người cần tra" },
        birthDate: { type: "string", description: "Ngày tháng năm sinh (ví dụ: '15/11/1998')" }
      }
    }
  },
  {
    name: "tarot_divination",
    description: "Rút bài Tarot giải mã thông điệp vũ trụ hôm nay: Xem tình duyên, sự nghiệp, tài chính hoặc một câu hỏi băn khoăn.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Câu hỏi hoặc khía cạnh muốn xin thông điệp bài Tarot" }
      }
    }
  },
  {
    name: "horoscope_zodiac",
    description: "Xem bói Tử vi 12 Cung Hoàng Đạo (Horoscope): Xem vận may hôm nay, tình cảm, công việc, con số may mắn của 12 chòm sao.",
    inputSchema: {
      type: "object",
      properties: {
        sign: { type: "string", description: "Tên cung hoàng đạo (ví dụ: 'Bạch Dương', 'Bọ Cạp', 'Kim Ngưu'...)" },
        date: { type: "string", description: "Thời gian xem (hôm nay, ngày mai, tuần này)", default: "hôm nay" }
      },
      required: ["sign"]
    }
  },
  {
    name: "iching_hexagram",
    description: "Gieo quẻ Kinh Dịch cổ truyền: Xin một quẻ dịch giải đoán việc làm ăn, thi cử, xuất hành, lời khuyên theo đạo lý Kinh Dịch.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Sự vụ cần xin quẻ Kinh Dịch chỉ dẫn" }
      }
    }
  },
  // ─── 8 Tiện ích Đời sống, Giải trí & Trí tuệ mới ────────────────────────
  {
    name: "bedtime_storyteller",
    description: "Kể chuyện đêm muộn hoặc truyện cổ tích ru bé ngủ với giọng điệu truyền cảm, ấm áp.",
    inputSchema: { type: "object", properties: { genre: { type: "string", description: "Thể loại (cổ tích, ngụ ngôn, phiêu lưu)", default: "cổ tích" } } }
  },
  {
    name: "tell_joke",
    description: "Kể chuyện cười thư giãn, pha trò hài hước, mang lại tiếng cười sảng khoái.",
    inputSchema: { type: "object", properties: { type: { type: "string", description: "Chủ đề tiếu lâm", default: "hài hước" } } }
  },
  {
    name: "brain_riddle",
    description: "Đố vui trí tuệ dân gian & hiện đại: Đưa ra câu đố kích thích tư duy và hướng dẫn đoán đáp án.",
    inputSchema: { type: "object", properties: { level: { type: "string", description: "Độ khó (dễ, vừa, mẹo)", default: "mẹo" } } }
  },
  {
    name: "chef_recipe",
    description: "Vua đầu bếp MasterChef: Gợi ý món ngon mỗi ngày, hướng dẫn cách nấu ăn chi tiết từ nguyên liệu có sẵn.",
    inputSchema: { type: "object", properties: { dish: { type: "string", description: "Tên món ăn hoặc nguyên liệu đang có" } } }
  },
  {
    name: "health_fitness_coach",
    description: "Huấn luyện viên sức khỏe & dinh dưỡng: Lời khuyên tập luyện, chế độ ăn uống khoa học, nhắc nhở giữ gìn sức khỏe.",
    inputSchema: { type: "object", properties: { goal: { type: "string", description: "Mục tiêu (giảm cân, tăng cơ, ngủ ngon, sống khỏe)", default: "sức khỏe" } } }
  },
  {
    name: "daily_motivation",
    description: "Tiếp lửa động lực mỗi ngày: Câu danh ngôn truyền cảm hứng, lời khuyên khởi đầu ngày mới tràn đầy năng lượng tích cực.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ai_debate_partner",
    description: "Đối thủ tranh biện AI sắc sảo: Cùng người dùng tranh luận, phản biện logic đa chiều về các vấn đề xã hội, công nghệ.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "Chủ đề muốn tranh luận" } } }
  },
  {
    name: "finance_calculator",
    description: "Cố vấn tài chính cá nhân & tính lãi kép: Tính tiền lãi gửi tiết kiệm, lãi kép theo số tiền và kỳ hạn năm/tháng.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Số tiền gốc (VNĐ)" },
        rate: { type: "number", description: "Lãi suất %/năm (ví dụ 6)" },
        months: { type: "number", description: "Kỳ hạn gửi (số tháng)" }
      }
    }
  },
  // ─── 7 Tiện ích Đỉnh Cao Mới ──────────────────────────────────────────
  {
    name: "feng_shui_sim",
    description: "Bói Sim phong thủy & 4 số cuối điện thoại: Tra cứu ngũ hành bản mệnh, quẻ cát hung 4 số đuôi sim theo kinh dịch.",
    inputSchema: { type: "object", properties: { sim: { type: "string", description: "Số điện thoại hoặc 4 số đuôi sim" }, year: { type: "string", description: "Năm sinh chủ nhân" } }, required: ["sim"] }
  },
  {
    name: "dream_interpreter",
    description: "Giải mã điềm báo giấc mơ: Phân tích ý nghĩa tâm linh, tâm lý học và con số may mắn tương ứng với giấc mơ.",
    inputSchema: { type: "object", properties: { dream: { type: "string", description: "Nội dung giấc mơ cần giải mã" } }, required: ["dream"] }
  },
  {
    name: "emotional_healing",
    description: "Chuyên gia tâm lý & chữa lành cảm xúc: Lắng nghe, chia sẻ, xoa dịu stress mệt mỏi, hướng dẫn bài tập thở an yên.",
    inputSchema: { type: "object", properties: { feeling: { type: "string", description: "Cảm xúc hoặc tâm sự hiện tại của bạn", default: "căng thẳng" } } }
  },
  {
    name: "coding_assistant",
    description: "Trợ lý lập trình AI đa ngôn ngữ (Python, JS, C++, Arduino ESP32): Giải thích thuật toán, sửa lỗi bug, viết code mẫu chuẩn.",
    inputSchema: { type: "object", properties: { language: { type: "string", description: "Ngôn ngữ lập trình", default: "javascript" }, problem: { type: "string", description: "Bài toán hoặc lỗi code cần giải quyết" } }, required: ["problem"] }
  },
  {
    name: "vietnam_history",
    description: "Bách khoa Lịch sử Việt Nam hào hùng: Tìm hiểu các triều đại, danh tướng, trận đánh lừng lẫy của dân tộc Việt Nam.",
    inputSchema: { type: "object", properties: { period: { type: "string", description: "Thời kỳ lịch sử hoặc nhân vật muốn tìm hiểu", default: "Việt Nam" } } }
  },
  {
    name: "legal_consultant",
    description: "Tư vấn Pháp luật Việt Nam: Tra cứu nhanh các quy định luật Dân sự, Giao thông, Lao động, Đất đai mới nhất.",
    inputSchema: { type: "object", properties: { issue: { type: "string", description: "Vấn đề pháp lý cần tư vấn" } }, required: ["issue"] }
  },
  {
    name: "study_homework_helper",
    description: "Gia sư giải bài tập các môn Toán, Lý, Hóa, Văn, Sử, Địa: Hướng dẫn giải chi tiết từng bước, phương pháp học hiệu quả.",
    inputSchema: { type: "object", properties: { subject: { type: "string", description: "Môn học (Toán, Lý, Hóa...)", default: "Toán" }, question: { type: "string", description: "Đề bài tập cần hướng dẫn giải" } }, required: ["question"] }
  },
  {
    name: "exam_prep_coach",
    description: "Huấn luyện viên luyện thi chứng chỉ quốc tế (IELTS, TOEIC, HSK, JLPT, TOPIK, VSTEP): Đề mẫu sát đề thi thật, hướng dẫn cấu trúc trả lời ăn điểm, gợi ý từ vựng band cao và chấm chữa trực tiếp.",
    inputSchema: {
      type: "object",
      properties: {
        exam: { type: "string", description: "Kỳ thi (IELTS, TOEIC, HSK, JLPT, TOPIK, VSTEP)", default: "IELTS" },
        skill: { type: "string", description: "Kỹ năng (Speaking, Writing, Reading, Listening)", default: "Speaking" },
        targetBand: { type: "string", description: "Mục tiêu điểm (ví dụ: '6.5', '7.5', '800+', 'N2', 'HSK 5')", default: "6.5" }
      }
    }
  },
  {
    name: "grammar_checker_coach",
    description: "Gia sư sửa lỗi ngữ pháp & tối ưu câu văn đa ngôn ngữ (Tiếng Anh, Nhật, Trung, Hàn, Việt...): Phát hiện lỗi ngữ pháp, chia thì, dùng từ sai ngữ cảnh và viết lại câu tự nhiên như người bản xứ.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", description: "Ngôn ngữ cần kiểm tra (tiếng Anh, tiếng Nhật, tiếng Trung...)", default: "english" },
        sentence: { type: "string", description: "Câu văn hoặc đoạn hội thoại cần sửa lỗi" }
      },
      required: ["sentence"]
    }
  },
  {
    name: "vocab_quiz_flashcard",
    description: "Flashcard đố vui từ vựng & phản xạ đàm thoại giọng nói: Cung cấp từ vựng hay kèm phát âm, nghĩa, và đưa ra câu đố phản xạ mini để người học trả lời ngay qua loa.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", description: "Ngôn ngữ học (english, chinese, japanese, korean, french...)", default: "english" },
        topic: { type: "string", description: "Chủ đề từ vựng (giao tiếp, du lịch, công nghệ, ẩm thực, kinh doanh...)", default: "giao tiếp" },
        level: { type: "string", description: "Cấp độ (cơ bản, trung cấp, nâng cao)", default: "trung cấp" }
      }
    }
  },
  {
    name: "traffic_fine_lookup",
    description: "Tra cứu thông tin phạt nguội giao thông và biển số xe ô tô, xe máy toàn quốc: Nhận diện tỉnh thành đăng ký, tra cứu mức phạt theo Nghị định 100/123 và hướng dẫn quy trình kiểm tra phạt nguội chuẩn từ Cục CSGT.",
    inputSchema: {
      type: "object",
      properties: {
        plateNumber: { type: "string", description: "Biển số xe cần tra cứu (ví dụ: '30A-123.45', '51H-99999', '29B-88888')" },
        vehicleType: { type: "string", description: "Loại phương tiện ('oto': ô tô, 'xemay': xe máy, 'xedien': xe điện)", default: "oto" }
      },
      required: ["plateNumber"]
    }
  },
  {
    name: "realtime_translator",
    description: "Thông dịch viên AI Song ngữ Trực tiếp đa ngôn ngữ (Việt, Anh, Trung, Nhật, Hàn, Pháp, Đức, Nga, Thái, Tây Ban Nha...): Dịch câu nói tức thì, kèm phiên âm chuẩn (Pinyin, Romaji, IPA) và hỗ trợ chế độ cabin hai chiều trò chuyện trực tiếp với người nước ngoài.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Câu nói, từ ngữ hoặc đoạn hội thoại cần dịch" },
        targetLang: { type: "string", description: "Ngôn ngữ đích cần dịch sang (ví dụ: 'tiếng Anh', 'tiếng Trung', 'tiếng Nhật', 'tiếng Hàn', 'tiếng Việt')", default: "tiếng Anh" },
        mode: { type: "string", description: "Chế độ dịch ('giao_tiep': đời thường có phiên âm, 'cabin_hai_chieu': thông dịch cabin 2 bên đối thoại, 'trang_trong': thương mại lịch sự)", default: "giao_tiep" }
      },
      required: ["text"]
    }
  },
  {
    name: "expert_search",
    description: "Tìm kiếm chuyên gia & Cố vấn cấp cao đa lĩnh vực (Bác sĩ/Y tế chuyên khoa, Luật sư/Pháp lý, Bất động sản, Tài chính/Đầu tư chứng khoán, Tâm lý học & Trị liệu cảm xúc, Kỹ thuật sửa chữa ô tô/điện gia dụng, Phong thủy nhà ở, Công nghệ IT/AI...). Cung cấp định hướng chuyên môn, tiêu chí chọn chuyên gia uy tín, địa chỉ bệnh viện/văn phòng đầu ngành tại Hà Nội, TP.HCM và phân vai chuyên gia cấp cao giải đáp chuyên sâu.",
    inputSchema: {
      type: "object",
      properties: {
        field: { type: "string", description: "Lĩnh vực, ngành nghề hoặc chuyên khoa cần tìm chuyên gia (ví dụ: 'bác sĩ da liễu', 'bác sĩ cơ xương khớp', 'luật sư thừa kế', 'bất động sản', 'tâm lý hôn nhân', 'sửa ô tô', 'phong thủy', 'tài chính', 'công nghệ IT')" },
        query: { type: "string", description: "Vấn đề hoặc câu hỏi cụ thể người dùng cần chuyên gia tư vấn giải quyết" },
        location: { type: "string", description: "Tỉnh thành hoặc khu vực cần tìm chuyên gia (ví dụ: 'Hà Nội', 'TP.HCM', 'Đà Nẵng'...)" }
      },
      required: ["field"]
    }
  },
];

// ─── Phân chia danh sách Tools: Miễn Phí (Free) & Nâng Cao (Pro) ─────────
// Gói Tiêu Chuẩn (Free): Đúng 10 tính năng gồm 2 tính năng ban đầu (Vàng, Thời tiết) + các tính năng phụ giải trí, bói toán, kể chuyện
const FREE_TOOL_NAMES = [
  "get_gold_price",       // 1. Giá vàng SJC/DOJI (Tính năng ban đầu)
  "get_weather",          // 2. Dự báo thời tiết thông minh (Tính năng ban đầu)
  "tell_joke",            // 3. Kể chuyện cười tiếu lâm
  "brain_riddle",         // 4. Đố vui trí tuệ dân gian
  "bedtime_storyteller",  // 5. Kể chuyện đêm muộn ru ngủ
  "daily_motivation",     // 6. Tiếp lửa động lực mỗi ngày
  "numerology_reading",   // 7. Thần số học Pitago
  "tarot_divination",     // 8. Bói bài Tarot thông điệp
  "horoscope_zodiac",     // 9. Tử vi 12 Cung Hoàng Đạo
  "iching_hexagram",      // 10. Gieo quẻ Kinh Dịch
];

const FREE_MCP_TOOLS = MCP_TOOLS.filter((t) => FREE_TOOL_NAMES.includes(t.name));
// Gói PRO bao gồm TẤT CẢ các tính năng của gói Tiêu Chuẩn + Các tính năng Pro đặc biệt (Giá ngoại tệ, Giá xăng, Xổ số, Tin tức, Zing MP3, YouTube, Đài FM, Crypto, 10 Gia sư, AI Coding, Luật, Bài tập...)
const PRO_MCP_TOOLS = MCP_TOOLS;

// ─── Xử lý các lệnh gọi MCP Tool ─────────────────────────────────────────
async function handleToolCall(name, args = {}, deviceName = "") {
  console.log(`[tool_call] 🛠️ [${deviceName || "General"}] Thực thi: ${name} với args:`, JSON.stringify(args));

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
    const rawLoc = (args.location || args.city || "").trim();
    const genericWords = [
      "",
      "hôm nay",
      "hien tai",
      "hiện tại",
      "o day",
      "ở đây",
      "noi toi o",
      "nơi tôi ở",
      "cho toi",
      "chỗ tôi",
      "today",
      "here",
      "now",
    ];

    let targetLoc = rawLoc;
    const isGeneric = genericWords.includes(rawLoc.toLowerCase());

    if (isGeneric) {
      // Người dùng không nói rõ địa điểm: Lấy vị trí đã ghi nhớ của loa này
      targetLoc = getDeviceLocation(deviceName);
    } else {
      // Người dùng nói rõ địa điểm: Tự động ghi nhớ vị trí này cho riêng chiếc loa này
      setDeviceLocation(deviceName, rawLoc);
    }

    const weatherResult = await extraTools.getWeather(targetLoc);
    if (isGeneric && targetLoc) {
      weatherResult.thietBi = deviceName || "Xiaozhi";
      weatherResult.ghiChu = `Vị trí tự động nhận diện theo thiết bị [${deviceName || "Loa"}]: ${targetLoc}`;
    }
    return weatherResult;
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

  // Xử lý 10 Gia sư ngoại ngữ
  if (name.startsWith("tutor_")) {
    const langCode = name.replace("tutor_", "");
    const mapLang = {
      english: "en", chinese: "zh", japanese: "ja", korean: "ko",
      french: "fr", german: "de", russian: "ru", spanish: "es", thai: "th", italian: "it"
    };
    const code = mapLang[langCode] || "en";
    return extraTools.getLanguageTutor(code, args.topic || "giao tiếp cơ bản");
  }

  // Xử lý Thần số học & Bói toán tâm linh
  if (name === "numerology_reading") {
    return extraTools.getNumerology(args.name, args.birthDate);
  }

  if (name === "tarot_divination") {
    return extraTools.getTarotReading(args.question);
  }

  if (name === "horoscope_zodiac") {
    return extraTools.getHoroscope(args.sign, args.date);
  }

  if (name === "iching_hexagram") {
    return extraTools.getIChingHexagram(args.question);
  }

  // 8 Tiện ích Đời sống & Giải trí mới
  if (name === "bedtime_storyteller") {
    return extraTools.getBedtimeStory(args.genre, args.audience);
  }

  if (name === "tell_joke") {
    return extraTools.getJoke(args.type);
  }

  if (name === "brain_riddle") {
    return extraTools.getRiddle(args.level);
  }

  if (name === "chef_recipe") {
    return extraTools.getCookingRecipe(args.dish, args.ingredients);
  }

  if (name === "health_fitness_coach") {
    return extraTools.getHealthFitnessTip(args.goal);
  }

  if (name === "daily_motivation") {
    return extraTools.getDailyMotivation();
  }

  if (name === "ai_debate_partner") {
    return extraTools.getAiDebatePartner(args.topic);
  }

  if (name === "finance_calculator") {
    return extraTools.getFinancialCalculator(args.amount, args.rate, args.months);
  }

  // 7 Tiện ích Đỉnh Cao Mới
  if (name === "feng_shui_sim") {
    return extraTools.getFengShuiSimPhone(args.sim, args.year);
  }

  if (name === "dream_interpreter") {
    return extraTools.getDreamInterpretation(args.dream);
  }

  if (name === "emotional_healing") {
    return extraTools.getEmotionalHealing(args.feeling);
  }

  if (name === "coding_assistant") {
    return extraTools.getCodingAssistant(args.language, args.problem);
  }

  if (name === "vietnam_history") {
    return extraTools.getVietnamHistoryFact(args.period);
  }

  if (name === "legal_consultant") {
    return extraTools.getLegalConsultant(args.issue);
  }

  if (name === "study_homework_helper") {
    return extraTools.getStudyTutorHomework(args.subject, args.question);
  }

  if (name === "exam_prep_coach") {
    return extraTools.getExamPrepCoach(args.exam, args.skill, args.targetBand);
  }

  if (name === "grammar_checker_coach") {
    return extraTools.getGrammarChecker(args.language, args.sentence || args.text || args.cau);
  }

  if (name === "vocab_quiz_flashcard") {
    return extraTools.getVocabQuizFlashcard(args.language, args.topic, args.level);
  }

  if (name === "traffic_fine_lookup") {
    return extraTools.getTrafficFineLookup(args.plateNumber || args.plate || args.bienSo, args.vehicleType || args.loaiXe);
  }

  if (name === "realtime_translator") {
    return extraTools.getRealtimeTranslator(args.text || args.cau || args.noiDung, args.targetLang || args.to || args.lang, args.mode);
  }

  if (name === "expert_search") {
    const loc = (args.location || args.diaDiem || args.khuVuc || "").trim() || getDeviceLocation(deviceName);
    return extraTools.getExpertSearch(
      args.field || args.linhVuc || args.chuyenNganh || args.category || "",
      args.query || args.cauHoi || args.issue || args.problem || "",
      loc
    );
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
  const existingDev = connectedDevices.get(deviceName);
  if (existingDev) {
    if (existingDev.reconnectTimer) {
      clearTimeout(existingDev.reconnectTimer);
      existingDev.reconnectTimer = null;
    }
    if (existingDev.pingTimer) {
      clearInterval(existingDev.pingTimer);
      existingDev.pingTimer = null;
    }
    if (existingDev.ws) {
      existingDev.ws.removeAllListeners();
      try {
        existingDev.ws.close();
      } catch (e) {}
    }
  }

  console.log(`[WSS] Đang kết nối tới Xiaozhi: ${deviceName}`);

  const ws = new WebSocket(wssUrl, {
    headers: {
      "User-Agent": "Xiaozhi-VN-Music/1.0",
      Accept: "application/json",
    },
  });

  const devEntry = {
    ws,
    url: wssUrl,
    connectedAt: null,
    status: "connecting",
    reconnectTimer: null,
    pingTimer: null,
  };
  connectedDevices.set(deviceName, devEntry);

  ws.on("open", () => {
    const current = connectedDevices.get(deviceName);
    if (current && current.ws === ws) {
      current.status = "connected";
      current.connectedAt = new Date().toISOString();
      console.log(`[WSS] ✅ Đã kết nối: ${deviceName}`);

      // Gửi ping định kỳ 30s để giữ kết nối ổn định với Xiaozhi Cloud
      current.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch (e) {}
        }
      }, 30000);
    }
  });

  ws.on("message", (data) => handleXiaozhiMessage(ws, data, deviceName));

  ws.on("close", (code) => {
    const current = connectedDevices.get(deviceName);
    // Nếu đây không phải là socket hiện tại (đã bị thay thế), bỏ qua
    if (!current || current.ws !== ws) {
      return;
    }

    if (current.pingTimer) {
      clearInterval(current.pingTimer);
      current.pingTimer = null;
    }

    current.status = "disconnected";
    console.log(`[WSS] ❌ Ngắt kết nối: ${deviceName} (code ${code})`);

    if (code === 4004) {
      console.error(`[WSS] ⛔ Token hết hạn hoặc không hợp lệ: ${deviceName}`);
      return;
    }

    // Chỉ tự động reconnect nếu không phải do cố ý ngắt
    if (current.reconnectTimer) {
      clearTimeout(current.reconnectTimer);
    }

    current.reconnectTimer = setTimeout(() => {
      const live = connectedDevices.get(deviceName);
      if (live && live.status === "disconnected") {
        console.log(`[WSS] 🔄 Reconnecting: ${deviceName}`);
        connectToXiaozhi(deviceName, wssUrl);
      }
    }, 10000);
  });

  ws.on("error", (err) => {
    const current = connectedDevices.get(deviceName);
    if (current && current.ws === ws) {
      console.error(`[WSS] ⚠️ Lỗi socket ${deviceName}: ${err.message}`);
    }
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
    location: d.location || "",
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

app.get("/api/tools", (req, res) => {
  res.json({
    total: MCP_TOOLS.length,
    freeCount: FREE_MCP_TOOLS.length,
    proCount: PRO_MCP_TOOLS.length,
    tools: MCP_TOOLS,
    bonion: MCP_TOOLS,
  });
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
  const { deviceName, wssUrl, requestedPro, reconnect, location } = req.body;
  if (!deviceName) {
    return res.status(400).json({ error: "Thiếu tên thiết bị" });
  }

  const devices = loadSavedDevices();
  const existing = devices.find((d) => d.deviceName === deviceName);

  let targetUrl = wssUrl;
  if (reconnect || wssUrl === "reconnect") {
    if (!existing || !existing.wssUrl || existing.wssUrl === "reconnect") {
      return res.status(400).json({ error: `Không tìm thấy URL cấu hình của thiết bị "${deviceName}"` });
    }
    targetUrl = existing.wssUrl;
  } else {
    if (!wssUrl || !wssUrl.startsWith("wss://")) {
      return res.status(400).json({ error: "Link kết nối phải bắt đầu bằng wss://" });
    }
  }

  const isProReq = requestedPro !== undefined ? !!requestedPro : (existing ? !!existing.isPro : false);
  const secret = addSavedDevice(deviceName, targetUrl, isProReq, "", location || "");
  connectToXiaozhi(deviceName, targetUrl);

  const msg = isProReq
    ? `Thiết bị ${deviceName} đã kết nối gói PRO!`
    : `Thiết bị ${deviceName} đã kết nối thành công với gói Miễn Phí!`;

  res.json({ success: true, message: msg, requestedPro: isProReq, deviceSecret: secret });
});

// Cập nhật vị trí thủ công cho thiết bị
app.post("/api/devices/set-location", (req, res) => {
  const { deviceName, location } = req.body;
  if (!deviceName || !location) {
    return res.status(400).json({ error: "Thiếu deviceName hoặc location" });
  }
  const ok = setDeviceLocation(deviceName, location);
  if (ok) {
    res.json({ success: true, message: `Đã lưu vị trí "${location}" cho thiết bị [${deviceName}]` });
  } else {
    res.status(404).json({ error: "Không tìm thấy thiết bị" });
  }
});

// Kết nối lại tất cả thiết bị trong danh sách
app.post("/api/reconnect-all", (req, res) => {
  const devices = loadSavedDevices();
  let count = 0;
  for (const dev of devices) {
    if (dev.wssUrl && dev.wssUrl.startsWith("wss://") && dev.autoConnect !== false) {
      connectToXiaozhi(dev.deviceName, dev.wssUrl);
      count++;
    }
  }
  console.log(`[reconnect-all] ⚡ Đang kết nối lại ${count} thiết bị...`);
  res.json({ success: true, message: `Đang kết nối lại ${count} thiết bị trong danh sách!`, count });
});

// Xuất bản sao lưu danh sách thiết bị (Admin)
app.get("/api/admin/export-devices", (req, res) => {
  const p = req.headers["x-admin-password"] || req.query.password || "";
  const isAdmin = p === ADMIN_PASSWORD || p === "123456";
  if (!isAdmin) {
    return res.status(403).json({ error: "Chỉ Admin mới có quyền tải bản sao lưu! Vui lòng cung cấp mật khẩu (?password=123456)" });
  }
  const devices = loadSavedDevices();
  res.setHeader("Content-Disposition", `attachment; filename=xiaozhi-devices-backup-${Date.now()}.json`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(devices, null, 2));
});

// Nhập khôi phục danh sách thiết bị (Admin)
app.post("/api/admin/import-devices", (req, res) => {
  const p = req.headers["x-admin-password"] || req.body.password || "";
  const isAdmin = p === ADMIN_PASSWORD || p === "123456";
  if (!isAdmin) {
    return res.status(403).json({ error: "Chỉ Admin mới có quyền khôi phục dữ liệu!" });
  }
  const { devices } = req.body;
  if (!Array.isArray(devices) || devices.length === 0) {
    return res.status(400).json({ error: "Dữ liệu thiết bị không hợp lệ!" });
  }

  saveDevicesToFile(devices);
  for (const d of devices) {
    syncDeviceToMongo(d).catch(() => {});
    if (d.autoConnect !== false && d.wssUrl && d.wssUrl.startsWith("wss://")) {
      connectToXiaozhi(d.deviceName, d.wssUrl);
    }
  }
  res.json({ success: true, message: `Đã khôi phục và tự động kết nối ${devices.length} thiết bị thành công!` });
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
app.listen(PORT, async () => {
  console.log(`===============================================`);
  console.log(`🎵 Xiaozhi Zing MP3 MCP Server đang chạy tại port ${PORT}`);
  console.log(`🌐 Web UI: http://localhost:${PORT}`);
  console.log(`===============================================`);

  // 1. Khởi tạo Database đám mây (nếu có MONGODB_URI)
  await initMongoDatabase();

  // 2. Tự động kết nối lại tất cả các thiết bị đã lưu
  const saved = loadSavedDevices();
  console.log(`[storage] 🔄 Tự động kết nối ${saved.length} thiết bị...`);
  for (const dev of saved) {
    if (dev.autoConnect !== false && dev.wssUrl && dev.wssUrl.startsWith("wss://")) {
      connectToXiaozhi(dev.deviceName, dev.wssUrl);
    }
  }
});
