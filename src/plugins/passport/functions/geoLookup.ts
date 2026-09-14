import { open, type CityResponse, type Reader } from "maxmind";

/**
 * Optional local MaxMind GeoLite2-City lookup for the Alts feature's "same city" signal. Reads a
 * `.mmdb` file from `GEOIP_DB_PATH` with no per-request third-party calls — if the env var is
 * unset or the file can't be opened, lookups just return null and alt matching falls back to
 * IP/subnet only.
 */

let readerPromise: Promise<Reader<CityResponse> | null> | null = null;

function loadReader(): Promise<Reader<CityResponse> | null> {
  const path = process.env.GEOIP_DB_PATH?.trim();
  if (!path) return Promise.resolve(null);
  return open<CityResponse>(path).catch(() => null);
}

export type GeoLocation = { country: string | null; region: string | null; city: string | null };

/** Best-effort coarse geolocation for an IP. Never throws; returns nulls when unavailable. */
export async function lookupGeo(ip: string): Promise<GeoLocation> {
  readerPromise ??= loadReader();
  const reader = await readerPromise;
  if (!reader) return { country: null, region: null, city: null };

  try {
    const result = reader.get(ip);
    return {
      country: result?.country?.iso_code ?? null,
      region: result?.subdivisions?.[0]?.names?.en ?? null,
      city: result?.city?.names?.en ?? null,
    };
  } catch {
    return { country: null, region: null, city: null };
  }
}
