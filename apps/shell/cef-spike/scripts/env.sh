# Source this: build tools and caches live outside the repo, in a path without spaces.
export CEF_SPIKE_HOME="${CEF_SPIKE_HOME:-$HOME/.cache/gustaf-cef-spike}"
export PATH="$CEF_SPIKE_HOME/tools/bin:$PATH"
export CEF_PATH="$CEF_SPIKE_HOME/cef"
export CARGO_TARGET_DIR="$CEF_SPIKE_HOME/target"
