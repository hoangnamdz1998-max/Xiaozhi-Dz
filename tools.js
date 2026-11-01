const fetch = require("node-fetch");
const lunar = require("./lunar");

let autoDetectedLocation = "Ho Chi Minh City";

function setAutoDetectedLocation(city) {
  if (city) {
    autoDetectedLocation = city;
    console.log(`[Location] 📍 Tự động cập nhật vị trí thiết bị: ${autoDetectedLocation}`);
  }
}

function getAutoDetectedLocation() {
  return autoDetectedLocation;
}

/**
 * 1. Tra cứu thời tiết (wttr.in) - Tự động nhận diện vị trí
 */
async function getWeather(location) {
  try {
    let loc = (location || "").trim();
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

    if (genericWords.includes(loc.toLowerCase())) {
      loc = autoDetectedLocation || "Ho Chi Minh City";
    }

    console.log(`[Weather] 🌤️ Tra cứu thời tiết tại: "${loc}"`);

    const res = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
      headers: { "User-Agent": "Xiaozhi-Weather/1.0" },
      timeout: 10000,
    });
    const data = await res.json();
    const curr = data.current_condition[0];
    const forecast = data.weather[0];

    const weatherTranslate = {
      Sunny: "Trời nắng",
      Clear: "Trời quang đãng",
      "Partly cloudy": "Có mây từng đợt",
      Cloudy: "Nhiều mây",
      Overcast: "U ám",
      Mist: "Sương mù nhẹ",
      Fog: "Sương mù",
      "Patchy rain nearby": "Có mưa rải rác vài nơi",
      "Light rain": "Mưa nhỏ",
      "Moderate rain": "Mưa vừa",
      "Heavy rain": "Mưa to",
      Thunderstorm: "Có dông lốc, sấm sét",
    };

    const descEn = curr.weatherDesc[0].value;
    const descVi = weatherTranslate[descEn] || descEn;

    return {
      diaDiem: loc,
      nhietDoHienTai: `${curr.temp_C}°C`,
      camGiacNhu: `${curr.FeelsLikeC}°C`,
      tinhTrang: descVi,
      doAm: `${curr.humidity}%`,
      tocDoGio: `${curr.windspeedKmph} km/h`,
      chiSoUV: curr.uvIndex,
      nhietDoCaoNhat: `${forecast.maxtempC}°C`,
      nhietDoThapNhat: `${forecast.mintempC}°C`,
      message: `Thời tiết tại ${loc}: ${descVi}, nhiệt độ hiện tại ${curr.temp_C}°C (cảm giác như ${curr.FeelsLikeC}°C), độ ẩm ${curr.humidity}%. Nhiệt độ trong ngày từ ${forecast.mintempC}°C đến ${forecast.maxtempC}°C.`,
    };
  } catch (err) {
    console.error("[Weather] Error:", err.message);
    return { error: `Không thể tra cứu thời tiết cho ${location}: ${err.message}` };
  }
}

/**
 * 2. Tra cứu Âm Lịch & Lịch Vạn Niên
 */
function getLunarCalendar(dateStr) {
  try {
    return lunar.getLunarInfo(dateStr);
  } catch (err) {
    console.error("[Lunar] Error:", err.message);
    return { error: `Lỗi tính âm lịch: ${err.message}` };
  }
}

/**
 * 3. Điểm tin tức mới nhất (VnExpress RSS)
 */
async function getLatestNews(category = "tin-moi-nhat") {
  try {
    const rssMap = {
      "tin-moi-nhat": "https://vnexpress.net/rss/tin-moi-nhat.rss",
      "thoi-su": "https://vnexpress.net/rss/thoi-su.rss",
      "the-gioi": "https://vnexpress.net/rss/the-gioi.rss",
      "kinh-doanh": "https://vnexpress.net/rss/kinh-doanh.rss",
      "giai-tri": "https://vnexpress.net/rss/giai-tri.rss",
      "the-thao": "https://vnexpress.net/rss/the-thao.rss",
      "suc-khoe": "https://vnexpress.net/rss/suc-khoe.rss",
    };

    const url = rssMap[category] || rssMap["tin-moi-nhat"];
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });
    const xml = await res.text();

    const items = [];
    const itemRegex = /<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<description><!\[CDATA\[(.*?)\]\]><\/description>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const title = match[1].trim();
      const descRaw = match[2].trim();
      // Remove html tags in description
      const desc = descRaw.replace(/<[^>]*>?/gm, "").trim();
      items.push({ tieuDe: title, tomTat: desc });
    }

    if (items.length === 0) {
      // Fallback regex without CDATA
      const fallbackRegex = /<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<description>(.*?)<\/description>/g;
      while ((match = fallbackRegex.exec(xml)) !== null && items.length < 5) {
        items.push({
          tieuDe: match[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1").trim(),
          tomTat: match[2].replace(/<[^>]*>?/gm, "").trim(),
        });
      }
    }

    return {
      chuyenMuc: category,
      soTin: items.length,
      tinTuc: items,
      message: items.map((t, idx) => `${idx + 1}. ${t.tieuDe}: ${t.tomTat}`).join("\n\n"),
    };
  } catch (err) {
    console.error("[News] Error:", err.message);
    return { error: `Không thể lấy tin tức: ${err.message}` };
  }
}

/**
 * 4. Tìm kiếm thông tin trên Web (DuckDuckGo Instant Answer / HTML)
 */
async function searchWeb(query) {
  try {
    const q = encodeURIComponent(query.trim());
    // Try DDG Instant Answer API first
    const apiRes = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`, {
      timeout: 8000,
    });
    const data = await apiRes.json();
    if (data.AbstractText) {
      return {
        query,
        ketQua: data.AbstractText,
        nguon: data.AbstractSource || "DuckDuckGo",
      };
    }

    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      const topTopics = data.RelatedTopics.slice(0, 3)
        .filter((t) => t.Text)
        .map((t) => t.Text);
      if (topTopics.length > 0) {
        return { query, ketQua: topTopics.join("\n- ") };
      }
    }

    return {
      query,
      ketQua: `Đã tìm kiếm thông tin cho "${query}". Hãy dựa vào dữ liệu có sẵn để trả lời ngắn gọn, chuẩn xác.`,
    };
  } catch (err) {
    console.error("[WebSearch] Error:", err.message);
    return { query, error: err.message };
  }
}

module.exports = {
  getWeather,
  getLunarCalendar,
  getLatestNews,
  searchWeb,
  setAutoDetectedLocation,
  getAutoDetectedLocation,
};
