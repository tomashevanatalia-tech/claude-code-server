#!/usr/bin/env node

"use strict"

const assert = require("assert/strict")
const vm = require("vm")
const zlib = require("zlib")
const {
  browserCompatibilityScript,
  browserCompatibilityScriptSource,
  codeServerEnvironment,
  compatibilityHash,
  decodeResponseBody,
  forwardHeaders,
  forwardedRequestHeaders,
  routeRequestPath,
  rewriteMetaCsp,
  rewriteMountedResponseHeaders,
  stripHopByHopHeaders,
  supportedAcceptEncoding,
  transformAntigravityCss,
  transformAntigravityHtml,
  validatePortPair,
} = require("../antigravity-proxy")

async function main() {
  assert.doesNotThrow(() => validatePortPair(8080, 8081))
  assert.throws(() => validatePortPair(8081, 8081), /must be different/)
  assert.throws(() => validatePortPair(0, 8081), /PORT must be an integer/)
  assert.throws(() => validatePortPair(8080, 8081, Number.NaN), /ANTIGRAVITY_SERVER_PORT must be an integer/)
  assert.throws(() => validatePortPair(8080, 8081, 8080), /must be different/)

  assert.deepEqual(routeRequestPath("/healthz?x=1"), { path: "/healthz?x=1", port: undefined })
  assert.deepEqual(routeRequestPath("/web/38000/?extensionView=true"), {
    path: "/proxy/38000/?extensionView=true",
    port: 38000,
  })
  assert.deepEqual(routeRequestPath("/web/38000/connect-websocket"), {
    path: "/proxy/38000/connect-websocket",
    port: 38000,
  })
  assert.deepEqual(routeRequestPath("/proxy/38000/oauth/callback?code=test"), {
    path: "/proxy/38000/oauth/callback?code=test",
    port: 38000,
  })
  const childEnvironment = codeServerEnvironment({ PORT: "8080", KEEP_ME: "yes" }, 8080)
  assert.equal(Object.hasOwn(childEnvironment, "PORT"), false)
  assert.equal(childEnvironment.CLOUD_IDE_EXTERNAL_PORT, "8080")
  assert.equal(childEnvironment.VSCODE_PROXY_URI, "/web/{{port}}/")
  assert.equal(childEnvironment.KEEP_ME, "yes")

  const source = `<html><head>
  <link href="/compiled.css">
  <link href="//cdn.example/styles.css">
  <script>if (a<b&&c>d) { const example = 'src="/leave-inline-code-alone.js"' }</script>
  <style>.inline { background: url(/inline.png) }</style>
</head><body><script src="/main.js"></script></body></html>`
  const transformed = transformAntigravityHtml(source, 38000)
  assert.match(transformed, /href="\/web\/38000\/compiled\.css"/)
  assert.match(transformed, /src="\/web\/38000\/main\.js"/)
  assert.match(transformed, /href="\/\/cdn\.example\/styles\.css"/)
  assert.match(transformed, /src="\/leave-inline-code-alone\.js"/)
  assert.match(transformed, /if \(a<b&&c>d\)/)
  assert.match(transformed, /url\(\/web\/38000\/inline\.png\)/)
  assert.match(transformed, /data-code-server-antigravity-proxy/)
  assert.match(transformed, /<base href="\/web\/38000\/">/)
  assert.match(transformed, /history\.replaceState/)
  assert.doesNotMatch(transformed, /isRemoteControl = true/)
  assert.match(transformed, /"Worker", "SharedWorker"/)
  assert.match(transformed, /new Proxy\(NativeWebSocket/)
  assert.match(
    transformAntigravityHtml('<html><head><link href="/a.css" src="/b.js"></head></html>', 38000),
    /href="\/web\/38000\/a\.css" src="\/web\/38000\/b\.js"/,
  )
  const richAssets = transformAntigravityHtml(
    '<html><head><img srcset="/small.png 1x, /large.png 2x" style="background:url(/background.png)"><meta http-equiv="refresh" content="0;url=/next"></head></html>',
    38000,
  )
  assert.match(richAssets, /srcset="\/web\/38000\/small\.png 1x, \/web\/38000\/large\.png 2x"/)
  assert.match(richAssets, /url\(\/web\/38000\/background\.png\)/)
  assert.match(richAssets, /content="0;url=\/web\/38000\/next"/)
  assert.equal(transformAntigravityHtml(transformed, 38000), transformed)
  assert.equal(transformAntigravityHtml(source, 38001), source)
  const inlineClosingHead = transformAntigravityHtml(
    '<html><head><script>const template = "</head>";</script></head><body></body></html>',
    38000,
  )
  assert.ok(inlineClosingHead.indexOf("</script>") < inlineClosingHead.indexOf("data-code-server-antigravity-proxy"))
  assert.match(inlineClosingHead, /const template = "<\/head>";/)
  assert.match(browserCompatibilityScript(38000), /var mount = "\/web\/38000"/)
  assert.match(browserCompatibilityScriptSource(38000), /var mount = "\/web\/38000"/)
  assert.match(browserCompatibilityScript(38000), /\[mount, internalMount\]\.some/)
  assert.match(browserCompatibilityScript(38000), /addEventListener\("load"/)
  assert.match(browserCompatibilityScript(38000), /applicationPath\(window\.location\.pathname\)/)
  assert.match(browserCompatibilityScript(38000), /mount \+ currentPath/)
  assert.match(browserCompatibilityScript(38000), /setAttribute/)
  assert.match(browserCompatibilityScript(38000), /setTimeout\(restoreMount, 10000\)/)

  const browserEvents = {}
  const browserLocation = {
    host: "ide.example",
    pathname: "/web/38000/open/conversation",
    search: "?thread=7",
    hash: "#message",
  }
  const applyBrowserUrl = (value) => {
    const current = `https://${browserLocation.host}${browserLocation.pathname}${browserLocation.search}${browserLocation.hash}`
    const url = new URL(value, current)
    browserLocation.pathname = url.pathname
    browserLocation.search = url.search
    browserLocation.hash = url.hash
  }
  const browserHistory = {
    state: null,
    replaceState(state, _unused, url) {
      this.state = state
      applyBrowserUrl(url)
    },
    pushState(state, _unused, url) {
      this.state = state
      applyBrowserUrl(url)
    },
  }
  function MockElement() {}
  MockElement.prototype.setAttribute = function (name, value) {
    this.attributes ||= {}
    this.attributes[name] = value
  }
  function MockXmlHttpRequest() {}
  MockXmlHttpRequest.prototype.open = function () {}
  function MockImageElement() {}
  function MockAnchorElement() {}
  const defineMockUrlProperty = (Type, property) => {
    Object.defineProperty(Type.prototype, property, {
      configurable: true,
      get() {
        return this[`_${property}`]
      },
      set(value) {
        this[`_${property}`] = value
      },
    })
  }
  defineMockUrlProperty(MockImageElement, "src")
  defineMockUrlProperty(MockImageElement, "srcset")
  defineMockUrlProperty(MockAnchorElement, "href")
  const browserFetches = []
  const browserBeacons = []
  const browserServiceWorkers = []
  const browserWebSockets = []
  const browserWorkers = []
  const browserSharedWorkers = []
  function MockWebSocket(url) {
    browserWebSockets.push(url)
  }
  function MockWorker(url) {
    browserWorkers.push(url)
  }
  function MockSharedWorker(url) {
    browserSharedWorkers.push(url)
  }
  const mockNavigator = {
    serviceWorker: {
      register(url, options) {
        browserServiceWorkers.push({ url, options })
      },
    },
    sendBeacon(url) {
      browserBeacons.push(url)
      return true
    },
  }
  const mockWindow = {
    HTMLAnchorElement: MockAnchorElement,
    HTMLImageElement: MockImageElement,
    location: browserLocation,
    navigator: mockNavigator,
    history: browserHistory,
    fetch(input) {
      browserFetches.push(input)
    },
    SharedWorker: MockSharedWorker,
    WebSocket: MockWebSocket,
    Worker: MockWorker,
    addEventListener(name, callback) {
      browserEvents[name] = callback
    },
  }
  vm.runInNewContext(browserCompatibilityScriptSource(38000), {
    document: { baseURI: "https://ide.example/web/38000/" },
    Element: MockElement,
    Request,
    XMLHttpRequest: MockXmlHttpRequest,
    URL,
    history: browserHistory,
    navigator: mockNavigator,
    setTimeout() {},
    window: mockWindow,
  })
  assert.equal(browserLocation.pathname, "/open/conversation")
  browserHistory.replaceState({}, "", "/conversation/42?thread=8#latest")
  browserEvents.load()
  assert.equal(browserLocation.pathname, "/web/38000/conversation/42")
  assert.equal(browserLocation.search, "?thread=8")
  assert.equal(browserLocation.hash, "#latest")
  mockWindow.fetch("assets/app.js")
  mockWindow.fetch("/api/session")
  mockWindow.fetch("/web/38000/already-mounted")
  mockWindow.fetch("/proxy/38000/internal-mounted")
  mockWindow.fetch("//cdn.example/library.js")
  mockWindow.fetch("data:text/plain,hello")
  mockWindow.fetch(new URL("/api/url-object", "https://ide.example"))
  assert.deepEqual(browserFetches, [
    "https://ide.example/web/38000/assets/app.js",
    "https://ide.example/web/38000/api/session",
    "https://ide.example/web/38000/already-mounted",
    "https://ide.example/proxy/38000/internal-mounted",
    "https://cdn.example/library.js",
    "data:text/plain,hello",
    "https://ide.example/web/38000/api/url-object",
  ])
  const postRequest = new Request("https://ide.example/web/38000/api/save", { method: "POST", body: "payload" })
  mockWindow.fetch(postRequest)
  assert.equal(browserFetches.at(-1), postRequest)
  assert.equal(postRequest.method, "POST")
  assert.equal(postRequest.bodyUsed, false)
  const rootPostRequest = new Request("https://ide.example/api/save", { method: "POST", body: "payload" })
  mockWindow.fetch(rootPostRequest)
  const rewrittenPostRequest = browserFetches.at(-1)
  assert.notEqual(rewrittenPostRequest, rootPostRequest)
  assert.equal(rewrittenPostRequest.url, "https://ide.example/web/38000/api/save")
  assert.equal(rewrittenPostRequest.method, "POST")
  assert.equal(await rewrittenPostRequest.text(), "payload")
  const mockImage = new MockElement()
  mockImage.setAttribute("src", "assets/image.png")
  assert.equal(mockImage.attributes.src, "https://ide.example/web/38000/assets/image.png")
  const propertyImage = new MockImageElement()
  propertyImage.src = "/property-image.png"
  propertyImage.srcset = "/small.png 1x, /large.png 2x"
  assert.equal(propertyImage.src, "https://ide.example/web/38000/property-image.png")
  assert.equal(
    propertyImage.srcset,
    "https://ide.example/web/38000/small.png 1x, https://ide.example/web/38000/large.png 2x",
  )
  const propertyAnchor = new MockAnchorElement()
  propertyAnchor.href = "/property-link"
  assert.equal(propertyAnchor.href, "https://ide.example/web/38000/property-link")
  mockNavigator.sendBeacon("/telemetry", "payload")
  mockNavigator.sendBeacon(new URL("/url-beacon", "https://ide.example"), "payload")
  assert.deepEqual(browserBeacons, [
    "https://ide.example/web/38000/telemetry",
    "https://ide.example/web/38000/url-beacon",
  ])
  new mockWindow.WebSocket(new URL("/socket", "https://ide.example"))
  new mockWindow.Worker(new URL("./worker.js", "https://ide.example/web/38000/"))
  new mockWindow.SharedWorker(new URL("/shared-worker.js", "https://ide.example"))
  assert.deepEqual(browserWebSockets, ["https://ide.example/web/38000/socket"])
  assert.deepEqual(browserWorkers, ["https://ide.example/web/38000/worker.js"])
  assert.deepEqual(browserSharedWorkers, ["https://ide.example/web/38000/shared-worker.js"])
  mockNavigator.serviceWorker.register(new URL("/service-worker.js", "https://ide.example"), { scope: "/app/" })
  assert.equal(browserServiceWorkers.length, 1)
  assert.equal(browserServiceWorkers[0].url, "https://ide.example/web/38000/service-worker.js")
  assert.equal(browserServiceWorkers[0].options.scope, "https://ide.example/web/38000/app/")
  browserHistory.pushState({}, "", "/conversation/43?thread=9#new")
  assert.equal(browserLocation.pathname, "/web/38000/conversation/43")
  assert.equal(browserLocation.search, "?thread=9")
  assert.equal(browserLocation.hash, "#new")
  browserEvents.pagehide()
  assert.equal(browserLocation.pathname, "/web/38000/conversation/43")
  assert.match(transformAntigravityHtml('<html><head lang="en"></head></html>', 38000), /<base href="\/web\/38000\/">/)
  assert.equal(
    transformAntigravityHtml('<html><body><img src="/without-head.png"></body></html>', 38000),
    '<html><body><img src="/web/38000/without-head.png"></body></html>',
  )
  assert.equal(decodeResponseBody(Buffer.from("plain"), "identity").toString(), "plain")
  assert.equal(decodeResponseBody(zlib.gzipSync("compressed"), "gzip").toString(), "compressed")
  assert.equal(decodeResponseBody(zlib.brotliCompressSync("brotli"), "br").toString(), "brotli")
  assert.equal(decodeResponseBody(zlib.deflateSync("deflated"), "deflate").toString(), "deflated")
  assert.equal(decodeResponseBody(zlib.deflateRawSync("raw-deflated"), "deflate").toString(), "raw-deflated")
  assert.equal(decodeResponseBody(Buffer.from("unknown"), "custom"), undefined)

  const securedHeaders = forwardHeaders(
    {
      "content-encoding": "gzip",
      "content-security-policy": "default-src 'self'; script-src 'self'",
      "content-security-policy-report-only": "default-src 'none'",
    },
    "changed",
    38000,
  )
  assert.equal(securedHeaders["content-encoding"], undefined)
  assert.equal(securedHeaders["content-length"], 7)
  assert.match(securedHeaders["content-security-policy"], /script-src 'self' 'sha256-[^']+'/)
  assert.match(securedHeaders["content-security-policy-report-only"], /default-src 'none' 'sha256-[^']+'/)
  assert.equal(securedHeaders["cache-control"], "no-store")

  const restrictedBasePolicy = forwardHeaders(
    { "content-security-policy": "default-src 'self'; base-uri 'none'" },
    "changed",
    38000,
  )["content-security-policy"]
  assert.match(restrictedBasePolicy, /base-uri 'self'/)
  assert.doesNotMatch(restrictedBasePolicy, /base-uri 'none'/)

  const elementPolicy = forwardHeaders(
    { "content-security-policy": "script-src 'self'; script-src-elem 'self'" },
    "changed",
    38000,
  )["content-security-policy"]
  assert.match(elementPolicy, /script-src 'self'; script-src-elem 'self' 'sha256-[^']+'/)

  const unsafeInlinePolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'"
  assert.equal(
    forwardHeaders({ "content-security-policy": unsafeInlinePolicy }, "changed", 38000)["content-security-policy"],
    unsafeInlinePolicy,
  )

  assert.deepEqual(
    forwardedRequestHeaders({
      headers: { host: "ide.example", "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    {
      host: "ide.example",
      "x-forwarded-for": "203.0.113.8, 127.0.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "ide.example",
    },
  )
  assert.deepEqual(
    rewriteMountedResponseHeaders(
      {
        location: "/proxy/38000/oauth/callback?code=test",
        refresh: "0; url='/proxy/38000/signed-in'",
        "x-unrelated": "kept",
      },
      38000,
    ),
    {
      location: "/web/38000/oauth/callback?code=test",
      refresh: "0; url='/web/38000/signed-in'",
      "x-unrelated": "kept",
    },
  )
  assert.equal(
    rewriteMountedResponseHeaders({ location: "/login?to=%2Fproxy%2F38000%2F" }, 38000).location,
    "/login?to=%2Fproxy%2F38000%2F",
  )
  assert.equal(
    rewriteMountedResponseHeaders({ location: "https://accounts.google.com/o/oauth2/auth" }, 38000).location,
    "https://accounts.google.com/o/oauth2/auth",
  )
  assert.equal(
    rewriteMountedResponseHeaders({ location: "/proxy/3000/dashboard" }, 3000).location,
    "/web/3000/dashboard",
  )
  assert.equal(supportedAcceptEncoding(undefined), "gzip, deflate, br")
  assert.equal(supportedAcceptEncoding("gzip, deflate, br, zstd"), "gzip, deflate, br")
  assert.equal(supportedAcceptEncoding("identity"), "identity")
  assert.equal(supportedAcceptEncoding("zstd"), "identity")
  assert.equal(supportedAcceptEncoding("gzip;q=0, *;q=0.5"), "deflate;q=0.5, br;q=0.5")
  assert.equal(supportedAcceptEncoding("identity;q=0, zstd"), "identity;q=0")
  assert.equal(
    transformAntigravityCss('body{background:url(/image.png)} .x{src:url("//cdn.example/font.woff")}', 38000),
    'body{background:url(/web/38000/image.png)} .x{src:url("//cdn.example/font.woff")}',
  )
  const alreadyMountedAssets = transformAntigravityHtml(
    '<html><head><link href="/web/38000/app.css"><script src="/proxy/38000/app.js"></script><style>.x{background:url(/proxy/38000/image.png)}</style></head></html>',
    38000,
  )
  assert.doesNotMatch(alreadyMountedAssets, /\/web\/38000\/(?:web|proxy)\/38000/)
  assert.match(alreadyMountedAssets, /href="\/web\/38000\/app\.css"/)
  assert.match(alreadyMountedAssets, /src="\/proxy\/38000\/app\.js"/)
  assert.match(alreadyMountedAssets, /url\(\/proxy\/38000\/image\.png\)/)
  assert.deepEqual(
    stripHopByHopHeaders({
      connection: "keep-alive, x-remove-me",
      "keep-alive": "timeout=5",
      "x-remove-me": "yes",
      upgrade: "websocket",
      host: "ide.example",
    }),
    { host: "ide.example" },
  )
  assert.equal(
    forwardHeaders({ "content-security-policy": "script-src 'self'" }, "unchanged", 38000, false)[
      "content-security-policy"
    ],
    "script-src 'self'",
  )

  const metaPolicy = "default-src 'self'; script-src 'self'"
  const metaSource = `<html><head><meta http-equiv="Content-Security-Policy" content="${metaPolicy}"></head></html>`
  const metaTransformed = transformAntigravityHtml(metaSource, 38000)
  assert.ok(metaTransformed.includes(`script-src 'self' 'sha256-${compatibilityHash(38000)}'`))
  const unquotedMetaTransformed = transformAntigravityHtml(
    `<html><head><meta http-equiv=Content-Security-Policy content="${metaPolicy}"></head></html>`,
    38000,
  )
  assert.ok(unquotedMetaTransformed.includes(`script-src 'self' 'sha256-${compatibilityHash(38000)}'`))
  assert.equal(
    rewriteMetaCsp(`<meta http-equiv="Content-Security-Policy" content="${unsafeInlinePolicy}">`, 38000),
    `<meta http-equiv="Content-Security-Policy" content="${unsafeInlinePolicy}">`,
  )

  console.log("Antigravity cloud proxy tests passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
