"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { launch, within } = require("../extension/extension.cjs");
const manifest = require("../extension/package.json");
const source = path.resolve(__dirname, "../ide_housekeeping.py");

test("launcher pins the exact tested Python utility", () => {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"), manifest.housekeepingSha256);
});

test("disabled launcher does not spawn", () => {
  assert.equal(launch({ IDE_HOUSEKEEPING_ENABLED: "0" }, () => assert.fail("spawned")), null);
});

test("missing volume and filesystem root are rejected", () => {
  assert.throws(() => launch({}, () => assert.fail("spawned")), /explicit Railway volume/);
  assert.throws(() => launch({ RAILWAY_VOLUME_MOUNT_PATH: path.parse(process.cwd()).root }), /Filesystem root/);
});

test("tampered utility cannot execute", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-housekeeping-"));
  try {
    const script = path.join(root, ".local/share/ide-housekeeping/ide_housekeeping.py");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "tampered");
    assert.throws(() => launch({ RAILWAY_VOLUME_MOUNT_PATH: root }, () => assert.fail("spawned")), /checksum/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launch uses fixed argv, no shell, and detaches without killing existing work", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ide-housekeeping-")));
  try {
    const script = path.join(root, ".local/share/ide-housekeeping/ide_housekeeping.py");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(source, script);
    let calls = 0;
    let detached = false;
    const fake = (command, args, options) => {
      calls++;
      assert.equal(command, "/usr/bin/python3");
      assert.deepEqual(args, ["-u", script, "--root", root, "--apply", "--loop"]);
      assert.equal(options.shell, undefined);
      assert.equal(options.detached, true);
      return { on() {}, unref() { detached = true; } };
    };
    launch({ RAILWAY_VOLUME_MOUNT_PATH: root }, fake, () => {});
    assert.equal(calls, 1);
    assert.equal(detached, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sibling path prefix is not containment", () => {
  assert.equal(within(path.resolve("/volume"), path.resolve("/volume-other/file")), false);
  assert.equal(within(path.resolve("/volume"), path.resolve("/volume/cache")), true);
});
