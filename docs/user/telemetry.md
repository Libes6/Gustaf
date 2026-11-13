# Product usage data

The Gustaf server can send product usage events, associated with a hashed account or installation
identifier. To count how many installations one person uses, the server also sends hashed account
identifiers: a signed-in account when one is linked, your OpenAI and Claude accounts when you are
signed in, and a random identifier for each device that connects. Events include the provider, model, reasoning effort,
permission mode, turn and request results, duration, release channel, and token counts when
available. Child-agent token counts are reported separately from the main agent's. Model names
are sent only when they appear in a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Gustaf AI usage

When this computer is registered to your Gustaf account (**Settings → Account**), it reports how
you use AI providers to that account: per day, the provider, the model when it appears in a
provider's public model list, the number of turns, and input and output token counts when the
provider reports them. Gustaf administrators can see these totals per account. Reports never include
prompts, responses, code, tool calls, file paths, keys, or error messages.

Only turns that finish while the computer is registered are counted; earlier history is never
uploaded. `T3CODE_TELEMETRY_ENABLED=false` and the managed policy's telemetry switch also stop
these reports.

## Relay connection diagnostics

Gustaf can send relay connection traces to diagnose connectivity. These are
separate from product events. Depending on the client version, traces can include connection
timings, environment identifiers and the connected machine's name. Failed spans can include error
messages and stack traces; error text can quote a value the app was handling.

To disable product events and relay tracing from the server, set
`T3CODE_TELEMETRY_ENABLED=false` in its environment before starting it. Relay tracing also stops
when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` turns OpenTelemetry export off.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
separate browser or mobile clients.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

The web app in a browser, including one the `gustaf` CLI opens, does not read these environment
variables. When its build has relay tracing configured, it sends its own connection traces even
if the server has opted out. The browser app has no relay tracing toggle.

## Mobile app diagnostics

When the Android app crashes or hits an error, it can send a report: the error
message, the stack trace, the app version, and the device model and OS version. Each launch can also
send startup timings, and every report carries a random ID for the install. Reports do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About > Diagnostics**.

The mobile app also sends relay connection traces when its build has tracing configured. These
carry an identifier for the current app session. **Send crash reports** does not control these
traces, and the mobile app has no separate relay tracing toggle. Server environment variables and
managed policy do not disable mobile tracing.

## Agent activity for mobile notifications

Background mobile notifications are not available in Gustaf. See
[Mobile notifications](./mobile-notifications.md). **Publish agent activity** under
**Settings > Sharing & access** belongs to that unavailable path. The telemetry opt-out does not
change it.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
