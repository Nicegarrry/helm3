# Helm v1.7 mobile fleet

`helm fleet sync` is a separate, outbound-only companion for a private here.now site. It does not open `helm.sqlite`, start/restart the daemon, send Helm tool calls, or alter workers. It reads only `$HELM_HOME/serve.json`, then performs a bounded `GET http://127.0.0.1:<port>/api/state`.

## Setup

1. Publish the contents of `helm/dashboard/` to a here.now site. Configure a site PIN (or restricted/account-members access) before starting the publisher. The `.herenow/data.json` manifest deliberately permits public **read** only; every mutation is owner-only.
2. Confirm the deployed site is really gated: anonymous page and Site Data requests return HTTP 401; PIN submission to `/` returns 303 and a cookie; the cookie can read Site Data with HTTP 200. Do not put a slug or PIN in this repository.
3. On the machine running Helm, authenticate locally with `HERENOW_API_KEY` or here.now's local `~/.herenow/credentials`. The credential is read only by the publisher and is never sent to the dashboard, local daemon, output, or files in this repository.
4. Start the companion independently, after the Helm daemons are already running:

   ```sh
   helm fleet sync --site YOUR_PRIVATE_SLUG
   # one bounded verification pass:
   helm fleet sync --site YOUR_PRIVATE_SLUG --once
   ```

   With no source flags, the monitor reads `HELM_HOME` (or `~/.helm`). To monitor multiple fleets in one cloud record, use explicit repeatable source labels:

   ```sh
   helm fleet sync --site YOUR_PRIVATE_SLUG \
     --source primary=/absolute/path/to/helm-home \
     --source mobile=/absolute/path/to/mobile-helm-home
   ```

   `--home <HELM_HOME>` remains a compatible single-source shorthand and cannot be combined with `--source`. `--interval <ms>` defaults to 30000 and must be an integer of at least 10000. Stop this publisher with Ctrl-C or SIGTERM; it wakes its delay, removes only its own singleton lock, and never restarts a daemon. The lock contains its PID, start time, site and source labels for safe manual stale-lock diagnosis. No Helm daemon restart is needed, including pre-v1.5 daemons that lack lifecycle metadata.

## Contract and privacy

The published `fleet` collection retains exactly one record. The publisher lists it, PATCHes that record, and POSTs only when the collection is empty using a stable idempotency key. More than one record is refused rather than guessing. Before every POST/PATCH it rechecks that the site policy is `password`, `restricted`, or `account_members`; `anyone_with_link` is refused.

The record holds `snapshot` as a JSON string under 15,000 UTF-8 bytes and checks the final escaped Site Data body stays below 16 KB. It allowlists only snapshot version/time; safe run, daemon, count, worker and model scalar summaries. Long scalar values are capped; `counts.truncatedFields`, `truncatedWorkers`, and `truncatedModels` make all size reduction explicit. Workers are active-first across all sources, then newest. Each worker has only its source label—not its local path or port—so identical worker IDs remain distinct. Objectives, events, tool arguments, logs, paths, result bodies, lifecycle journal, deployment metadata, credentials and any unrecognised nested values are never copied.

Every source reports an ID/label, source observation time, and live/stale/unavailable status. A malformed local response is rejected rather than manufactured into a healthy empty fleet. When one source fails, the publisher retains its last safe cloud workers and source observation time, labels that source unavailable, and marks the totals incomplete; if every source fails it makes no owner API call at all and leaves the cloud record untouched. The page polls every 30 seconds only while visible, bypasses the browser cache, prevents overlapping requests, marks snapshots stale after 90 seconds, and marks failed reads offline while retaining the last rendered snapshot. With no record yet it says that it is waiting, rather than implying an empty fleet.

## v1.7.1 dashboard appearance and filters

The hosted page is a compact, read-only monitoring surface using the warm-paper palette with navy interaction accents. It bundles Bricolage Grotesque, Hanken Grotesk, and JetBrains Mono from local files only; their SIL OFL 1.1 notices are in `dashboard/fonts/licenses/`. The accessible Appearance selector offers System, Light, and Dark. System follows later OS colour-scheme changes; a valid explicit choice is persisted in `localStorage` under `helm-fleet-appearance`. Storage access is best-effort: blocked or malformed storage falls back to System, and an early guarded read applies a stored explicit choice before the stylesheet to prevent a light/dark flash. This remains presentation-only: no publisher, daemon, fleet data, or control capability changes.

## Phone use and acceptance

Open the PIN-protected site in Safari/Chrome and use the browser's **Add to Home Screen** action if a phone shortcut is useful. It remains a read-only web page, not a remote-control client. Its responsive layout is designed for 320 px, 390 px, tablet and desktop widths; controls have 44 px touch targets, system light/dark colours, project button filters (All by default), state and Runner filters, active-first worker cards and expandable safe details. Project buttons display the short repository name, retain the full slug as their key/title, and include the slug when names collide. Worker metadata starts with `Repository: <repoSlug>` and identifies the independent fleet source as `Runner: <sourceId>`; a runner can work on several projects.

Acceptance checks:

- Access policy and the anonymous/PIN HTTP flow above are checked on the deployed site by the coordinator.
- The publisher accepts old valid `/api/state` shapes with missing daemon metadata and an empty fleet, without daemon changes; it rejects missing `ok:true`, `run`, arrays, or timestamp.
- Tests use injected HTTP functions only: no real here.now, provider, credential or daemon calls.
- A sleeping laptop simply leaves the existing record stale; bring the publisher process back up later. No daemon restart or replay is required.
