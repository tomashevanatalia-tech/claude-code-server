#!/usr/bin/env node

"use strict"

const assert = require("assert/strict")
const { spawn } = require("child_process")
const crypto = require("crypto")
const http = require("http")
const net = require("net")
const path = require("path")
const zlib = require("zlib")

const proxyScript = path.resolve(__dirname, "../antigravity-proxy.js")

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function request(port, requestPath, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on("error", reject)
    })
    req.on("error", reject)
    req.end()
  })
}

function requestInterruptedStream(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: requestPath }, (res) => {
      const chunks = []
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
      }
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("aborted", finish)
      res.on("error", finish)
      res.on("end", () => reject(new Error("Expected the streamed response to be interrupted")))
    })
    req.on("error", reject)
  })
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 10000)
    const inspect = (chunk) => {
      output += chunk.toString()
      if (pattern.test(output)) {
        clearTimeout(timer)
        resolve(output)
      }
    }
    child.stdout.on("data", inspect)
    child.stderr.on("data", inspect)
    child.once("error", reject)
    child.once("exit", (code) => {
      if (!pattern.test(output)) reject(new Error(`Proxy exited early with ${code}: ${output}`))
    })
  })
}

function abortUpload(port) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/slow-upload",
      method: "POST",
      headers: { "content-length": 1024 * 1024 },
    })
    req.on("response", (res) => {
      res.resume()
      finish()
    })
    req.on("error", finish)
    req.write(Buffer.alloc(1024))
    setTimeout(() => {
      req.destroy()
      finish()
    }, 20)
  })
}

function startProxy(externalPort, internalPort) {
  return spawn(process.execPath, [proxyScript, process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    env: {
      ...process.env,
      PORT: String(externalPort),
      CODE_SERVER_INTERNAL_PORT: String(internalPort),
      ANTIGRAVITY_SERVER_PORT: "38000",
      CLOUD_IDE_UPSTREAM_TIMEOUT_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
}

function upgrade(port, requestPath = "/web/38000/connect-websocket", payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n",
      )
      if (payload) setTimeout(() => socket.write(payload), 10)
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("Timed out waiting for WebSocket upgrade"))
    }, 5000)
    let response = ""
    socket.on("data", (data) => {
      response += data.toString()
      const expected = payload ? "upstream-to-client" : "HTTP/1.1"
      if (!response.includes(expected)) return
      clearTimeout(timer)
      socket.destroy()
      resolve(response)
    })
    socket.once("error", reject)
  })
}

async function main() {
  let mode = "interrupted"
  let normalAcceptEncoding
  let observedAcceptEncoding
  let observedIfModifiedSince
  let observedIfNoneMatch
  let bufferedResponseClosed
  let bufferedResponseStarted
  let delayedRequestStarted
  const normalSource = '<html><head></head><body><script src="/main.js"></script></body></html>'
  const normalCompressed = zlib.gzipSync(normalSource)
  const cssCompressed = zlib.gzipSync("body{background:url(/image.png)}")
  const oversized = Buffer.from(`<html><head></head><body>${"x".repeat(8 * 1024 * 1024 + 100)}</body></html>`)
  const upstreamSockets = new Set()
  const upstream = http.createServer((req, res) => {
    observedAcceptEncoding = req.headers["accept-encoding"]
    observedIfModifiedSince = req.headers["if-modified-since"]
    observedIfNoneMatch = req.headers["if-none-match"]
    if (mode === "client-abort") {
      req.on("error", () => {})
      req.resume()
      return
    }
    if (mode === "interrupted") {
      res.writeHead(200, { "content-type": "text/html" })
      res.write("<html><head>")
      setTimeout(() => res.destroy(), 20)
      return
    }
    if (mode === "hang") {
      req.resume()
      return
    }
    if (mode === "buffered-client-abort") {
      res.on("close", bufferedResponseClosed)
      res.writeHead(200, { "content-type": "text/html" })
      res.write("<html><head>")
      bufferedResponseStarted()
      return
    }
    if (mode === "delayed") {
      delayedRequestStarted()
      res.writeHead(200, { "content-type": "application/javascript" })
      setTimeout(() => res.end("const drained = true;"), 100)
      return
    }
    if (mode === "slow-stream") {
      res.writeHead(200, { "content-type": "application/javascript" })
      res.write("const first = true;")
      setTimeout(() => res.end("const last = true;"), 2200)
      return
    }
    if (mode === "normal") {
      normalAcceptEncoding = req.headers["accept-encoding"]
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
        "content-length": normalCompressed.length,
        "content-security-policy": "default-src 'self'; script-src 'self'",
        etag: '"upstream-html"',
        "last-modified": "Sat, 06 Sep 2026 12:00:00 GMT",
      })
      res.end(normalCompressed)
      return
    }
    if (mode === "not-modified") {
      res.writeHead(304, {
        "content-type": "text/html",
        "content-length": "73",
        "content-security-policy": "default-src 'self'; script-src 'self'",
        etag: '"current"',
      })
      res.end()
      return
    }
    if (mode === "partial") {
      const partial = '<script src="/partial.js">'
      res.writeHead(206, {
        "content-type": "text/html",
        "content-length": Buffer.byteLength(partial),
        "content-range": `bytes 0-${Buffer.byteLength(partial) - 1}/100`,
      })
      res.end(partial)
      return
    }
    if (mode === "redirect") {
      res.writeHead(302, {
        location: "/proxy/38000/oauth/callback?code=test",
        refresh: "0; url=/proxy/38000/signed-in",
      })
      res.end()
      return
    }
    if (mode === "stream-interrupted") {
      res.writeHead(200, { "content-type": "application/javascript" })
      res.write("const partial = true;")
      setTimeout(() => res.destroy(), 20)
      return
    }
    if (mode === "identity-asset") {
      res.writeHead(200, { "content-type": "application/javascript" })
      res.end("const asset = true;")
      return
    }
    if (mode === "css") {
      res.writeHead(200, {
        "content-type": "text/css",
        "content-encoding": "gzip",
        "content-length": cssCompressed.length,
      })
      res.end(cssCompressed)
      return
    }
    res.writeHead(200, { "content-type": "text/html", "content-length": oversized.length })
    res.end(oversized)
  })
  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket)
    socket.on("close", () => upstreamSockets.delete(socket))
  })
  upstream.on("upgrade", (req, socket, head) => {
    if (mode === "ws-hang") return
    assert.equal(req.headers["x-forwarded-proto"], "http")
    assert.equal(req.headers["x-forwarded-host"], `127.0.0.1:${externalPort}`)
    assert.match(req.headers["x-forwarded-for"], /127\.0\.0\.1/)
    if (mode === "ws-ide") {
      assert.equal(req.url, "/stable-test/vscode?reconnect=1")
      const reply = (data) => {
        assert.equal(data.toString(), "client-to-upstream")
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nupstream-to-client",
        )
      }
      if (head.length) reply(head)
      else socket.once("data", reply)
      return
    }
    assert.equal(req.url, "/proxy/38000/connect-websocket")
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
  })

  const internalPort = await listen(upstream)
  const reservation = http.createServer()
  const externalPort = await listen(reservation)
  await close(reservation)

  const proxy = startProxy(externalPort, internalPort)
  await waitForOutput(proxy, /Cloud IDE proxy listening/)

  const interrupted = await request(externalPort, "/web/38000/")
  assert.equal(interrupted.status, 502)
  assert.match(interrupted.body.toString(), /response was interrupted/)

  mode = "normal"
  const normal = await request(externalPort, "/web/38000/")
  assert.equal(normal.status, 200)
  assert.equal(normalAcceptEncoding, "gzip, deflate, br")
  assert.equal(normal.headers["content-encoding"], undefined)
  assert.equal(Number(normal.headers["content-length"]), normal.body.length)
  assert.equal(normal.headers.etag, undefined)
  assert.equal(normal.headers["last-modified"], undefined)
  assert.equal(normal.headers["cache-control"], "no-store")
  const normalHtml = normal.body.toString()
  const injectedSource = normalHtml.match(/<script data-code-server-antigravity-proxy>([\s\S]*?)<\/script>/)[1]
  const injectedHash = crypto.createHash("sha256").update(injectedSource).digest("base64")
  assert.ok(normal.headers["content-security-policy"].includes(`script-src 'self' 'sha256-${injectedHash}'`))
  assert.match(normalHtml, /data-code-server-antigravity-proxy/)
  assert.match(normalHtml, /<base href="\/web\/38000\/">/)
  assert.match(normalHtml, /src="\/web\/38000\/main\.js"/)

  const directProxyRedirectTarget = await request(externalPort, "/proxy/38000/oauth/callback?code=test")
  assert.match(directProxyRedirectTarget.body.toString(), /data-code-server-antigravity-proxy/)
  assert.match(directProxyRedirectTarget.body.toString(), /src="\/web\/38000\/main\.js"/)

  mode = "redirect"
  const redirect = await request(externalPort, "/web/38000/oauth/start")
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.location, "/web/38000/oauth/callback?code=test")
  assert.equal(redirect.headers.refresh, "0; url=/web/38000/signed-in")

  mode = "identity-asset"
  const identityAsset = await request(externalPort, "/web/38000/main.js", "GET", { "accept-encoding": "identity" })
  assert.equal(observedAcceptEncoding, "identity")
  assert.equal(identityAsset.headers["content-encoding"], undefined)
  assert.equal(identityAsset.body.toString(), "const asset = true;")

  mode = "hang"
  const timedOut = await request(externalPort, "/web/38000/api/hang")
  assert.equal(timedOut.status, 504)
  assert.match(timedOut.body.toString(), /upstream timed out/)

  mode = "identity-asset"
  await request(externalPort, "/web/38000/main.js", "GET", { "accept-encoding": "zstd" })
  assert.equal(observedAcceptEncoding, "identity")

  mode = "css"
  const css = await request(externalPort, "/web/38000/styles.css", "GET", { "accept-encoding": "gzip, zstd" })
  assert.equal(observedAcceptEncoding, "gzip")
  assert.equal(css.headers["content-encoding"], undefined)
  assert.equal(css.body.toString(), "body{background:url(/web/38000/image.png)}")

  const head = await request(externalPort, "/web/38000/", "HEAD")
  assert.equal(head.status, 200)
  assert.equal(head.headers["content-encoding"], undefined)
  assert.equal(head.headers["content-length"], undefined)
  assert.equal(head.body.length, 0)

  mode = "not-modified"
  const notModified = await request(externalPort, "/web/38000/", "GET", {
    "if-modified-since": "Sat, 06 Sep 2026 12:00:00 GMT",
    "if-none-match": '"upstream-html"',
  })
  assert.equal(notModified.status, 304)
  assert.equal(observedIfModifiedSince, undefined)
  assert.equal(observedIfNoneMatch, undefined)
  assert.equal(notModified.headers["content-length"], undefined)
  assert.equal(notModified.headers.etag, undefined)
  assert.equal(notModified.headers["cache-control"], "no-store")
  assert.ok(notModified.headers["content-security-policy"].includes(`'sha256-${injectedHash}'`))
  assert.equal(notModified.body.length, 0)

  mode = "partial"
  const partial = await request(externalPort, "/web/38000/partial.html", "GET", { range: "bytes=0-24" })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers["content-range"], "bytes 0-25/100")
  assert.equal(partial.body.toString(), '<script src="/partial.js">')
  assert.doesNotMatch(partial.body.toString(), /data-code-server-antigravity-proxy/)

  mode = "client-abort"
  await abortUpload(externalPort)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(proxy.exitCode, null)
  mode = "normal"
  assert.equal((await request(externalPort, "/after-client-abort")).status, 200)

  mode = "buffered-client-abort"
  const bufferedStarted = new Promise((resolve) => {
    bufferedResponseStarted = resolve
  })
  const bufferedClosed = new Promise((resolve) => {
    bufferedResponseClosed = resolve
  })
  const abortedDownload = http.get({ hostname: "127.0.0.1", port: externalPort, path: "/web/38000/abort.html" })
  abortedDownload.on("error", () => {})
  await bufferedStarted
  abortedDownload.destroy()
  let bufferedAbortTimer
  await Promise.race([
    bufferedClosed,
    new Promise((_, reject) => {
      bufferedAbortTimer = setTimeout(() => reject(new Error("Buffered upstream survived client abort")), 2000)
    }),
  ])
  clearTimeout(bufferedAbortTimer)
  assert.equal(proxy.exitCode, null)

  mode = "stream-interrupted"
  const interruptedStream = await requestInterruptedStream(externalPort, "/web/38000/main.js")
  assert.equal(interruptedStream.status, 200)
  assert.equal(interruptedStream.body.toString(), "const partial = true;")
  assert.doesNotMatch(interruptedStream.body.toString(), /Cloud IDE upstream unavailable/)
  assert.equal(proxy.exitCode, null)

  mode = "oversized"
  const large = await request(externalPort, "/web/38000/", "GET", { "accept-encoding": "identity" })
  assert.equal(observedAcceptEncoding, "identity")
  assert.equal(large.status, 200)
  assert.equal(large.body.length, oversized.length)
  assert.deepEqual(large.body, oversized)

  mode = "slow-stream"
  const slowStream = await request(externalPort, "/web/38000/slow-stream.js")
  assert.equal(slowStream.status, 200)
  assert.equal(slowStream.body.toString(), "const first = true;const last = true;")

  mode = "normal"
  assert.match(await upgrade(externalPort), /^HTTP\/1\.1 101 Switching Protocols/)
  mode = "ws-ide"
  assert.match(
    await upgrade(externalPort, "/stable-test/vscode?reconnect=1", "client-to-upstream"),
    /upstream-to-client/,
  )
  mode = "ws-hang"
  assert.match(await upgrade(externalPort), /^HTTP\/1\.1 504 Gateway Timeout/)

  mode = "delayed"
  const delayedStarted = new Promise((resolve) => {
    delayedRequestStarted = resolve
  })
  const drainingRequest = request(externalPort, "/web/38000/draining.js")
  await delayedStarted
  const stopped = waitForExit(proxy)
  proxy.kill("SIGINT")
  const drained = await drainingRequest
  assert.equal(drained.status, 200)
  assert.equal(drained.body.toString(), "const drained = true;")
  assert.equal((await stopped).code, 0)

  const occupied = http.createServer()
  const occupiedPort = await listen(occupied)
  const collision = startProxy(occupiedPort, internalPort)
  const collisionExit = waitForExit(collision)
  const collisionOutput = await waitForOutput(collision, /EADDRINUSE/)
  assert.match(collisionOutput, /Unable to listen for cloud IDE traffic/)
  assert.equal((await collisionExit).code, 1)

  await close(occupied)
  for (const socket of upstreamSockets) socket.destroy()
  await close(upstream)

  const startingReservation = http.createServer()
  const startingExternalPort = await listen(startingReservation)
  await close(startingReservation)
  const startingProxy = startProxy(startingExternalPort, internalPort)
  await waitForOutput(startingProxy, /Cloud IDE proxy listening/)
  const starting = await request(startingExternalPort, "/healthz")
  assert.equal(starting.status, 503)
  assert.equal(starting.headers["retry-after"], "1")
  assert.match(starting.body.toString(), /upstream is starting/)
  const startingStopped = waitForExit(startingProxy)
  startingProxy.kill("SIGINT")
  assert.equal((await startingStopped).code, 0)

  console.log("Antigravity proxy lifecycle tests passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
