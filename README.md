# denno-sideload-automation

GitHub Actions pipeline that **merges multiple AltStore / SideStore source JSONs** into one combined source and publishes it to a **GitHub Gist**.

Use it as a template for your own sideload source: list the upstream URLs you care about, set a few secrets, and the workflow keeps a single Gist up to date on a schedule (or on demand).

---

## What it does

1. Reads a list of source URLs from `sources.json`
2. Fetches each source JSON
3. Merges apps by `bundleIdentifier` (newer version wins; richer metadata is preferred)
4. Sanitizes data so SideStore / KSign accept the file:
   - Dates normalized to ISO-8601 UTC (`…Z`)
   - Empty `versions[]` promoted from top-level `downloadURL` / `version` / `date` when needed
   - Screenshot arrays vs device-keyed objects handled safely
5. Optionally drops blocked bundle IDs
6. Writes the result to your Gist as `source.json` (or whatever filename you configure)

Your SideStore / AltStore / KSign client then points at the Gist **raw** URL.

---

## Requirements

- A GitHub account
- A **classic** Personal Access Token with the **`gist`** scope  
  (GitHub App installation tokens and many fine-grained tokens **cannot** write Gists)
- An empty (or existing) Gist that will hold the published source

---

## Quick start

### 1. Use this repo

- **Fork** this repository, or  
- Click **Use this template** → create a new repo under your account

### 2. Create a Gist

1. Go to [gist.github.com](https://gist.github.com)
2. Create a Gist with one file named `source.json` (content can be `{}` for now)
3. Copy the Gist **ID** from the URL:  
   `https://gist.github.com/yourname/<<<<<<<< THIS_ID >>>>>>>>`

### 3. Create a classic PAT

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. Generate a token with the **`gist`** scope only (enough for this pipeline)
3. Copy the token (you will not see it again)

### 4. Add repository secrets

In your fork: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret name   | Value                          |
|---------------|--------------------------------|
| `GIST_TOKEN`  | Your classic PAT (`gist` scope) |
| `GIST_ID`     | The Gist ID from step 2        |

Optional **Variables** (Settings → Secrets and variables → Actions → Variables):

| Variable            | Default                         | Purpose                    |
|---------------------|---------------------------------|----------------------------|
| `SOURCE_NAME`       | `My SideStore Source`           | Top-level `name` in JSON   |
| `SOURCE_IDENTIFIER` | `com.example.sidestore`         | Top-level `identifier`     |
| `GIST_FILENAME`     | `source.json`                   | Filename inside the Gist   |

### 5. Configure your source list

Edit `sources.json` (array of URLs):

```json
[
  "https://example.com/altstore.json",
  "https://another.example/source.json"
]
```

Commit and push to `main`.

### 6. Run the workflow

**Actions** → **Merge Sources** → **Run workflow**.

When it finishes, open:

```text
https://gist.githubusercontent.com/<you>/<GIST_ID>/raw/source.json
```

Add that URL as a source in SideStore / AltStore / KSign.

---

## Repository layout

```text
.
├── sources.json                 # Your list of upstream source URLs (required)
├── sources.example.json         # Sample list (optional reference)
├── blocked-bundle-ids.json      # Optional: bundle IDs to never publish
├── scripts/
│   └── merge-sources.mjs        # Merger + sanitizer + Gist publisher
├── .github/workflows/
│   ├── merge.yml                # Scheduled + manual merge / publish
│   └── security-scan.yml        # Semgrep, gitleaks, npm audit
├── package.json
├── LICENSE                      # MIT
└── README.md
```

---

## `sources.json`

Plain JSON array of strings. Each URL must return AltStore/SideStore-compatible JSON (`name`, `identifier`, `apps[]`, etc.).

```json
[
  "https://flyinghead.github.io/flycast-builds/altstore.json",
  "https://community-apps.sidestore.io/sidecommunity.json"
]
```

Invalid or unreachable URLs are logged and skipped; the rest still publish.

---

## Blocked bundle IDs (optional)

If you want to exclude specific apps (e.g. an unmaintained fork), add:

**`blocked-bundle-ids.json`**

```json
[
  "com.example.unwanted.app"
]
```

The merge script drops those IDs when loading the existing Gist and when merging new sources, so they do not reappear.

---

## Merge behavior

| Rule | Behavior |
|------|----------|
| Key | `bundleIdentifier` |
| Version | Newer date / version string wins |
| Metadata | Existing richer fields kept when possible (icon, developer, screenshots) |
| Screenshots | Supports URL arrays and `{ iphone: [...], ipad: [...] }` objects |
| Dates | Forced to ISO-8601 UTC ending in `Z` (empty → fallback) |
| Empty versions | Built from top-level `downloadURL` / `version` / `date` when present |
| Existing Gist apps | Loaded first so hand-curated entries are not wiped if a run partially fails |

Hand-added apps that only exist in the Gist (not in any URL in `sources.json`) are **kept** unless their bundle ID is blocked.

---

## Workflows

### Merge Sources (`merge.yml`)

- **Triggers:** `workflow_dispatch` (manual) and daily schedule (`0 6 * * *` UTC)
- **Runtime:** Node.js 22
- **Env:** `GIST_TOKEN`, `GIST_ID`, optional name/identifier/filename variables
- **On success:** Gist file updated; SideStore clients pick it up on refresh (raw URLs can cache briefly)

Recommended: run manually once after setup, then leave the daily schedule on.

### Security Scan (`security-scan.yml`)

Runs on push/PR to `main` (and manually):

| Job | What it does |
|-----|----------------|
| **Semgrep** | SAST on the JS merge script (no GitHub Advanced Security required) |
| **gitleaks** | Scans history for accidentally committed secrets |
| **npm audit** | Dependency audit when `package.json` is present |

These are optional hygiene checks for the template itself. They do not publish your source.

---

## SideStore / KSign notes

- Prefer the **raw** Gist URL:  
  `https://gist.githubusercontent.com/<user>/<id>/raw/source.json`  
  (not the HTML Gist page)
- SideStore and KSign are strict about **dates** and schema; this pipeline normalizes dates and empty `versions` so a single bad upstream entry does not break the whole source
- LiveContainer is often more tolerant; if something loads there but not in SideStore, check dates and `versions[]` first

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Workflow fails with Gist `403` | Token lacks `gist` scope, or is a GitHub App / fine-grained token | Use a **classic** PAT with `gist` |
| Gist `404` | Wrong `GIST_ID` or token from another account | Confirm ID and that the token owns the Gist |
| SideStore refuses to load source | Empty or invalid `date` on some app | Ensure you are on the current `merge-sources.mjs` (date sanitization) |
| App missing after a run | Not in any `sources.json` URL and was never in the Gist; or blocked | Add URL or remove from blocklist |
| Duplicate app names | Different `bundleIdentifier`s (two ports of the same app) | Block the one you do not want, or remove its source URL |
| Stale content in SideStore | Raw URL caching | Refresh source / wait; confirm Gist revision updated on GitHub |

---

## Security

- **Never** commit `GIST_TOKEN` or any PAT
- Use repository secrets only
- Prefer a classic PAT limited to the `gist` scope
- This pipeline only needs to read public source URLs and PATCH your own Gist
- `security-scan.yml` helps catch accidental secret commits and basic code issues on PRs

---

## License

[MIT](LICENSE)

---

## Credits

Built for maintaining combined SideStore sources. Fork it, point it at your own Gist, and keep a single clean source without hand-editing JSON.
