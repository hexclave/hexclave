// Runs only in the disposable prebuilt Bun container; no application dependencies.
const marker = process.env.HEXCLAVE_LIVE_TEST_MARKER;
const hostname = process.env.HEXCLAVE_LIVE_TEST_HOSTNAME;
const flyHostname = process.env.HEXCLAVE_LIVE_TEST_FLY_HOSTNAME;
if (!marker || !hostname || !flyHostname) throw new Error('Missing fixture identity');
const results = new Map();
const cookieNames = ['__Host-hxc_session', 'hxc_path', 'hxc_domain', 'hxc_invalid'];
function cookies(request) {
  return new Map((request.headers.get('cookie') ?? '').split(';').map(value => {
    const [name, ...rest] = value.trim().split('=');
    return [name, rest.join('=')];
  }));
}
function cookieHeaders(domain, value, remove = false) {
  const expiry = remove ? '; Max-Age=0' : '';
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const cookie of [
    `__Host-hxc_session=${value}; Secure; HttpOnly; SameSite=Lax; Path=/`,
    `hxc_path=${value}; Secure; SameSite=Strict; Path=/compatibility/scoped`,
    `hxc_domain=${value}; Secure; SameSite=None; Domain=${domain}; Path=/`,
    `hxc_invalid=${value}; Secure; Domain=${domain === hostname ? flyHostname : hostname}; Path=/`,
  ]) headers.append('Set-Cookie', cookie + expiry);
  return headers;
}

async function browserChecks() {
  const output = document.getElementById('output');
  const button = document.getElementById('run');
  const marker = document.getElementById('marker').textContent;
  const lines = [];
  const failures = [];
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  function log(message) {
    lines.push(message);
    output.textContent = lines.join('\n');
  }
  async function request(path, init = {}) {
    const response = await fetch(path, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return response;
  }
  async function test(name, action) {
    try {
      await action();
      log(`PASS: ${name}`);
    } catch (error) {
      failures.push(name);
      log(`FAIL: ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  button.disabled = true;
  await test('SSE and chunked response arrive incrementally', async () => {
    for (const kind of ['sse', 'chunks']) {
      const response = await request(`/compatibility/stream?kind=${kind}`);
      assert(response.body, 'Missing response stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = '';
      let firstAt;
      let lastAt;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
          if (body.includes(`${marker}:first`) && firstAt === undefined) firstAt = performance.now();
          if (body.includes(`${marker}:last`) && lastAt === undefined) lastAt = performance.now();
        }
        assert(firstAt !== undefined && lastAt !== undefined, 'Missing stream markers');
        assert(lastAt - firstAt >= 1500, `${kind} buffered: first and last arrived ${Math.round(lastAt - firstAt)}ms apart`);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
  });
  await test('browser cookies: session, HttpOnly, path, domain, rotation, logout', async () => {
    // Each browser host gets its own session. No parent-domain cookies are created.
    for (const value of ['first', 'rotated']) {
      await request(`/compatibility/login?domain=${encodeURIComponent(location.hostname)}&value=${value}`, { method: 'POST' });
      const root = await (await request('/compatibility/session')).json();
      const scoped = await (await request('/compatibility/scoped/session')).json();
      assert(root.session === `${marker}-${value}`, 'Secure host-only session missing or stale');
      assert(root.domain === `${marker}-${value}`, 'Explicit current-domain cookie missing');
      assert(root.path === null && scoped.path === `${marker}-${value}`, 'Cookie Path scope was not respected');
      assert(root.invalid === null, 'Browser accepted a cookie scoped to the other origin');
      assert(!document.cookie.includes('__Host-hxc_session='), 'HttpOnly session visible to JavaScript');
    }
    await request(`/compatibility/logout?domain=${encodeURIComponent(location.hostname)}`, { method: 'POST' });
    const session = await (await request('/compatibility/scoped/session')).json();
    assert(Object.values(session).every(value => value === null), 'Logout did not remove cookies');
  });
  await test('WebSocket upgrade, session cookie, text and binary echo, clean close', async () => {
    await request(`/compatibility/login?domain=${encodeURIComponent(location.hostname)}&value=websocket`, { method: 'POST' });
    try {
      await new Promise((resolve, reject) => {
        const url = new URL('/compatibility/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, 'hxc-live-test');
        socket.binaryType = 'arraybuffer';
        let stage = 0;
        const timeout = setTimeout(() => finish(new Error('WebSocket timed out after 15 seconds')), 15_000);
        function finish(error) {
          clearTimeout(timeout);
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          socket.close();
          if (error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        }
        socket.onopen = () => {
          socket.send(`${marker}:echo`);
        };
        socket.onmessage = event => {
          try {
            if (stage === 0) {
              assert(event.data === `${marker}:echo`, 'Text echo mismatch');
              assert(socket.protocol === 'hxc-live-test', 'Subprotocol missing');
              stage = 1;
              socket.send(new Uint8Array([0, 1, 127, 128, 255]));
            } else {
              assert(event.data instanceof ArrayBuffer, 'Binary response became text');
              assert(Array.from(new Uint8Array(event.data)).join(',') === '0,1,127,128,255', 'Binary echo mismatch');
              stage = 2;
              socket.close(1000, 'complete');
            }
          } catch (error) { finish(error); }
        };
        socket.onerror = () => finish(new Error('WebSocket failed to connect or exchange data'));
        socket.onclose = event => finish(stage === 2 && event.wasClean && event.code === 1000 ? undefined : new Error(`Unexpected close: ${event.code}, stage ${stage}`));
      });
    } finally {
      await request(`/compatibility/logout?domain=${encodeURIComponent(location.hostname)}`, { method: 'POST' });
    }
  });
  try {
    await request('/compatibility/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marker, origin: location.hostname, failures, lines }) });
    log(failures.length === 0 ? 'COMPLETE: all browser checks passed. Return to the terminal.' : 'COMPLETE: failures reported to the terminal.');
  } catch (error) { log(`Could not report results: ${error instanceof Error ? error.message : String(error)}`); }
}

const page = `<!doctype html><meta charset="utf-8"><title>Deployment proxy compatibility test</title>
<style>body{font:15px system-ui;margin:32px;max-width:900px}button{padding:10px}pre{white-space:pre-wrap}</style>
<h1>Deployment proxy compatibility test</h1><p>Run these checks on both the Fly and branded URLs printed in your terminal.</p>
<button id="run">Run browser checks</button><pre id="output"></pre><span id="marker" hidden>${marker}</span>
<script>document.getElementById('run').onclick = ${browserChecks.toString()};</script>`;

// Optional TLS is used only by the local gateway integration test. In the live
// fixture, Fly terminates TLS and no key/certificate is mounted in the app.
const tlsCert = process.env.HEXCLAVE_LIVE_TEST_TLS_CERT;
const tlsKey = process.env.HEXCLAVE_LIVE_TEST_TLS_KEY;
if ((tlsCert === undefined) !== (tlsKey === undefined)) throw new Error('Both fixture TLS paths are required');
Bun.serve({
  tls: tlsCert === undefined ? undefined : { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) },
  hostname: '0.0.0.0', port: Number(process.env.HEXCLAVE_LIVE_TEST_PORT ?? '80'),
  async fetch(request, server) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = { 'Cache-Control': 'no-store' };
    if (path === '/compatibility/ws') {
      if (cookies(request).get('__Host-hxc_session') !== `${marker}-websocket`) return new Response('Session required', { status: 401, headers });
      if (server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'hxc-live-test' } })) return;
      return new Response('Upgrade required', { status: 426, headers });
    }
    if (path === '/compatibility/cookie-isolation') {
      const publicHost = request.headers.get('x-forwarded-host') ?? url.hostname;
      if (![hostname, flyHostname].includes(publicHost)) return new Response('Invalid test host', { status: 400, headers });
      return new Response(`<!doctype html><title>Cookie isolation test</title><h1>Cookie isolation test</h1>
        <button id="set">Set test session</button><button id="read">Read session</button><pre id="output"></pre>
        <script>
        async function check(set) {
          const output = document.getElementById('output');
          try {
            if (set) {
              const login = await fetch('/compatibility/login?domain=${publicHost}&value=first', { method: 'POST' });
              if (!login.ok) throw new Error('Login failed: ' + login.status);
            }
            const response = await fetch('/compatibility/session', { cache: 'no-store' });
            if (!response.ok) throw new Error('Session read failed: ' + response.status);
            output.textContent = JSON.stringify(await response.json(), null, 2);
          } catch (error) { output.textContent = 'FAIL: ' + String(error); }
        }
        document.getElementById('set').onclick = () => check(true);
        document.getElementById('read').onclick = () => check(false);
        </script>`, { headers: { ...headers, 'Content-Type': 'text/html' } });
    }
    if (path === '/compatibility') return new Response(page, { headers: { ...headers, 'Content-Type': 'text/html' } });
    if (path === '/compatibility/stream') {
      const sse = url.searchParams.get('kind') === 'sse';
      let timer;
      const stream = new ReadableStream({
        start(controller) {
          const encode = value => new TextEncoder().encode(sse ? `data: ${marker}:${value}\n\n` : `${marker}:${value}\n`);
          controller.enqueue(encode('first'));
          timer = setTimeout(() => {
            controller.enqueue(encode('last'));
            controller.close();
          }, 3000);
        },
        cancel() { clearTimeout(timer); },
      });
      return new Response(stream, { headers: { ...headers, 'Content-Type': sse ? 'text/event-stream' : 'text/plain', 'X-Accel-Buffering': 'no' } });
    }
    if (path === '/compatibility/login' || path === '/compatibility/logout') {
      const domain = url.searchParams.get('domain');
      const value = url.searchParams.get('value');
      if (request.method !== 'POST' || ![hostname, flyHostname].includes(domain) || (path.endsWith('login') && !['first', 'rotated', 'websocket'].includes(value))) return new Response('Invalid test request', { status: 400, headers });
      return new Response('ok', { headers: cookieHeaders(domain, `${marker}-${value}`, path.endsWith('logout')) });
    }
    if (path === '/compatibility/redirect') {
      return new Response('redirect', { status: 307, headers: { ...headers, Location: `https://${hostname}/destination?q=a%2Fb` } });
    }
    if (path === '/compatibility/error') return new Response('fixture unavailable', { status: 503, headers: { ...headers, 'Retry-After': '7' } });
    if (path === '/compatibility/upload-stream') {
      if (request.body === null) return new Response('Body required', { status: 400, headers });
      let bytes = 0;
      return new Response(request.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(new TextEncoder().encode(`${bytes}\n`));
        },
      })), { headers: { ...headers, 'Content-Type': 'text/plain', 'X-Accel-Buffering': 'no' } });
    }
    if (path === '/compatibility/request') {
      return Response.json({
        method: request.method,
        path: url.pathname + url.search,
        host: request.headers.get('host'),
        forwardedHost: request.headers.get('x-forwarded-host'),
        forwardedProto: request.headers.get('x-forwarded-proto'),
        bodyLength: (await request.arrayBuffer()).byteLength,
      }, { headers });
    }
    if (path === '/compatibility/session' || path === '/compatibility/scoped/session') {
      const values = cookies(request);
      return Response.json(Object.fromEntries(['session', 'path', 'domain', 'invalid'].map((key, i) => [key, values.get(cookieNames[i]) ?? null])), { headers });
    }
    if (path === '/compatibility/result') {
      if (request.method === 'POST') {
        const result = await request.json();
        if (result.marker !== marker || ![hostname, flyHostname].includes(result.origin) || !Array.isArray(result.failures) || !result.failures.every(value => typeof value === 'string') || !Array.isArray(result.lines) || !result.lines.every(value => typeof value === 'string')) return new Response('Invalid report', { status: 400, headers });
        results.set(result.origin, result);
      }
      return Response.json([...results.values()], { headers });
    }
    if (path === '/' || path === '/llms.txt') return new Response(request.method === 'HEAD' ? null : marker, { status: request.method === 'POST' ? 405 : 200, headers });
    return new Response('Not found', { status: 404, headers });
  },
  websocket: { message(socket, message) { socket.send(message); } },
});
