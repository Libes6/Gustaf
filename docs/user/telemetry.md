# Product usage data and privacy

Gustaf sends no product analytics. It has no built-in analytics endpoint, no crash reporter, and
no connection to T3 Code's services (T3 Connect, its hosted app, or its relay). Your prompts, code,
and files go from your machine to your providers, not to Gustaf.

## What reaches Gustaf Cloud

Gustaf Cloud (`https://api.libes6.ru`, override with `GUSTAF_API_URL`) is contacted only for
features you use:

- **Sign-in.** Signing in to a Gustaf account opens GitHub in your browser. The cloud keeps the
  account profile it returns and the sessions you create.
- **Devices.** A registered computer or phone is listed under **Settings > Account**. Each sends
  a periodic heartbeat with its app version, platform, and OS version, never names, paths, or
  anything you typed.
- **AI usage totals.** A registered computer sends counts per day, provider, and model: turns and
  input and output tokens. No prompts, responses, or file contents leave the machine. Set
  `T3CODE_TELEMETRY_ENABLED=false` in the server's environment to stop them.
- **Relay.** `gustaf relay login` and the relay pairing panel connect your phone to this computer
  through the Gustaf cloud relay.
- **Problem reports.** **Report a problem** sends the message you write, the app version and
  platform, and a bounded tail of the app log, when you press send.
- **Client configuration.** The app fetches announcements, minimum versions, and feature flags
  from the cloud.

## Updates

The desktop app checks for new versions in the
[Gustaf releases on GitHub](https://github.com/Libes6/Gustaf/releases) and downloads them from
there. The model catalog is refreshed from the same repository.

## Optional analytics

An operator who runs their own PostHog can set `T3CODE_POSTHOG_KEY` and `T3CODE_POSTHOG_HOST`
to receive the usage events the server records. Without both, nothing is sent, and agent
feedback reports are saved on the machine but never leave it.

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
