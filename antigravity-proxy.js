#!/usr/bin/env node

"use strict"

const { spawn } = require("child_process")
const crypto = require("crypto")
const http = require("http")
const net = require("net")
const zlib = require("zlib")

const externalPort = Number(process.env.PORT || 8080)
const internalPort = Number(process.env.CODE_SERVER_INTERNAL_PORT || 8081)
const antigravityPort = Number(process.env.ANTIGRAVITY_SERVER_PORT || 38000)
// Antigravity's hub answers loopback callers only: any other Host header gets
// "Unauthorized Host (Localhost only)". The cloud IDE is reached by its public
// domain and code-server forwards that Host verbatim to the hub, so the UI
// would never render. A loopback relay rewrites the Host on that last hop only.
// code-server still sees the browser's real Host and Origin, which its proxy
// routes check against each other before authenticating the request.
let hostHeaderRelayPort = 0

const mountPattern = /^\/web\/(\d+)(\/.*)?$/
const codeServerProxyPattern = /^\/proxy\/(\d+)(\/.*)?$/
const maxHtmlBytes = 8 * 1024 * 1024
const configuredUpstreamTimeout = Number(process.env.CLOUD_IDE_UPSTREAM_TIMEOUT_MS || 120000)
const upstreamTimeoutMs =
  Number.isInteger(configuredUpstreamTimeout) && configuredUpstreamTimeout >= 10 && configuredUpstreamTimeout <= 600000
    ? configuredUpstreamTimeout
    : 120000

function validatePortPair(external, internal, antigravity = 38000) {
  for (const [name, value] of [
    ["PORT", external],
    ["CODE_SERVER_INTERNAL_PORT", internal],
    ["ANTIGRAVITY_SERVER_PORT", antigravity],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${name} must be an integer from 1 to 65535`)
    }
  }
  if (new Set([external, internal, antigravity]).size !== 3) {
    throw new Error("PORT, CODE_SERVER_INTERNAL_PORT and ANTIGRAVITY_SERVER_PORT must be different")
  }
}

function routeRequestPath(requestPath) {
  const url = new URL(requestPath, "http://code-server.invalid")
  const match = url.pathname.match(mountPattern)
  if (match) {
    const suffix = match[2] || "/"
    return {
      path: `/proxy/${match[1]}${suffix}${url.search}`,
      port: Number(match[1]),
    }
  }

  const proxyMatch = url.pathname.match(codeServerProxyPattern)
  if (proxyMatch) return { path: requestPath, port: Number(proxyMatch[1]) }

  return { path: requestPath, port: undefined }
}

function relayRequestPath(requestPath, port, relayPort) {
  if (port !== antigravityPort || !relayPort || relayPort === antigravityPort) return requestPath
  const prefix = `/proxy/${antigravityPort}`
  if (requestPath !== prefix && !requestPath.startsWith(`${prefix}/`)) return requestPath
  return `/proxy/${relayPort}${requestPath.slice(prefix.length)}`
}

function createHostHeaderRelay(hubPort = antigravityPort) {
  const loopbackHost = `127.0.0.1:${hubPort}`
  const relay = http.createServer((req, res) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: hubPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: loopbackHost },
      },
      (upstreamResponse) => {
        upstreamResponse.on("error", () => res.destroy())
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
        upstreamResponse.pipe(res)
      },
    )
    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const isStarting = error.code === "ECONNREFUSED"
      res.writeHead(isStarting ? 503 : 502, {
        "content-type": "text/plain; charset=utf-8",
        ...(isStarting ? { "retry-after": "1" } : {}),
      })
      res.end(`Antigravity hub ${isStarting ? "is starting" : "unavailable"}: ${error.code || "connection error"}`)
    })
    req.on("error", () => upstream.destroy())
    req.on("aborted", () => upstream.destroy())
    res.on("error", () => {
      upstream.destroy()
      req.destroy()
    })
    req.pipe(upstream)
  })
  relay.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(hubPort, "127.0.0.1", () => {
      const headers = Object.entries({ ...req.headers, host: loopbackHost })
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n")
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on("error", () => socket.destroy())
    upstream.on("close", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
  })
  return relay
}

function browserCompatibilityScriptSource(port) {
  const mount = `/web/${port}`
  return `(function () {
  var mount = ${JSON.stringify(mount)};
  var internalMount = ${JSON.stringify(`/proxy/${port}`)};
  var nativeHistoryReplaceState = history.replaceState.bind(history);
  var nativeHistoryPushState = history.pushState.bind(history);
  var historyGuardInstalled = false;

  function applicationPath(pathname) {
    for (var prefix of [mount, internalMount]) {
      if (pathname === prefix) return "/";
      if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
    }
    return pathname;
  }

  function rewrite(value) {
    try {
      var raw = typeof value === "string"
        ? value
        : value && typeof value.url === "string"
          ? value.url
          : String(value);
      var url = new URL(raw, document.baseURI);
      var isMounted = [mount, internalMount].some(function (prefix) {
        return url.pathname === prefix || url.pathname.startsWith(prefix + "/");
      });
      if (url.host === window.location.host && !isMounted) {
        url.pathname = mount + (url.pathname.startsWith("/") ? url.pathname : "/" + url.pathname);
      }
      return url.toString();
    } catch (_) {
      return value;
    }
  }

  function rewriteSrcset(value) {
    return String(value).split(",").map(function (candidate) {
      var parts = candidate.trim().split(/\\s+/);
      parts[0] = rewrite(parts[0]);
      return parts.join(" ");
    }).join(", ");
  }

  var nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var normalizedName = String(name).toLowerCase();
    if (normalizedName === "href" || normalizedName === "src") value = rewrite(value);
    if (normalizedName === "srcset") value = rewriteSrcset(value);
    return nativeSetAttribute.call(this, name, value);
  };

  function guardUrlProperty(typeName, property, transform) {
    var Type = window[typeName];
    if (typeof Type !== "function") return;
    var descriptor = Object.getOwnPropertyDescriptor(Type.prototype, property);
    if (!descriptor || typeof descriptor.set !== "function") return;
    try {
      Object.defineProperty(Type.prototype, property, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) {
          return descriptor.set.call(this, transform(value));
        }
      });
    } catch (_) {}
  }

  for (var guardedProperty of [
    ["HTMLImageElement", "src", rewrite],
    ["HTMLImageElement", "srcset", rewriteSrcset],
    ["HTMLScriptElement", "src", rewrite],
    ["HTMLLinkElement", "href", rewrite],
    ["HTMLAnchorElement", "href", rewrite],
    ["HTMLIFrameElement", "src", rewrite],
    ["HTMLSourceElement", "src", rewrite],
    ["HTMLSourceElement", "srcset", rewriteSrcset],
    ["HTMLMediaElement", "src", rewrite],
    ["HTMLFormElement", "action", rewrite]
  ]) {
    guardUrlProperty(guardedProperty[0], guardedProperty[1], guardedProperty[2]);
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof Request !== "undefined" && input instanceof Request) {
      var rewrittenUrl = rewrite(input.url);
      return nativeFetch(rewrittenUrl === input.url ? input : new Request(rewrittenUrl, input), init);
    }
    return nativeFetch(rewrite(input), init);
  };

  if (typeof navigator.sendBeacon === "function") {
    var nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeSendBeacon(rewrite(url), data);
    };
  }

  if (navigator.serviceWorker && typeof navigator.serviceWorker.register === "function") {
    var nativeServiceWorkerRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function (scriptUrl, options) {
      var mountedOptions = options;
      if (options && options.scope) {
        mountedOptions = Object.assign({}, options, { scope: rewrite(options.scope) });
      }
      return nativeServiceWorkerRegister(rewrite(scriptUrl), mountedOptions);
    };
  }

  var NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct: function (Target, args) {
      args[0] = rewrite(args[0]);
      return Reflect.construct(Target, args);
    }
  });

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = rewrite(url);
    return nativeOpen.apply(this, arguments);
  };

  if (typeof window.EventSource === "function") {
    var NativeEventSource = window.EventSource;
    window.EventSource = new Proxy(NativeEventSource, {
      construct: function (Target, args) {
        args[0] = rewrite(args[0]);
        return Reflect.construct(Target, args);
      }
    });
  }

  for (var workerName of ["Worker", "SharedWorker"]) {
    if (typeof window[workerName] !== "function") continue;
    var NativeWorker = window[workerName];
    window[workerName] = new Proxy(NativeWorker, {
      construct: function (Target, args) {
        args[0] = rewrite(args[0]);
        return Reflect.construct(Target, args);
      }
    });
  }

  function mountedHistoryUrl(value) {
    if (value === undefined || value === null) return value;
    try {
      var url = new URL(value, document.baseURI);
      if (url.host !== window.location.host) return value;
      var path = applicationPath(url.pathname);
      url.pathname = mount + (path.startsWith("/") ? path : "/" + path);
      return url.pathname + url.search + url.hash;
    } catch (_) {
      return value;
    }
  }

  function installHistoryGuard() {
    if (historyGuardInstalled) return;
    historyGuardInstalled = true;
    history.replaceState = function (state, unused, url) {
      return nativeHistoryReplaceState(state, unused, mountedHistoryUrl(url));
    };
    history.pushState = function (state, unused, url) {
      return nativeHistoryPushState(state, unused, mountedHistoryUrl(url));
    };
  }

  // The Antigravity extension uses in-memory routing, but initializes it from
  // location.pathname. Hide the cloud-only mount from that initial route while
  // keeping all network traffic on the authenticated mount above.
  nativeHistoryReplaceState(
    history.state,
    "",
    applicationPath(window.location.pathname) + window.location.search + window.location.hash
  );
  function restoreMount() {
    var currentPath = applicationPath(window.location.pathname);
    nativeHistoryReplaceState(history.state, "", mount + currentPath + window.location.search + window.location.hash);
    installHistoryGuard();
  }
  // Restoring the mount while the page is alive puts it back in front of the
  // router: Antigravity's bundle mounts long after "load" fires, reads
  // location.pathname then, and renders its "Not Found" route for the mounted
  // path. Keep the application path for the whole session and put the mount
  // back only on the way out, so a reload still lands on the authenticated URL.
  window.addEventListener("pagehide", restoreMount, { once: true });
})();
`
}

function browserCompatibilityScript(port) {
  return `<script data-code-server-antigravity-proxy>${browserCompatibilityScriptSource(port)}</script>`
}

function transformAntigravityHtml(body, port) {
  if (port !== antigravityPort || body.includes("data-code-server-antigravity-proxy")) return body

  const mount = `/web/${port}`
  const mountedAssets = rewriteHtmlAssetPaths(body, port)
  const protectedBlocks = []
  const protectedAssets = mountedAssets.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) => {
    const digest = crypto.createHash("sha256").update(block).digest("hex")
    const token = `__code-server-antigravity-injection-block-${protectedBlocks.length}-${digest}__`
    protectedBlocks.push({ token, block })
    return token
  })
  if (!/<head\b[^>]*>/i.test(protectedAssets) || !/<\/head\s*>/i.test(protectedAssets)) return mountedAssets

  const withMetaCsp = rewriteMetaCsp(protectedAssets, port)
  const withBase = withMetaCsp.replace(/<head\b[^>]*>/i, (head) => `${head}\n<base href="${mount}/">`)
  let transformed = withBase.replace(/<\/head\s*>/i, `${browserCompatibilityScript(port)}\n</head>`)
  for (const protectedBlock of protectedBlocks) {
    transformed = transformed.split(protectedBlock.token).join(protectedBlock.block)
  }
  return transformed
}

function mountRootPath(value, mount) {
  const internalMount = mount.replace(/^\/web\//, "/proxy/")
  if (
    value === mount ||
    value.startsWith(`${mount}/`) ||
    value === internalMount ||
    value.startsWith(`${internalMount}/`)
  ) {
    return value
  }
  return `${mount}${value}`
}

function rewriteHtmlTag(tag, mount) {
  return tag
    .replace(/(\s(?:href|src)=["'])(\/(?!\/)[^"']*)/gi, (_, attribute, value) => {
      return `${attribute}${mountRootPath(value, mount)}`
    })
    .replace(/(\ssrcset=")([^"]*)"/gi, (_, attribute, value) => `${attribute}${rewriteSrcset(value, mount)}"`)
    .replace(/(\ssrcset=')([^']*)'/gi, (_, attribute, value) => `${attribute}${rewriteSrcset(value, mount)}'`)
    .replace(/url\((["']?)(\/(?!\/)[^"')]*)(?=["']?\))/gi, (_, quote, value) => {
      return `url(${quote}${mountRootPath(value, mount)}`
    })
    .replace(/(\scontent=["'][^"']*url=)(\/(?!\/)[^"']*)/gi, (_, attribute, value) => {
      return `${attribute}${mountRootPath(value, mount)}`
    })
}

function rewriteHtmlAssetPaths(body, port) {
  const mount = `/web/${port}`
  const protectedBlocks = []
  const protectedBody = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block, kind) => {
    const openingEnd = block.indexOf(">") + 1
    const closingStart = block.toLowerCase().lastIndexOf("</")
    const opening = rewriteHtmlTag(block.slice(0, openingEnd), mount)
    const content = block.slice(openingEnd, closingStart)
    const protectedContent = kind.toLowerCase() === "style" ? transformAntigravityCss(content, port) : content
    const digest = crypto.createHash("sha256").update(block).digest("hex")
    const token = `__code-server-antigravity-block-${protectedBlocks.length}-${digest}__`
    protectedBlocks.push({ token, value: `${opening}${protectedContent}${block.slice(closingStart)}` })
    return token
  })
  let rewritten = protectedBody.replace(/<[^>]+>/g, (tag) => rewriteHtmlTag(tag, mount))
  for (const protectedBlock of protectedBlocks) {
    rewritten = rewritten.split(protectedBlock.token).join(protectedBlock.value)
  }
  return rewritten
}

function rewriteSrcset(value, mount) {
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/)
      if (parts[0].startsWith("/") && !parts[0].startsWith("//")) parts[0] = mountRootPath(parts[0], mount)
      return parts.join(" ")
    })
    .join(", ")
}

function transformAntigravityCss(body, port) {
  if (port !== antigravityPort) return body
  const mount = `/web/${port}`
  return body.replace(/url\((["']?)(\/(?!\/)[^"')]*)(?=["']?\))/gi, (_, quote, value) => {
    return `url(${quote}${mountRootPath(value, mount)}`
  })
}

function decodeResponseBody(body, encoding) {
  switch (
    String(encoding || "identity")
      .trim()
      .toLowerCase()
  ) {
    case "":
    case "identity":
      return body
    case "gzip":
      return zlib.gunzipSync(body, { maxOutputLength: maxHtmlBytes })
    case "br":
      return zlib.brotliDecompressSync(body, { maxOutputLength: maxHtmlBytes })
    case "deflate":
      try {
        return zlib.inflateSync(body, { maxOutputLength: maxHtmlBytes })
      } catch {
        return zlib.inflateRawSync(body, { maxOutputLength: maxHtmlBytes })
      }
    default:
      return undefined
  }
}

function addCompatibilityHash(policy, hash) {
  if (!policy) return policy
  const source = `'sha256-${hash}'`
  const directives = String(policy).split(";")
  const names = directives.map((directive) => directive.trim().split(/\s+/, 1)[0].toLowerCase())
  let target = names.indexOf("script-src-elem")
  if (target === -1) target = names.indexOf("script-src")
  if (target === -1) target = names.indexOf("default-src")
  if (target !== -1) {
    const directive = directives[target]
    const unsafeInlineIsEffective =
      directive.includes("'unsafe-inline'") && !/'nonce-[^']+'|'sha(?:256|384|512)-[^']+'/.test(directive)
    if (!unsafeInlineIsEffective && !directive.includes(source)) directives[target] += ` ${source}`
  }
  const baseUri = names.indexOf("base-uri")
  if (baseUri !== -1) {
    const sources = directives[baseUri].trim().split(/\s+/)
    const allowed = sources.slice(1).filter((item) => item !== "'none'")
    if (!allowed.includes("'self'")) allowed.push("'self'")
    directives[baseUri] = `base-uri ${allowed.join(" ")}`
  }
  return directives.join(";")
}

function compatibilityHash(port) {
  return crypto.createHash("sha256").update(browserCompatibilityScriptSource(port)).digest("base64")
}

function rewriteMetaCsp(body, port) {
  const hash = compatibilityHash(port)
  return body.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!/\shttp-equiv=(?:["']content-security-policy["']|content-security-policy)(?=\s|\/?>)/i.test(tag)) return tag
    return tag.replace(/(\scontent=(["']))(.*?)\2/i, (_, prefix, quote, policy) => {
      return `${prefix}${addCompatibilityHash(policy, hash)}${quote}`
    })
  })
}

function addCompatibilityCsp(headers, port) {
  const hash = compatibilityHash(port)
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    if (Array.isArray(headers[name])) headers[name] = headers[name].map((policy) => addCompatibilityHash(policy, hash))
    else if (headers[name]) headers[name] = addCompatibilityHash(headers[name], hash)
  }
}

function disableTransformedCaching(headers) {
  delete headers.etag
  delete headers["last-modified"]
  delete headers.expires
  headers["cache-control"] = "no-store"
}

function forwardHeaders(headers, body, port, compatibilityScriptInjected = true) {
  const forwarded = rewriteMountedResponseHeaders(stripHopByHopHeaders(headers), port)
  delete forwarded["content-encoding"]
  delete forwarded["transfer-encoding"]
  if (compatibilityScriptInjected) addCompatibilityCsp(forwarded, port)
  disableTransformedCaching(forwarded)
  forwarded["content-length"] = Buffer.byteLength(body)
  return forwarded
}

function rewriteMountedUrl(value, port) {
  const mount = `/web/${port}`
  const internalMount = `/proxy/${port}`
  const source = String(value)
  if (source === internalMount || source.startsWith(`${internalMount}/`) || source.startsWith(`${internalMount}?`)) {
    return `${mount}${source.slice(internalMount.length)}`
  }

  try {
    const url = new URL(source)
    if (url.pathname === internalMount || url.pathname.startsWith(`${internalMount}/`)) {
      url.pathname = `${mount}${url.pathname.slice(internalMount.length)}`
      return url.toString()
    }
  } catch {
    // Relative redirects already resolve below the mounted request path.
  }
  return source
}

function rewriteMountedResponseHeaders(headers, port) {
  if (!Number.isInteger(port)) return headers
  const rewritten = { ...headers }
  if (rewritten.location) {
    rewritten.location = Array.isArray(rewritten.location)
      ? rewritten.location.map((value) => rewriteMountedUrl(value, port))
      : rewriteMountedUrl(rewritten.location, port)
  }
  if (rewritten.refresh) {
    const rewriteRefresh = (value) =>
      String(value).replace(
        /(\burl\s*=\s*)(["']?)([^"'\s;]+)\2/i,
        (_, prefix, quote, url) => `${prefix}${quote}${rewriteMountedUrl(url, port)}${quote}`,
      )
    rewritten.refresh = Array.isArray(rewritten.refresh)
      ? rewritten.refresh.map(rewriteRefresh)
      : rewriteRefresh(rewritten.refresh)
  }
  return rewritten
}

function forwardedRequestHeaders(req) {
  const headers = { ...req.headers }
  const remoteAddress = req.socket.remoteAddress
  if (remoteAddress) {
    const existing = Array.isArray(headers["x-forwarded-for"])
      ? headers["x-forwarded-for"].join(", ")
      : headers["x-forwarded-for"]
    headers["x-forwarded-for"] = existing ? `${existing}, ${remoteAddress}` : remoteAddress
  }
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http"
  if (!headers["x-forwarded-host"] && headers.host) headers["x-forwarded-host"] = headers.host
  return headers
}

function supportedAcceptEncoding(value) {
  if (!value) return "gzip, deflate, br"
  const preferences = new Map()
  for (const part of String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [name, ...parameters] = part
      .toLowerCase()
      .split(";")
      .map((item) => item.trim())
    const qualityParameter = parameters.find((parameter) => parameter.startsWith("q="))
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1
    preferences.set(name, Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : 0)
  }
  const wildcard = preferences.get("*")
  const compressed = ["gzip", "deflate", "br"].flatMap((name) => {
    const quality = preferences.has(name) ? preferences.get(name) : (wildcard ?? 0)
    if (!quality) return []
    return [quality === 1 ? name : `${name};q=${quality}`]
  })
  if (compressed.length) return compressed.join(", ")

  const identityQuality = preferences.has("identity") ? preferences.get("identity") : wildcard === 0 ? 0 : 1
  return identityQuality ? (identityQuality === 1 ? "identity" : `identity;q=${identityQuality}`) : "identity;q=0"
}

function stripHopByHopHeaders(headers) {
  const stripped = { ...headers }
  const connectionTokens = String(stripped.connection || "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  for (const name of [
    ...connectionTokens,
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete stripped[name]
  }
  return stripped
}

function codeServerEnvironment(environment, port) {
  const childEnvironment = {
    ...environment,
    CLOUD_IDE_EXTERNAL_PORT: String(port),
    VSCODE_PROXY_URI: "/web/{{port}}/",
  }
  delete childEnvironment.PORT
  return childEnvironment
}

function proxyHttp(req, res) {
  const routed = routeRequestPath(req.url || "/")
  const headers = stripHopByHopHeaders(forwardedRequestHeaders(req))
  if (routed.port === antigravityPort) {
    headers["accept-encoding"] = supportedAcceptEncoding(req.headers["accept-encoding"])
    delete headers["if-none-match"]
    delete headers["if-modified-since"]
  }
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: internalPort,
      method: req.method,
      path: relayRequestPath(routed.path, routed.port, hostHeaderRelayPort),
      headers,
    },
    (upstreamResponse) => {
      // This bounds connection/time-to-first-byte only. Long-running agent
      // streams must remain open after the upstream has started responding.
      upstream.setTimeout(0)
      res.on("error", () => upstreamResponse.destroy())
      const contentType = String(upstreamResponse.headers["content-type"] || "")
      const statusCode = upstreamResponse.statusCode || 502
      const responseHasBody = req.method !== "HEAD" && statusCode !== 204 && statusCode !== 304
      const isHtml = contentType.includes("text/html")
      const isCss = contentType.includes("text/css")
      if (routed.port === antigravityPort && !responseHasBody) {
        const bodylessHeaders = rewriteMountedResponseHeaders(
          stripHopByHopHeaders(upstreamResponse.headers),
          routed.port,
        )
        delete bodylessHeaders["content-encoding"]
        delete bodylessHeaders["content-length"]
        if (isHtml) addCompatibilityCsp(bodylessHeaders, routed.port)
        if (isHtml || isCss) disableTransformedCaching(bodylessHeaders)
        upstreamResponse.on("error", () => res.destroy())
        res.writeHead(statusCode, bodylessHeaders)
        upstreamResponse.pipe(res)
        return
      }
      if (routed.port === antigravityPort && responseHasBody && statusCode !== 206 && (isHtml || isCss)) {
        const chunks = []
        let size = 0
        let finished = false
        res.on("close", () => {
          if (res.writableEnded || finished) return
          finished = true
          upstream.destroy()
          upstreamResponse.destroy()
        })
        const failBufferedResponse = () => {
          if (finished) return
          finished = true
          if (!res.headersSent)
            res.writeHead(upstreamTimedOut ? 504 : 502, { "content-type": "text/plain; charset=utf-8" })
          res.end(upstreamTimedOut ? "Antigravity UI response timed out" : "Antigravity UI response was interrupted")
        }
        const handleEnd = () => {
          if (finished) return
          finished = true
          const rawBody = Buffer.concat(chunks)
          let decodedBody
          try {
            decodedBody = decodeResponseBody(rawBody, upstreamResponse.headers["content-encoding"])
          } catch {
            decodedBody = undefined
          }
          if (!decodedBody) {
            console.warn(`Unable to transform Antigravity response at ${new URL(routed.path, "http://local").pathname}`)
            res.writeHead(
              upstreamResponse.statusCode || 502,
              rewriteMountedResponseHeaders(stripHopByHopHeaders(upstreamResponse.headers), routed.port),
            )
            res.end(rawBody)
            return
          }
          const sourceBody = decodedBody.toString("utf8")
          const body = isHtml
            ? transformAntigravityHtml(sourceBody, routed.port)
            : transformAntigravityCss(sourceBody, routed.port)
          const compatibilityScriptInjected =
            !sourceBody.includes("data-code-server-antigravity-proxy") &&
            body.includes("data-code-server-antigravity-proxy")
          res.writeHead(
            upstreamResponse.statusCode || 502,
            forwardHeaders(upstreamResponse.headers, body, routed.port, compatibilityScriptInjected),
          )
          res.end(body)
        }
        const handleData = (chunk) => {
          if (finished) return
          size += chunk.length
          chunks.push(chunk)
          if (size <= maxHtmlBytes) return

          // Preserve availability if a future Antigravity release grows a
          // large inline document. It may lose path rewriting, but it must not
          // turn an otherwise valid upstream response into a synthetic 502.
          finished = true
          console.warn(
            `Antigravity response at ${new URL(routed.path, "http://local").pathname} exceeded ${maxHtmlBytes} bytes; forwarding unchanged`,
          )
          upstreamResponse.removeListener("error", failBufferedResponse)
          upstreamResponse.removeListener("aborted", failBufferedResponse)
          upstreamResponse.removeListener("data", handleData)
          upstreamResponse.removeListener("end", handleEnd)
          upstreamResponse.on("error", () => res.destroy())
          res.writeHead(
            upstreamResponse.statusCode || 502,
            rewriteMountedResponseHeaders(stripHopByHopHeaders(upstreamResponse.headers), routed.port),
          )
          for (const buffered of chunks) res.write(buffered)
          upstreamResponse.pipe(res)
        }
        upstreamResponse.on("error", failBufferedResponse)
        upstreamResponse.on("aborted", failBufferedResponse)
        upstreamResponse.on("data", handleData)
        upstreamResponse.on("end", handleEnd)
        return
      }

      upstreamResponse.on("error", () => res.destroy())
      res.writeHead(
        upstreamResponse.statusCode || 502,
        rewriteMountedResponseHeaders(stripHopByHopHeaders(upstreamResponse.headers), routed.port),
      )
      upstreamResponse.pipe(res)
    },
  )

  let upstreamTimedOut = false
  upstream.setTimeout(upstreamTimeoutMs, () => {
    upstreamTimedOut = true
    const timeoutError = new Error("Cloud IDE upstream timed out")
    timeoutError.code = "ETIMEDOUT"
    upstream.destroy(timeoutError)
  })

  req.on("error", () => upstream.destroy())
  res.on("error", () => {
    upstream.destroy()
    req.destroy()
  })
  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const isStarting = error.code === "ECONNREFUSED"
    const statusCode = upstreamTimedOut ? 504 : isStarting ? 503 : 502
    res.writeHead(statusCode, {
      "content-type": "text/plain; charset=utf-8",
      ...(isStarting ? { "retry-after": "1" } : {}),
    })
    const state = upstreamTimedOut ? "timed out" : isStarting ? "is starting" : "unavailable"
    res.end(`Cloud IDE upstream ${state}: ${error.code || "connection error"}`)
  })
  req.on("aborted", () => upstream.destroy())
  req.pipe(upstream)
}

function proxyWebSocket(req, socket, head) {
  const routed = routeRequestPath(req.url || "/")
  let handshakeReceived = false
  const upstream = net.connect(internalPort, "127.0.0.1", () => {
    const headers = Object.entries(forwardedRequestHeaders(req))
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n")
    const upstreamPath = relayRequestPath(routed.path, routed.port, hostHeaderRelayPort)
    upstream.write(`${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.setTimeout(upstreamTimeoutMs, () => {
    if (!handshakeReceived && !socket.destroyed) {
      socket.end("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    }
    upstream.destroy()
  })
  upstream.once("data", () => {
    handshakeReceived = true
    upstream.setTimeout(0)
  })

  upstream.on("error", () => socket.destroy())
  upstream.on("close", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
  socket.on("close", () => upstream.destroy())
}

function main() {
  validatePortPair(externalPort, internalPort, antigravityPort)
  const codeServerArgs = process.argv.slice(2)
  if (!codeServerArgs.length) throw new Error("Expected the code-server executable and arguments")

  const codeServer = spawn(codeServerArgs[0], codeServerArgs.slice(1), {
    env: codeServerEnvironment(process.env, externalPort),
    stdio: "inherit",
  })

  const hostHeaderRelay = createHostHeaderRelay()
  hostHeaderRelay.on("error", (error) => {
    // Without the relay the hub still answers loopback callers, so keep the IDE
    // running and let Antigravity report its own unauthorized-host page.
    hostHeaderRelayPort = 0
    console.error(`Antigravity host header relay unavailable: ${error.code || "server error"}`)
  })
  hostHeaderRelay.listen(0, "127.0.0.1", () => {
    hostHeaderRelayPort = hostHeaderRelay.address().port
    console.log(`Antigravity host header relay listening on 127.0.0.1:${hostHeaderRelayPort}`)
  })

  const server = http.createServer(proxyHttp)
  const sockets = new Set()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("upgrade", proxyWebSocket)
  server.listen(externalPort, "0.0.0.0", () => console.log(`Cloud IDE proxy listening on 0.0.0.0:${externalPort}`))

  let terminating = false
  let serverClosing = false
  let serverClosed = false
  let forceCloseTimer
  const closeCallbacks = []
  const finishServerClose = () => {
    serverClosing = false
    serverClosed = true
    if (forceCloseTimer) clearTimeout(forceCloseTimer)
    forceCloseTimer = undefined
    for (const callback of closeCallbacks.splice(0)) callback()
  }
  const closeServer = (callback, force = false) => {
    if (serverClosed) {
      if (callback) callback()
      return
    }
    if (callback) closeCallbacks.push(callback)
    if (force) {
      for (const socket of sockets) socket.destroy()
    }
    if (serverClosing) return
    if (!server.listening) {
      finishServerClose()
      return
    }
    serverClosing = true
    server.close(finishServerClose)
  }
  server.on("error", (error) => {
    console.error(`Unable to listen for cloud IDE traffic: ${error.code || "server error"}`)
    if (!codeServer.killed) codeServer.kill("SIGTERM")
    closeServer(() => process.exit(1), true)
  })
  const shutdown = (signal) => {
    terminating = true
    hostHeaderRelay.close()
    if (!forceCloseTimer) {
      forceCloseTimer = setTimeout(() => closeServer(undefined, true), 5000)
    }
    closeServer()
    if (!codeServer.killed) codeServer.kill(signal)
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
  codeServer.on("error", (error) => {
    console.error(`Unable to start code-server: ${error.code || "process error"}`)
    closeServer(() => process.exit(1), true)
  })
  codeServer.on("exit", (code, signal) =>
    closeServer(() => process.exit(terminating ? 0 : (code ?? (signal ? 1 : 0))), !terminating),
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

module.exports = {
  browserCompatibilityScript,
  createHostHeaderRelay,
  browserCompatibilityScriptSource,
  codeServerEnvironment,
  compatibilityHash,
  decodeResponseBody,
  forwardHeaders,
  forwardedRequestHeaders,
  rewriteMetaCsp,
  relayRequestPath,
  rewriteMountedResponseHeaders,
  routeRequestPath,
  stripHopByHopHeaders,
  supportedAcceptEncoding,
  transformAntigravityCss,
  transformAntigravityHtml,
  validatePortPair,
}
