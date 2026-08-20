#!/usr/bin/env node
/**
 * SideStore / AltStore source merger.
 * Fetches upstream sources, merges by bundleIdentifier, sanitizes dates,
 * and publishes to a GitHub Gist.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const FALLBACK_DATE = "2024-01-01T00:00:00Z";

/* ---------- CONFIG ---------- */
async function fileExists(p) {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadBlockedBundleIds() {
  const p = path.join(ROOT, "blocked-bundle-ids.json");
  if (!(await fileExists(p))) return new Set();
  try {
    const data = JSON.parse(await readFile(p, "utf8"));
    if (!Array.isArray(data)) return new Set();
    return new Set(data.map((id) => String(id).trim()).filter(Boolean));
  } catch {
    console.warn("⚠️ Could not parse blocked-bundle-ids.json — ignoring.");
    return new Set();
  }
}

/* ---------- BASIC HELPERS ---------- */
function safeText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v);
}

function normalizeDate(value) {
  if (value === null || value === undefined) return FALLBACK_DATE;
  let d = String(value).trim();
  if (!d) return FALLBACK_DATE;

  d = d.replace("+00:00", "Z").replace(/\+0000$/, "Z");

  try {
    const probe = d.endsWith("Z") ? d.slice(0, -1) + "+00:00" : d;
    const dt = new Date(probe);
    if (!isNaN(dt.getTime())) {
      if (d.includes("T") && (d.endsWith("Z") || /[+\-]\d{2}:?\d{2}$/.test(d))) {
        return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return d + "T00:00:00Z";
      }
      return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  } catch {
    /* fall through */
  }

  for (const fmt of [d.slice(0, 19), d.slice(0, 10)]) {
    const dt = new Date(fmt);
    if (!isNaN(dt.getTime())) {
      return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
  }
  return FALLBACK_DATE;
}

function versionSortKey(v) {
  const d = v && v.date ? new Date(v.date) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : null;
}

function compareVersionStrings(a, b) {
  const pa = String(a || "0").split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0,
      y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function isNewer(a, b) {
  if (!b) return true;
  if (!a) return false;
  const da = versionSortKey(a),
    db = versionSortKey(b);
  if (da !== null && db !== null) return da > db;
  return compareVersionStrings(a.version, b.version) > 0;
}

function pickLatestVersion(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  return versions.reduce((best, cur) => (isNewer(cur, best) ? cur : best), null);
}

function permissionLabel(p) {
  if (p === null || p === undefined) return "";
  if (typeof p === "string") return p;
  if (typeof p === "object") {
    const label = p.type || p.name || p.identifier || p.key || p.permission;
    return label ? safeText(label) : "";
  }
  return safeText(p);
}

function toScreenshotList(val) {
  if (!val) return [];
  const urls = [];

  const pushItem = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      urls.push(item);
    } else if (typeof item === "object" && item.imageURL) {
      urls.push(String(item.imageURL));
    }
  };

  if (Array.isArray(val)) {
    for (const item of val) pushItem(item);
    return [...new Set(urls.filter(Boolean))];
  }

  if (typeof val === "object") {
    for (const v of Object.values(val)) {
      if (Array.isArray(v)) {
        for (const item of v) pushItem(item);
      } else {
        pushItem(v);
      }
    }
    return [...new Set(urls.filter(Boolean))];
  }

  return [];
}

function ensureVersions(app) {
  let versions = Array.isArray(app.versions) ? app.versions.slice() : [];

  versions = versions.filter((v) => v && (v.downloadURL || v.url));

  versions = versions.map((v) => ({
    ...v,
    date: normalizeDate(v.date),
    downloadURL: v.downloadURL || v.url || "",
    version: v.version != null ? String(v.version) : "",
  }));

  if (!versions.length && app.downloadURL) {
    versions = [
      {
        version: app.version != null ? String(app.version) : "1.0",
        date: normalizeDate(app.date || app.versionDate),
        downloadURL: app.downloadURL,
        size: app.size || 0,
        ...(app.minOSVersion ? { minOSVersion: app.minOSVersion } : {}),
        ...(app.localizedDescription || app.versionDescription
          ? {
              localizedDescription:
                app.localizedDescription || app.versionDescription,
            }
          : {}),
      },
    ];
  }

  versions = versions.map((v) => ({
    ...v,
    date: normalizeDate(v.date),
  }));

  return versions;
}

function normalizeApp(app) {
  const versions = ensureVersions(app);
  const latest = pickLatestVersion(versions);
  const versionInfo = latest || {};

  let screenshots;
  if (
    app.screenshots &&
    typeof app.screenshots === "object" &&
    !Array.isArray(app.screenshots)
  ) {
    screenshots = app.screenshots;
  } else {
    screenshots = toScreenshotList(app.screenshotURLs || app.screenshots);
  }

  const permissions = (() => {
    let perms = [];
    if (app.appPermissions) {
      if (Array.isArray(app.appPermissions.entitlements)) {
        perms.push(...app.appPermissions.entitlements.map(permissionLabel));
      }
      if (
        app.appPermissions.privacy &&
        typeof app.appPermissions.privacy === "object"
      ) {
        perms.push(...Object.keys(app.appPermissions.privacy));
      }
    }
    if (Array.isArray(app.permissions)) {
      perms.push(...app.permissions.map(permissionLabel));
    }
    return [...new Set(perms.filter(Boolean))];
  })();

  const date = normalizeDate(versionInfo.date || app.date || app.versionDate);

  return {
    ...app,
    downloadURL: versionInfo.downloadURL || app.downloadURL || "",
    version: versionInfo.version || app.version || "",
    size: versionInfo.size || app.size || 0,
    date,
    minOSVersion: versionInfo.minOSVersion || app.minOSVersion || "",
    screenshots,
    permissions,
    versions: latest ? [latest] : versions.slice(0, 1),
  };
}

function sanitizeExistingApps(apps, blocked) {
  return apps
    .filter((app) => {
      const bid = safeText(app?.bundleIdentifier);
      if (blocked.has(bid)) {
        console.log(`🚫 Dropped blocked app: ${bid}`);
        return false;
      }
      return true;
    })
    .map((app) => {
      try {
        return normalizeApp(app);
      } catch (e) {
        console.warn(
          `⚠️ Failed to sanitize existing app ${app?.bundleIdentifier || "?"}: ${e.message}`
        );
        return app;
      }
    });
}

function mergeAppInto(mergedApps, app, sourceName, blocked) {
  const normalized = normalizeApp(app);
  const bundleId = safeText(normalized.bundleIdentifier);
  if (!bundleId) return;
  if (blocked.has(bundleId)) return;

  const existing = mergedApps.find((a) => a.bundleIdentifier === bundleId);

  if (!existing) {
    normalized._sources = [sourceName];
    mergedApps.push(normalized);
    return;
  }

  existing._sources = Array.isArray(existing._sources) ? existing._sources : [];
  if (!existing._sources.includes(sourceName)) existing._sources.push(sourceName);

  existing.iconURL = existing.iconURL || normalized.iconURL;
  existing.developerName = existing.developerName || normalized.developerName;
  existing.subtitle = existing.subtitle || normalized.subtitle;

  const existingIsObject =
    existing.screenshots &&
    typeof existing.screenshots === "object" &&
    !Array.isArray(existing.screenshots);
  const incomingIsObject =
    normalized.screenshots &&
    typeof normalized.screenshots === "object" &&
    !Array.isArray(normalized.screenshots);

  if (existingIsObject || incomingIsObject) {
    if (!existingIsObject && incomingIsObject) {
      existing.screenshots = normalized.screenshots;
    }
  } else {
    const combined = [
      ...toScreenshotList(existing.screenshots),
      ...toScreenshotList(normalized.screenshots),
    ];
    existing.screenshots = [...new Set(combined)];
  }

  const existingPerms = Array.isArray(existing.permissions)
    ? existing.permissions
    : [];
  const incomingPerms = Array.isArray(normalized.permissions)
    ? normalized.permissions
    : [];
  existing.permissions = [
    ...new Set([...existingPerms, ...incomingPerms].filter(Boolean)),
  ];

  const candidate = pickLatestVersion(normalized.versions);
  const current = pickLatestVersion(existing.versions);
  if (candidate && isNewer(candidate, current)) {
    existing.versions = [{ ...candidate, date: normalizeDate(candidate.date) }];
    existing.downloadURL = candidate.downloadURL || existing.downloadURL;
    existing.version = candidate.version || existing.version;
    existing.size = candidate.size || existing.size;
    existing.date = normalizeDate(candidate.date || existing.date);
    existing.minOSVersion = candidate.minOSVersion || existing.minOSVersion;
  } else if (!current && candidate) {
    existing.versions = [{ ...candidate, date: normalizeDate(candidate.date) }];
    existing.downloadURL = candidate.downloadURL || existing.downloadURL;
    existing.version = candidate.version || existing.version;
    existing.size = candidate.size || existing.size;
    existing.date = normalizeDate(candidate.date || existing.date);
  } else {
    existing.date = normalizeDate(existing.date);
    if (Array.isArray(existing.versions)) {
      existing.versions = existing.versions.map((v) => ({
        ...v,
        date: normalizeDate(v.date),
      }));
    }
  }
}

async function fetchJSON(url, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function main() {
  const sourcesPath = path.join(ROOT, "sources.json");
  if (!(await fileExists(sourcesPath))) {
    throw new Error(
      "sources.json not found. Copy sources.example.json to sources.json and add your URLs."
    );
  }

  const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error("sources.json must be a non-empty array of URLs");
  }

  const blocked = await loadBlockedBundleIds();
  if (blocked.size) {
    console.log(`🚫 Loaded ${blocked.size} blocked bundle ID(s).`);
  }

  const ghToken = process.env.GH_TOKEN || process.env.GIST_TOKEN;
  const gistId = process.env.GIST_ID;
  const filename = process.env.GIST_FILENAME || "source.json";
  const sourceName = process.env.SOURCE_NAME || "My SideStore Source";
  const sourceIdentifier =
    process.env.SOURCE_IDENTIFIER || "com.example.sidestore";

  let mergedApps = [];
  const failures = [];

  if (ghToken && gistId) {
    const existingRes = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        Authorization: `token ${ghToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (existingRes.ok) {
      const gistData = await existingRes.json();
      let file = gistData.files[filename];

      if (file && file.truncated && file.raw_url) {
        console.log(
          `ℹ️ "${filename}" content was truncated by the API — fetching full file from raw_url.`
        );
        const rawRes = await fetch(file.raw_url);
        if (rawRes.ok) {
          file = { ...file, content: await rawRes.text() };
        } else {
          console.warn(
            `⚠️ Could not fetch raw_url for truncated file: HTTP ${rawRes.status}`
          );
        }
      }

      if (file && file.content) {
        try {
          const parsed = JSON.parse(file.content);
          if (Array.isArray(parsed.apps)) {
            mergedApps = sanitizeExistingApps(parsed.apps, blocked);
            console.log(
              `📥 Loaded ${mergedApps.length} existing apps from Gist (sanitized).`
            );
          }
        } catch {
          throw new Error(
            `Existing Gist file "${filename}" could not be parsed as JSON. Refusing to continue, ` +
              `since proceeding would overwrite your existing gist with an incomplete apps list.`
          );
        }
      }
    } else {
      const body = await existingRes.text();
      if (existingRes.status === 404) {
        throw new Error(
          `GET /gists/${gistId} returned 404. Either GIST_ID is wrong (check for stray ` +
            `whitespace when pasted) or GH_TOKEN belongs to an account that doesn't own this ` +
            `gist. Raw response: ${body}`
        );
      }
      throw new Error(
        `Could not load existing Gist: HTTP ${existingRes.status} — ${body}`
      );
    }
  }

  for (const url of sources) {
    try {
      const src = await fetchJSON(url);
      const name = safeText(src.name || url);
      if (Array.isArray(src.apps)) {
        src.apps.forEach((app) => mergeAppInto(mergedApps, app, name, blocked));
        console.log(`✓ ${url} — ${src.apps.length} apps`);
      } else {
        failures.push({ url, reason: "no apps array in response" });
        console.warn(`✗ ${url} — no apps array`);
      }
    } catch (e) {
      failures.push({ url, reason: e.message });
      console.warn(`✗ ${url} — ${e.message}`);
    }
  }

  const dedupedApps = [];
  for (const app of mergedApps) {
    const clean = normalizeApp(app);
    const bid = safeText(clean.bundleIdentifier);
    if (blocked.has(bid)) continue;
    if (!dedupedApps.find((a) => a.bundleIdentifier === bid)) {
      dedupedApps.push(clean);
    }
  }

  const output = {
    name: sourceName,
    identifier: sourceIdentifier,
    apps: dedupedApps,
  };

  console.log(
    `\nMerged ${dedupedApps.length} total apps (${failures.length} failed).`
  );

  if (!ghToken || !gistId) {
    console.log("\nGH_TOKEN / GIST_ID not set — writing merged output locally.");
    await writeFile(
      path.join(ROOT, "merged-source.json"),
      JSON.stringify(output, null, 2)
    );
    console.log("Wrote merged-source.json");
    return;
  }

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${ghToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      files: {
        [filename]: { content: JSON.stringify(output, null, 2) },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist update failed: HTTP ${res.status} — ${body}`);
  }

  console.log(`\n✅ Updated gist ${gistId} (${filename}).`);

  if (failures.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("❌ Pipeline failed:", e);
  process.exit(1);
});
