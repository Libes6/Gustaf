#!/usr/bin/env python3
"""Build a signed macOS updater pair and serve it exclusively on loopback."""
import argparse
import base64
import datetime
import hashlib
import http.server
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "updater-smoke.local"
PORT = 47831
PAYLOAD = "Gustaf-0.1.1.app.tar.gz"


def build():
    if sys.platform != "darwin":
        raise SystemExit("This local test builds macOS apps only.")
    OUT.mkdir(exist_ok=True)
    keys = Path.home() / ".tauri"
    env = dict(os.environ, GUSTAF_LOCAL_UPDATER_TEST="1",
               TAURI_SIGNING_PRIVATE_KEY=str(keys / "gustaf.key"),
               TAURI_SIGNING_PRIVATE_KEY_PASSWORD=(keys / "gustaf.key.password").read_text().strip())
    for name in ("APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"):
        env.pop(name, None)
    key = (keys / "gustaf.key.pub").read_text().strip()
    # Build an isolated source snapshot: never edit the user's checkout.
    source = OUT / "source"
    if source.exists():
        shutil.rmtree(source)
    source.mkdir()
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).split(b"\0")
    for name in tracked:
        if not name:
            continue
        relative = Path(os.fsdecode(name))
        origin = ROOT / relative
        destination = source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if origin.is_file():
            shutil.copy2(origin, destination)
    for relative in ("node_modules", "apps/desktop/node_modules", "apps/desktop/sidecar/node_modules"):
        origin = ROOT / relative
        if origin.exists():
            destination = source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(origin, target_is_directory=True)
    updater = source / "apps/desktop/src-tauri/src/updater.rs"
    original = updater.read_text()
    guard = 'url.starts_with("https://") && url.len() > 8'
    local_guard = '''(url.starts_with("https://") && url.len() > 8) || (
        option_env!("GUSTAF_LOCAL_UPDATER_TEST") == Some("1") &&
        config.get("dangerousInsecureTransportProtocol").and_then(|v| v.as_bool()) == Some(true) &&
        reqwest::Url::parse(url).ok().is_some_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.username().is_empty() && url.password().is_none())
    )'''
    if original.count(guard) != 1:
        raise SystemExit("Updater guard has changed; review the isolated test override before building.")
    updater.write_text(original.replace(guard, local_guard))
    env["CARGO_TARGET_DIR"] = str(ROOT / "apps/desktop/src-tauri/target")
    for version in ("0.1.0", "0.1.1"):
        config = OUT / "config.json"
        config.write_text(json.dumps({"version": version,
            "bundle": {"createUpdaterArtifacts": True},
            "plugins": {"updater": {"pubkey": key,
                "endpoints": [f"http://127.0.0.1:{PORT}/latest.json"],
                "dangerousInsecureTransportProtocol": True}}}))
        log = OUT / f"build-{version}.log"
        print(f"Building signed local test {version}; log: {log}", flush=True)
        with log.open("w") as stream:
            os.chmod(log, 0o600)
            subprocess.run(["npm", "run", "tauri", "--", "build", "--bundles", "app", "--config", str(config)],
                           cwd=source, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True)
        bundle = ROOT / "apps/desktop/src-tauri/target/release/bundle/macos"
        app = bundle / "Gustaf.app"
        with (app / "Contents/Info.plist").open("rb") as stream:
            assert plistlib.load(stream)["CFBundleShortVersionString"] == version
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        destination = OUT / version
        destination.mkdir(exist_ok=True)
        target = destination / "Gustaf.app"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(app, target, symlinks=True)
        if version == "0.1.0":
            subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(target),
                            str(OUT / "Gustaf-0.1.0-local-test.zip")], check=True)
        else:
            shutil.copy2(bundle / "Gustaf.app.tar.gz", OUT / PAYLOAD)
            shutil.copy2(bundle / "Gustaf.app.tar.gz.sig", OUT / (PAYLOAD + ".sig"))
    signature = (OUT / (PAYLOAD + ".sig")).read_text().strip()
    base64.b64decode(signature, validate=True)
    arch = "aarch64" if os.uname().machine == "arm64" else "x86_64"
    manifest = {"version": "0.1.1", "notes": "Тест обновления 0.1.0 → 0.1.1. Проверьте сохранность настроек, проектов и истории.",
                "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "platforms": {f"darwin-{arch}": {"url": f"http://127.0.0.1:{PORT}/{PAYLOAD}", "signature": signature}}}
    (OUT / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (OUT / PAYLOAD, OUT / "Gustaf-0.1.0-local-test.zip")}
    (OUT / "sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    (OUT / "mode.txt").write_text("update")
    print("Test pair ready. Start with: python3 scripts/updater-smoke.py serve", flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        route = self.path.split("?", 1)[0]
        mode = (OUT / "mode.txt").read_text().strip()
        if route == "/latest.json":
            manifest = json.loads((OUT / "latest.json").read_text())
            if mode == "current":
                manifest["version"] = "0.1.0"
            elif mode == "bad-signature":
                for target in manifest["platforms"].values():
                    lines = base64.b64decode(target["signature"]).decode().splitlines()
                    signature = bytearray(base64.b64decode(lines[1]))
                    signature[10] ^= 1
                    lines[1] = base64.b64encode(signature).decode()
                    target["signature"] = base64.b64encode(("\n".join(lines) + "\n").encode()).decode()
            elif mode == "offline":
                self.send_error(503, "Simulated unavailable feed")
                return
            body = json.dumps(manifest, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif route == "/" + PAYLOAD:
            if mode == "broken-download":
                self.send_error(503, "Simulated download failure")
                return
            payload = OUT / PAYLOAD
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(payload.stat().st_size))
            self.end_headers()
            with payload.open("rb") as stream:
                shutil.copyfileobj(stream, self.wfile)
        else:
            self.send_error(404)


def serve():
    if not (OUT / "latest.json").is_file():
        raise SystemExit("Build the test pair first.")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Local signed update feed: http://127.0.0.1:{PORT}/latest.json", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "serve", "update", "current", "bad-signature", "broken-download", "offline"])
    action = parser.parse_args().action
    if action == "build":
        build()
    elif action == "serve":
        serve()
    else:
        (OUT / "mode.txt").write_text(action)
        print(f"Test feed mode: {action}. Recheck updates in the app.")
