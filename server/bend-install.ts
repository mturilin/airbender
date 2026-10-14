// What: plans a verified bend release download, or a source build.
// Why: installing Airbender should not require a Go toolchain (bead-bb-bk2).
// Design: download the release matching package.json, never “latest”; stage
// beside the destination and verify before replacing an existing executable.
// Gotchas: the visible terminal runs a POSIX shell even when the user's shell
// is fish. Release assets and their checksums must use the names below.

import { shellQuote } from "./bd.ts";

/** A setup command shown before execution, or the reason none is available. */
export interface BendInstallPlan {
  method: "download" | "build" | null;
  command: string | null;
  unavailable: string | null;
}

/**
 * Maps a Node platform/architecture to a published asset, or null if unsupported.
 * Pure: no downloads or file changes. Windows keeps the existing build path.
 */
export function bendReleaseAsset(platform: string, arch: string): string | null {
  if (platform !== "linux" && platform !== "darwin") return null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  return cpu === null ? null : `bend-${platform}-${cpu}`;
}

/**
 * Produces the visible-terminal command for one pinned release binary.
 * Inputs must name a stable semver, a supported asset and an absolute target.
 * Result is shell text; calling this function changes nothing. Executing it
 * downloads over HTTPS, checks SHA-256, checks that bend runs, then replaces
 * target/bend atomically. Any earlier failure leaves the old binary intact.
 */
export function bendDownloadCommand(
  version: string,
  asset: string,
  target: string,
  verifier: "sha256sum" | "shasum",
): string {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("bend release needs a stable version.");
  if (!/^bend-(linux|darwin)-(amd64|arm64)$/u.test(asset)) throw new Error("Unsupported bend asset.");
  const url = `https://github.com/mturilin/airbender/releases/download/v${version}/${asset}`;
  const script = [
    "set -eu",
    `target=${shellQuote(target)}`,
    'mkdir -p "$target"',
    'stage=$(mktemp -d "$target/.bend-install.XXXXXX")',
    `trap 'rm -rf "$stage"' EXIT`,
    'trap \'exit 1\' HUP INT TERM',
    `curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 180 --output "$stage/bend" ${shellQuote(url)}`,
    `curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 180 --output "$stage/checksum" ${shellQuote(`${url}.sha256`)}`,
    'read -r expected rest < "$stage/checksum"',
    'case "$expected" in ""|*[!0-9a-f]*) echo "Invalid bend checksum." >&2; exit 1;; esac',
    '[ "${#expected}" -eq 64 ] || { echo "Invalid bend checksum." >&2; exit 1; }',
    verifier === "sha256sum"
      ? 'actual=$(sha256sum "$stage/bend")'
      : 'actual=$(shasum -a 256 "$stage/bend")',
    'actual=${actual%% *}',
    '[ "$actual" = "$expected" ] || { echo "bend checksum did not match. Nothing was installed." >&2; exit 1; }',
    'chmod 755 "$stage/bend"',
    '"$stage/bend" --json version',
    'mv -f "$stage/bend" "$target/bend"',
    'echo "bend is installed: $target/bend"',
  ].join("\n");
  return `sh -c ${shellQuote(script)}`;
}

/**
 * Chooses a binary install when this host has a published asset and tools;
 * otherwise offers the existing Go build when source and Go are available.
 * All inputs describe already-observed state. Pure; execution is the owner's
 * setup action in a visible terminal, never an automatic plugin side effect.
 */
export function planBendInstall(input: {
  platform: string;
  arch: string;
  version: string | null;
  source: string | null;
  target: string;
  hasProgram: (name: string) => boolean;
}): BendInstallPlan {
  const { platform, arch, version, source, target, hasProgram } = input;
  const asset = bendReleaseAsset(platform, arch);
  const verifier = hasProgram("sha256sum") ? "sha256sum" : hasProgram("shasum") ? "shasum" : null;
  if (asset !== null && version !== null && /^\d+\.\d+\.\d+$/u.test(version) &&
      hasProgram("curl") && hasProgram("sh") && verifier !== null) {
    return { method: "download", command: bendDownloadCommand(version, asset, target, verifier), unavailable: null };
  }
  if (source !== null && hasProgram("go")) {
    return {
      method: "build",
      command: `mkdir -p ${shellQuote(target)} && env -u GOROOT go build -C ${shellQuote(source)} -o ${shellQuote(`${target}/bend`)} ./cmd/bend && echo ${shellQuote(`bend is built: ${target}/bend`)}`,
      unavailable: null,
    };
  }
  const why = asset === null
    ? `No precompiled bend is available for ${platform}/${arch}.`
    : version === null || !/^\d+\.\d+\.\d+$/u.test(version)
      ? "This copy of Airbender does not identify a stable bend release."
      : "Installing the precompiled bend needs curl, sh and sha256sum or shasum.";
  return {
    method: null,
    command: null,
    unavailable: `${why} Build from source with Go 1.24 or later${source === null ? " in the Airbender repository" : ""}, and put bend on your PATH.`,
  };
}
