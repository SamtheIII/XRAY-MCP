import axios from 'axios';

const AUTH_URL = 'https://xray.cloud.getxray.app/api/v2/authenticate';
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
// Refresh a minute before the cached expiry so a request that starts just
// before the boundary doesn't hit Xray with an already-expired token.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
// Holds the in-flight auth request so concurrent callers share one fetch
// instead of all hitting Xray's /authenticate at once.
let inFlight: Promise<string> | null = null;

export async function getToken(): Promise<string> {
  if (!process.env.XRAY_CLIENT_ID) throw new Error('XRAY_CLIENT_ID is required');
  if (!process.env.XRAY_CLIENT_SECRET) throw new Error('XRAY_CLIENT_SECRET is required');

  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  // De-duplicate concurrent fetches: the first caller starts the request, the
  // rest await the same promise. Cleared on settle so a failure can be retried.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await axios.post<string>(AUTH_URL, {
        client_id: process.env.XRAY_CLIENT_ID,
        client_secret: process.env.XRAY_CLIENT_SECRET,
      });
      // Guard against caching a junk token (empty/non-string body on a 200),
      // which would otherwise stick for the full TTL and break every call.
      if (typeof res.data !== 'string' || res.data.length === 0) {
        throw new Error('Xray authentication returned an empty or invalid token');
      }
      cachedToken = res.data;
      tokenExpiresAt = Date.now() + TOKEN_TTL_MS - TOKEN_EXPIRY_SKEW_MS;
      return cachedToken;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
