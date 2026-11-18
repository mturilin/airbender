// What: runs install-bend.sh, the one-line install the agents' rules give,
// against a fake release in a temp folder.
// Why: an agent with no Airbender installs bend with it (bead-bb-d1z); a
// failed download or checksum must never replace a working bend.
// Design: only curl and uname are faked; sh, checksums, permissions and the
// rename are real. The fake curl logs the URLs it was asked for.
// Gotchas: no network or home-directory writes. These tests need POSIX tools.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve(import.meta.dirname, "..", "install-bend.sh");

/**
 * Supplies a fake release (curl and uname on PATH) and an install folder that
 * already holds an "old bend", to a callback; removes all temp files after.
 * The folder's name has a space, an apostrophe and a dollar sign, to test
 * quoting. The env given to the callback installs there and nowhere else.
 */
function withRelease(check: (root: string, target: string, env: NodeJS.ProcessEnv) => void): void {
  const root = mkdtempSync(join(tmpdir(), "install-bend-"));
  const target = join(root, "owner's $commands");
  const fake = join(root, "fake-bin");
  mkdirSync(target);
  mkdirSync(fake);
  writeFileSync(join(target, "bend"), "old bend");
  const binary = '#!/bin/sh\nprintf \'{"version":9}\\n\'\n';
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
echo "$url" >> "$TEST_RELEASE/urls"
case "$url" in
  *.sha256) cp "$TEST_RELEASE/checksum" "$output";;
  *) cp "$TEST_RELEASE/binary" "$output";;
esac
`, { mode: 0o755 });
  writeFileSync(join(fake, "uname"), `#!/bin/sh
case "$1" in
  -s) echo "\${TEST_OS:-Linux}";;
  -m) echo "\${TEST_CPU:-x86_64}";;
esac
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fake}:${process.env.PATH}`,
    TEST_RELEASE: root,
    BEND_INSTALL_DIR: target,
  };
  delete env.BEND_VERSION;
  try {
    check(root, target, env);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** The URLs the fake curl was asked for, in order. */
function urls(root: string): string[] {
  return readFileSync(join(root, "urls"), "utf8").trim().split("\n");
}

test("a verified download from the latest release installs, is executable, and leaves no staging folder", () => {
  withRelease((root, target, env) => {
    const out = execFileSync("sh", [script], { env, encoding: "utf8" });
    assert.equal(readFileSync(join(target, "bend"), "utf8"), readFileSync(join(root, "binary"), "utf8"));
    assert.equal(statSync(join(target, "bend")).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(target), ["bend"]);
    assert.deepEqual(urls(root), [
      "https://github.com/mturilin/airbender/releases/latest/download/bend-linux-amd64",
      "https://github.com/mturilin/airbender/releases/latest/download/bend-linux-amd64.sha256",
    ]);
    assert.match(out, /bend is installed/u);
    assert.match(out, /is not on your PATH/u);
  });
});

test("it runs from a pipe, as the line in the rules does", () => {
  withRelease((_root, target, env) => {
    execFileSync("sh", [], { env, input: readFileSync(script) });
    assert.notEqual(readFileSync(join(target, "bend"), "utf8"), "old bend");
  });
});

test("a script cut off part way through the pipe runs nothing", () => {
  withRelease((root, target, env) => {
    const whole = readFileSync(script, "utf8");
    const half = whole.slice(0, whole.indexOf('mv -f "$stage/bend"'));
    spawnSync("sh", [], { env, input: half });
    assert.equal(readFileSync(join(target, "bend"), "utf8"), "old bend");
    assert.deepEqual(readdirSync(target), ["bend"]);
    assert.equal(readdirSync(root).includes("urls"), false);
  });
});

test("BEND_VERSION picks one release, the platform picks the asset, and an install folder on PATH is not warned about", () => {
  withRelease((root, target, env) => {
    const out = execFileSync("sh", [script], {
      env: { ...env, BEND_VERSION: "v0.2.0", TEST_OS: "Darwin", TEST_CPU: "arm64", PATH: `${target}:${env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(urls(root)[0], "https://github.com/mturilin/airbender/releases/download/v0.2.0/bend-darwin-arm64");
    assert.doesNotMatch(out, /not on your PATH/u);
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
      const run = spawnSync("sh", [script], { env, encoding: "utf8" });
      assert.notEqual(run.status, 0, failure);
      assert.match(run.stderr, /install-bend: /u, failure);
      assert.equal(readFileSync(join(target, "bend"), "utf8"), "old bend", failure);
      assert.deepEqual(readdirSync(target), ["bend"], failure);
    });
  }
});

test("unsupported platforms and a malformed BEND_VERSION install nothing and say why", () => {
  const cases: [NodeJS.ProcessEnv, RegExp][] = [
    [{ TEST_OS: "MINGW64_NT-10.0" }, /WSL/u],
    [{ TEST_OS: "FreeBSD" }, /no bend for FreeBSD/u],
    [{ TEST_CPU: "i686" }, /no bend for i686/u],
    [{ BEND_VERSION: "latest" }, /BEND_VERSION must look like/u],
    [{ BEND_VERSION: "v1.2.3; echo x" }, /BEND_VERSION must look like/u],
  ];
  for (const [extra, reason] of cases) {
    withRelease((root, target, env) => {
      const run = spawnSync("sh", [script], { env: { ...env, ...extra }, encoding: "utf8" });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, reason);
      assert.equal(readFileSync(join(target, "bend"), "utf8"), "old bend");
      assert.deepEqual(readdirSync(root).includes("urls"), false);
    });
  }
});
