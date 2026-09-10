// Opt-in integration test: requires Docker, Bun and OpenSSL already installed.
// Exercises the actual image/config with a TLS origin on an isolated Docker network.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

const root = import.meta.dir;
const id = `hxc-gateway-test-${randomUUID()}`;
const temp = join(tmpdir(), `${id}.untracked`);
mkdirSync(temp, { mode: 0o700 });
const network = `${id}-network`;
const origin = `${id}-origin`;
const gateway = `${id}-gateway`;
const image = `${id}:test`;
const port = Number(process.env.HEXCLAVE_GATEWAY_TEST_PORT ?? (Number(process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? '81') * 100 + 10070));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid gateway test port');
const base = `http://127.0.0.1:${port}`;
const domain = process.env.HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN ?? 'deploy.built-with-hexclave.com';
// The public development key from apps/marshal/.env.development; production uses its own.
const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f9000112233445566778899aabbccddeeff';
// Mirrors apps/marshal/src/platform-domain-names.ts platformHostnameMac.
function mac(appSuffix, signingKey = key, signedDomain = domain) {
  return createHmac('sha256', Buffer.from(signingKey, 'hex')).update(`hexclave-deployment-hostname/v1\0${signedDomain}\0${appSuffix}`).digest('hex').slice(0, 12);
}
// Marshal-shaped app suffixes (hxc-<env 1>-<ns 1-2>-<key 1-2>-<hex 18>, minus hxc-); the
// gateway only ever routes these. `wrong` aliases the `test` origin, whose certificate does
// not cover it.
const apps = { test: 't-ns-ke-0123456789abcdef01', second: 't-ns-se-0123456789abcdef02', wrong: 't-ns-wr-0123456789abcdef03' };
const hosts = Object.fromEntries(Object.entries(apps).map(([name, suffix]) => [name, `${suffix}-${mac(suffix)}.${domain}`]));
const host = hosts.test;
const marker = 'gateway-test-marker';
const created = [];
let networkCreated = false;
let imageCreated = false;
function command(name, args) {
  return execFileSync(name, args, { encoding: 'utf8', timeout: 180000, stdio: 'pipe' });
}
async function probe(path, options = {}) {
  return await fetch(new URL(path, base), { ...options, headers: { Host: host, ...options.headers }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
}
beforeAll(async () => {
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem'), '-subj', `/CN=hxc-${apps.test}.fly.dev`, '-addext', `subjectAltName=DNS:hxc-${apps.test}.fly.dev,DNS:hxc-${apps.second}.fly.dev`]);
  command('docker', ['build', '-t', image, root]);
  imageCreated = true;
  for (const invalid of ['', '*.example.net', 'Example.net', 'example.net\n', '-bad.example.net', 'a'.repeat(64) + '.net']) {
    expect(() => command('docker', ['run', '--rm', '-e', `HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN=${invalid}`, '-e', `HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY=${key}`, image, 'nginx', '-t'])).toThrow();
  }
  for (const invalid of ['', 'short', 'g'.repeat(64), '0'.repeat(63), `${key}\n`]) {
    expect(() => command('docker', ['run', '--rm', '-e', `HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN=${domain}`, '-e', `HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY=${invalid}`, image, 'nginx', '-t'])).toThrow();
  }
  expect(() => command('docker', ['run', '--rm', '-e', `HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN=${domain}`, image, 'nginx', '-t'])).toThrow();
  command('docker', ['network', 'create', network]);
  networkCreated = true;
  for (const name of ['test', 'second']) {
    const container = `${origin}-${name}`;
    command('docker', ['run', '-d', '--name', container, '--network', network, '--network-alias', `hxc-${apps[name]}.fly.dev`,
      ...(name === 'test' ? ['--network-alias', `hxc-${apps.wrong}.fly.dev`] : []),
      '-v', `${resolve(root, '../marshal/src/live-proxy-fixture/server.mjs')}:/fixture.mjs:ro`, '-v', `${temp}:/tls:ro`,
      '-e', `HEXCLAVE_LIVE_TEST_MARKER=${name === 'test' ? marker : 'second-marker'}`, '-e', `HEXCLAVE_LIVE_TEST_HOSTNAME=${hosts[name]}`, '-e', `HEXCLAVE_LIVE_TEST_FLY_HOSTNAME=hxc-${apps[name]}.fly.dev`,
      '-e', 'HEXCLAVE_LIVE_TEST_PORT=443', '-e', 'HEXCLAVE_LIVE_TEST_TLS_CERT=/tls/cert.pem', '-e', 'HEXCLAVE_LIVE_TEST_TLS_KEY=/tls/key.pem',
      'oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e', 'bun', '/fixture.mjs']);
    created.push(container);
  }
  command('docker', ['run', '-d', '--name', gateway, '--network', network, '-p', `127.0.0.1:${port}:8080`,
    '-e', 'HEXCLAVE_GATEWAY_RESOLVER=127.0.0.11', '-e', `HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN=${domain}`, '-e', `HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY=${key}`, '-v', `${join(temp, 'cert.pem')}:/etc/ssl/certs/ca-certificates.crt:ro`, image]);
  created.push(gateway);
  command('docker', ['exec', gateway, 'nginx', '-t']);
  for (let i = 0; i < 30; i++) {
    const response = await probe('/');
    if (response.status === 200 && await response.text() === marker) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Gateway fixture did not become ready: ${command('docker', ['logs', gateway])}`);
}, 240000);

afterAll(() => {
  try {
    for (const container of created.reverse()) command('docker', ['rm', '-f', container]);
    if (networkCreated) command('docker', ['network', 'rm', network]);
    if (imageCreated) command('docker', ['image', 'rm', image]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('rejects unrelated/malformed hosts and keeps health checks off application paths', async () => {
  for (const invalid of ['example.com', 'project.built-with-hexclave.com', domain, `a.b.${domain}`, `-a.${domain}`, `a-.${domain}`, `${'a'.repeat(60)}.${domain}`, `test.${domain.replaceAll('.', 'x')}`, `login.${domain}`, `test.${domain}`, host.replace(`.${domain}`, `.${domain.replaceAll('.', 'x')}`), `${host}.attacker.example`]) {
    expect((await probe('/', { headers: { Host: invalid } })).status).toBe(421);
  }
  expect((await probe('/healthz', { headers: { Host: 'gateway-health.internal' } })).status).toBe(200);
  expect((await probe('/healthz')).status).toBe(404);
});

test('routes only hostnames signed with the gateway key', async () => {
  // Pinned alongside apps/marshal/src/platform-domain-names.test.ts so the two constructions
  // cannot drift apart unnoticed.
  expect(mac('t-ns-ke-0123456789abcdef01', key, 'deploy.built-with-hexclave.com')).toBe('b8e6cf5af5b3');
  expect((await probe('/')).status).toBe(200);
  const suffix = apps.test;
  const signed = mac(suffix);
  const forged = [
    // A shape-conforming app name, as anyone can register on Fly, with no signature.
    `${suffix}.${domain}`,
    // Off by one character, an all-zero signature, and a signature that is not hex.
    `${suffix}-${signed.slice(0, -1)}${signed.endsWith('0') ? '1' : '0'}.${domain}`,
    `${suffix}-${'0'.repeat(12)}.${domain}`,
    `${suffix}-${'g'.repeat(12)}.${domain}`,
    // Signed under a different key, over a different domain, or for a different app.
    `${suffix}-${mac(suffix, '0'.repeat(64))}.${domain}`,
    `${suffix}-${mac(suffix, key, `x${domain}`)}.${domain}`,
    `${suffix}-${mac(apps.second)}.${domain}`,
    // Correctly signed, but with a name the gateway would never have been asked to sign:
    // a vanity label, or a suffix outside Marshal's shape.
    `login-${mac('login')}.${domain}`,
    `${suffix}x-${mac(`${suffix}x`)}.${domain}`,
    `t-ns-ke-${'0'.repeat(19)}-${mac(`t-ns-ke-${'0'.repeat(19)}`)}.${domain}`,
    // Signature bytes tucked somewhere other than the end.
    `${signed}-${suffix}.${domain}`,
  ];
  for (const invalid of forged) {
    expect([invalid, (await probe('/', { headers: { Host: invalid } })).status]).toEqual([invalid, 421]);
  }
  // Hostnames are case-insensitive; nginx lowercases $host before gateway.js sees it.
  expect((await probe('/', { headers: { Host: host.toUpperCase() } })).status).toBe(200);
  expect((await probe('/', { headers: { Host: `${host}:443` } })).status).toBe(200);
});

test('forwards methods and Set-Cookie attributes without caching', async () => {
  expect(await (await probe('/llms.txt?query=retained')).text()).toBe(marker);
  expect(await (await probe('/llms.txt', { method: 'HEAD' })).text()).toBe('');
  expect((await probe('/llms.txt', { method: 'POST', body: 'hello' })).status).toBe(405);
  const login = await probe(`/compatibility/login?domain=${host}&value=first`, { method: 'POST' });
  expect(login.headers.getSetCookie()).toContain(`__Host-hxc_session=${marker}-first; Secure; HttpOnly; SameSite=Lax; Path=/`);
  const response = await probe('/compatibility/session', { headers: { Cookie: `__Host-hxc_session=${marker}-first` } });
  expect((await response.json()).session).toBe(`${marker}-first`);
  expect((await (await probe('/compatibility/session')).json()).session).toBe(null);
});

test('preserves encoded query strings, public forwarding headers, and large uploads', async () => {
  const response = await probe('/compatibility/request?q=a%2Fb&empty=&q=second', {
    method: 'POST', body: 'x'.repeat(2 * 1024 * 1024),
    headers: { 'X-Forwarded-Host': 'untrusted.example', 'X-Forwarded-Proto': 'https' },
  });
  expect(await response.json()).toEqual({
    method: 'POST', path: '/compatibility/request?q=a%2Fb&empty=&q=second',
    host: `hxc-${apps.test}.fly.dev`, forwardedHost: host, forwardedProto: 'https', bodyLength: 2 * 1024 * 1024,
  });
});

test('verifies the TLS hostname of upstreams', async () => {
  expect((await probe('/', { headers: { Host: hosts.wrong } })).status).toBe(502);
});

for (const kind of ['sse', 'chunks']) {
  test(`streams ${kind} before the response finishes`, async () => {
    const response = await probe(`/compatibility/stream?kind=${kind}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let first;
    let last;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
      if (content.includes(`${marker}:first`) && first === undefined) first = performance.now();
      if (content.includes(`${marker}:last`) && last === undefined) last = performance.now();
    }
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(last - first).toBeGreaterThan(1500);
  }, 15000);
}

test('proxies authenticated WebSocket text/binary messages and close', async () => {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/compatibility/ws`, {
      headers: { Host: host, Cookie: `__Host-hxc_session=${marker}-websocket`, 'Sec-WebSocket-Protocol': 'hxc-live-test' },
    });
    socket.binaryType = 'arraybuffer';
    let stage = 0;
    const timer = setTimeout(() => finish(new Error('WebSocket timeout')), 10000);
    function finish(error) {
      clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
      if (error !== undefined) reject(error); else resolve();
    }
    socket.onopen = () => socket.send('echo');
    socket.onmessage = event => {
      try {
        if (stage === 0) {
          expect(event.data).toBe('echo');
          stage = 1;
          socket.send(new Uint8Array([0, 1, 128, 255]));
        } else {
          expect([...new Uint8Array(event.data)]).toEqual([0, 1, 128, 255]);
          stage = 2;
          socket.close(1000, 'complete');
        }
      } catch (error) { finish(error); }
    };
    socket.onerror = () => finish(new Error('WebSocket connection failed'));
    socket.onclose = event => finish(stage === 2 && event.code === 1000 ? undefined : new Error(`Unexpected close ${event.code}`));
  });
}, 15000);


test('keeps simultaneous application responses separate', async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const second = index % 2 === 1;
    const response = await probe('/', { headers: { Host: second ? hosts.second : host } });
    expect(await response.text()).toBe(second ? 'second-marker' : marker);
  }));
  expect(responses.length).toBe(20);
});

test('preserves redirects, upstream error bodies, and retry headers', async () => {
  const redirect = await probe('/compatibility/redirect');
  expect(redirect.status).toBe(307);
  expect(redirect.headers.get('location')).toBe(`https://${host}/destination?q=a%2Fb`);
  expect(await redirect.text()).toBe('redirect');
  const error = await probe('/compatibility/error');
  expect(error.status).toBe(503);
  expect(error.headers.get('retry-after')).toBe('7');
  expect(await error.text()).toBe('fixture unavailable');
});

test('streams a slow upload upstream before the client finishes sending', async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let finishUpload;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024));
      finishUpload = () => { controller.enqueue(new Uint8Array(1024)); controller.close(); };
    },
  });
  try {
    const response = await probe('/compatibility/upload-stream', { method: 'POST', body, duplex: 'half', signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('1024\n');
    finishUpload();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('2048\n');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}, 20000);

test('accepts new requests after a streaming client disconnects', async () => {
  const response = await probe('/compatibility/stream?kind=sse');
  const reader = response.body.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  expect(await (await probe('/')).text()).toBe(marker);
});

test('a stopped upstream fails without disrupting another application', async () => {
  command('docker', ['stop', '-t', '1', `${origin}-second`]);
  expect([502, 504]).toContain((await probe('/', { headers: { Host: hosts.second } })).status);
  expect(await (await probe('/')).text()).toBe(marker);
}, 20000);

test('WebSocket clients detect gateway replacement and can reconnect', async () => {
  function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/compatibility/ws`, {
      headers: { Host: host, Cookie: `__Host-hxc_session=${marker}-websocket`, 'Sec-WebSocket-Protocol': 'hxc-live-test' },
    });
    return socket;
  }
  const socket = connect();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Initial connection timeout')), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Initial connection failed')); };
    });
    const closed = new Promise(resolve => { socket.onclose = resolve; });
    command('docker', ['restart', '-t', '1', gateway]);
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    // Container restart returns before nginx necessarily accepts connections.
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const [result] = await Promise.allSettled([probe('/')]);
      if (result.status === 'fulfilled' && result.value.status === 200) {
        ready = await result.value.text() === marker;
        if (ready) break;
      }
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    const next = connect();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Reconnect timeout')), 10000);
        next.onopen = () => next.send('after-restart');
        next.onmessage = event => {
          clearTimeout(timer);
          if (event.data === 'after-restart') resolve(); else reject(new Error('Incorrect reconnect echo'));
        };
        next.onerror = () => { clearTimeout(timer); reject(new Error('Reconnect failed')); };
      });
    } finally { next.close(); }
  } finally { socket.close(); }
}, 30000);
