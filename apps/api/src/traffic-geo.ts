import { createRequire as createGeoRequire } from 'node:module';
const requireGeo = createGeoRequire(import.meta.url);
let geo: { lookup(ip: string): { country: string } | null } | undefined;
/** Only use the peer IP supplied by API Gateway/the local HTTP server. Never persist it. */
export function trafficCountry(ip?: string): string | null {
  if (!ip) return null;
  geo ||= requireGeo('geoip-country');
  return geo!.lookup(ip)?.country || null;
}
