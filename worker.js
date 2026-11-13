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

const U0 = 0xd342d11e;
const U1 = 0xd4244583;
const U2 = 0xb36e524a;
const U3 = 0xb1f0afa4;

const RESPONSE_HEADER = new Uint8Array(2);
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", Server: "nginx" };
const decoder = new TextDecoder();
const noop = () => {};

const B64 = new Int8Array(128).fill(-1);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let i = 0; i < 64; i++) B64[ALPHABET.charCodeAt(i)] = i;
B64[45] = 62;
B64[95] = 63;

let waiters = [];
let total = 0;

const wakeAll = () => {
  const list = waiters;
  if (!list.length) return;
  waiters = [];
  for (let i = 0; i < list.length; i++) list[i]();
};

const NGINX_PAGE = `<!DOCTYPE html>
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
</html>\r\n`;

export default {
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === WS_PATH && req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const protocol = req.headers.get("Sec-WebSocket-Protocol");
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.binaryType = "arraybuffer";
      server.send(RESPONSE_HEADER);
      handleTraffic(server, url, protocol ? decodeEarly(protocol) : null);
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined
      });
    }

    return path === "/"
      ? new Response(NGINX_PAGE, { headers: HTML_HEADERS })
      : new Response("Not Found", { status: 404, headers: HTML_HEADERS });
  }
};

function decodeEarly(value) {
  let n = value.length;
  if ((n & 3) === 0) {
    if (value.charCodeAt(n - 1) === 61) n--;
    if (n > 0 && value.charCodeAt(n - 1) === 61) n--;
  }
  if ((n & 3) === 1) return null;
  const size = (n * 3) >> 2;
  if (size < 18) return null;
  const out = new Uint8Array(size);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const c = value.charCodeAt(i);
    const v = c < 128 ? B64[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = acc >> bits;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

async function dial(hostname, port, ms) {
  const socket = connect({ hostname, port });
  let timer;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Connect timeout")), ms);
      })
    ]);
    return socket;
  } catch (error) {
    socket.close().catch(noop);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function handleTraffic(ws, url, early) {
  let tcp = null;
  let writer = null;
  let started = early !== null;
  let sent = 0;
  let acked = 0;
  let credit = false;
  let acct = 0;
  let queued = 0;
  let len = 0;
  let timer = 0;
  let resume = null;
  const buf = [];
  const queue = [];

  const hold = (r) => {
    resume = r;
    if (total > BUDGET) waiters.push(r);
  };

  const wake = () => {
    const r = resume;
    if (r) {
      resume = null;
      r();
    }
  };

  const sync = () => {
    const d = (credit ? sent - acked : 0) - acct;
    if (!d) return;
    acct += d;
    total += d;
    if (d < 0) wakeAll();
  };

  const blocked = () =>
    credit && (sent + len - acked > WINDOW || total > BUDGET) && ws.readyState === 1;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    if (!len) return;
    if (ws.readyState !== 1) {
      buf.length = 0;
      len = 0;
      return;
    }
    const n = len;
    const count = buf.length;
    let out = buf[0];
    if (count > 1) {
      out = new Uint8Array(n);
      let o = 0;
      for (let i = 0; i < count; i++) {
        const c = buf[i];
        out.set(c, o);
        o += c.byteLength;
      }
    }
    buf.length = 0;
    len = 0;
    ws.send(out);
    sent += n;
    sync();
  };

  const close = () => {
    try {
      if (ws.readyState < 2) ws.close();
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
    len = 0;
    credit = false;
    sync();
    wake();
  };

  const pump = async (reader) => {
    try {
      while (ws.readyState === 1) {
        while (blocked()) {
          flush();
          await new Promise(hold);
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf.push(value);
        len += value.byteLength;
        if (len >= FLUSH_SIZE) flush();
        else if (!timer) timer = setTimeout(flush, FLUSH_MS);
      }
      flush();
    } catch {}
    close();
  };

  const start = async (data) => {
    let host;
    let port;
    let offset;

    try {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

      if (
        view.getUint32(1) !== U0 ||
        view.getUint32(5) !== U1 ||
        view.getUint32(9) !== U2 ||
        view.getUint32(13) !== U3
      ) {
        return close();
      }

      const pIdx = 19 + view.getUint8(17);
      port = view.getUint16(pIdx);
      const type = view.getUint8(pIdx + 2);
      offset = pIdx + 3;

      if (type === 1) {
        host = `${view.getUint8(offset)}.${view.getUint8(offset + 1)}.${view.getUint8(offset + 2)}.${view.getUint8(offset + 3)}`;
        offset += 4;
      } else if (type === 2) {
        const n = view.getUint8(offset++);
        host = decoder.decode(new Uint8Array(data.buffer, data.byteOffset + offset, n));
        offset += n;
      } else if (type === 3) {
        host = view.getUint16(offset).toString(16);
        for (let i = 2; i < 16; i += 2) host += ":" + view.getUint16(offset + i).toString(16);
        offset += 16;
      } else {
        return close();
      }
    } catch {
      return close();
    }

    try {
      tcp = await dial(host, port, CONNECT_TIMEOUT);
    } catch {
      if (ws.readyState !== 1) return close();
      const [proxyHost, proxyPort] = (url.searchParams.get("proxyip") || PROXY_IP).split(":");
      try {
        tcp = await dial(proxyHost, proxyPort ? +proxyPort : port, FALLBACK_TIMEOUT);
      } catch {
        return close();
      }
    }

    if (ws.readyState !== 1) return close();

    writer = tcp.writable.getWriter();

    if (offset < data.byteLength) writer.write(data.subarray(offset)).catch(close);

    for (let i = 0; i < queue.length; i++) writer.write(queue[i]).catch(close);
    queue.length = 0;

    pump(tcp.readable.getReader());
  };

  ws.addEventListener("message", ({ data }) => {
    if (typeof data === "string") {
      const n = Number(data);
      if (n >= 0) {
        credit = true;
        if (n > acked) acked = n;
        sync();
        wake();
      }
      return;
    }

    const chunk = new Uint8Array(data);

    if (writer) {
      writer.write(chunk).catch(close);
    } else if (started) {
      queued += chunk.byteLength;
      if (queued > QUEUE_LIMIT) return close();
      queue.push(chunk);
    } else {
      started = true;
      start(chunk).catch(close);
    }
  });

  ws.addEventListener("close", close);
  ws.addEventListener("error", close);

  if (early) start(early).catch(close);
}
