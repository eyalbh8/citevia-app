# Database cutover maintenance guard

`CITEVIA_MAINTENANCE_MODE=true` freezes database writer entry points in both
production Lambda handlers. The default is false. Read the flag on every invocation;
cached application and scanner instances also obey it.

The API returns HTTP 503 for every path, including health, public traffic, MCP,
authentication and ordinary reads. It returns `Retry-After: 60`, `Cache-Control:
no-store` and a JSON body with `maintenance: true` and error code
`MAINTENANCE_MODE`. The configured frontend origin receives an explicit CORS
allow-origin header and can read Retry-After. Other origins are not reflected.
The maintenance branch constructs no cloud runtime or identity provider.

For SQS, the scanner returns every received message ID in `batchItemFailures`.
It never acknowledges queued work during the freeze and never parses message
bodies or constructs runtime/providers. Direct scheduled or IAM invocations return
`{"maintenance":true}`. This includes reconciliation, kickoff, portfolio refresh,
reanalysis, admin bootstrap and `database:migrate`; there is no migration bypass
that could write to the frozen source database.

## Final dump and cutover sequence

1. Disable the SQS event source mapping and pause job schedules before the freeze.
   Record their original states so only previously enabled sources are resumed.
2. Enable maintenance on both API and scanner Lambda configurations. Wait until
   both updates have completed and verify API health returns 503 and direct scanner
   reconciliation returns `maintenance: true`.
3. Let already-running invocations finish before taking the final dump. Existing
   executions retain their old environment; the flag cannot interrupt them. Allow
   for the scanner's 300-second timeout and the API's 29-second timeout after both
   function updates, and verify no old executions or database writers remain.
4. Perform the verified final dump/restore and switch the database connection while
   maintenance remains enabled. Use an isolated operator connection for target
   restore or migrations; the source Lambda migration entry point stays blocked.
5. Verify target data and application compatibility, disable maintenance on the
   target-connected functions, then resume the recorded schedules and SQS mapping.
   Confirm health, authenticated access and queue processing before retiring the
   source. If rolling back, freeze and drain target writers first so new writes
   are not silently split across databases.

Returning failed SQS items preserves messages but does not pause SQS delivery.
The current queue visibility timeout is 1,800 seconds and its redrive policy is
five receives. Repeated maintenance deliveries can consume those receives and
eventually move existing work to the DLQ. Disable the event source mapping for
the planned cutover instead of relying on handler failures for a prolonged pause.
Inspect both queues before resuming; do not purge them or acknowledge jobs manually.

This guard does not stop independent SQL clients or other services. Close or pause
those writers as part of the final source consistency check. It also does not pause
database maintenance initiated directly through an operator SQL connection.

[AWS SQS partial-batch retry behavior](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)
and [queue visibility/redrive guidance](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
describe why queued messages must remain failed while handler maintenance is active.
