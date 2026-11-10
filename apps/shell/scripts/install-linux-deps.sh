#!/usr/bin/env bash
# System libraries the Linux shell needs to compile and bundle. Both CI jobs
# (bundle and warm-cache) run this, so the two never drift apart.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
  libdbus-1-dev libxcb1-dev libxrandr-dev libgbm-dev libegl-dev libwayland-dev \
  libpipewire-0.3-dev libspa-0.2-dev patchelf libatomic1 xvfb rpm \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
