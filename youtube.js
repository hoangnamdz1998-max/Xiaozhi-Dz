const fetch = require("node-fetch");

const INVIDIOUS_INSTANCES = [
  "https://yewtu.be",
  "https://inv.tux.pizza",
  "https://invidious.nerdvpn.de",
  "https://invidious.drgns.space",
];

async function searchYouTube(query, limit = 5) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 6000,
      });
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.slice(0, limit).map((v) => ({
          videoId: v.videoId,
          title: v.title,
          author: v.author,
          lengthSeconds: v.lengthSeconds,
        }));
      }
    } catch (err) {
      console.warn(`[YouTube] Instance ${instance} error:`, err.message);
    }
  }
  return [];
}

async function getYouTubeAudioUrl(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const url = `${instance}/api/v1/videos/${videoId}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 6000,
      });
      const data = await res.json();
      if (data && Array.isArray(data.adaptiveFormats)) {
        const audioStreams = data.adaptiveFormats
          .filter((f) => f.type && f.type.startsWith("audio/"))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (audioStreams.length > 0 && audioStreams[0].url) {
          return {
            title: data.title,
            author: data.author,
            streamUrl: audioStreams[0].url,
          };
        }
      }
    } catch (err) {
      console.warn(`[YouTube Stream] Instance ${instance} error:`, err.message);
    }
  }
  return null;
}

module.exports = {
  searchYouTube,
  getYouTubeAudioUrl,
};
