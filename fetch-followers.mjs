/*
  Holt die Followerzahlen von YouTube, Instagram und TikTok über Apify,
  rechnet sie zusammen und schreibt sie in followers.json.
  Läuft einmal am Tag automatisch über GitHub Actions.
  Hier steht KEIN geheimer Schlüssel drin. Der kommt aus den GitHub Secrets.

  Jede Plattform hat eine oder mehrere Quellen. Klappt die erste nicht,
  wird automatisch die nächste versucht. Wenn eine Plattform gar nichts
  liefert, wird die letzte bekannte Zahl behalten, damit die Summe nie
  kaputtgeht.
*/

import { readFile, writeFile } from "node:fs/promises";

const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error("APIFY_TOKEN fehlt. Als GitHub Secret hinterlegen.");
  process.exit(1);
}

const USERNAME = "motivationverz";

const PLATFORMS = [
  {
    name: "youtube",
    sources: [
      {
        actor: "data_api/youtube-subscribers-scraper-cheap",
        input: { youtubeHandle: USERNAME },
      },
      {
        actor: "streamers/youtube-scraper",
        input: {
          startUrls: [{ url: `https://www.youtube.com/@${USERNAME}` }],
          maxResults: 1,
          maxResultsShorts: 0,
          maxResultStreams: 0,
        },
      },
    ],
  },
  {
    name: "instagram",
    sources: [
      {
        actor: "apify/instagram-profile-scraper",
        input: { usernames: [USERNAME] },
      },
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

function findFollowerCount(data) {
  let best = 0;
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (FOLLOWER_KEYS.has(key.toLowerCase())) {
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
  const items = await res.json();
  return findFollowerCount(items);
}

async function fetchCount(platform) {
  for (const source of platform.sources) {
    try {
      const count = await runActor(source);
      if (count > 0) {
        console.log(`${platform.name}: ${count} (via ${source.actor})`);
        return count;
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
    return { platforms: {}, total: 0 };
  }
}

const previous = await loadPrevious();
const result = {
  platforms: {},
  total: 0,
  updatedAt: new Date().toISOString(),
};

for (const platform of PLATFORMS) {
  try {
    result.platforms[platform.name] = await fetchCount(platform);
  } catch (err) {
    const fallback = previous.platforms?.[platform.name] || 0;
    result.platforms[platform.name] = fallback;
    console.warn(`${platform.name} (${err.message}). Behalte ${fallback}.`);
  }
}

result.total = Object.values(result.platforms).reduce((a, b) => a + b, 0);

await writeFile("followers.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Gesamt: ${result.total}`);
