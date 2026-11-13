# Managed policy

A managed policy lets an administrator configure Gustaf for every user on a machine. It sets
defaults and locks for settings, and limits such as the broadest permission mode or which
providers may run. The Gustaf server on the machine enforces it for every app that connects:
the desktop app, a browser, or the mobile app.

## Roll out a policy

1. Write the policy as JSON, starting from the [example](#write-a-policy).
2. Run `gustaf policy check policy.json`. It prints what the policy will do, or what is wrong with it.
3. Deploy the policy to each machine with your device management tool, in
   [one of the supported places](#where-the-policy-goes).
4. Restart Gustaf on the machine. The server reads the policy only when it starts.
5. Run `gustaf policy show` on the machine to
   [check what the server loaded](#check-what-the-server-loaded).

See [The `gustaf` command](./install.md#the-gustaf-command).

## Write a policy

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://it.example.com/t3",
  "settings": {
    "defaultRuntimeMode": { "value": "approval-required", "locked": false },
    "enableAgentBrowserAccess": { "value": false, "locked": true }
  },
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["desktop", "local-browser"],
    "telemetry": false
  }
}
```

`schemaVersion` and `organization` are required. Users see the organization's name in Settings
and beside each control the policy locks, with a link to `supportUrl` if you set one. [`settings`](#settings)
sets defaults and locks, and [`limits`](#limits) restricts what Gustaf may do.

Every user on the machine can read the policy, so do not put credentials in it.

## Where the policy goes

Use one of these per machine:

| OS      | Native policy                                                                                        | Policy file                                       |
| ------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| macOS   | Configuration profile for `com.t3tools.t3code`                                                       | `/Library/Application Support/T3Code/policy.json` |
| Windows | Group Policy template, or a `Policy` JSON value (both under `HKLM\SOFTWARE\Policies\T3Tools\T3Code`) | `C:\Program Files\T3Code\policy.json`             |
| Linux   |                                                                                                      | `/etc/t3code/policy.json`                         |

Gustaf does not merge sources. If a machine has both a native policy and a policy file, Gustaf
refuses to start until you remove one.

**Policy file.** Copy the JSON to the path for the OS. Make it and its folder writable only by
administrators.

**macOS configuration profile.** Add a custom settings payload for the preference domain
`com.t3tools.t3code`. The payload's keys are the policy's top-level keys (`schemaVersion`,
`organization`, `supportUrl`, `settings`, `limits`); JSON objects become dictionaries and lists
become arrays. To make the payload from a policy file you checked, run
`plutil -convert xml1 -o com.t3tools.t3code.plist policy.json` and upload the result, or run
`gustaf policy templates <directory> --policy policy.json` to write a complete
`macos/t3code.mobileconfig`. Install it as
a device profile, since Gustaf ignores user profiles, and deploy only one profile for this domain.
A profile cannot hold `null`, so use a policy file if a setting's value must be `null`.

**Windows Group Policy.** Run `gustaf policy templates <directory>` and copy
`windows/t3code.admx` and `windows/en-US/t3code.adml` into your `PolicyDefinitions` folder or
central store, or import them into Intune. The policies appear under Computer Configuration >
Administrative Templates > Gustaf. Set **Organization** whenever you set any other Gustaf policy.
Locks and provider fields go in the two JSON policies, as the same objects a policy file would hold.
Machines pick up a change at the next Group Policy refresh; run `gpupdate /target:computer /force`
to apply it now, then restart Gustaf.
Setting webhook tasks, browser cookie import, or usage data to **Disabled** turns that feature
off. The connect policy is the hosted connect client, which Gustaf does not include. Setting any other Gustaf policy to
**Disabled** restricts nothing, the same as **Not Configured**.

**Windows registry value.** Instead of the template, set the `Policy` value (`REG_SZ`) to the whole policy as one line of JSON,
from Group Policy Preferences or an Intune script. Gustaf reads it through the Windows registry
API, so it works where registry tools such as `reg.exe` are blocked for users. Use one or the other:
Gustaf refuses to start when the key holds both a `Policy` value and the template's settings. In
PowerShell, as an administrator:

```powershell
$json = (Get-Content -Raw -Encoding UTF8 policy.json) -replace '\r?\n\s*', ''
New-Item -Path HKLM:\SOFTWARE\Policies\T3Tools\T3Code -Force | Out-Null
Set-ItemProperty -Path HKLM:\SOFTWARE\Policies\T3Tools\T3Code -Name Policy -Value $json -Type String
```

## Check what the server loaded

Run `gustaf policy show` as the user who runs Gustaf. It prints the installed policy and its
fingerprint, then says whether the running server loaded that policy or an older one. The server
reads the policy only when it starts, so "Restart Gustaf to apply the installed policy" means it
still enforces the old one. In Settings, users see that your organization manages the environment,
and each locked control shows **Managed by**.

## Change or remove a policy

After you deploy, change, or remove a policy, restart the Gustaf server on the machine: quit and
reopen the desktop app, or run `gustaf service restart` for the
[background service](./background-service.md). Reconnecting a phone or browser does not reload the
policy.

To remove a policy, delete the file, remove the profile, set the Group Policy settings to
**Not Configured**, or delete the registry value, then restart
the server. Users get back the settings they had chosen, since Gustaf never writes policy values
into them.

## When Gustaf refuses to start

Gustaf refuses to start rather than run with a policy it cannot fully enforce. That includes a
policy it cannot read or parse, a setting it does not know, a value of the wrong type, a key this
version does not support, or a machine with both a native policy and a file. The error names where
the policy came from and what is wrong.

`gustaf policy check` catches the same problems in a JSON file. For a profile or registry value, check
the JSON before you convert it. For the Group Policy template, check a complete policy file that
holds the same settings, then paste its `settings` and `limits.providers.instances` objects into the
two JSON policies. A policy written for a newer version can use keys an older one
cannot enforce, so upgrade Gustaf before you deploy a policy that uses them.

## Settings

Each key under `settings` is a setting's path in the server's `settings.json`, such as
`storageCleanup.logsAfterDays`. To find a path, change the setting in Gustaf and look in
`settings.json` under `~/.t3/userdata`.

- `"locked": false` sets a default. It applies wherever the user has not chosen a value of their
  own, and users can change it.
- `"locked": true` sets the value. Users and agents cannot change it, in Settings or in a project's
  settings, and Settings shows the control as managed by your organization. Removing the policy
  brings back the user's own value.

A few settings need care:

- A default cannot add an entry, such as a provider instance, because users could never remove it.
  Lock the entry instead, or set provider fields with [`providers.instances`](#providers).
- A setting that can be empty, such as `defaultModelSelection`, is managed as a whole. You cannot
  manage one field inside it.
- `defaultRuntimeMode` cannot be broader than [`maxRuntimeMode`](#permission-modes).
- `worktreeCleanup`, which projects can also set, overrides the `worktree` rules in
  `storageCleanup`. Lock it along with those rules; Gustaf refuses a policy that locks only the
  rules.
- `observability` cannot be managed. Its OTLP endpoints come from each user's environment
  variables, settings file and desktop startup input, which a policy cannot override.
- Manage `idleCompaction`, not the older `compactIdleThreads`. A Claude instance's own idle
  compaction choice still wins over `idleCompaction`.
- A provider instance's fields override each other, so lock `providerInstances.<id>` as a whole,
  or pin single fields with [`providers.instances`](#providers). Gustaf refuses a lock on one
  field inside an instance. A whole-instance lock covers only that instance; to cover every
  instance of a provider, use `providers.instances`.

## Limits

`limits` restricts what Gustaf may do. Leave a key out to keep Gustaf's normal behavior.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["desktop"],
    "connect": false,
    "webhookTasks": false,
    "browserCookieImport": false,
    "telemetry": false,
    "providers": {
      "allowedDrivers": ["claudeAgent", "codex"],
      "instances": {
        "claudeAgent": {
          "locked": true,
          "environment": [{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" }]
        }
      }
    },
    "updates": { "mode": "auto", "feedUrl": "https://updates.example.com/gustaf/" }
  }
}
```

### Permission modes

`maxRuntimeMode` is the broadest [permission mode](./permission-modes.md) any thread may use:
`approval-required` (Supervised), `auto-accept-edits`, `auto`, or `full-access`. It covers threads
that users start, agents start, and scheduled tasks start. A thread already above the limit cannot
run another turn until someone lowers its mode; its queued messages send once that happens. New
threads start at the limit when the user's default is above it.

With `maxRuntimeMode` set, you own each provider's launch settings: binary path, launch arguments,
config home, and the environment variables set on each provider. They come from
[`providers.instances`](#providers) or Gustaf's defaults, and users cannot change them, because a
wrapper script, a launch flag, or a variable such as `NODE_OPTIONS` could otherwise turn off the
provider's approvals. Pin the variables your users need, such as a gateway URL, in
`providers.instances`.

Variables in the environment that starts Gustaf itself still reach providers, and a default
binary path such as `claude` is looked up on that environment's `PATH`. The desktop app builds that
environment from settings the user controls, such as their shell profile, so a user could put their
own `claude` earlier on their `PATH`. Pin an absolute `binaryPath` in `providers.instances` for each
provider you allow.

ACP agents' own mode menus have no effect under `maxRuntimeMode`, except Antigravity's, whose modes
Gustaf can place under the limit. Users still choose which ACP Registry agent runs; leave
`acpRegistry` out of `allowedDrivers` to stop that.

The limit decides which modes Gustaf asks the provider for. It is not a sandbox; see
[What a policy does not cover](#what-a-policy-does-not-cover).

### Clients

`clients` lists how the server may run:

- `desktop`: as the desktop app's own server.
- `local-browser`: as a server only browsers on this machine reach, such as `gustaf serve`.
- `remote`: reachable from phones and other computers on a network you allow.

`remote` is the line that matters. A server reachable from the network also accepts browsers on
this machine, and the two local kinds differ only in how Gustaf was started. On machines with the
desktop app, keep `desktop` in the list, or the app cannot start.

Without `remote`, the server listens only on a loopback address, creates no pairing links, and
signs out devices that paired earlier. It does not start with a host other than a loopback
address or `localhost`. A [background service](./background-service.md) installed before
`T3CODE_LAN` existed keeps private-network access, so without `remote` it refuses to start.
Run `gustaf up --no-lan` when its `service.env` sets no `T3CODE_HOST`, or set
`T3CODE_HOST=127.0.0.1` in `service.env`, then run `gustaf service restart`. The desktop app starts
with network access and Tailscale Serve off, whatever the user chose. Set `"connect": false`
to keep the hosted connect client off. Gustaf does not use that client. The relay, LAN, and
Tailscale stay available when `remote` is allowed.

When it starts, the server also turns off each Tailscale Serve route, HTTPS or TCP, that forwards
to it, such as one `gustaf pair --tailscale` set up, and leaves other routes alone. It does not start
while such a route stays on, or while Tailscale's answer cannot be read; the error names the
command that turns the route off. A route whose target is a name, such as `localhost` or another
machine on the same port, also stops it, since a name can resolve to this server; change the route
or Gustaf's port. If Tailscale is installed but does not answer, as on a Mac where it was never set up, the
server does not start until Tailscale is set up or removed. It does start when Tailscale is not
installed, not running, or
logged out, since nothing forwards then; a route Tailscale kept returns when Tailscale runs again,
so restart Gustaf after that.

### Other capabilities

- `webhookTasks: false`: scheduled tasks cannot use webhook triggers. Existing webhook tasks stay
  but do not run, and cannot be turned back on. Users can still edit or delete them.
- `browserCookieImport: false`: users cannot import cookies from another browser into Gustaf's
  browser.
- `telemetry: false`: the server and desktop app send no [product usage data](./telemetry.md) or
  relay connection traces. A policy cannot turn them on. A browser that opens the server
  still sends its own relay traces when that build has them configured.

### Providers

`providers.allowedDrivers` lists the providers that may run, by ID: `codex` (Codex),
`claudeAgent` (Claude), `cursor` (Cursor), `grok` (Grok), `opencode` (OpenCode), `antigravity`
(Antigravity), `fx` (fx), `kiro` (Kiro), `pi` (Pi), `muse` (Muse Code), and `acpRegistry` (ACP
Registry).
`gustaf policy check` rejects an ID this version does not know. Threads on other providers stay,
marked unavailable, and users can still turn those providers off.

`providers.instances` sets fields on every instance of a provider, such as an environment variable
that routes Claude through Amazon Bedrock or a base URL for a company gateway. `binaryPath` and
`launchArgs` work only for providers that have those settings. With `"locked": true`, users cannot
change the fields you set. With `"locked": false`, the fields fill in only what the user left
empty. A `codex` entry that is locked, or any `codex` entry under `maxRuntimeMode`, also rules out
[Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), since that runtime would skip
your fields. In the same way, an `opencode` entry like that rules out a server URL, so OpenCode
starts the binary you set.

### Updates

- `mode`: `auto` keeps the normal update flow. `off` stops Gustaf from checking for updates, for
  machines that get Gustaf through device management.
- `feedUrl`: the desktop app and `gustaf update` use this mirror instead of GitHub Releases.
  Publish the same files a Gustaf GitHub Release contains, including `latest.json`.
- `allowNightly: false`: the nightly channel is unavailable.

## What a policy does not cover

The policy controls what Gustaf does. Agents run through each provider's own CLI, which reads its
own configuration, such as `~/.claude`, and which a user can also run outside Gustaf. To restrict
those CLIs, use their own managed configuration, such as Claude Code's managed settings.

On a managed Windows machine, the desktop app does not run a WSL environment. A Gustaf server a
user starts inside WSL reads `/etc/t3code/policy.json` in that distro, not the Windows policy.
Deploy the policy file there too if your users run Gustaf in WSL.

Without `remote`, Gustaf does not expose the server, but a user can still forward its local port
with other tools.

A user with administrator rights on the machine can edit or remove the policy. Gustaf enforces
the policy in its own processes, which run as the user, so it stops users from changing managed
settings in Gustaf but does not stop a user who modifies or replaces Gustaf itself. A version
from before managed policy ignores it too. To control which builds can run, use your device
management tool's application controls.
