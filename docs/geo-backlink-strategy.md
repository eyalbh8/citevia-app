# Monthly GEO Backlink Strategy

This feature is implemented in the existing CiteVia project, scan, PostgreSQL, queue and React architecture. It is disabled unless a system administrator enables **Settings → GEO Backlink Strategy** for the project. Its setting is independent of the AI scanning switch. Only system administrators can read or change this feature in this release.

## Operation

- A separate one-minute reconciliation event checks the project timezone. The current monthly report becomes due on the first day at 06:00 local time, with same-month catch-up after downtime or enabling the feature. Existing twice-weekly scan schedules are unchanged.
- Manual and scheduled generation use `GeoBacklinkEngine.handle`. Reports analyse the preceding local calendar month, including daylight-saving changes. Successfully completed scan runs and succeeded answers are used across all providers. Partial, failed, cancelled and reporting-excluded runs do not contribute.
- Captures use the existing native-citation and saved-analysis indexes, with bounded artifact fallback for older data. No additional AI provider calls occur.
- Reports with fewer than two distinct provider scans are marked `insufficient_data` and contain no recommendations. Reports can contain fewer than the target when eligible evidence is limited.
- A leased report is unique per project/month. Once completed, both a normal report and an insufficient-data report retain their original cohort. Repeating generation returns that report. Refreshing measurements changes performance data, not selected websites.
- Candidate scoring is deterministic and records its evidence and component scores. Default weights are 25 citation consistency, 25 competitor gap, 25 relevance, 15 visibility gap, and 10 placement feasibility. Default priority allocation is P1/P2/P3/P4 = 5/3/1/1; empty allocations are redistributed.
- Article verification is distinct from AI answer analysis. P1 requires verified article brand absence, at least two verified competitors, topic/market relevance and repeated citation evidence. Public retrieval is bounded to the strongest 40 domains per run and a time budget. Robots restrictions, positive crawl delays, paywalls, missing article bodies, errors and timeouts leave article facts unknown. Requests pin validated public IPv4 DNS addresses, validate redirects, and limit response size/time. Exact article ordering/ranking, outdated information and placement availability are not invented.
- Domains use `tldts` Public Suffix List normalization, including private suffix tenants. Brand/competitor-owned, government/military, search/proxy and explicitly excluded domains are filtered. The domain ledger is checked again inside the project-row transaction that saves the final report. Imported dates and rejected, cancelled or unpublished opportunities still block repeat recommendations. The default is 180 full elapsed days; configuration cannot shorten it below 180.
- The backlog retains discovered domains and first discovery dates. A later selection requires citation evidence in the new analysis month. Discovery alone does not enter the exclusion ledger.

## Data and code

Migration `database/migrations/019_geo_backlinks.sql` adds six account-scoped tables:

- `citevia_geo_backlink_reports`: monthly identity, leases, analysis window and settings snapshot.
- `citevia_geo_backlink_candidates`: persistent domain backlog and latest fresh evidence.
- `citevia_geo_backlink_recommendations`: original cohort/evidence plus editable lifecycle.
- `citevia_geo_backlink_ledger`: canonical-domain exclusion history summary.
- `citevia_geo_backlink_activities`: immutable status and field-change audit events.
- `citevia_geo_backlink_performance`: publication-date-and-URL-specific baseline/30/60/90-day observations.

Core rules live in `packages/core/src/geo-backlinks.ts`; storage has matching PostgreSQL and memory implementations. Worker and retrieval code live in `apps/scanner/src/geo-backlinks.ts`, `geo-backlink-progress.ts` and `geo-backlink-articles.ts`. API routes are in `apps/api/src/geo-backlinks.ts`. The frontend adds `GeoBacklinkSettings.tsx`, `GeoBacklinksView.tsx` and `geo-backlinks.css` using the existing query and UI components.

Progress summaries are built in the background and persisted in the existing artifact store, avoiding a six-month scan query on each API page load. They refresh daily, following generation/import/lifecycle updates, or on request. The UI polls while a refresh is pending. Publication measurements use actual publication dates and matching provider/prompt ID/version/text/country cohorts. Changed prompt compositions are excluded from comparisons. A changed publication URL creates a separate measurement lineage even when the date stays the same. Saved measured checkpoints are immutable; insufficient checkpoints can be filled by later available scan data.

## API

All routes below are under `/v1/projects/:projectId/geo-backlinks` and enforce system-admin authorization, project isolation and the project feature toggle.

- `GET /reports?offset=0&limit=25`: report history.
- `POST /reports` with `{ "month": "2026-11" }`: reserve/enqueue or return the original monthly report.
- `GET /reports/:month`: report and selected recommendation summaries.
- `GET /recommendations`: paginated search/filter/sort for current or historical recommendations.
- `GET /recommendations/:id`: full evidence, paginated audit events and publication-matching measurements.
- `PATCH /recommendations/:id`: version-checked lifecycle, notes, owner, contact/publication dates, published URL, landing page, placement type, link type, cost and currency.
- `GET /candidates`: paginated persistent backlog summaries.
- `POST /history/import`: import documented prior recommendation dates, idempotently.
- `GET /progress`: persisted six-month summary, cohorts and placement checkpoints; returns a pending state and queues the initial build when needed.
- `POST /progress/refresh`: enqueue a measurement/summary refresh without replacing monthly selections.

List filters include month, priority, category, provider, status and `q`; sorting includes recommended date, website, score and eligibility date. List responses omit large answer evidence arrays; the recommendation detail retains them. Settings use the existing `PATCH /v1/projects/:projectId/settings` version check with a strict `geoBacklinks` object: `enabled`, `target` (1–50), `exclusionDays` (180–3650), `weights`, and optional `excludedDomains`. `enabledAt` is owned by the server and must not be sent in setting updates.

Historical import example (actual dates only):

```json
{
  "items": [
    {
      "domain": "publisher.com",
      "articleUrl": "https://publisher.com/original-article",
      "recommendedAt": "2026-10-15T12:00:00Z",
      "priority": "P3",
      "status": "recommended",
      "notes": "Imported from the documented October outreach plan."
    }
  ]
}
```

The worker also imports legacy database rows only when their type/action explicitly identifies a backlink recommendation and a recorded URL/date exists. Arbitrary tracked articles are not treated as recommendations. Historical imports never fabricate publication dates. Add publication information through the normal lifecycle form if known. The no-repeat guarantee covers recorded/imported history; external recommendations that have never been recorded cannot be excluded automatically.

## Deployment and verification

Deploy the API and scanner bundles plus the client, apply migration 019 using the existing database migration procedure, and deploy the updated `infra/template.yaml` to install `GeoBacklinksReconcile`. Existing queue, database, artifact bucket and worker permissions are reused. No new API keys or paid AI integrations are required. The scanner needs its existing outbound internet access for optional article retrieval. Enable the feature separately on each project after deployment.

The implementation is verified with core, public-retrieval, worker, API, memory/PostgreSQL and frontend tests. PostgreSQL tests apply the actual migrations to isolated PGlite databases. Production databases are not modified by these tests. Use `npm test`, `npm run typecheck`, and `npm run build` for release validation.

Current evidence limits: static public HTML with an identifiable article/main body is supported; JavaScript-only and restricted content remains unknown. Publication URL attribution is limited to observed native citations. Referral conversions and source-attributable traffic remain null because existing traffic records do not provide a trustworthy per-placement conversion join. Daily article observations show their actual verification time; a current retrieval is never represented as pre-publication article evidence. Visibility changes are correlations, not proof that a placement caused them. No outreach, purchases or publishing is automated.
