# Native browser spike (not shipped)

Stage 0 of the hybrid browser (TASKS.md, "Гибридный браузер"). A standalone Tauri app with its own
identifier, so it never touches a running Gustaf: an HTML UI webview plus a native child webview
placed over a slot the UI measures, the way `BrowserSurfaceSlot` places Electron's view.

    cargo build --release
    ./target/release/native-browser-spike                          # interactive
    SPIKE_URL=https://github.com python3 -I bench/run.py 'native-browser-spike|com\.apple\.WebKit' ./target/release/native-browser-spike
    python3 -I bench/run.py chrome-headless-shell node bench/stream-bench.mjs <chrome-headless-shell> <url> metal|disable-gpu

`bench/stream-bench.mjs` imports Playwright by an absolute path from a local checkout; adjust it.

## Results, 2026-11-16, Apple M4, macOS 27.2, chrome-headless-shell 157.0.8103.38

CPU is the sum over the processes each run started, as a share of one core; panel 700x850 CSS px @2x.
The stream column counts Chrome only: Gustaf's own JPEG decode (~2-4 ms a frame in WKWebView, PR #120)
and the server's relay come on top.

| Page, phase | Native WebKit | Stream, `--use-angle=metal` | Stream, `--disable-gpu` (shipped) |
|---|---|---|---|
| github.com, idle (3D hero animates) | 44% | 56% (45 fps) | 515% (37 fps) |
| github.com, scrolling | 33% | 50% (45 fps) | 200% (43 fps) |
| MDN article, idle | 0% | 0% (no frames) | not run |
| MDN article, scrolling | 10% | 37% (45 fps, 70 KB/frame) | not run |
| Memory | 180-435 MB | 440-520 MB plus the client page | 520-790 MB |
