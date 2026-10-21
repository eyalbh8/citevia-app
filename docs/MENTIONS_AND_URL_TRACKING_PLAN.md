# Mentions and URL tracking implementation plan

Status: implemented and locally verified, 21 October 2026. Production rollout is a separate step. The Manage Prompts menu is removed. The original design specification follows the implementation notes below.

## Implemented behavior and operational notes

- Mentions now reads all eligible historical captures in the selected UTC period, with the reference filters, provider donut, first-to-last-observed-day percentage changes, chart, URL markers and paginated answer rows. Original Markdown is rendered safely. Unscanned dates are gaps; a successful scan with no brand mentions contributes a measured zero.
- Citevia currently projects one target-company result per analyzed capture, so its provider mention count equals its distinct mentioned-answer count. Additional brand domains are not multiplied into fictitious result rows. Company-result, native-annotation and answer counts are explicitly separate in URL details.
- Tracking supports registration, search, status/date/provider filters, grouping, sorting, pagination, seven-month trends, detail evidence, and owner-only pause/resume. Publication time defaults to activation time; titles/types come from the URL. No crawler or metadata-fetch request is implied by registration.
- Migration `005_url_tracking.sql` adds four account-scoped tables: canonical captures, grouped native citation evidence, tracked URL registration, and capture/URL matches. Raw annotations remain in each evidence record. The existing `tracked_recommendations` compatibility counters are refreshed transactionally, including when a scan becomes visible. Aggregates are computed from this compact ledger rather than an additional rollup table.
- `saveMeasurement` is the scanner integration point. Project/run/result locking, version checks and unique capture/URL identities make retries and reanalysis idempotent. Active intervals preserve pause/resume history during replay. Only completed/partial runs contribute to public tracking reads and compatibility counters; search candidates are excluded.
- Missing click/crawl telemetry and content-baseline lift are displayed as unavailable. Topics remain omitted. The reference inconsistencies described in section 5 are resolved using consistent eligibility, actual citation dates and one lifecycle rule.
- Pickup parity retains iGEO's integer rounding of the continuous median for the KPI, and its lower-middle median with a nine-day fallback for the lifecycle threshold. These differ for even-sized cohorts.
- `npm run tracking:backfill -- --backend local --project ACCOUNT_ID --from YYYY-MM-DD --to YYYY-MM-DD` rebuilds from saved artifacts one UTC day at a time, without provider calls. Stop the local dev server first. Progress logs contain `nextDate`, `processed`, and `missing`; rerunning a date range is safe. A missing artifact produces a nonzero exit status, so restore it and repeat that range rather than treating it as zero evidence.
- `--backend postgres` uses the existing database environment variables and `EVIDENCE_BUCKET`; run it from an authorized environment that can reach the private database and read the artifact bucket. It does not alter networking. Registration dates and paused intervals still apply during backfill: old answers do not become post-registration citations.
- Checks include the real scan finalizer, PostgreSQL/PGlite and memory repositories, retry/reanalysis replacement, normalized duplicates, cross-account permissions, pause/resume replay, source-versus-citation evidence, and historical backfill. Browser verification uses synthetic data only in an isolated temporary test harness, never app startup or production.

Match iGEO's Mentions layout, answer rows, metric definitions and URL tracking workflow using Citevia's saved evidence. Continue the existing requirement to omit Topics. Preserve Citevia branding and account permissions. Reference numbers must be reproducible with identical input records; another account's totals must never become hardcoded application data.

## Reference baseline

The live iGEO Mentions page was inspected, alongside the local `igeo-app` checkout at HEAD `0c33eafca`. The reference paths below are relative to `/Users/eyalbenhaim/Desktop/igeo/igeo-app`:

- `apps/client/src/page-sections/dashboards/crm-2/page-view/AllMentionsView.tsx`: page composition, shared filters, chart markers, pagination.
- Its `components/LLMMentionsCurrencyCard.tsx`, `ChartSection.tsx`, `ResponseTable.tsx`, `ResponseTableHeader.tsx`, `ResponseTableBody.tsx`, and response utilities: presentation and interactions.
- `apps/server/src/api/services/prompts.service.ts`: `getMentionedPromptResponseIdentifiers`, `getMentionedResponsesCount`, and `getLLMMentionsCountWithProviderTotals`.
- `apps/client/src/page-sections/dashboards/tracking/page-view/` and `trackingTokens.ts`: tracking screen, URL form, columns, filters and detail drawer. Tracking was inspected in source; its live layout still needs the visual comparison in the acceptance phase.
- `apps/server/src/api/services/trackedRecommendations.service.ts`: source-occurrence counters and scan integration.
- `apps/server/src/api/services/content-tracking.service.ts`: tracking list, summary, detail, lifecycle and lift.
- `apps/server/src/utils/tracked-url.utils.ts` and `content-tracking-sql.util.ts`: URL identity rules in JavaScript and SQL.

## 1. Mentions screen

Replace the existing hero, single-scan picker and prompt-status table with the reference structure:

1. Compact Mentions title and shared pill filters: Regions, Tags, Branded, Prompt Types, Providers, date range. Providers support multiple selections. Omit Topics. Carry the same filters into every request and reset pagination when they change.
2. Two cards across the top, approximately 25%/75% at desktop widths. The left card is **LLM Mentions**, with a provider donut, total in its center, provider icons and hover counts/percentage changes. The right card is **Mentions Over Time**, with provider colors, filled curves, legend, date tooltips and expand control. Match the rounded white cards, pale headers, thin warm borders, spacing and typography of the reference; use Citevia's logo where branding appears.
3. An answer table below, with its own scrolling area and columns in this exact order: **Response, Model, Rank, Brands, Citations, Sentiment, Date**. An optional Raw column is restricted to system administrators, as in iGEO. Default to 25 rows; offer 25, 50 and 100. Sort Model, Rank, Citations, Sentiment and Date across the full result set, with a stable response-ID tie breaker.
4. Show a three-line formatted answer preview, provider name/icon, stored brand rank, brand/domain icons with a popover, citation count, sentiment pill and compact date. Reuse Citevia's safe Markdown renderer for previews and full answers. Clicking a row opens that specific historical answer, including its prompt snapshot, provider/model, capture date, brands and original sources.
5. Include tracked-URL markers beneath the time chart. Group same-day items into a count marker and list their titles, URLs and appearances in the hover panel. Link a tracked URL to its detail view and the actual matching answers. Do not show content-publication markers until real published-content records exist.

Keep manual scan execution available through the existing scan workflow. A failed scan remains visible in scan diagnostics and prompt history; it does not become a zero-valued successful mention row.

### Mentions data contract

- Query all eligible saved responses in the selected period, across selected providers, rather than only the latest run. Use successful responses from completed or partially completed scans. A mention row requires the target brand to appear, visibility 100, and rank at least 1, matching iGEO's table predicate.
- Preserve separate original captures. Reanalysis of the same capture updates its derived measurement; it must not create a second answer row. Keep prompt text/version/region/branded/intent/tags from the scan snapshot so later edits do not rewrite historical filters.
- iGEO's provider totals count matching company-domain `results` rows. Its answer table selects the latest qualifying response for each prompt/scan/provider/day. Preserve both concepts explicitly in the API; do not assume a company-row count is always identical to a response-row count when a brand has multiple domains.
- Donut total is the sum of provider mention counts; provider share is `count / total × 100`, rounded to two decimals, with a zero-total guard.
- iGEO's donut change uses the **first and last observed day counts inside the selected range**: `(last − first) / first × 100`, rounded to two decimals. It is not the previous-period comparison used by Citevia's Prompts page. A single observed day gives 0%. Return a finite value plus an explicit missing/zero-baseline state rather than serializing JavaScript Infinity.
- Daily chart points are mention counts, not visibility percentages. Use hourly buckets for the 24-hour/single-day mode. Provider colors and labels follow the reference; show only providers supported and enabled for the account. Missing measurement and confirmed zero remain distinct in API metadata.
- Rank, brands, citations and sentiment come from saved analysis/native citations. The reference Citations cell uses `sourcesCount ?? sources.length ?? 0`; do not substitute a count of brand domains. The Brands cell prefers extracted companies with site URLs, sorted by rank, with response sources as its fallback. Dates use abbreviated month and numeric day. Preserve numeric sentiment and show a dash when absent. The actual Mentions color helper uses green at 70+, light green at 30–69, gray from −30 to below 30, and red below −30; this differs from its tooltip's 0–100 bands and the Prompts helper. Freeze these exact display rules in compatibility fixtures and record any deliberate correction separately.
- Make the effective start/end, bucket timezone and comparison basis explicit in responses. Use shared UTC boundaries for all components. Preserve explicit custom dates; include all selected calendar days, avoiding separate client/server date calculations.

## 2. URL tracking screen and interactions

Add a Tracking destination using iGEO's tracking composition. It complements Mentions, which remains an answer-level view.

- **Track results** opens the reference's single URL form with HTTP/HTTPS validation and **Activate tracking**. A successful server save is required before showing “Tracking activated.” Accept website pages, articles and public social-post URLs. Infer title/content type from the URL when metadata is unavailable. No Topic field is required.
- Four KPI cards: **Tracked URLs**, **Citations in AI answers**, **Cited at least once**, **Median time to pickup**. Show the tracked-count increase this month, cited numerator/denominator and pickup days. Keep unavailable deltas as unavailable.
- Trend card with Citations, Mentions and AI clicks tabs and publication-volume bars. Match iGEO's seven-month presentation. Citevia can populate scan-derived citations and brand mentions; clicks require their own event source.
- Search, All / Cited / Not cited / At risk tabs; sort by Most cited / Lift / Newest / Fastest pickup / A–Z; group by Status / Month / None. Default to newest, status grouping, 25 rows; offer 25/50/100.
- Exact table order: **Content, Type, Status, Citations, Lift, Engines, Pickup**. Each content cell contains the title, URL/path and publication date. Type is Blog, Website content or Social post. Status labels are Published, Crawled, Cited, No pickup and Lost.
- The detail drawer contains the publication/crawl/first-citation timeline, citation trend, engine share, matching prompts, average position, sentiment and links to answer evidence. Reuse the answer drawer rather than rendering a latest-answer shortcut.

### Tracking count definitions

Store the measures independently because iGEO uses different ones in different views:

- **Lifetime appearances:** matching source occurrences after tracking starts. iGEO increments this from every matching entry in `company_sources UNION ALL url_sources`, including repeated URLs and entries in separate company-result rows. The main list and citation KPI currently display this stored counter. Preserve that compatibility counter and its evidence lineage.
- **Matching results:** distinct projected result records that cite the URL. This is the reference's detail/period aggregation basis. Repeating a URL in one result does not increase this measure.
- **Matching answers:** distinct original response captures citing the URL. Keep this separately so a user can inspect how many answers contained the URL without multiplying it by the number of extracted companies.
- **Prompt coverage:** distinct prompt IDs associated with matching captures. **Engine share:** provider matching-result count divided by all provider matching-result counts, following the reference detail view.
- **First/last cited:** earliest/latest evidence timestamp, not the time the backfill ran. **Pickup:** nonnegative rounded days from published date (or tracking creation date) to first citation. Preserve a separate tracking-start timestamp.
- Tracking list/date filtering currently selects URLs by publication date, and its displayed citations are lifetime counts. The detail chart is restricted to evidence in the selected date range. Include this distinction in tooltips and API field names.
- Cited-at-least-once rate is the number of selected URLs with citation evidence divided by selected tracked URLs, rounded to a whole percent; an empty set yields 0. Median pickup uses stored pickup times for URLs first cited in range.
- Lifecycle precedence: current citations → Cited; previously cited but no current citations → Lost; never cited beyond the pickup threshold → No pickup; independently observed crawl → Crawled; otherwise Published. The reference recomputation uses a 30-day current/previous window and threshold `max(14 days, 2 × account median pickup)`, with a nine-day fallback median.
- Reference lift compares brand mentions in the associated topic for 30 days before/after publication. Since Topics are excluded here, leave Lift unavailable for unlinked content. A future prompt-linked lift can use the same formula with an explicitly labeled prompt scope; it must not be presented as topic-level parity. Formula: rounded `(after − before) / before × 100`; the reference uses 100 when before is zero and after positive, otherwise 0 for two zeros.

## 3. URL identity and evidence

Add a dedicated tracking identity function. Do not replace Citevia's existing general `normalizeUrl`, which retains scheme and follows different normalization rules.

The iGEO-compatible tracking key lowercases the hostname, removes scheme, port and fragment, removes tracking query keys case-insensitively, and sorts remaining query entries. Drop `utm` and `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `igshid`, `igsh` and `si`. Preserve path case, `www`, trailing slash and content-identifying query values such as YouTube `v` and Facebook `story_fbid`/`id`. Store the original URL for display/evidence. JavaScript and SQL must pass identical identity fixtures, including Unicode and encoded paths.

Only native citation evidence and its persisted company-source associations feed the citation counters. Search-result candidates and plain text mentions of a domain are not citations. If body hyperlinks are collected separately, store their evidence kind and do not mix them into the reference-compatible totals. Preserve repeated citation entries even when the UI displays a deduplicated source list.

Do not infer a crawl or click from an answer citation. Add account-scoped crawl/referral event ingestion separately if full telemetry parity is required. Until such events exist, those fields are unavailable rather than synthetic zeros. Saving a URL must not require fetching its contents; any later metadata fetch needs the existing safe outbound-fetch restrictions.

## 4. Server and database work

Reuse the existing `tracked_recommendations` and `tracked_recommendation_links` tables for registration, metadata and reference counters. Add a migration rather than changing the baseline `001_igeo.sql`.

Proposed normalized records:

1. `citevia_tracked_urls`: one URL identity per account, linked to the tracking parent; original URL, normalized key/version, tracking start, publication date, optional prompt link, active state, title/type and computed-state revision. Unique `(account_id, normalized_url)` prevents duplicate registrations with tracking parameters.
2. `citevia_response_citations`: original capture identity, account/run/prompt/provider, evidence timestamp, normalized URL, original URL, source kind/ordinal, block/offset and optional projected-company-result ID. A stable evidence key preserves genuine repeated sources while making reprocessing idempotent.
3. `citevia_tracked_url_matches`: tracked URL plus evidence record, linked to the original capture and projected result. Enforce unique match identity and account-scoped foreign keys. This is the audit trail for every appearance.
4. `citevia_tracked_url_scan_totals`: per tracked URL/run/provider/revision totals for occurrences, distinct results and distinct captures, plus first/last cited. Derived daily/monthly summaries support charts without repeatedly unnesting all historical arrays.

Keep raw answers and provider payloads unchanged in the existing DB/artifact store. Reuse `saveMeasurement` and its current result-version checks to persist evidence and matches in the same transaction as the corresponding projection. Insert/update source rows and replace that result's contribution; never blindly increment a lifetime counter on every finalize call. Sum committed per-scan contributions to update cached counters. A repeated queue message, concurrent finalizer, retry or reanalysis must produce the same total.

The scanner already calls `saveMeasurement` before `finalizeRun`. Extend this path and make aggregation repairable if summary generation fails. Reanalysis must reuse capture identity; a genuinely new collected answer receives a new capture identity. Active tracking controls future matching; archived prompts retain their existing citation evidence.

Implemented account-scoped API routes under `/projects/:projectId`:

- `GET /mentions`: filtered paginated answer rows and total; server-side sort.
- `GET /mentions/summary`: provider totals, shares, change basis, effective period, historical points and URL markers.
- `GET /tracked-urls`, `POST /tracked-urls`, `PATCH /tracked-urls/:id`: list, idempotent registration and metadata/active-state changes.
- `GET /tracked-urls/summary`, `GET /tracked-urls/:id`, `GET /tracked-urls/:id/answers`: KPIs, detail and paginated evidence.
- Continue using the existing response-detail route for original answers. Enforce project membership for every read and owner permission for mutations; validate linked prompt IDs within the same account.

Index account/date/provider and account/normalized-URL lookups, with capture/result IDs for deduplication. Extend both Postgres/PGlite and MemoryRepository implementations and their contracts. Avoid loading full answer bodies for charts or list counts. Cache keys must include account, all filters, effective period and data revision.

## 5. Reference inconsistencies to resolve explicitly

The inspected iGEO implementation has behavior that prevents literal equality between all its own views:

- Its Mentions historical query does not restrict scan IDs the way the provider-total query does; date-window calculations and the chart's latest-data anchoring also differ.
- Tracking list counters are lifetime source occurrences; detail counts are matched results in a selected period. Repeated sources/company projections can therefore produce different numbers legitimately.
- Its tracking summary attributes lifetime citations to the month of first citation/publication; this is not the actual month-by-month evidence history. The summary also leaves citation percentage change null.
- The tracking list derives lifecycle with a fixed 14-day threshold and lifetime citations, while recomputation uses a dynamic threshold and recent-period citations. The At risk query uses another last-cited rule. Some supported provider filters are not applied to list/summary counters.

For exact compatibility, preserve the named lifetime/period measures and reference formulas, and document their scope. Proposed correctness improvements are a shared Mentions scan/date predicate, actual dated evidence for citation trends, one lifecycle rule across lists/filters/details, and consistent filter application. These are deliberate differences from the current reference, not claims of existing iGEO behavior. Review their fixtures before implementation; keep the visual design unchanged.

## 6. Delivery and acceptance

1. **Freeze parity fixtures:** record iGEO layouts and formatting using identical viewport, provider selection and explicit date boundaries; port reference metric/URL helpers into isolated fixtures. Cover regular data and the inconsistencies above. Confirm the no-Topics adaptation and unavailable lift/telemetry states.
2. **Persist evidence:** add migrations, normalized URL identity, repository methods and transactional scanner matching. Create read-only reconciliation queries and a resumable backfill from existing saved answers/results. Do not run fresh paid scans to reconstruct evidence that is already stored.
3. **Build server reads:** Mentions list/summary and tracking list/summary/detail/evidence endpoints, with consistent filters, authorization, stable pagination and correct empty/error states.
4. **Build the two screens:** replace Mentions, add Tracking, share answer rendering and connect URL markers to evidence. Keep runtime values entirely server-backed.
5. **Verify and release:** validate a staging account, then apply the additive migration, deploy writers/readers, backfill in batches with checkpoints, reconcile totals and enable the screens. Track parser/normalization versions so a future rule change can rebuild derived data without changing originals.

Required checks:

- Numerical parity fixtures for provider totals/shares, first-to-last percentage changes, rank, citation counts, sentiment display, lifetime appearances and pickup.
- The same URL twice in one answer, in both source arrays, on two company rows, on two providers and in separate runs: assert all three count measures independently.
- Normalization collisions and non-collisions, content query IDs, source candidates versus citations, missing evidence, zero baseline and a single observed day.
- Retry/reanalysis/concurrent-finalizer and interrupted-backfill tests: no counter inflation; every counted record links to evidence.
- Account isolation, owner/viewer permissions, archived prompts/URLs, old prompt versions, partial scans, date boundaries/timezones and filter combinations.
- PostgreSQL/PGlite migration and query tests, realistic history pagination and query plans; no per-URL full-history scans or silent export limits.
- Desktop/mobile visual comparison to iGEO, keyboard operation, answer formatting, chart tooltips, sorting and pagination. Reconcile each KPI to its defined evidence measure, rather than requiring lifetime and period totals to agree.

Apply migration 005 before enabling the updated API/client. The implementation does not import another account's data or hardcode the reference account's numbers. Production migration, deployment and real-account reconciliation remain release operations.
