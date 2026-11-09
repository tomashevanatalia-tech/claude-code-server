"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const manifest = require("./package.json");

function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function launch(env = process.env, spawn = childProcess.spawn, report = console.log) {
  if (env.IDE_HOUSEKEEPING_ENABLED === "0") return null;
  const configured = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!configured || !path.isAbsolute(configured)) throw new Error("No explicit Railway volume");
  const root = fs.realpathSync(configured);
  if (root === path.parse(root).root) throw new Error("Filesystem root is not allowed");
  const script = path.join(root, ".local/share/ide-housekeeping/ide_housekeeping.py");
  if (fs.lstatSync(script).isSymbolicLink() || !within(root, fs.realpathSync(script))) {
    throw new Error("Unsafe housekeeping script path");
  }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(script)).digest("hex");
  if (hash !== manifest.housekeepingSha256) throw new Error("Housekeeping checksum mismatch");
  const child = spawn("/usr/bin/python3", ["-u", script, "--root", root, "--apply", "--loop"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.on("error", (error) => report(`Housekeeping launch failed: ${error.code || error.name}`));
  child.unref();
  report("Housekeeping scheduled every 72 hours; its persisted timestamp survives restarts.");
  return child;
}

function activate(context) {
  const vscode = require("vscode");
  const output = vscode.window.createOutputChannel("IDE Disk Housekeeping");
  context.subscriptions.push(output);
  try {
    launch(process.env, childProcess.spawn, (message) => output.appendLine(message));
  } catch (error) {
    output.appendLine(`Housekeeping not started: ${error.message}`);
  }
}

module.exports = { activate, launch, within };
