import { pbkdf2 } from "node:crypto";

const ACCESS_COOKIE = "atlas_access";
const REFRESH_COOKIE = "atlas_refresh";
const INSTALLATION_COOKIE = "atlas_installation";
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_CONCURRENCY_GRACE_MS = 5 * 1000;
const NATIVE_REFRESH_REPLAY_GRACE_MS = 35 * 1000;
const INSTALLATION_TTL_SECONDS = 90 * 24 * 60 * 60;
const JWT_ISSUER = "austin-hike-bike-atlas";
const JWT_AUDIENCE = "austin-hike-bike-atlas-web";
const PASSWORD_ALGORITHM = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_KEY_BYTES = 32;
const NATIVE_AUTH_MAX_BODY_BYTES = 4 * 1024;
const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(randomBytes, length = 32) {
  return base64UrlEncode(randomBytes(length));
}

async function sha256(value) {
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
}

async function nativeRefreshReplacementToken(refreshToken, secret) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importJwtKey(secret),
    encoder.encode(`native-refresh-v1\u0000${refreshToken}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function importJwtKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signAccessToken(claims, secret) {
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importJwtKey(secret),
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyAccessToken(token, secret, nowSeconds) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Invalid session");

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    throw new HttpError(401, "Invalid session");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new HttpError(401, "Invalid session");
  }

  let validSignature;
  try {
    validSignature = await crypto.subtle.verify(
      "HMAC",
      await importJwtKey(secret),
      base64UrlDecode(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    throw new HttpError(401, "Invalid session");
  }
  if (
    !validSignature ||
    claims.typ !== "access" ||
    claims.iss !== JWT_ISSUER ||
    claims.aud !== JWT_AUDIENCE ||
    typeof claims.sub !== "string" ||
    typeof claims.jti !== "string" ||
    !Number.isInteger(claims.tokenVersion) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > nowSeconds + 60 ||
    claims.exp <= nowSeconds
  ) {
    throw new HttpError(401, "Invalid session");
  }
  return claims;
}

async function derivePassword(password, pepper, salt, iterations) {
  const derived = await new Promise((resolve, reject) => {
    pbkdf2(
      `${password}\u0000${pepper}`,
      salt,
      iterations,
      PASSWORD_KEY_BYTES,
      "sha256",
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
  return new Uint8Array(derived);
}

export async function hashPassword(password, pepper, randomBytes) {
  const salt = randomBytes(16);
  const derived = await derivePassword(
    password,
    pepper,
    salt,
    PASSWORD_ITERATIONS,
  );
  return {
    passwordHash: base64UrlEncode(derived),
    passwordAlgorithm: PASSWORD_ALGORITHM,
    passwordParameters: JSON.stringify({
      iterations: PASSWORD_ITERATIONS,
      keyBytes: PASSWORD_KEY_BYTES,
      salt: base64UrlEncode(salt),
    }),
  };
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function verifyPassword(password, pepper, stored) {
  const algorithm = stored.passwordAlgorithm ?? stored.password_algorithm;
  const parametersValue =
    stored.passwordParameters ?? stored.password_parameters;
  const hash = stored.passwordHash ?? stored.password_hash;
  if (algorithm !== PASSWORD_ALGORITHM) return false;
  let parameters;
  try {
    parameters = JSON.parse(parametersValue);
  } catch {
    return false;
  }
  if (
    !Number.isInteger(parameters.iterations) ||
    parameters.iterations < 100_000 ||
    parameters.iterations > 1_000_000 ||
    parameters.keyBytes !== PASSWORD_KEY_BYTES ||
    typeof parameters.salt !== "string"
  ) {
    return false;
  }
  const actual = await derivePassword(
    password,
    pepper,
    base64UrlDecode(parameters.salt),
    parameters.iterations,
  );
  return constantTimeEqual(actual, base64UrlDecode(hash));
}

function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    try {
      result[part.slice(0, separator).trim()] = decodeURIComponent(
        part.slice(separator + 1).trim(),
      );
    } catch {
      // Ignore malformed cookies rather than failing the whole auth request.
    }
  }
  return result;
}

function bearerAccessToken(request) {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]{16,4096})$/u.exec(authorization);
  if (!match) throw new HttpError(401, "Invalid session");
  return match[1];
}

export function requiresSameOrigin(request) {
  return bearerAccessToken(request) === null;
}

function cookie(name, value, request, options = {}) {
  const secure = new URL(request.url).protocol === "https:";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function appendSessionCookies(
  headers,
  request,
  session,
  installation,
  sessionMaxAgeSeconds = Math.floor(REFRESH_TTL_MS / 1000),
) {
  const maxAge = Math.max(0, sessionMaxAgeSeconds);
  headers.append(
    "Set-Cookie",
    cookie(ACCESS_COOKIE, session.accessToken, request, {
      maxAge: Math.min(ACCESS_TTL_SECONDS, maxAge),
    }),
  );
  headers.append(
    "Set-Cookie",
    cookie(REFRESH_COOKIE, session.refreshToken, request, {
      maxAge,
    }),
  );
  if (installation) {
    headers.append(
      "Set-Cookie",
      cookie(INSTALLATION_COOKIE, installation, request, {
        maxAge: INSTALLATION_TTL_SECONDS,
      }),
    );
  }
}

function appendClearedCookies(headers, request) {
  for (const name of [
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    INSTALLATION_COOKIE,
  ]) {
    headers.append("Set-Cookie", cookie(name, "", request, { maxAge: 0 }));
  }
}

function response(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers });
}

function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) {
    throw new HttpError(403, "Invalid request origin");
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

async function readNativeJson(request) {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > NATIVE_AUTH_MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large");
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > NATIVE_AUTH_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    return body;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") throw new HttpError(400, "Email is required");
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new HttpError(400, "Enter a valid email address");
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) {
    throw new HttpError(400, "Password must be 12 to 128 characters");
  }
  return value;
}

function validateDisplayName(value) {
  if (typeof value !== "string") throw new HttpError(400, "Display name is required");
  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    throw new HttpError(400, "Display name must be 1 to 80 characters");
  }
  return displayName;
}

function validateInstallationCredential(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(value)) {
    throw new HttpError(401, "Invalid installation credential");
  }
  return value;
}

function validateRefreshToken(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(value)) {
    throw new HttpError(401, "Invalid session");
  }
  return value;
}

function userAgentFamily(request) {
  const value = request.headers.get("user-agent") ?? "";
  if (/edg\//iu.test(value)) return "Edge";
  if (/firefox\//iu.test(value)) return "Firefox";
  if (/chrome\//iu.test(value)) return "Chrome";
  if (/safari\//iu.test(value)) return "Safari";
  return "Other";
}

async function checkRateLimit(request, action, dependencies) {
  const policy = {
    anonymous: [20, 60_000],
    login: [10, 5 * 60_000],
    refresh: [60, 60_000],
    register: [10, 5 * 60_000],
  }[action];
  if (!policy) return;
  const [limit, windowMs] = policy;
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = dependencies.now();
  const keyHash = await sha256(
    `${action}\u0000${address}\u0000${dependencies.passwordPepper}`,
  );
  await dependencies.db
    .prepare("DELETE FROM auth_rate_limits WHERE reset_at <= ?")
    .bind(now)
    .run();
  const current = await dependencies.db
    .prepare(
      `INSERT INTO auth_rate_limits (key_hash, count, reset_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         count = CASE
           WHEN auth_rate_limits.reset_at <= ? THEN 1
           ELSE auth_rate_limits.count + 1
         END,
         reset_at = CASE
           WHEN auth_rate_limits.reset_at <= ? THEN excluded.reset_at
           ELSE auth_rate_limits.reset_at
         END
       RETURNING count, reset_at`,
    )
    .bind(keyHash, now + windowMs, now, now)
    .first();
  if (!current) throw new HttpError(503, "Authentication is unavailable");
  if (current.count > limit) {
    const error = new HttpError(429, "Too many requests");
    error.retryAfter = Math.max(1, Math.ceil((current.reset_at - now) / 1000));
    throw error;
  }
}

function defaultRandomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function publicUser(user) {
  return {
    id: user.id,
    accountType: user.account_type,
    email: user.email,
    displayName: user.display_name,
  };
}

async function countRetainedRides(dependencies, userId) {
  const result = await dependencies.db
    .prepare("SELECT count(*) AS count FROM rides WHERE user_id = ? AND deleted_at IS NULL")
    .bind(userId)
    .first();
  return Number(result?.count ?? 0);
}

async function prepareSession({
  jwtSecret,
  now,
  randomBytes,
  user,
}) {
  const sessionId = crypto.randomUUID();
  const refreshToken = randomToken(randomBytes);
  const refreshTokenHash = await sha256(refreshToken);
  const expiresAt = now + REFRESH_TTL_MS;
  const accessToken = await signAccessToken(
    {
      aud: JWT_AUDIENCE,
      exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS,
      iat: Math.floor(now / 1000),
      iss: JWT_ISSUER,
      jti: sessionId,
      sub: user.id,
      tokenVersion: user.token_version,
      typ: "access",
    },
    jwtSecret,
  );
  return {
    accessToken,
    expiresAt,
    refreshToken,
    refreshTokenHash,
    sessionId,
  };
}

async function createSession(dependencies) {
  const prepared = await prepareSession(dependencies);
  await dependencies.db.batch([
    dependencies.db
      .prepare(
        `INSERT INTO auth_sessions
          (id, user_id, refresh_token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        prepared.sessionId,
        dependencies.user.id,
        prepared.refreshTokenHash,
        dependencies.now,
        prepared.expiresAt,
      ),
    dependencies.db
      .prepare(
        `INSERT INTO auth_refresh_tokens (token_hash, session_id, issued_at)
         VALUES (?, ?, ?)`,
      )
      .bind(
        prepared.refreshTokenHash,
        prepared.sessionId,
        dependencies.now,
      ),
  ]);
  return {
    accessToken: prepared.accessToken,
    refreshToken: prepared.refreshToken,
  };
}

async function authenticateAccessToken(accessToken, dependencies) {
  const claims = await verifyAccessToken(
    accessToken,
    dependencies.jwtSecret,
    Math.floor(dependencies.now() / 1000),
  );
  const user = await dependencies.db
    .prepare(
      `SELECT u.id, u.account_type, u.email, u.display_name, u.token_version,
              u.password_hash, u.password_algorithm, u.password_parameters
       FROM users AS u
       JOIN auth_sessions AS s
         ON s.id = ? AND s.user_id = u.id
       WHERE u.id = ?
         AND u.deleted_at IS NULL
         AND s.revoked_at IS NULL
         AND s.expires_at > ?`,
    )
    .bind(claims.jti, claims.sub, dependencies.now())
    .first();
  if (!user || user.token_version !== claims.tokenVersion) {
    throw new HttpError(401, "Invalid session");
  }
  return { claims, user };
}

export async function authenticateRequest(request, dependencies) {
  const accessToken = bearerAccessToken(request) ?? parseCookies(request)[ACCESS_COOKIE];
  if (!accessToken) throw new HttpError(401, "Authentication required");
  return (await authenticateAccessToken(accessToken, dependencies)).user;
}

async function authenticateBearerSession(request, dependencies) {
  const accessToken = bearerAccessToken(request);
  if (!accessToken) throw new HttpError(401, "Authentication required");
  return authenticateAccessToken(accessToken, dependencies);
}

async function anonymous(request, dependencies, native = false) {
  if (!native) assertSameOrigin(request);
  await checkRateLimit(request, "anonymous", dependencies);
  if (native) await readNativeJson(request);
  if (!native) {
    try {
      const existing = await authenticateRequest(request, dependencies);
      return response({ user: publicUser(existing) });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
    }
  }

  const cookies = native ? {} : parseCookies(request);
  if (!native && cookies[INSTALLATION_COOKIE]) {
    const installationHash = await sha256(cookies[INSTALLATION_COOKIE]);
    const restored = await dependencies.db
      .prepare(
        `SELECT u.id, u.account_type, u.email, u.display_name, u.token_version
         FROM anonymous_installations AS i
         JOIN users AS u ON u.id = i.user_id
         WHERE i.installation_secret_hash = ?
           AND i.first_seen_at + ? > ?
           AND u.account_type = 'anonymous'
           AND u.deleted_at IS NULL`,
      )
      .bind(
        installationHash,
        INSTALLATION_TTL_SECONDS * 1000,
        dependencies.now(),
      )
      .first();
    if (restored) {
      const session = await createSession({
        ...dependencies,
        now: dependencies.now(),
        user: restored,
      });
      const headers = new Headers();
      appendSessionCookies(headers, request, session);
      return response({ user: publicUser(restored) }, 200, headers);
    }
  }

  const now = dependencies.now();
  const userId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const installationSecret = randomToken(dependencies.randomBytes);
  const installationHash = await sha256(installationSecret);
  const refreshToken = randomToken(dependencies.randomBytes);
  const refreshHash = await sha256(refreshToken);
  const sessionId = crypto.randomUUID();
  await dependencies.db.batch([
    dependencies.db
      .prepare(
        `INSERT INTO users
          (id, account_type, token_version, last_seen_at, created_at, updated_at)
         VALUES (?, 'anonymous', 0, ?, ?, ?)`,
      )
      .bind(userId, now, now, now),
    dependencies.db
      .prepare(
        `INSERT INTO anonymous_installations
          (id, user_id, installation_secret_hash, user_agent_family,
           first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        installationId,
        userId,
        installationHash,
        userAgentFamily(request),
        now,
        now,
      ),
    dependencies.db
      .prepare(
        `INSERT INTO auth_sessions
          (id, user_id, refresh_token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, userId, refreshHash, now, now + REFRESH_TTL_MS),
    dependencies.db
      .prepare(
        `INSERT INTO auth_refresh_tokens
          (token_hash, session_id, issued_at)
         VALUES (?, ?, ?)`,
      )
      .bind(refreshHash, sessionId, now),
  ]);
  const user = {
    id: userId,
    account_type: "anonymous",
    email: null,
    display_name: null,
    token_version: 0,
  };
  const session = {
    accessToken: await signAccessToken(
      {
        aud: JWT_AUDIENCE,
        exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS,
        iat: Math.floor(now / 1000),
        iss: JWT_ISSUER,
        jti: sessionId,
        sub: userId,
        tokenVersion: 0,
        typ: "access",
      },
      dependencies.jwtSecret,
    ),
    refreshToken,
  };
  if (native) {
    return response({
      user: publicUser(user),
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      installationCredential: installationSecret,
    }, 201);
  }
  const headers = new Headers();
  appendSessionCookies(headers, request, session, installationSecret);
  return response({ user: publicUser(user) }, 201, headers);
}

async function restoreNativeInstallation(request, dependencies) {
  await checkRateLimit(request, "anonymous", dependencies);
  const body = await readNativeJson(request);
  const credential = validateInstallationCredential(body.installationCredential);
  const installationHash = await sha256(credential);
  const restored = await dependencies.db
    .prepare(
      `SELECT u.id, u.account_type, u.email, u.display_name, u.token_version
       FROM anonymous_installations AS i
       JOIN users AS u ON u.id = i.user_id
       WHERE i.installation_secret_hash = ?
         AND i.first_seen_at + ? > ?
         AND u.account_type = 'anonymous'
         AND u.deleted_at IS NULL`,
    )
    .bind(
      installationHash,
      INSTALLATION_TTL_SECONDS * 1000,
      dependencies.now(),
    )
    .first();
  if (!restored) throw new HttpError(401, "Invalid installation credential");
  await dependencies.db
    .prepare("UPDATE anonymous_installations SET last_seen_at = ? WHERE installation_secret_hash = ?")
    .bind(dependencies.now(), installationHash)
    .run();
  const session = await createSession({
    ...dependencies,
    now: dependencies.now(),
    user: restored,
  });
  return response({ user: publicUser(restored), ...session });
}

async function register(request, dependencies, native = false) {
  if (!native) assertSameOrigin(request);
  await checkRateLimit(request, "register", dependencies);
  const current = native
    ? (await authenticateBearerSession(request, dependencies)).user
    : await authenticateRequest(request, dependencies);
  const body = native ? await readNativeJson(request) : await readJson(request);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const displayName = native ? validateDisplayName(body.displayName) : current.display_name;

  if (current.account_type === "registered") {
    if (
      current.email !== email ||
      !(await verifyPassword(password, dependencies.passwordPepper, current))
    ) {
      throw new HttpError(409, "Account is already registered");
    }
    const session = await createSession({
      ...dependencies,
      now: dependencies.now(),
      user: current,
    });
    if (native) {
      return response({
        retainedRideCount: await countRetainedRides(dependencies, current.id),
        user: publicUser(current),
        ...session,
      });
    }
    const headers = new Headers();
    appendSessionCookies(headers, request, session);
    return response({
      retainedRideCount: await countRetainedRides(dependencies, current.id),
      user: publicUser(current),
    }, 200, headers);
  }

  const passwordRecord = await hashPassword(
    password,
    dependencies.passwordPepper,
    dependencies.randomBytes,
  );
  const now = dependencies.now();
  const upgraded = {
    ...current,
    account_type: "registered",
    display_name: displayName,
    email,
    password_hash: passwordRecord.passwordHash,
    password_algorithm: passwordRecord.passwordAlgorithm,
    password_parameters: passwordRecord.passwordParameters,
    token_version: current.token_version + 1,
  };
  const preparedSession = await prepareSession({
    ...dependencies,
    now,
    user: upgraded,
  });
  try {
    const results = await dependencies.db.batch([
      dependencies.db
        .prepare(
          `UPDATE users
           SET account_type = 'registered',
               email = ?,
               display_name = ?,
               password_hash = ?,
               password_algorithm = ?,
               password_parameters = ?,
               registered_at = ?,
               updated_at = ?,
               token_version = token_version + 1
           WHERE id = ? AND account_type = 'anonymous' AND deleted_at IS NULL`,
        )
        .bind(
          email,
          displayName,
          passwordRecord.passwordHash,
          passwordRecord.passwordAlgorithm,
          passwordRecord.passwordParameters,
          now,
          now,
          current.id,
        ),
      dependencies.db
        .prepare(
          `UPDATE auth_sessions
           SET revoked_at = ?
           WHERE user_id = ? AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM users
               WHERE id = ? AND account_type = 'registered'
                 AND email = ? AND password_hash = ?
             )`,
        )
        .bind(
          now,
          current.id,
          current.id,
          email,
          passwordRecord.passwordHash,
        ),
      dependencies.db
        .prepare(
          `INSERT INTO auth_sessions
            (id, user_id, refresh_token_hash, created_at, expires_at)
           SELECT ?, id, ?, ?, ?
           FROM users
           WHERE id = ? AND account_type = 'registered'
             AND email = ? AND password_hash = ?`,
        )
        .bind(
          preparedSession.sessionId,
          preparedSession.refreshTokenHash,
          now,
          preparedSession.expiresAt,
          current.id,
          email,
          passwordRecord.passwordHash,
        ),
      dependencies.db
        .prepare(
          `INSERT INTO auth_refresh_tokens (token_hash, session_id, issued_at)
           SELECT ?, id, ?
           FROM auth_sessions
           WHERE id = ? AND user_id = ? AND refresh_token_hash = ?`,
        )
        .bind(
          preparedSession.refreshTokenHash,
          now,
          preparedSession.sessionId,
          current.id,
          preparedSession.refreshTokenHash,
        ),
    ]);
    if (
      results[0].meta?.changes !== 1 ||
      results[2].meta?.changes !== 1 ||
      results[3].meta?.changes !== 1
    ) {
      throw new HttpError(409, "Account could not be registered");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (/unique constraint/iu.test(String(error))) {
      throw new HttpError(409, "An account already uses that email");
    }
    throw error;
  }

  if (native) {
    return response({
      retainedRideCount: await countRetainedRides(dependencies, upgraded.id),
      user: publicUser(upgraded),
      accessToken: preparedSession.accessToken,
      refreshToken: preparedSession.refreshToken,
    });
  }
  const headers = new Headers();
  appendSessionCookies(headers, request, {
    accessToken: preparedSession.accessToken,
    refreshToken: preparedSession.refreshToken,
  });
  headers.append(
    "Set-Cookie",
    cookie(INSTALLATION_COOKIE, "", request, { maxAge: 0 }),
  );
  return response({
    retainedRideCount: await countRetainedRides(dependencies, upgraded.id),
    user: publicUser(upgraded),
  }, 200, headers);
}

async function login(request, dependencies, native = false) {
  if (!native) assertSameOrigin(request);
  await checkRateLimit(request, "login", dependencies);
  const body = native ? await readNativeJson(request) : await readJson(request);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const user = await dependencies.db
    .prepare(
      `SELECT id, account_type, email, display_name, token_version,
              password_hash, password_algorithm, password_parameters
       FROM users
       WHERE email = ? AND account_type = 'registered' AND deleted_at IS NULL`,
    )
    .bind(email)
    .first();
  if (!user) {
    await derivePassword(
      password,
      dependencies.passwordPepper,
      new Uint8Array(16),
      PASSWORD_ITERATIONS,
    );
    throw new HttpError(401, "Invalid email or password");
  }
  if (!(await verifyPassword(password, dependencies.passwordPepper, user))) {
    throw new HttpError(401, "Invalid email or password");
  }
  const session = await createSession({
    ...dependencies,
    now: dependencies.now(),
    user,
  });
  if (native) return response({ user: publicUser(user), ...session });
  const headers = new Headers();
  appendSessionCookies(headers, request, session);
  headers.append(
    "Set-Cookie",
    cookie(INSTALLATION_COOKIE, "", request, { maxAge: 0 }),
  );
  return response({ user: publicUser(user) }, 200, headers);
}

async function rejectRefreshReuse({ db, now, oldHash, sessionId }) {
  const token = await db
    .prepare(
      `SELECT used_at
       FROM auth_refresh_tokens
       WHERE token_hash = ? AND session_id = ?`,
    )
    .bind(oldHash, sessionId)
    .first();
  if (
    token?.used_at !== null &&
    token?.used_at <= now &&
    now - token.used_at <= REFRESH_CONCURRENCY_GRACE_MS
  ) {
    const error = new HttpError(409, "Refresh already completed");
    error.retryAfter = 1;
    throw error;
  }
  await db
    .prepare(
      `UPDATE auth_sessions
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(now, sessionId)
    .run();
  throw new HttpError(401, "Invalid session");
}

async function replayNativeRefresh({ dependencies, now, oldToken, session }) {
  if (
    session.used_at === null ||
    session.used_at > now ||
    now - session.used_at > NATIVE_REFRESH_REPLAY_GRACE_MS
  ) {
    return null;
  }
  const refreshToken = await nativeRefreshReplacementToken(
    oldToken,
    dependencies.jwtSecret,
  );
  if (await sha256(refreshToken) !== session.refresh_token_hash) return null;
  const accessToken = await signAccessToken(
    {
      aud: JWT_AUDIENCE,
      exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS,
      iat: Math.floor(now / 1000),
      iss: JWT_ISSUER,
      jti: session.session_id,
      sub: session.id,
      tokenVersion: session.token_version,
      typ: "access",
    },
    dependencies.jwtSecret,
  );
  return response({ accessToken, refreshToken });
}

async function refresh(request, dependencies, native = false) {
  if (!native) assertSameOrigin(request);
  await checkRateLimit(request, "refresh", dependencies);
  const oldToken = native
    ? validateRefreshToken((await readNativeJson(request)).refreshToken)
    : parseCookies(request)[REFRESH_COOKIE];
  if (!oldToken) throw new HttpError(401, "Authentication required");
  const oldHash = await sha256(oldToken);
  const now = dependencies.now();
  const session = await dependencies.db
    .prepare(
      `SELECT s.id AS session_id, s.refresh_token_hash, s.expires_at,
              s.revoked_at, t.used_at, u.id, u.account_type, u.email,
              u.display_name, u.token_version
       FROM auth_refresh_tokens AS t
       JOIN auth_sessions AS s ON s.id = t.session_id
       JOIN users AS u ON u.id = s.user_id
       WHERE t.token_hash = ? AND u.deleted_at IS NULL`,
  )
    .bind(oldHash)
    .first();
  if (!session) throw new HttpError(401, "Invalid session");
  if (session.revoked_at !== null || session.expires_at <= now) {
    throw new HttpError(401, "Invalid session");
  }
  if (session.used_at !== null) {
    if (native) {
      const replayed = await replayNativeRefresh({
        dependencies,
        now,
        oldToken,
        session,
      });
      if (replayed) return replayed;
    }
    return rejectRefreshReuse({
      db: dependencies.db,
      now,
      oldHash,
      sessionId: session.session_id,
    });
  }
  if (session.refresh_token_hash !== oldHash) {
    throw new HttpError(401, "Invalid session");
  }

  const newToken = native
    ? await nativeRefreshReplacementToken(oldToken, dependencies.jwtSecret)
    : randomToken(dependencies.randomBytes);
  const newHash = await sha256(newToken);
  const results = await dependencies.db.batch([
    dependencies.db
      .prepare(
        `UPDATE auth_sessions
         SET refresh_token_hash = ?, last_used_at = ?, rotated_at = ?
         WHERE id = ? AND refresh_token_hash = ?
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(newHash, now, now, session.session_id, oldHash, now),
    dependencies.db
      .prepare(
        `INSERT INTO auth_refresh_tokens (token_hash, session_id, issued_at)
         SELECT ?, id, ?
         FROM auth_sessions
         WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
      )
      .bind(newHash, now, session.session_id, newHash),
    dependencies.db
      .prepare(
        `UPDATE auth_refresh_tokens
         SET used_at = ?
         WHERE token_hash = ? AND session_id = ? AND used_at IS NULL`,
      )
      .bind(now, oldHash, session.session_id),
  ]);
  if (results.some((result) => result.meta?.changes !== 1)) {
    if (native) {
      const current = await dependencies.db
        .prepare(
          `SELECT s.id AS session_id, s.refresh_token_hash, s.expires_at,
                  s.revoked_at, t.used_at, u.id, u.token_version
           FROM auth_refresh_tokens AS t
           JOIN auth_sessions AS s ON s.id = t.session_id
           JOIN users AS u ON u.id = s.user_id
           WHERE t.token_hash = ? AND u.deleted_at IS NULL`,
        )
        .bind(oldHash)
        .first();
      if (current && current.revoked_at === null && current.expires_at > now) {
        const replayed = await replayNativeRefresh({
          dependencies,
          now,
          oldToken,
          session: current,
        });
        if (replayed) return replayed;
      }
    }
    return rejectRefreshReuse({
      db: dependencies.db,
      now,
      oldHash,
      sessionId: session.session_id,
    });
  }
  const accessToken = await signAccessToken(
    {
      aud: JWT_AUDIENCE,
      exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS,
      iat: Math.floor(now / 1000),
      iss: JWT_ISSUER,
      jti: session.session_id,
      sub: session.id,
      tokenVersion: session.token_version,
      typ: "access",
    },
    dependencies.jwtSecret,
  );
  if (native) return response({ accessToken, refreshToken: newToken });
  const headers = new Headers();
  appendSessionCookies(headers, request, {
    accessToken,
    refreshToken: newToken,
  }, undefined, Math.floor((session.expires_at - now) / 1000));
  return response({ user: publicUser(session) }, 200, headers);
}

async function logout(request, dependencies, native = false) {
  if (native) {
    const { claims, user } = await authenticateBearerSession(request, dependencies);
    await dependencies.db
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at = ?
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .bind(dependencies.now(), claims.jti, user.id)
      .run();
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  assertSameOrigin(request);
  const cookies = parseCookies(request);
  const refreshToken = cookies[REFRESH_COOKIE];
  const statements = [];
  if (refreshToken) {
    statements.push(
      dependencies.db
        .prepare(
          `UPDATE auth_sessions
           SET revoked_at = ?
           WHERE id IN (
             SELECT session_id
             FROM auth_refresh_tokens
             WHERE token_hash = ?
           ) AND revoked_at IS NULL`,
        )
        .bind(dependencies.now(), await sha256(refreshToken)),
    );
  }
  if (cookies[ACCESS_COOKIE]) {
    try {
      const claims = await verifyAccessToken(
        cookies[ACCESS_COOKIE],
        dependencies.jwtSecret,
        Math.floor(dependencies.now() / 1000),
      );
      statements.push(
        dependencies.db
          .prepare(
            `UPDATE auth_sessions
             SET revoked_at = ?
             WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
          )
          .bind(dependencies.now(), claims.jti, claims.sub),
      );
    } catch {
      // Invalid access tokens do not prevent clearing the browser cookies.
    }
  }
  if (statements.length > 0) await dependencies.db.batch(statements);
  const headers = new Headers();
  appendClearedCookies(headers, request);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(null, { status: 204, headers });
}

async function deleteAccount(request, dependencies) {
  assertSameOrigin(request);
  const user = await authenticateRequest(request, dependencies);
  const deleted = await dependencies.db
    .prepare("DELETE FROM users WHERE id = ? AND deleted_at IS NULL")
    .bind(user.id)
    .run();
  if (deleted.meta?.changes < 1) throw new HttpError(404, "Account not found");
  const headers = new Headers();
  appendClearedCookies(headers, request);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(null, { status: 204, headers });
}

function method(request, expected) {
  if (request.method !== expected) throw new HttpError(405, "Method not allowed");
}

export function createAuthHandler(options) {
  if (
    !options.db ||
    typeof options.jwtSecret !== "string" ||
    options.jwtSecret.length < 32 ||
    typeof options.passwordPepper !== "string" ||
    options.passwordPepper.length < 32
  ) {
    return async () => response({ error: "Authentication is unavailable" }, 503);
  }
  const dependencies = {
    ...options,
    logError: options.logError ?? ((message, details) => console.error(message, details)),
    now: options.now ?? Date.now,
    randomBytes: options.randomBytes ?? defaultRandomBytes,
  };
  return async function handleAuth(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/mobile/v1/auth/anonymous") {
        method(request, "POST");
        return await anonymous(request, dependencies, true);
      }
      if (path === "/api/mobile/v1/auth/installation/restore") {
        method(request, "POST");
        return await restoreNativeInstallation(request, dependencies);
      }
      if (path === "/api/mobile/v1/auth/register") {
        method(request, "POST");
        return await register(request, dependencies, true);
      }
      if (path === "/api/mobile/v1/auth/login") {
        method(request, "POST");
        return await login(request, dependencies, true);
      }
      if (path === "/api/mobile/v1/auth/refresh") {
        method(request, "POST");
        return await refresh(request, dependencies, true);
      }
      if (path === "/api/mobile/v1/auth/logout") {
        method(request, "POST");
        return await logout(request, dependencies, true);
      }
      if (path === "/api/mobile/v1/auth/me") {
        method(request, "GET");
        return response({
          user: publicUser((await authenticateBearerSession(request, dependencies)).user),
        });
      }
      if (path === "/api/auth/anonymous") {
        method(request, "POST");
        return await anonymous(request, dependencies);
      }
      if (path === "/api/auth/register") {
        method(request, "POST");
        return await register(request, dependencies);
      }
      if (path === "/api/auth/login") {
        method(request, "POST");
        return await login(request, dependencies);
      }
      if (path === "/api/auth/refresh") {
        method(request, "POST");
        return await refresh(request, dependencies);
      }
      if (path === "/api/auth/logout") {
        method(request, "POST");
        return await logout(request, dependencies);
      }
      if (path === "/api/auth/account") {
        method(request, "DELETE");
        return await deleteAccount(request, dependencies);
      }
      if (path === "/api/auth/me") {
        method(request, "GET");
        return response({
          user: publicUser(await authenticateRequest(request, dependencies)),
        });
      }
      return response({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = new Headers();
        if (error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
        return response({ error: error.message }, error.status, headers);
      }
      dependencies.logError("Authentication request failed", {
        error: error instanceof Error ? error.name : "UnknownError",
        path: new URL(request.url).pathname,
      });
      return response({ error: "Authentication request failed" }, 500);
    }
  };
}
