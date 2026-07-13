// In-process DNS lookup cache. Used by every HttpsProxyAgent so that the proxy
// gateway hostname (proxy.flameproxies.com, gw.dataimpulse.com, …) is resolved
// AT MOST once per TTL window instead of on every single login request.
//
// Why this matters at bulk concurrency: HttpsProxyAgent is built per-request
// (intentionally, for IP rotation), so each request opens a fresh TCP socket,
// which triggers a fresh DNS lookup of the GATEWAY hostname. At 100 logins/s
// that's ~100 syscalls/s into the libc resolver — small individually but real
// in aggregate, and one slow resolver response stalls a whole worker. With this
// cache, every gateway request after the first within TTL is sub-millisecond
// resolution.
//
// Only caches when callers ask for ONE address (the common case). The all:true
// signature passes through to dns.lookup unchanged so anything fancy keeps
// working. Negative results are NOT cached — if a transient resolver fail
// happens, the next request retries instead of being pinned to a stale failure.

const dns = require('dns');

const TTL_MS = Number(process.env.DNS_CACHE_TTL_MS) || 5 * 60 * 1000;
const _cache = new Map(); // hostname → { addr, family, exp }
let hits = 0, misses = 0;

function cachedLookup(hostname, options, cb) {
  // dns.lookup's options arg is optional — caller may pass just (hostname, cb).
  if (typeof options === 'function') { cb = options; options = {}; }
  options = options || {};
  // Node's net.connect calls lookup with { all: true } — handle that shape too.
  // Cache stores BOTH shapes so any caller (all:true or all:false) is served.
  const now = Date.now();
  const hit = _cache.get(hostname);
  if (hit && hit.exp > now && (!options.family || options.family === hit.family)) {
    hits++;
    if (options.all) return process.nextTick(() => cb(null, hit.all));
    return process.nextTick(() => cb(null, hit.addr, hit.family));
  }
  misses++;
  // Resolve with all:true so we capture every record once, then reshape on the
  // way out for the specific caller. This makes future calls in either shape
  // a cache hit.
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err || !Array.isArray(addresses) || !addresses.length) {
      // Don't cache failures — let the next call retry.
      return options.all ? cb(err, addresses) : cb(err);
    }
    const first = addresses[0];
    _cache.set(hostname, { all: addresses, addr: first.address, family: first.family, exp: now + TTL_MS });
    if (options.all) cb(null, addresses);
    else cb(null, first.address, first.family);
  });
}

function stats() { return { hits, misses, entries: _cache.size, ttlMs: TTL_MS }; }

module.exports = { cachedLookup, stats };
