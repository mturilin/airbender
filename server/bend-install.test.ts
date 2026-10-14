// What: checks platform selection and executes the installer in a temp folder.
// Why: a failed download or checksum must never replace a working bend.
// Design: only curl is faked; sh, checksums, permissions and rename are real.
// Gotchas: no network or home-directory writes. These tests need POSIX tools.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bendDownloadCommand, bendReleaseAsset, planBendInstall } from "./bend-install.ts";

test("release assets map Linux and macOS Intel/ARM; others stay on the build path", () => {
  assert.equal(bendReleaseAsset("linux", "x64"), "bend-linux-amd64");
  assert.equal(bendReleaseAsset("linux", "arm64"), "bend-linux-arm64");
  assert.equal(bendReleaseAsset("darwin", "x64"), "bend-darwin-amd64");
  assert.equal(bendReleaseAsset("darwin", "arm64"), "bend-darwin-arm64");
  assert.equal(bendReleaseAsset("win32", "x64"), null);
  assert.equal(bendReleaseAsset("linux", "ia32"), null);
});

test("a supported host installs without Go or source; unsupported hosts can build", () => {
  const base = { platform: "linux", arch: "x64", version: "0.1.0", source: null,
    target: "/tmp/bin", hasProgram: (name: string) => ["curl", "sh", "sha256sum"].includes(name) };
  const download = planBendInstall(base);
  assert.equal(download.method, "download");
  assert.match(download.command!, /releases\/download\/v0\.1\.0\/bend-linux-amd64/u);
  assert.doesNotMatch(download.command!, /latest|go build/u);
  assert.equal(planBendInstall({ ...base, platform: "freebsd", source: "/src/bend", hasProgram: () => true }).method, "build");
  assert.equal(planBendInstall({ ...base, hasProgram: () => false }).command, null);
  assert.equal(planBendInstall({ ...base, version: "0.1.0-rc.1" }).command, null);
  assert.throws(() => bendDownloadCommand("$(echo bad)", "bend-linux-amd64", "/bin", "sha256sum"));
});

/**
 * Supplies a fake curl and release files to a callback; removes all temp files.
 * The caller runs real shell commands, limited to this fixture's destination.
 * The destination contains a space, apostrophe and dollar sign to test quoting.
 */
function withRelease(check: (root: string, target: string, env: NodeJS.ProcessEnv) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bend-install-"));
  const target = join(root, "owner's $commands");
  const fake = join(root, "fake-bin");
  mkdirSync(target);
  mkdirSync(fake);
  writeFileSync(join(target, "bend"), "old bend");
  const binary = '#!/bin/sh\nprintf \'{"version":8}\\n\'\n';
  writeFileSync(join(root, "binary"), binary);
  writeFileSync(join(root, "checksum"), `${createHash("sha256").update(binary).digest("hex")}  bend-linux-amd64\n`);
  writeFileSync(join(fake, "curl"), `#!/bin/sh
set -eu
if [ "\${TEST_FAIL_DOWNLOAD:-}" = yes ]; then exit 22; fi
output=
url=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; output=$1; else url=$1; fi
  shift
done
case "$url" in
  *.sha256) cp "$TEST_RELEASE/checksum" "$output";;
  *) cp "$TEST_RELEASE/binary" "$output";;
esac
`, { mode: 0o755 });
  try {
    check(root, target, { ...process.env, PATH: `${fake}:${process.env.PATH}`, TEST_RELEASE: root });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a verified download installs, is executable, and cleans up its staging folder", () => {
  withRelease((root, target, env) => {
    const command = bendDownloadCommand("0.1.0", "bend-linux-amd64", target, "sha256sum");
    execFileSync("sh", ["-c", command], { env });
    assert.equal(readFileSync(join(target, "bend"), "utf8"), readFileSync(join(root, "binary"), "utf8"));
    assert.equal(statSync(join(target, "bend")).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(target), ["bend"]);
  });
});

test("checksum mismatches, malformed checksums, failed downloads and bad binaries preserve the old bend", () => {
  for (const failure of ["mismatch", "malformed", "download", "executable"]) {
    withRelease((root, target, env) => {
      if (failure === "mismatch") writeFileSync(join(root, "checksum"), `${"0".repeat(64)}  bend\n`);
      if (failure === "malformed") writeFileSync(join(root, "checksum"), "not-a-checksum\n");
      if (failure === "download") env.TEST_FAIL_DOWNLOAD = "yes";
      if (failure === "executable") {
        const bad = "#!/bin/sh\nexit 1\n";
        writeFileSync(join(root, "binary"), bad);
        writeFileSync(join(root, "checksum"), `${createHash("sha256").update(bad).digest("hex")}  bend\n`);
      }
      const command = bendDownloadCommand("0.1.0", "bend-linux-amd64", target, "sha256sum");
      assert.throws(() => execFileSync("sh", ["-c", command], { env, stdio: "pipe" }), failure);
      assert.equal(readFileSync(join(target, "bend"), "utf8"), "old bend", failure);
      assert.deepEqual(readdirSync(target), ["bend"], failure);
    });
  }
});

test("macOS's shasum verifier follows the same install path", () => {
  withRelease((_root, target, env) => {
    execFileSync("sh", ["-c", bendDownloadCommand("0.1.0", "bend-darwin-arm64", target, "shasum")], { env });
    assert.notEqual(readFileSync(join(target, "bend"), "utf8"), "old bend");
  });
});
