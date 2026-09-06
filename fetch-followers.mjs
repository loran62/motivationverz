/*
  Holt die Followerzahlen von YouTube, Instagram und TikTok über Apify,
  rechnet sie zusammen und schreibt sie in followers.json.
  Läuft einmal am Tag automatisch über GitHub Actions.
  Hier steht KEIN geheimer Schlüssel drin. Der kommt aus den GitHub Secrets.

  Wenn eine Plattform mal nicht antwortet, wird die letzte bekannte Zahl
  behalten, damit die Gesamtsumme nie kaputtgeht.

  Falls eine Plattform dauerhaft keine Zahl mehr liefert, muss nur der
  passende "actor" Wert unten getauscht werden. Der Rest bleibt gleich.
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
    actor: "automationagents/youtube-channel",
    input: { startUrls: [{ url: `https://www.youtube.com/@${USERNAME}` }] },
  },
  {
    name: "instagram",
    actor: "apify/instagram-profile-scraper",
    input: { usernames: [USERNAME] },
  },
  {
    name: "tiktok",
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
];

const FOLLOWER_KEYS = new Set([
  "followerscount", "followers", "follower_count", "followercount",
  "fans", "fanscount", "subscribers", "subscribercount", "subscriber_count",
]);

function toNumber(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const s = value.trim().replace(/,/g, "");
    const m = s.match(/^([\d.]+)\s*([kmb])?$/i);
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

async function runActor(platform) {
  const actorPath = platform.actor.replace("/", "~");
  const url =
    `https://api.apify.com/v2/acts/${actorPath}` +
    `/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(platform.input),
  });
  if (!res.ok) throw new Error(`Apify ${platform.name} HTTP ${res.status}`);
  const items = await res.json();
  const count = findFollowerCount(items);
  if (!count) throw new Error(`Keine Followerzahl gefunden für ${platform.name}`);
  return count;
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
    const count = await runActor(platform);
    result.platforms[platform.name] = count;
    console.log(`${platform.name}: ${count}`);
  } catch (err) {
    const fallback = previous.platforms?.[platform.name] || 0;
    result.platforms[platform.name] = fallback;
    console.warn(`${platform.name} fehlgeschlagen (${err.message}). Behalte ${fallback}.`);
  }
}

result.total = Object.values(result.platforms).reduce((a, b) => a + b, 0);

await writeFile("followers.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Gesamt: ${result.total}`);
