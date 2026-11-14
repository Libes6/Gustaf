#!/bin/sh
# Installs the Gustaf CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/Libes6/Gustaf/main/scripts/install.sh | sh
#
# Environment:
#   T3CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; Gustaf publishes only stable releases)
#   T3CODE_VERSION           exact version to install (overrides T3CODE_CHANNEL)
#   T3CODE_HOME              T3 home directory (default: ~/.t3)
#   T3CODE_INSTALL_BIN_DIR   where the `gustaf` symlink goes (default: ~/.local/bin)
#   T3CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $T3CODE_HOME/runtime/versions/<version>, the
# same layout `gustaf service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

repo="Libes6/Gustaf"
base_url="${T3CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${T3CODE_HOME:-$HOME/.t3}"
case "$t3_home" in
  /*) ;;
  *)
    # Preserve cwd's trailing newlines; trim only pwd's newline and the sentinel.
    t3_cwd="$(pwd -P && printf .)"
    t3_home="${t3_cwd%??}/$t3_home"
    ;;
esac
bin_dir="${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
# Trailing slashes would put `//` in the paths the gustaf command guard compares.
while [ "${t3_home%/}" != "$t3_home" ] && [ "$t3_home" != / ]; do t3_home="${t3_home%/}"; done
while [ "${bin_dir%/}" != "$bin_dir" ] && [ "$bin_dir" != / ]; do bin_dir="${bin_dir%/}"; done
# Absolute, so the PATH hint never adds a folder that changes with the working directory.
case "$bin_dir" in /*) ;; *) bin_dir="$PWD/$bin_dir" ;; esac

fail() {
  printf '\ngustaf install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n  %sGustaf%s %sCLI installer%s\n\n' "$bold" "$reset" "$muted" "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -H "Accept: ${3:-*/*}" -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response --header="Accept: ${3:-*/*}" "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
# cliArchivePlatformKey in packages/shared/src/cliRelease.ts: the platforms Gustaf releases.
case "${platform}-${arch}" in
  darwin-arm64 | linux-x64) ;;
  *) fail "Gustaf has no CLI for ${platform}-${arch}. Releases are at https://github.com/${repo}/releases" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${T3CODE_CHANNEL:-stable}"
version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "T3CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  if [ "$channel" = stable ]; then
    # release.yml marks only plain stable releases latest. This is a github.com
    # page, so it is not cut off by a page of newer nightlies or the API quota.
    fetch "https://github.com/${repo}/releases/latest" "$tmp_index" application/json
    version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  else
    page=1
    while [ -z "$version" ] && [ "$page" -le 10 ]; do
      fetch "https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}" "$tmp_index"
      version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
      grep -q '"tag_name"' "$tmp_index" || break
      page=$((page + 1))
    done
  fi
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set T3CODE_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "gustaf ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set T3CODE_CHANNEL=stable (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${T3CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="gustaf-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s Gustaf %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS.txt" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "found no Gustaf ${version} release at ${base_url}"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "Gustaf ${version} has no CLI archive for ${platform}-${arch}"
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting Gustaf..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/gustaf" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the gustaf command..."
mkdir -p "$bin_dir"
# Replace only this home's own gustaf links: into its versions, or the desktop app's launcher.
# Anything that is not a symlink (a script, a copied binary) belongs to someone else.
# Exactly <versions>/<version>/gustaf ($1 under $2), or t3 in a version unpacked from an upstream
# T3 Code archive; never another program inside a version.
version_t3() {
  case "$1" in "$2"/*) ;; *) return 1 ;; esac
  case "${1#"$2"/}" in */*/*) return 1 ;; */gustaf | */t3) return 0 ;; *) return 1 ;; esac
}
slot_empty=true
if [ -e "${bin_dir}/gustaf" ] || [ -L "${bin_dir}/gustaf" ]; then
  slot_empty=false
  owned=false
  if [ -L "${bin_dir}/gustaf" ]; then
    existing="$(readlink "${bin_dir}/gustaf" 2>/dev/null || true)"
    case "$existing" in /*) ;; *) existing="${bin_dir}/${existing}" ;; esac
    real_versions_dir="$(CDPATH='' cd -P -- "$versions_dir" && pwd)"
    # Through a symlinked T3 home the link text names the alias; resolve its folder to compare.
    existing_dir="$(CDPATH='' cd -P -- "$(dirname -- "$existing")" 2>/dev/null && pwd || true)"
    # The text alone counts only without . or .. segments (a pruned version leaves a dangling link).
    case "$existing" in
      */./* | */../* | */. | */..) ;;
      *)
        if version_t3 "$existing" "$versions_dir" || version_t3 "$existing" "$real_versions_dir" ||
          [ "$existing" = "${t3_home}/bin/gustaf" ]; then owned=true; fi
        ;;
    esac
    if [ -n "$existing_dir" ] && version_t3 "${existing_dir}/${existing##*/}" "$real_versions_dir"; then
      owned=true
    fi
  fi
  "$owned" || fail "another gustaf is already at ${bin_dir}/gustaf. Remove it and run this again, or run ${target_dir}/gustaf directly."
fi
# An empty spot is linked without -f, so a file that appears after the check above is kept.
if "$slot_empty"; then
  ln -s "${target_dir}/gustaf" "${bin_dir}/gustaf" || fail "could not link ${bin_dir}/gustaf; something else was created there."
else
  # Known race, accepted: a file written here after the ownership check above is overwritten.
  ln -sfn "${target_dir}/gustaf" "${bin_dir}/gustaf"
fi
# Pruning keeps what this launcher points at; a background service cannot see bin_dir otherwise.
launcher="$(CDPATH='' cd -P -- "$bin_dir" && pwd)/gustaf"
launchers="${t3_home}/runtime/launchers"
grep -qxF "$launcher" "$launchers" 2>/dev/null || printf '%s\n' "$launcher" >> "$launchers"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled Gustaf %s%s\n\n' "$green" "$version" "$reset" >&2
# The folder a shell reads its startup file from: $1 when set and safe to paste, else $2 when
# unset. A set but unsafe folder prints nothing, since the default would never be read.
read_from() {
  case "$1" in
    "") printf '%s' "$2" ;;
    /*) case "$1" in *[!A-Za-z0-9_./-]*) ;; *) printf '%s' "$1" ;; esac ;;
  esac
}
# A command to paste for zsh, Linux bash, or fish, like `gustaf install` prints. macOS bash reads only
# one of several startup files, so no single file is safe to change there.
path_command=
path_rest="$bin_dir"
path_prefix=
case "$bin_dir" in "$HOME"/*) path_rest="${bin_dir#"$HOME"}" path_prefix='$HOME' ;; esac
case "$path_rest" in *[!A-Za-z0-9_./-]*) path_rest= ;; esac
if [ -n "$path_rest" ]; then
  # Last on PATH, so it never shadows another gustaf.
  path_line="export PATH=\"\$PATH:${path_prefix}${path_rest}\""
  shell_name="${SHELL:-}"
  case "${shell_name##*/}" in
    zsh)
      # zsh reads .zshrc from ZDOTDIR when it is set; ~/.zshrc would never be read then.
      zsh_dir="$(read_from "${ZDOTDIR:-}" '~')"
      [ -z "$zsh_dir" ] || path_command="printf '\\n%s\\n' '${path_line}' >> ${zsh_dir}/.zshrc" ;;
    bash) [ "$platform" = darwin ] || path_command="printf '\\n%s\\n' '${path_line}' >> ~/.bashrc" ;;
    fish)
      # --path changes $PATH itself; fish_user_paths would go ahead of the system folders.
      config_dir="$(read_from "${XDG_CONFIG_HOME:-}" '~/.config')"
      fish_dir="${config_dir}/fish"
      [ -z "$config_dir" ] || path_command="mkdir -p ${fish_dir} && printf '\\n%s\\n' 'fish_add_path --append --path ${path_prefix}${path_rest}' >> ${fish_dir}/config.fish" ;;
  esac
fi
# A gustaf earlier on PATH runs instead; the PATH command adds this folder last.
# A PATH entry with a trailing slash gives `dir//gustaf`.
first_t3="$(command -v gustaf 2>/dev/null | tr -s / || true)"
case "$first_t3" in "" | "${bin_dir}/gustaf") first_t3= ;; esac
if [ -n "$first_t3" ]; then
  printf '  Another gustaf at %s runs first, so run %s%s/gustaf%s to use this one.\n\n' "$first_t3" "$bold" "$bin_dir" "$reset"
else
  case ":${PATH}:" in
    *":${bin_dir}:"* | *":${bin_dir}/:"*) printf '  Run %sgustaf%s to use Gustaf here, or %sgustaf up%s to use it from your other devices.\n\n' "$bold" "$reset" "$bold" "$reset" ;;
    *)
      if [ -n "$path_command" ]; then
        printf '  %s is not on your PATH yet. Add it with:\n\n    %s\n\n  Then open a new terminal and run %sgustaf%s.\n\n' "$bin_dir" "$path_command" "$bold" "$reset"
      else
        printf '  Add %s to your PATH, then run %sgustaf%s.\n\n' "$bin_dir" "$bold" "$reset"
      fi
      ;;
  esac
fi
