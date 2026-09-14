/*
  Holt Followerzahlen von YouTube, Instagram und TikTok über Apify und
  zusätzlich die Gesamtaufrufe des YouTube Kanals. Schreibt alles in
  followers.json. Läuft täglich über GitHub Actions.
  Hier steht KEIN geheimer Schlüssel drin, der kommt aus den GitHub Secrets.

  Jede Plattform hat mehrere Quellen. Klappt die erste nicht, wird die
  nächste versucht. Liefert eine Plattform gar nichts, bleibt die letzte
  bekannte Zahl erhalten, damit nichts kaputtgeht.
*/

import { readFile, writeFile } from "node:fs/promises";

const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error("APIFY_TOKEN fehlt. Als GitHub Secret hinterlegen.");
  process.exit(1);
}

const USERNAME = "motivationverz";
const YT_URL = `https://www.youtube.com/@${USERNAME}`;

const PLATFORMS = [
  {
    name: "youtube",
    sources: [
      { actor: "gio21/youtube-channel-scraper", input: { handles: [USERNAME] } },
      { actor: "scrapemamba/youtube-channel-scraper", input: { handles: [USERNAME] } },
      { actor: "gio21/youtube-channel-scraper", input: { channelUrls: [YT_URL] } },
      { actor: "data_api/youtube-subscribers-scraper-cheap", input: { youtubeHandle: USERNAME } },
    ],
  },
  {
    name: "instagram",
    sources: [
      { actor: "apify/instagram-profile-scraper", input: { usernames: [USERNAME] } },
    ],
  },
  {
    name: "tiktok",
    sources: [
      {
        actor: "clockworks/tiktok-scraper",
        input: {
          profiles: [USERNAME],
          resultsPerPage: 1,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadSubtitles: false,
          shouldDownloadSlideshowImages: false,
        },
      },
    ],
  },
];

const FOLLOWER_KEYS = new Set([
  "followers", "followerscount", "follower_count", "followercount",
  "followerstext", "followercounttext",
  "fans", "fanscount",
  "subscribers", "subscriberscount", "subscribercount", "subscriber_count",
  "subscriberstext", "subscribercounttext", "numberofsubscribers",
  "channelfollowercount",
]);

const VIEW_KEYS = new Set([
  "viewcount", "views", "totalviews", "totalviewcount",
  "channelviewcount", "view_count", "lifetimeviews", "videoviewcount",
]);

function toNumber(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const m = value.replace(/,/g, "").match(/([\d.]+)\s*([kmb])?/i);
    if (m) {
      let n = parseFloat(m[1]);
      const suf = (m[2] || "").toLowerCase();
      if (suf === "k") n *= 1e3;
      else if (suf === "m") n *= 1e6;
      else if (suf === "b") n *= 1e9;
      return Math.round(n);
    }
  }
  return 0;
}

function scanMax(data, keys) {
  let best = 0;
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (keys.has(key.toLowerCase())) {
          const n = toNumber(value);
          if (n > best) best = n;
        }
        visit(value);
      }
    }
  };
  visit(data);
  return best;
}

async function runActor(source) {
  const actorPath = source.actor.replace("/", "~");
  const url =
    `https://api.apify.com/v2/acts/${actorPath}` +
    `/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source.input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPlatform(platform) {
  for (const source of platform.sources) {
    try {
      const items = await runActor(source);
      const followers = scanMax(items, FOLLOWER_KEYS);
      const views = scanMax(items, VIEW_KEYS);
      if (followers > 0) {
        console.log(`${platform.name}: ${followers} Follower, ${views} Views (via ${source.actor})`);
        return { followers, views };
      }
      console.warn(`${platform.name} via ${source.actor}: keine Zahl gefunden.`);
    } catch (err) {
      console.warn(`${platform.name} via ${source.actor} fehlgeschlagen: ${err.message}`);
    }
  }
  throw new Error(`Alle Quellen fehlgeschlagen für ${platform.name}`);
}

async function loadPrevious() {
  try {
    return JSON.parse(await readFile("followers.json", "utf8"));
  } catch {
    return { platforms: {}, total: 0, youtubeViews: 0 };
  }
}

const previous = await loadPrevious();
const result = {
  platforms: {},
  total: 0,
  youtubeViews: 0,
  updatedAt: new Date().toISOString(),
};

for (const platform of PLATFORMS) {
  try {
    const { followers, views } = await fetchPlatform(platform);
    result.platforms[platform.name] = followers;
    if (platform.name === "youtube") {
      result.youtubeViews = views > 0 ? views : (previous.youtubeViews || 0);
    }
  } catch (err) {
    result.platforms[platform.name] = previous.platforms?.[platform.name] || 0;
    if (platform.name === "youtube") {
      result.youtubeViews = previous.youtubeViews || 0;
    }
    console.warn(`${platform.name} (${err.message}). Behalte alte Werte.`);
  }
}

result.total = Object.values(result.platforms).reduce((a, b) => a + b, 0);

await writeFile("followers.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Follower gesamt: ${result.total}, YouTube Views: ${result.youtubeViews}`);
