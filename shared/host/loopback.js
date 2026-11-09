/**
 * Trust fence for a plugin's local HTTP API: only this server's own page, on a loopback socket with
 * an exact loopback Host, gets through. A page on another local port is refused too. The desktop
 * shell forwards the Client's requests without an Origin, and `dsh web` is same-origin.
 */

/** True only for an exactly spelled loopback hostname; a prefix test would accept `127.0.0.1.evil.example`. */
function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  return /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){2}$/.test(hostname);
}

/** True when an `Origin`/`Referer` value is absent or names exactly this server (host and port). */
function isSameAuthority(value, authority) {
  if (typeof value !== 'string' || value.trim() === '') return true;
  try {
    return new URL(value.trim()).host === authority;
  } catch {
    return false;
  }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {{checkReferer?: boolean}} [options] also require a same-server Referer
 * @returns {boolean}
 */
export function isLoopbackRequest(request, { checkReferer = false } = {}) {
  const address = request.socket?.remoteAddress || '';
  const loopbackAddress =
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.') ||
    address === '::ffff:7f00:1';
  if (!loopbackAddress) return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(parsed.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!isSameAuthority(request.headers.origin, parsed.host)) return false;
  if (checkReferer && !isSameAuthority(request.headers.referer, parsed.host)) return false;
  // A form or text/plain POST skips the CORS preflight; the Client only ever sends JSON or no body.
  const type = request.headers['content-type'];
  if (request.method === 'POST' && type !== undefined && !/^application\/json\s*(;|$)/i.test(type)) return false;
  return true;
}
