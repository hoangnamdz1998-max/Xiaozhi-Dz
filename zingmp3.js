const crypto = require("crypto");
const fetch = require("node-fetch");

const ZING_URL = "https://zingmp3.vn";
const ZING_VERSION = "1.6.34";
const ZING_SECRET = "2aa2d1c561e809b267f3638c4a307aab";
const ZING_API_KEY = "88265e23d4284f25963e6eedac8fbfa3";

let sessionCookies = "";
let lastCookieTime = 0;

function getHash256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function getHmac512(str, secret) {
  return crypto.createHmac("sha512", secret).update(str, "utf8").digest("hex");
}

async function ensureCookies() {
  const now = Date.now();
  if (sessionCookies && now - lastCookieTime < 3600000) {
    return sessionCookies;
  }
  try {
    const res = await fetch(ZING_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "X-Forwarded-For": "113.161.72.10",
        "X-Real-IP": "113.161.72.10",
      },
    });
    const setCookie = res.headers.raw()["set-cookie"];
    if (setCookie && Array.isArray(setCookie)) {
      sessionCookies = setCookie.map((c) => c.split(";")[0]).join("; ");
      lastCookieTime = now;
    }
  } catch (err) {
    console.error("[ZingMP3] Error obtaining session cookies:", err.message);
  }
  return sessionCookies;
}

async function zingRequest(path, params = {}, hashStr = "") {
  await ensureCookies();
  const ctime = Math.floor(Date.now() / 1000).toString();
  const fullHashStr = hashStr.replace("TIME", ctime);
  const hash256 = getHash256(fullHashStr);
  const sig = getHmac512(path + hash256, ZING_SECRET);

  const queryParams = new URLSearchParams({
    ...params,
    ctime,
    version: ZING_VERSION,
    apiKey: ZING_API_KEY,
    sig,
  });

  const url = `${ZING_URL}${path}?${queryParams.toString()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-Forwarded-For": "113.161.72.10",
      "X-Real-IP": "113.161.72.10",
      Cookie: sessionCookies,
    },
  });
  return await res.json();
}

async function searchSongs(keyword, limit = 5) {
  try {
    const data = await zingRequest(
      "/api/v2/search/multi",
      { q: keyword },
      `ctime=TIMEversion=${ZING_VERSION}`
    );
    if (data.err === 0 && data.data && Array.isArray(data.data.songs)) {
      return data.data.songs.slice(0, limit).map((s) => ({
        encodeId: s.encodeId,
        title: s.title,
        artist: s.artistsNames || "",
        duration: s.duration,
        thumbnail: s.thumbnailM || s.thumbnail || "",
      }));
    }
  } catch (err) {
    console.error("[ZingMP3] Search error:", err.message);
  }
  return [];
}

async function getStreamUrl(encodeId) {
  try {
    const data = await zingRequest(
      "/api/v2/song/get/streaming",
      { id: encodeId },
      `ctime=TIMEid=${encodeId}version=${ZING_VERSION}`
    );
    console.log("[ZingMP3] Stream data:", JSON.stringify(data));
    if (data.err === 0 && data.data) {
      return data.data["128"] || data.data["320"] || "";
    }
  } catch (err) {
    console.error("[ZingMP3] Get stream error:", err.message);
  }
  return "";
}

async function getSongInfo(encodeId) {
  try {
    const data = await zingRequest(
      "/api/v2/song/get/info",
      { id: encodeId },
      `ctime=TIMEid=${encodeId}version=${ZING_VERSION}`
    );
    if (data.err === 0 && data.data) {
      const s = data.data;
      return {
        encodeId: s.encodeId,
        title: s.title,
        artist: s.artistsNames || "",
        album: s.album ? s.album.title : "",
        duration: s.duration,
        thumbnail: s.thumbnailM || s.thumbnail || "",
        genres: (s.genres || []).map((g) => g.name),
        composers: (s.composers || []).map((c) => c.name),
      };
    }
  } catch (err) {
    console.error("[ZingMP3] Get song info error:", err.message);
  }
  return null;
}

async function getLyrics(encodeId) {
  try {
    const data = await zingRequest(
      "/api/v2/lyric/get/lyric",
      { id: encodeId },
      `ctime=TIMEid=${encodeId}version=${ZING_VERSION}`
    );
    if (data.err === 0 && data.data) {
      if (data.data.file) {
        const fileRes = await fetch(data.data.file);
        return await fileRes.text();
      }
      if (Array.isArray(data.data.sentences)) {
        return data.data.sentences
          .map((item) => {
            const text = (item.words || []).map((w) => w.data).join(" ");
            const min = Math.floor(item.startTime / 60000);
            const sec = ((item.startTime % 60000) / 1000).toFixed(2);
            return `[${String(min).padStart(2, "0")}:${String(sec).padStart(5, "0")}]${text}`;
          })
          .join("\n");
      }
    }
  } catch (err) {
    console.error("[ZingMP3] Get lyrics error:", err.message);
  }
  return "";
}

async function getTopCharts(limit = 10) {
  try {
    const data = await zingRequest(
      "/api/v2/page/get/chart-home",
      {},
      `ctime=TIMEversion=${ZING_VERSION}`
    );
    if (data.err === 0 && data.data && data.data.RTChart) {
      const items = data.data.RTChart.items || [];
      return items.slice(0, limit).map((s, idx) => ({
        rank: idx + 1,
        encodeId: s.encodeId,
        title: s.title,
        artist: s.artistsNames || "",
        duration: s.duration,
        thumbnail: s.thumbnailM || s.thumbnail || "",
      }));
    }
  } catch (err) {
    console.error("[ZingMP3] Get top charts error:", err.message);
  }
  return [];
}

module.exports = {
  searchSongs,
  getStreamUrl,
  getSongInfo,
  getLyrics,
  getTopCharts,
};
