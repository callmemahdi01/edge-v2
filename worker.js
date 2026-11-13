import { connect } from "cloudflare:sockets";

const WS_PATH = "/home/go.html";
const PROXY_IP = "proxyip.cmliussss.net";
const CONNECT_TIMEOUT = 7000;
const FALLBACK_TIMEOUT = 10000;
const WINDOW = 4194304;
const BUDGET = 83886080;
const QUEUE_LIMIT = 4194304;
const FLUSH_SIZE = 32768;
const FLUSH_MS = 2;
const SCRATCH_SIZE = 131072;

const RESPONSE_HEADER = new Uint8Array(2);
const HTML_HEADERS = new Headers({ "Content-Type": "text/html; charset=utf-8", Server: "nginx" });
const HTML_INIT = { headers: HTML_HEADERS };
const NOT_FOUND_INIT = { status: 404, headers: HTML_HEADERS };
const decoder = new TextDecoder();
const NGINX_BODY = new TextEncoder().encode(`<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
</body>
</html>\r\n`);
const NOT_FOUND_BODY = new Uint8Array([78, 111, 116, 32, 70, 111, 117, 110, 100]);

const SCRATCH = new Uint8Array(SCRATCH_SIZE);

const B64 = new Int8Array(128).fill(-1);
for (let i = 0; i < 26; i++) {
  B64[65 + i] = i;
  B64[97 + i] = 26 + i;
}
for (let i = 0; i < 10; i++) B64[48 + i] = 52 + i;
B64[43] = B64[45] = 62;
B64[47] = B64[95] = 63;

const BYTE_STR = Array.from({ length: 256 }, (_, i) => String(i));
const IP4_KEY = new Uint32Array(128);
const IP4_VAL = new Array(128);
const DOM_HOST = new Array(256);
const IP6_BYTES = new Uint8Array(1024);
const IP6_HOST = new Array(64);
const qsCache = new Map();
const proxyCache = new Map();

let waiters = [];
let waitersAlt = [];
let total = 0;

const noop = () => {};
const enqueueWaiter = (r) => {
  waiters.push(r);
};

function wakeAll() {
  const n = waiters.length;
  if (!n) return;
  const list = waiters;
  waiters = waitersAlt;
  waitersAlt = list;
  for (let i = 0; i < n; i++) {
    list[i]();
    list[i] = null;
  }
  list.length = 0;
}

function getQueryProxy(qs) {
  let proxyip = qsCache.get(qs);
  if (proxyip !== undefined) return proxyip;
  if (qs.startsWith("proxyip=") && !qs.includes("&") && !qs.includes("%") && !qs.includes("+")) {
    proxyip = qs.slice(8);
  } else if (qs.includes("proxyip") || qs.includes("%")) {
    proxyip = new URLSearchParams(qs).get("proxyip");
  } else {
    proxyip = null;
  }
  if (qsCache.size >= 256) qsCache.clear();
  qsCache.set(qs, proxyip);
  return proxyip;
}

function upgradeWS(protocol, proxyip) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.binaryType = "arraybuffer";
  server.send(RESPONSE_HEADER);
  handleTraffic(server, proxyip, protocol ? decodeEarly(protocol) : null);
  return protocol
    ? new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": protocol } })
    : new Response(null, { status: 101, webSocket: client });
}

export default {
  fetch(req) {
    const raw = req.url;
    const schemeEnd = raw.indexOf("://") + 3;
    const pStart = raw.indexOf("/", schemeEnd);
    const qIdx = raw.indexOf("?", schemeEnd);
    const hIdx = raw.indexOf("#", schemeEnd);

    if (
      schemeEnd > 2 &&
      pStart !== -1 &&
      (qIdx === -1 || pStart < qIdx) &&
      (hIdx === -1 || pStart < hIdx)
    ) {
      const pEnd = qIdx !== -1 ? (hIdx !== -1 && hIdx < qIdx ? hIdx : qIdx) : (hIdx !== -1 ? hIdx : raw.length);
      const pLen = pEnd - pStart;

      if (pLen === 1) {
        return new Response(NGINX_BODY, HTML_INIT);
      }

      if (pLen === 13 && raw.startsWith(WS_PATH, pStart)) {
        const upg = req.headers.get("Upgrade");
        if (upg && (upg === "websocket" || upg.toLowerCase() === "websocket")) {
          const proxyip =
            qIdx !== -1 && (hIdx === -1 || qIdx < hIdx)
              ? getQueryProxy(raw.slice(qIdx + 1, hIdx === -1 ? raw.length : hIdx))
              : null;
          return upgradeWS(req.headers.get("Sec-WebSocket-Protocol"), proxyip);
        }
        return new Response(NOT_FOUND_BODY, NOT_FOUND_INIT);
      }

      const dotIdx = raw.indexOf("/.", pStart);
      const slsIdx = raw.indexOf("\\", schemeEnd);
      const pctIdx = raw.indexOf("%2", pStart);
      if (
        (dotIdx === -1 || dotIdx >= pEnd) &&
        (slsIdx === -1 || slsIdx >= pEnd) &&
        (pctIdx === -1 || pctIdx >= pEnd)
      ) {
        return new Response(NOT_FOUND_BODY, NOT_FOUND_INIT);
      }
    }

    const url = new URL(raw);
    const pathname = url.pathname;
    if (pathname === WS_PATH) {
      const upg = req.headers.get("Upgrade");
      if (upg && (upg === "websocket" || upg.toLowerCase() === "websocket")) {
        return upgradeWS(req.headers.get("Sec-WebSocket-Protocol"), url.searchParams.get("proxyip"));
      }
    }
    return pathname === "/"
      ? new Response(NGINX_BODY, HTML_INIT)
      : new Response(NOT_FOUND_BODY, NOT_FOUND_INIT);
  }
};

function decodeEarlyFallback(value) {
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const n = bin.length;
    if (n < 18) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeEarly(value) {
  let len = value.length;
  if (len < 24) return null;
  if ((len & 3) === 0 && value.charCodeAt(len - 1) === 61) {
    len--;
    if (value.charCodeAt(len - 1) === 61) len--;
  }
  if ((len & 3) === 1) return decodeEarlyFallback(value);
  const outLen = (len * 3) >> 2;
  if (outLen < 18) return null;
  const out = new Uint8Array(outLen);
  let i = 0;
  let j = 0;
  const end = len - (len & 3);
  while (i < end) {
    const c1 = value.charCodeAt(i);
    const c2 = value.charCodeAt(i + 1);
    const c3 = value.charCodeAt(i + 2);
    const c4 = value.charCodeAt(i + 3);
    if ((c1 | c2 | c3 | c4) > 127) return null;
    const a = B64[c1];
    const b = B64[c2];
    const c = B64[c3];
    const d = B64[c4];
    if ((a | b | c | d) < 0) return decodeEarlyFallback(value);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[j] = n >> 16;
    out[j + 1] = n >> 8;
    out[j + 2] = n;
    i += 4;
    j += 3;
  }
  const rem = len - end;
  if (rem === 2) {
    const c1 = value.charCodeAt(i);
    const c2 = value.charCodeAt(i + 1);
    if ((c1 | c2) > 127) return null;
    const a = B64[c1];
    const b = B64[c2];
    if ((a | b) < 0) return decodeEarlyFallback(value);
    out[j] = (a << 2) | (b >> 4);
  } else if (rem === 3) {
    const c1 = value.charCodeAt(i);
    const c2 = value.charCodeAt(i + 1);
    const c3 = value.charCodeAt(i + 2);
    if ((c1 | c2 | c3) > 127) return null;
    const a = B64[c1];
    const b = B64[c2];
    const c = B64[c3];
    if ((a | b | c) < 0) return decodeEarlyFallback(value);
    out[j] = (a << 2) | (b >> 4);
    out[j + 1] = (b << 4) | (c >> 2);
  }
  return out;
}

function dial(hostname, port, ms, setCancel) {
  let socket;
  try {
    socket = connect({ hostname, port });
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        setCancel(null);
        socket.close().catch(noop);
        reject();
      }
    }, ms);
    setCancel(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.close().catch(noop);
        reject();
      }
    });
    socket.opened.then(
      () => {
        if (!settled) {
          settled = true;
          setCancel(null);
          clearTimeout(timer);
          resolve(socket);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          setCancel(null);
          clearTimeout(timer);
          socket.close().catch(noop);
          reject();
        }
      }
    );
  });
}

function handleTraffic(ws, customProxy, early) {
  let tcp = null;
  let writer = null;
  let cancelDial = null;
  let started = !!early;
  let closed = false;
  let sent = 0;
  let acked = 0;
  let credit = false;
  let acct = 0;
  let queued = 0;
  const buf = [];
  let bufCount = 0;
  let len = 0;
  let timer = 0;
  let queue = null;

  const setDialCancel = (fn) => {
    cancelDial = fn;
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    const count = bufCount;
    const n = len;
    if (!n || closed || ws.readyState !== 1) {
      for (let i = 0; i < count; i++) buf[i] = null;
      bufCount = 0;
      len = 0;
      return;
    }
    let out;
    if (count === 1) {
      out = buf[0];
      buf[0] = null;
    } else if (n <= SCRATCH_SIZE) {
      let o = 0;
      for (let i = 0; i < count; i++) {
        const c = buf[i];
        buf[i] = null;
        SCRATCH.set(c, o);
        o += c.byteLength;
      }
      out = SCRATCH.subarray(0, n);
    } else {
      out = new Uint8Array(n);
      let o = 0;
      for (let i = 0; i < count; i++) {
        const c = buf[i];
        buf[i] = null;
        out.set(c, o);
        o += c.byteLength;
      }
    }
    if (buf.length > 64) buf.length = 0;
    bufCount = 0;
    len = 0;
    try {
      ws.send(out);
    } catch {
      close();
      return;
    }
    sent += n;
    if (credit) {
      acct += n;
      total += n;
    }
  };

  const close = () => {
    if (closed) {
      if (tcp) {
        tcp.close().catch(noop);
        tcp = null;
      }
      return;
    }
    closed = true;
    if (cancelDial) {
      const fn = cancelDial;
      cancelDial = null;
      fn();
    }
    try {
      if (ws.readyState <= 1) ws.close();
    } catch {}
    if (tcp) {
      tcp.close().catch(noop);
      tcp = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    buf.length = 0;
    bufCount = 0;
    len = 0;
    queue = null;
    if (acct) {
      total -= acct;
      acct = 0;
    }
    credit = false;
    wakeAll();
  };

  const start = async (data) => {
    const dLen = data.byteLength;
    if (
      dLen < 23 ||
      data[1] !== 0xd3 || data[2] !== 0x42 || data[3] !== 0xd1 || data[4] !== 0x1e ||
      data[5] !== 0xd4 || data[6] !== 0x24 || data[7] !== 0x45 || data[8] !== 0x83 ||
      data[9] !== 0xb3 || data[10] !== 0x6e || data[11] !== 0x52 || data[12] !== 0x4a ||
      data[13] !== 0xb1 || data[14] !== 0xf0 || data[15] !== 0xaf || data[16] !== 0xa4
    ) {
      return close();
    }

    const pIdx = 19 + data[17];
    const offset0 = pIdx + 3;
    if (offset0 >= dLen) return close();

    const port = (data[pIdx] << 8) | data[pIdx + 1];
    const type = data[pIdx + 2];
    let host;
    let offset;

    if (type === 1) {
      offset = offset0 + 4;
      if (offset > dLen) return close();
      const b0 = data[offset0];
      const b1 = data[offset0 + 1];
      const b2 = data[offset0 + 2];
      const b3 = data[offset0 + 3];
      const ipKey = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      const slot = Math.imul(ipKey, 0x9e3779b1) >>> 25;
      host = IP4_VAL[slot];
      if (host === undefined || IP4_KEY[slot] !== ipKey) {
        host = BYTE_STR[b0] + "." + BYTE_STR[b1] + "." + BYTE_STR[b2] + "." + BYTE_STR[b3];
        IP4_KEY[slot] = ipKey;
        IP4_VAL[slot] = host;
      }
    } else if (type === 2) {
      const addrLen = data[offset0];
      const addrStart = offset0 + 1;
      offset = addrStart + addrLen;
      if (offset > dLen) return close();
      if (!addrLen) {
        host = "";
      } else {
        const slot =
          (addrLen ^
            (data[addrStart] << 1) ^
            (data[addrStart + (addrLen > 1 ? 1 : 0)] << 3) ^
            (data[addrStart + (addrLen >> 1)] << 5) ^
            (data[offset - (addrLen > 4 ? 5 : 1)] << 7)) &
          255;
        const cached = DOM_HOST[slot];
        let hit = cached !== undefined && cached.length === addrLen;
        if (hit) {
          for (let k = 0; k < addrLen; k++) {
            if (cached.charCodeAt(k) !== data[addrStart + k]) {
              hit = false;
              break;
            }
          }
        }
        if (hit) {
          host = cached;
        } else {
          host = decoder.decode(data.subarray(addrStart, offset));
          DOM_HOST[slot] = host;
        }
      }
    } else if (type === 3) {
      offset = offset0 + 16;
      if (offset > dLen) return close();
      const slot =
        ((data[offset0] ^ data[offset0 + 5] ^ data[offset0 + 11] ^ data[offset0 + 15]) ^
          ((data[offset0 + 13] ^ data[offset0 + 14]) << 2)) &
        63;
      const base = slot << 4;
      let cached = IP6_HOST[slot];
      if (cached !== undefined) {
        for (let k = 0; k < 16; k++) {
          if (IP6_BYTES[base + k] !== data[offset0 + k]) {
            cached = undefined;
            break;
          }
        }
      }
      if (cached !== undefined) {
        host = cached;
      } else {
        host =
          ((data[offset0] << 8) | data[offset0 + 1]).toString(16) + ":" +
          ((data[offset0 + 2] << 8) | data[offset0 + 3]).toString(16) + ":" +
          ((data[offset0 + 4] << 8) | data[offset0 + 5]).toString(16) + ":" +
          ((data[offset0 + 6] << 8) | data[offset0 + 7]).toString(16) + ":" +
          ((data[offset0 + 8] << 8) | data[offset0 + 9]).toString(16) + ":" +
          ((data[offset0 + 10] << 8) | data[offset0 + 11]).toString(16) + ":" +
          ((data[offset0 + 12] << 8) | data[offset0 + 13]).toString(16) + ":" +
          ((data[offset0 + 14] << 8) | data[offset0 + 15]).toString(16);
        for (let k = 0; k < 16; k++) IP6_BYTES[base + k] = data[offset0 + k];
        IP6_HOST[slot] = host;
      }
    } else {
      return close();
    }

    let tcpHost = host;
    let tcpPort = port;
    try {
      tcp = await dial(tcpHost, tcpPort, CONNECT_TIMEOUT, setDialCancel);
    } catch {
      if (closed || ws.readyState !== 1) return close();
      if (customProxy) {
        let entry = proxyCache.get(customProxy);
        if (entry === undefined) {
          const colon = customProxy.indexOf(":");
          if (colon === -1) {
            entry = { host: customProxy, port: null };
          } else {
            const nextColon = customProxy.indexOf(":", colon + 1);
            const pStr = nextColon === -1 ? customProxy.slice(colon + 1) : customProxy.slice(colon + 1, nextColon);
            entry = { host: customProxy.slice(0, colon), port: pStr ? +pStr : null };
          }
          if (proxyCache.size >= 256) proxyCache.clear();
          proxyCache.set(customProxy, entry);
        }
        tcpHost = entry.host;
        if (entry.port !== null) tcpPort = entry.port;
      } else {
        tcpHost = PROXY_IP;
      }
      try {
        tcp = await dial(tcpHost, tcpPort, FALLBACK_TIMEOUT, setDialCancel);
      } catch {
        return close();
      }
    }

    if (closed || ws.readyState !== 1) return close();

    writer = tcp.writable.getWriter();

    if (offset < dLen) {
      writer.write(data.subarray(offset)).catch(close);
    }

    if (queue) {
      for (let i = 0, qLen = queue.length; i < qLen; i++) {
        writer.write(queue[i]).catch(close);
      }
      queue = null;
    }

    const reader = tcp.readable.getReader();
    try {
      while (!closed && ws.readyState === 1) {
        if (credit && (sent + len - acked > WINDOW || total > BUDGET)) {
          if (len) flush();
          while (!closed && ws.readyState === 1 && credit && (sent - acked > WINDOW || total > BUDGET)) {
            await new Promise(enqueueWaiter);
          }
          if (closed || ws.readyState !== 1) break;
        }
        const { done, value } = await reader.read();
        if (done || closed || ws.readyState !== 1) break;
        const vLen = value.byteLength;
        if (!vLen) continue;
        if (!len && vLen >= FLUSH_SIZE) {
          try {
            ws.send(value);
          } catch {
            break;
          }
          sent += vLen;
          if (credit) {
            acct += vLen;
            total += vLen;
          }
        } else {
          buf[bufCount++] = value;
          len += vLen;
          if (len >= FLUSH_SIZE) flush();
          else if (!timer) timer = setTimeout(flush, FLUSH_MS);
        }
      }
      if (len) flush();
    } catch {}
    close();
  };

  ws.addEventListener("message", (ev) => {
    if (closed) return;
    const data = ev.data;
    if (typeof data === "string") {
      const n = +data;
      if (n >= 0) {
        if (!credit) {
          credit = true;
          if (n > acked) acked = n;
          const d = sent - acked - acct;
          if (d) {
            acct += d;
            total += d;
            if (d < 0) wakeAll();
          }
        } else if (n > acked) {
          const dec = n - acked;
          acked = n;
          acct -= dec;
          total -= dec;
          wakeAll();
        }
      }
      return;
    }
    const chunk =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    if (writer) {
      writer.write(chunk).catch(close);
    } else if (started) {
      queued += chunk.byteLength;
      if (queued > QUEUE_LIMIT) return close();
      if (!queue) queue = [chunk];
      else queue.push(chunk);
    } else {
      started = true;
      start(chunk).catch(close);
    }
  });

  ws.addEventListener("close", close);
  ws.addEventListener("error", close);

  if (early) start(early).catch(close);
}
