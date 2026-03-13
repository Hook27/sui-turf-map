# SUI Turf Map

Interactive map of the SUI blockchain turf game, auto-updated every 8 hours via GitHub Actions.

## Setup (one time)

### 1. Create a GitHub repository

Go to https://github.com/new and create a **public** repository named `sui-turf-map`.

### 2. Upload these files

Upload all files from this folder to the repository root:
```
index.html
fetch_data.py
data.json          ← placeholder, will be overwritten on first run
.github/
  workflows/
    update.yml
```

For `data.json`, create an empty placeholder file with content `{}`.

### 3. Enable GitHub Pages

In your repository: **Settings → Pages → Source → Deploy from branch → main → / (root) → Save**

Your map will be live at: `https://your-username.github.io/sui-turf-map/`

### 4. Run the workflow for the first time

Go to **Actions → Update map data → Run workflow** to populate `data.json` immediately.
The first run takes about 10 minutes.

### 5. Done

The workflow runs automatically every 8 hours. The map loads instantly from `data.json`.

---

## Manual refresh button

The map has a **⚡ Refresh data** button that triggers the GitHub Actions workflow via the API.

To use it you need a GitHub Personal Access Token with `workflow` scope:
https://github.com/settings/tokens/new?scopes=workflow&description=SUI+Turf+Map

Enter your token and repository name (`username/sui-turf-map`) in the modal when prompted.
The token is never stored — it only exists in memory for that one API call.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | The map — loads `data.json`, no RPC calls |
| `fetch_data.py` | Data fetcher — runs on GitHub Actions |
| `data.json` | Generated data file — served by GitHub Pages |
| `.github/workflows/update.yml` | Scheduled workflow — runs every 8 hours |

## Local testing

To test locally before publishing:

```bash
python fetch_data.py        # generates data.json (~10 min)
python -m http.server 8080  # serves on http://localhost:8080
```
