export const AUSTIN_SERVICE_AREA = Object.freeze({
  west: -98.35,
  south: 29.7,
  east: -97.05,
  north: 30.85,
});

export function pointInServiceArea(point) {
  return (
    Number.isFinite(point?.latitude) &&
    Number.isFinite(point?.longitude) &&
    point.latitude >= AUSTIN_SERVICE_AREA.south &&
    point.latitude <= AUSTIN_SERVICE_AREA.north &&
    point.longitude >= AUSTIN_SERVICE_AREA.west &&
    point.longitude <= AUSTIN_SERVICE_AREA.east
  );
}

export function haversineMiles(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function jsonError(message, status, extra = {}) {
  return Response.json(
    { error: message, ...extra },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

export async function readJsonBody(request, maximumBytes) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new RangeError(`Request body must not exceed ${maximumBytes} bytes.`);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new RangeError(`Request body must not exceed ${maximumBytes} bytes.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError("Request body must be valid JSON.");
  }
}

export function providerEndpoint(baseUrl, pathname) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url;
}

export async function requestAllowed(rateLimiter, request, sharedKey = null) {
  if (!rateLimiter) return true;
  const key = sharedKey ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const result = await rateLimiter.limit({ key });
  return result.success;
}
