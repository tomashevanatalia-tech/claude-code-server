#!/usr/bin/env node

"use strict"

const fs = require("fs")
const path = require("path")

const [extensionsDir, expectedVersion, quarantineDir] = process.argv.slice(2)
if (!extensionsDir || !expectedVersion || !quarantineDir) {
  throw new Error("usage: reconcile-antigravity-metadata.js EXTENSIONS_DIR EXPECTED_VERSION QUARANTINE_DIR")
}

const extensionId = "google.google-antigravity"
const expectedDirectory = `${extensionId}-${expectedVersion}`
const extensionsRoot = path.resolve(extensionsDir)
const metadataPath = path.join(extensionsRoot, "extensions.json")

function recoverEntriesFromDirectories() {
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifestPath = path.join(extensionsRoot, entry.name, "package.json")
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        if (
          ![manifest.publisher, manifest.name, manifest.version].every((value) => typeof value === "string" && value)
        ) {
          throw new Error("publisher, name or version is missing")
        }
        return [
          {
            identifier: { id: `${manifest.publisher}.${manifest.name}` },
            version: manifest.version,
            location: {
              $mid: 1,
              path: path.join(extensionsRoot, entry.name),
              scheme: "file",
            },
            relativeLocation: entry.name,
            metadata: {},
          },
        ]
      } catch (error) {
        console.error(`Skipped invalid extension directory ${entry.name} while rebuilding metadata: ${error.message}`)
        return []
      }
    })
}

let entries
let metadataMode = 0o644
if (fs.existsSync(metadataPath)) {
  metadataMode = fs.statSync(metadataPath).mode & 0o777
  try {
    entries = JSON.parse(fs.readFileSync(metadataPath, "utf8"))
    if (!Array.isArray(entries)) throw new Error("metadata must contain a JSON array")
  } catch (error) {
    const backupPath = `${metadataPath}.corrupt-backup`
    fs.rmSync(backupPath, { force: true })
    fs.renameSync(metadataPath, backupPath)
    console.error(`Replaced corrupt extension metadata; backup saved to ${backupPath}: ${error.message}`)
    entries = recoverEntriesFromDirectories()
  }
} else {
  entries = recoverEntriesFromDirectories()
}

const expectedExists = fs.existsSync(path.join(extensionsRoot, expectedDirectory))
const reconciled = entries.filter((entry) => {
  const id = String(entry?.identifier?.id || entry?.id || "").toLowerCase()
  if (id !== extensionId) return true
  const relativeLocation = String(entry?.relativeLocation || "")
  return expectedExists && (entry?.version === expectedVersion || relativeLocation === expectedDirectory)
})
if (
  expectedExists &&
  !reconciled.some((entry) => String(entry?.identifier?.id || entry?.id || "").toLowerCase() === extensionId)
) {
  const recoveredExpected = recoverEntriesFromDirectories().find(
    (entry) => entry.relativeLocation === expectedDirectory && entry.version === expectedVersion,
  )
  if (recoveredExpected) reconciled.push(recoveredExpected)
}
const temporaryPath = `${metadataPath}.${process.pid}.tmp`
fs.writeFileSync(temporaryPath, `${JSON.stringify(reconciled)}\n`, { mode: metadataMode })
fs.renameSync(temporaryPath, metadataPath)

if (fs.existsSync(quarantineDir)) {
  const quarantined = fs
    .readdirSync(quarantineDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${extensionId}-`))
    .map((entry) => {
      const fullPath = path.join(quarantineDir, entry.name)
      return { fullPath, modified: fs.statSync(fullPath).ctimeMs }
    })
    .sort((left, right) => right.modified - left.modified || right.fullPath.localeCompare(left.fullPath))

  for (const stale of quarantined.slice(3)) fs.rmSync(stale.fullPath, { recursive: true, force: true })
}
