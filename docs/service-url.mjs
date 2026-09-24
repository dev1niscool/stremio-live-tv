const ADDRESS_HELP = 'Enter your public service address, such as https://your-service.onrender.com.';
const ORIGIN_HELP = 'Enter only your service address, without an access key, path, query or fragment.';
const HTTPS_HELP = 'Use the HTTPS service address. An HTTPS page cannot check an HTTP service.';

function validHostname(hostname) {
  // URL already validates bracketed IPv6 addresses and normalizes IPv4/IDNs.
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true;
  return hostname.length <= 253 && hostname.split('.').every(label =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Normalize a user-entered service origin without retaining or echoing secrets. */
export function normalizeServiceUrl(value, { pageOrigin = '', sameOriginOnly = false } = {}) {
  if (typeof value !== 'string') throw new Error(ADDRESS_HELP);
  const input = value.trim();
  if (!input || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error(ADDRESS_HELP);

  let candidate;
  if (/^https?:\/\//i.test(input)) candidate = input;
  else if (input.startsWith('//')) candidate = `https:${input}`;
  else {
    const scheme = input.match(/^([a-z][a-z\d+.-]*):/i)?.[1];
    const bareHostPort = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i.test(input);
    if (scheme && (/^https?$/i.test(scheme) || !bareHostPort)) throw new Error('Use an HTTP or HTTPS service address.');
    candidate = `https://${input}`;
  }

  let url;
  try { url = new URL(candidate); } catch { throw new Error(ADDRESS_HELP); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS service address.');
  if (url.username || url.password) throw new Error(ORIGIN_HELP);
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  if (!validHostname(url.hostname)) throw new Error(ADDRESS_HELP);
  if (url.hostname === 'dashboard.render.com') {
    throw new Error('Use your public service address ending in .onrender.com, not the Render dashboard address.');
  }
  // Check the original path too: URL normalization must not silently accept
  // private paths such as /addon/.. or discard empty ?/# separators.
  const rawPath = candidate.match(/^https?:\/\/[^/?#]+([^?#]*)/i)?.[1] || '';
  if ((rawPath && rawPath !== '/') || url.pathname !== '/' || candidate.includes('?') || candidate.includes('#')) {
    throw new Error(ORIGIN_HELP);
  }

  let page = null;
  if (pageOrigin) {
    try { page = new URL(pageOrigin); } catch { throw new Error('Open the service setup page and try again.'); }
    if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password
      || page.pathname !== '/' || page.search || page.hash) throw new Error('Open the service setup page and try again.');
  }
  if (url.protocol === 'http:' && url.hostname.endsWith('.onrender.com')) url.protocol = 'https:';
  if (url.protocol === 'http:' && (page?.protocol === 'https:' || (isLoopback(url.hostname) && page?.protocol !== 'http:'))) {
    throw new Error(HTTPS_HELP);
  }
  if (sameOriginOnly && (!page || url.origin !== page.origin)) {
    throw new Error('Use this setup page’s own service address, or open the other service’s setup page.');
  }
  return url.origin;
}
