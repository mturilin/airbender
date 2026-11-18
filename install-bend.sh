#!/bin/sh
# What: installs the `bend` program, and only it, from Airbender's GitHub
# releases: no BB, no plugin, no beads.
#
# Why: a repository set up with Airbender tells its agents to use `bend` for
# every issue. An agent that checks the repository out without Airbender
# (a headless one, say) needs `bend` and nothing else. The rules give it one
# line, `curl -fsSL .../install-bend.sh | sh`, and this script is what that
# line runs; it can be read before it is run (bead-bb-d1z).
#
# Design notes:
#   - POSIX sh, not bash or Babashka: it has to run on a bare machine.
#   - The latest release by default, so the line in the rules never changes;
#     BEND_VERSION=vX.Y.Z picks one release. The panel's own installer
#     (server/bend-install.ts) pins the plugin's version instead; the steps
#     here are the same as its steps.
#   - Nothing replaces an existing `bend` until the download has passed its
#     SHA-256 check and has run: it is staged inside the target folder and
#     moved over the old one in one rename.
#   - BEND_INSTALL_DIR picks the folder; ~/.local/bin by default.
#   - All of it is inside main, called on the last line, because `curl | sh`
#     runs the script as it arrives.
#
# Gotchas:
#   - Releases have Linux and macOS builds, for amd64 and arm64, only. Windows
#     is refused here; under WSL it is Linux and works.
#   - Needs curl, and sha256sum (Linux) or shasum (macOS).
#   - The checksum comes from the same release as the binary: it catches a
#     broken download, not a tampered release.

set -eu

repository="https://github.com/mturilin/airbender"

# fail prints a message for the person or agent running this, and stops.
fail() {
  echo "install-bend: $*" >&2
  exit 1
}

# download fetches one URL to a file, over HTTPS only, with time limits.
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 180 --output "$2" "$1" ||
    fail "could not download $1"
}

# main does the whole install. Everything runs from the call on the last
# line, so a download through `curl | sh` that is cut off part way runs
# nothing at all, instead of the first half of the script.
main() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      fail "there is no bend for Windows. Run this under WSL, where it is Linux." ;;
    *) fail "there is no bend for $(uname -s); releases are for Linux and macOS." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) cpu=amd64 ;;
    aarch64 | arm64) cpu=arm64 ;;
    *) fail "there is no bend for $(uname -m); releases are for amd64 and arm64." ;;
  esac
  asset="bend-$os-$cpu"

  command -v curl >/dev/null 2>&1 || fail "curl is needed to download bend."
  if command -v sha256sum >/dev/null 2>&1; then
    verifier=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    verifier=shasum
  else
    fail "sha256sum or shasum is needed to check the download."
  fi

  version=${BEND_VERSION:-}
  if [ -z "$version" ]; then
    url="$repository/releases/latest/download/$asset"
  else
    # A shell pattern's * matches anything, so the digits-and-dots check is
    # its own step: "v1.2.3; x" passes the first pattern alone.
    case "$version" in
      v[0-9]*.[0-9]*.[0-9]*) ;;
      *) fail "BEND_VERSION must look like v1.2.3, not '$version'." ;;
    esac
    case "${version#v}" in
      *[!0-9.]*) fail "BEND_VERSION must look like v1.2.3, not '$version'." ;;
    esac
    url="$repository/releases/download/$version/$asset"
  fi

  target=${BEND_INSTALL_DIR:-"$HOME/.local/bin"}
  mkdir -p "$target"
  stage=$(mktemp -d "$target/.bend-install.XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  trap 'exit 1' HUP INT TERM

  echo "install-bend: downloading $asset ${version:-(latest release)}"
  download "$url" "$stage/bend"
  download "$url.sha256" "$stage/checksum"

  read -r expected rest <"$stage/checksum" || true
  case "$expected" in
    "" | *[!0-9a-f]*) fail "the checksum file is not valid. Nothing was installed." ;;
  esac
  [ "${#expected}" -eq 64 ] || fail "the checksum file is not valid. Nothing was installed."
  if [ "$verifier" = sha256sum ]; then
    actual=$(sha256sum "$stage/bend")
  else
    actual=$(shasum -a 256 "$stage/bend")
  fi
  actual=${actual%% *}
  [ "$actual" = "$expected" ] || fail "the checksum did not match. Nothing was installed."

  chmod 755 "$stage/bend"
  "$stage/bend" --json version >/dev/null 2>&1 || fail "the downloaded bend does not run here. Nothing was installed."
  mv -f "$stage/bend" "$target/bend"
  echo "install-bend: bend is installed: $target/bend"

  case ":$PATH:" in
    *":$target:"*) ;;
    *) echo "install-bend: $target is not on your PATH; add it, or run $target/bend." ;;
  esac
}

main "$@"
