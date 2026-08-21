# Deployment Guide

This document covers how to deploy the hauction pipeline on a VPS for nightly
automated auction data updates.

---

## 1. Prerequisites

- Python 3.11+ with a virtual environment at `/path/to/hauction/.venv`
- Git installed and the repository cloned to the VPS
- An SSH deploy key that has **write** access to the GitHub repository

---

## 2. SSH Deploy Key Setup

The pipeline commits and pushes `auctions.json` automatically.  It needs an
SSH key pair with write access to the GitHub repo.

### Generate a key pair (on the VPS)

```bash
ssh-keygen -t ed25519 -C "hauction-deploy" -f ~/.ssh/hauction_deploy -N ""
```

### Add the public key to GitHub

1. Copy the public key:
   ```bash
   cat ~/.ssh/hauction_deploy.pub
   ```
2. Open the GitHub repository → **Settings** → **Deploy keys** →
   **Add deploy key**.
3. Paste the public key, tick **Allow write access**, and save.

### Configure SSH to use the key for this repo

Add a `Host` block to `~/.ssh/config`:

```
Host github-hauction
    HostName github.com
    User git
    IdentityFile ~/.ssh/hauction_deploy
    IdentitiesOnly yes
```

Then set the remote URL to use the alias:

```bash
cd /path/to/hauction
git remote set-url origin git@github-hauction:YOUR_ORG/hauction.git
```

---

## 3. Environment Variables

Create a `.env` file in the project root (not committed to git) or export
variables directly in the cron environment.

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_GEOCODING_API_KEY` | _(empty)_ | Google Geocoding API key |
| `GEOCODING_DAILY_BUDGET` | `300` | Max geocoding API calls per run |
| `DB_PATH` | `data/hauction.db` | Path to SQLite database |
| `OUTPUT_PATH` | `public/auctions.json` | Path where auctions.json is written |
| `SANITY_THRESHOLD_PCT` | `0.20` | Minimum fraction of previous count before treating a scrape as failed |
| `GIT_REPO_PATH` | `.` | Repository root for git CLI calls |
| `GIT_REMOTE` | `origin` | Git remote name to push to |
| `GIT_BRANCH` | `main` | Git branch to push to |
| `GIT_PUSH_ENABLED` | `true` | Set to `false`, `0`, or `no` to disable git push (local dev) |

---

## 4. Cron Setup

Add a cron entry to run the pipeline nightly (e.g. at 02:00):

```bash
crontab -e
```

```
0 2 * * * cd /path/to/hauction && /path/to/hauction/.venv/bin/python -m pipeline.runner >> /var/log/hauction.log 2>&1
```

Replace `/path/to/hauction` with the actual clone path.

> **Note:** cron inherits a minimal environment.  Either source your `.env`
> inside the command or use a wrapper script that loads it before running.

### Wrapper script approach (recommended)

Create `/path/to/hauction/scripts/run_pipeline.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && source .env; set +a
exec .venv/bin/python -m pipeline.runner
```

```bash
chmod +x scripts/run_pipeline.sh
```

Cron entry:

```
0 2 * * * /path/to/hauction/scripts/run_pipeline.sh >> /var/log/hauction.log 2>&1
```

---

## 5. Scraping Entry Point

The single entry point that triggers scraping for **all regions** is
`pipeline/runner.py` → `run()`.

### CLI invocation

```bash
python -m pipeline.runner
```

This is exactly what the cron job and wrapper script (see section 4) execute.

### What `run()` does in one invocation

`run()` scrapes **both** regions sequentially — there is currently no way to
trigger a single region independently:

1. **DE — Germany (ZVG):** iterates over every German federal state defined in
   `scrapers.zvg.STATES`, calling `zvg.fetch(states=[state])` and
   `zvg.parse(html, state)` for each one.  Each state is wrapped in its own
   `try/except` so a failure in one state does not abort the others.
2. **ES — Spain (BOE):** calls `boe.fetch()` then `boe.parse(raw)` in a single
   block.

After both scrapers finish, the pipeline runs geocoding, publishes the
`auctions.json` output file, and pushes to git.

### Programmatic usage

```python
from pipeline.runner import run

summary = run(db_path="data/hauction.db", output_path="public/auctions.json")
print(summary)
```

Both parameters are optional; omitting them falls back to the values loaded
from environment variables by `config.py` (see section 3).

### No region-selective triggering

There is currently **no CLI flag or API argument** to run only DE or only ES.
Every invocation of `run()` (or `python -m pipeline.runner`) always executes
both scrapers in the DE → ES order.

---

## 6. Log Rotation

Prevent `/var/log/hauction.log` from growing unbounded with logrotate:

Create `/etc/logrotate.d/hauction`:

```
/var/log/hauction.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
```

---

## 7. Verifying the Cron

- After the first scheduled run, check `/var/log/hauction.log` for the
  `Pipeline complete:` summary line.
- Check the GitHub repository's commit history to confirm `auctions.json`
  was pushed.
- The pipeline logs `auctions.json committed and pushed to origin/main.` on
  success, or `auctions.json is unchanged since last commit; skipping git push.`
  when there is nothing new to commit.
