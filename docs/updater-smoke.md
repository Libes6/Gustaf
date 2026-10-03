# Local macOS update test

This builds release-mode, ad-hoc-signed macOS apps for the current machine's architecture. Both use the existing application identifier and data directories. A separate app copy can therefore test data preservation while the ordinary app remains available. Close every other Gustaf instance before opening the test copy.

```sh
python3 scripts/updater-smoke.py build
python3 scripts/updater-smoke.py serve
```

Credentials are read from `~/.tauri/gustaf.key`, `gustaf.key.pub`, and `gustaf.key.password`. The password is passed only to the build subprocess. Output is ignored under `updater-smoke.local/`. The public manifest and payload are served only on `127.0.0.1:47831`; other paths return 404. No tag, release, or remote feed is created.

HTTP loopback is enabled only when both `GUSTAF_LOCAL_UPDATER_TEST=1` was present at compilation and `dangerousInsecureTransportProtocol=true` is in the embedded test config. Ordinary release builds still require HTTPS. The local test retains native signature verification. The script copies tracked source into an isolated snapshot under the output directory and applies the loopback guard there. Tauri config overrides the test versions. The working checkout and its release version remain unchanged.

1. Keep the local server running. Close the ordinary Gustaf app.
2. Open `updater-smoke.local/0.1.0/Gustaf.app` directly in its writable folder. Alternatively, unzip `Gustaf-0.1.0-local-test.zip` into a writable directory. Do not run from inside a ZIP or a mounted DMG.
3. Confirm installed version `0.1.0` in Settings → General. Record existing settings, projects and history; optionally create a small test chat.
4. The update icon immediately above the account icon should offer `0.1.1`. Click it to download, verify the signature, install and restart. When testing failure modes first, use the separate download action in Settings instead.
5. If generation is active, first decline the interruption prompt and confirm that the app and data remain available. Then retry with explicit interruption consent.
6. After relaunch, verify `0.1.1`, settings, projects and history. Check again: it should report the current version.
7. Quit the test copy and reopen the ordinary app when done. These test builds keep the local feed and are not production distribution builds.

For failure checks **before installing 0.1.1**, change the server's mode in a second terminal and check again in the app:

```sh
python3 scripts/updater-smoke.py bad-signature   # Download must fail; install stays unavailable.
python3 scripts/updater-smoke.py broken-download # Download fails with a retryable error.
python3 scripts/updater-smoke.py offline         # Feed returns 503; no false “up to date”.
python3 scripts/updater-smoke.py current         # No newer version for 0.1.0.
python3 scripts/updater-smoke.py update          # Restore normal signed 0.1.1 offer.
```

Stop the server with Ctrl+C to test a refused connection. Restart it and retry. HTTP and build/signature checks do not establish an actual installed-app upgrade: the UI installation/relaunch and data-preservation steps above must still be performed on the device.
