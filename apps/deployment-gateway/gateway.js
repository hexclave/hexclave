// Decides which Fly app a request is for, or "" to refuse it with 421.
//
// A platform hostname is <suffix>-<mac>.<platform domain>, where hxc-<suffix> is the Fly app
// Marshal created (apps/marshal/src/fly/naming.ts appNameForService) and <mac> is the first
// 16 hex characters of HMAC-SHA256 over the domain and suffix under a key only Marshal and
// this gateway hold (apps/marshal/src/platform-domain-names.ts platformHostnameMac — keep the
// two byte for byte identical). Fly app names are global across every Fly org, so anyone can
// register a shape-conforming hxc-* app; without the key they cannot produce a hostname this
// gateway routes to it, which is what keeps our wildcard certificate and domain off their
// content. The gateway therefore needs no per-deployment routing table.
import crypto from 'crypto';

const MAC_CONTEXT = 'hexclave-deployment-hostname/v1';
const MAC_LENGTH = 16;
// <env 1>-<ns 1-2>-<key 1-2>-<sha256 hex 18>, then the mac. Nothing else — a looser shape
// would only widen what a leaked key could sign.
const LABEL = /^([a-z0-9]-[a-z0-9]{1,2}-[a-z0-9]{1,2}-[0-9a-f]{18})-([0-9a-f]{16})$/;

function constantTimeEqual(expected, provided) {
  if (expected.length !== provided.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return difference === 0;
}

function deploymentApp(r) {
  // Both are validated at container start (15-platform-domain.envsh) and exported to the
  // workers by nginx.conf's `env` directives.
  const domain = process.env.HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN;
  const key = process.env.HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY;
  // $host is already lowercased with any port removed.
  const host = r.variables.host;
  if (!domain || !key || !host || !host.endsWith('.' + domain)) return '';
  const match = LABEL.exec(host.slice(0, -(domain.length + 1)));
  if (match === null) return '';
  const expected = crypto.createHmac('sha256', Buffer.from(key, 'hex'))
    .update(MAC_CONTEXT + '\0' + domain + '\0' + match[1])
    .digest('hex')
    .slice(0, MAC_LENGTH);
  return constantTimeEqual(expected, match[2]) ? 'hxc-' + match[1] : '';
}

export default { deploymentApp };
