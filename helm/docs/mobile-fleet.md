# Helm v1.6 mobile fleet

`helm fleet sync` is a separate, outbound-only companion for a private here.now site. It does not open `helm.sqlite`, start/restart the daemon, send Helm tool calls, or alter workers. It reads only `$HELM_HOME/serve.json`, then performs a bounded `GET http://127.0.0.1:<port>/api/state`.

## Setup

1. Publish the contents of `helm/dashboard/` to a here.now site. Configure a site PIN (or restricted/account-members access) before starting the publisher. The `.herenow/data.json` manifest deliberately permits public **read** only; every mutation is owner-only.
2. Confirm the deployed site is really gated: anonymous page and Site Data requests return HTTP 401; PIN submission to `/` returns 303 and a cookie; the cookie can read Site Data with HTTP 200. Do not put a slug or PIN in this repository.
3. On the machine running Helm, authenticate locally with `HERENOW_API_KEY` or here.now's local `~/.herenow/credentials`. The credential is read only by the publisher and is never sent to the dashboard, local daemon, output, or files in this repository.
4. Start the companion independently, after the Helm daemon is already running:

   ```sh
   helm fleet sync --site YOUR_PRIVATE_SLUG
   # one bounded verification pass:
   helm fleet sync --site YOUR_PRIVATE_SLUG --once
   ```

   `--home <HELM_HOME>` selects a non-default daemon home and `--interval <ms>` defaults to 30000. Stop this publisher with Ctrl-C or SIGTERM; it only removes its own singleton lock. No Helm daemon restart is needed, including with a v1.5 daemon that lacks daemon metadata.

## Contract and privacy

The published `fleet` collection retains exactly one record. The publisher lists it, PATCHes that record, and POSTs only when the collection is empty using a stable idempotency key. More than one record is refused rather than guessing. Before every POST/PATCH it rechecks that the site policy is `password`, `restricted`, or `account_members`; `anyone_with_link` is refused.

The record holds `snapshot` as a JSON string under 15,000 UTF-8 bytes (the Site Data body remains below 16 KB). It allowlists only snapshot version/time; safe run, daemon, count, worker and model scalar summaries. Workers are active-first, then newest. If capacity is reached, `counts.truncatedWorkers` says exactly how many were omitted. Objectives, events, tool arguments, logs, paths, result bodies, lifecycle journal, deployment metadata, credentials and any unrecognised nested values are never copied.

If loopback state cannot be read, the publisher does not write a zero/healthy replacement: the prior cloud record remains and the dashboard becomes stale. The page polls every 30 seconds only while visible, marks snapshots stale after 90 seconds, and marks failed reads offline while retaining the last rendered snapshot.

## Phone use and acceptance

Open the PIN-protected site in Safari/Chrome and use the browser's **Add to Home Screen** action if a phone shortcut is useful. It remains a read-only web page, not a remote-control client. Its responsive layout is designed for 320 px, 390 px, tablet and desktop widths; controls have 44 px touch targets, system light/dark colours, project/state filters, active-first worker cards and expandable safe details.

Acceptance checks:

- Access policy and the anonymous/PIN HTTP flow above are checked on the deployed site by the coordinator.
- The publisher accepts old `/api/state` shapes with missing daemon metadata and an empty fleet, without daemon changes.
- Tests use injected HTTP functions only: no real here.now, provider, credential or daemon calls.
- A sleeping laptop simply leaves the existing record stale; bring the publisher process back up later. No daemon restart or replay is required.
