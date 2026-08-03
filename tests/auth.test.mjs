import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAuthHandler,
  signAccessToken,
  verifyAccessToken,
} from "../worker/auth.js";

const JWT_SECRET = "test-jwt-secret-that-is-at-least-32-bytes";
const PASSWORD_PEPPER = "test-password-pepper-at-least-32-bytes";
const ORIGIN = "https://atlas.test";
const migrationsDirectory = fileURLToPath(
  new URL("../drizzle/", import.meta.url),
);

class TestStatement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new TestStatement(this.database, this.sql, parameters);
  }

  first() {
    return Promise.resolve(
      this.database.prepare(this.sql).get(...this.parameters) ?? null,
    );
  }

  runSync() {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  run() {
    return Promise.resolve(this.runSync());
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    for (const migrationFile of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.database.exec(
        readFileSync(join(migrationsDirectory, migrationFile), "utf8").replaceAll(
          "--> statement-breakpoint",
          "",
        ),
      );
    }
  }

  prepare(sql) {
    return new TestStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

function deterministicRandomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function createFixture(start = 1_800_000_000_000) {
  const db = new TestD1();
  let now = start;
  return {
    db,
    handler: createAuthHandler({
      db,
      jwtSecret: JWT_SECRET,
      passwordPepper: PASSWORD_PEPPER,
      randomBytes: deterministicRandomBytes,
      now: () => now,
    }),
    setNow(value) {
      now = value;
    },
  };
}

function request(path, { body, cookies, method = "POST", ip = "192.0.2.1" } = {}) {
  const headers = new Headers({
    "cf-connecting-ip": ip,
    origin: ORIGIN,
    "user-agent": "Mozilla/5.0 Chrome/130.0",
  });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (cookies && Object.keys(cookies).length > 0) {
    headers.set(
      "cookie",
      Object.entries(cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    );
  }
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function applyCookies(response, jar) {
  for (const value of response.headers.getSetCookie()) {
    const [pair, ...attributes] = value.split(";").map((part) => part.trim());
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const cookieValue = decodeURIComponent(pair.slice(separator + 1));
    if (attributes.some((attribute) => attribute.toLowerCase() === "max-age=0")) {
      delete jar[name];
    } else {
      jar[name] = cookieValue;
    }
  }
}

async function bootstrap(fixture, jar = {}, ip = "192.0.2.1") {
  const result = await fixture.handler(
    request("/api/auth/anonymous", { cookies: jar, ip }),
  );
  applyCookies(result, jar);
  return { body: await result.json(), jar, result };
}

test("anonymous bootstrap issues protected credentials and restores identity", async () => {
  const fixture = createFixture();
  const first = await bootstrap(fixture);

  assert.equal(first.result.status, 201);
  assert.equal(first.body.user.accountType, "anonymous");
  assert.ok(first.jar.atlas_access);
  assert.ok(first.jar.atlas_refresh);
  assert.ok(first.jar.atlas_installation);
  for (const setCookie of first.result.headers.getSetCookie()) {
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /SameSite=Lax/u);
    assert.match(setCookie, /Secure/u);
  }

  const userId = first.body.user.id;
  delete first.jar.atlas_access;
  delete first.jar.atlas_refresh;
  const restored = await bootstrap(fixture, first.jar, "192.0.2.2");
  assert.equal(restored.result.status, 200);
  assert.equal(restored.body.user.id, userId);

  const counts = fixture.db.database
    .prepare(
      `SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM anonymous_installations) AS installations`,
    )
    .get();
  assert.equal(counts.users, 1);
  assert.equal(counts.installations, 1);
  fixture.db.close();
});

test("anonymous installation restoration expires after 90 days", async () => {
  const start = 1_800_000_000_000;
  const fixture = createFixture(start);
  const first = await bootstrap(fixture);
  const originalUserId = first.body.user.id;
  const installation = first.jar.atlas_installation;

  fixture.setNow(start + 90 * 24 * 60 * 60 * 1000);
  const expired = await bootstrap(
    fixture,
    { atlas_installation: installation },
    "192.0.2.2",
  );

  assert.equal(expired.result.status, 201);
  assert.notEqual(expired.body.user.id, originalUserId);
  fixture.db.close();
});

test("auth rate limits are shared across Worker handlers", async () => {
  const fixture = createFixture();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await fixture.handler(
      request("/api/auth/anonymous", { ip: "192.0.2.42" }),
    );
    assert.equal(result.status, 201);
  }

  const limited = await fixture.handler(
    request("/api/auth/anonymous", { ip: "192.0.2.42" }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");

  const secondWorkerHandler = createAuthHandler({
    db: fixture.db,
    jwtSecret: JWT_SECRET,
    passwordPepper: PASSWORD_PEPPER,
    randomBytes: deterministicRandomBytes,
    now: () => 1_800_000_000_000,
  });
  const limitedAcrossHandlers = await secondWorkerHandler(
    request("/api/auth/anonymous", { ip: "192.0.2.42" }),
  );
  assert.equal(limitedAcrossHandlers.status, 429);
  assert.equal(
    fixture.db.database
      .prepare("SELECT count(*) AS count FROM auth_rate_limits")
      .get().count,
    1,
  );
  fixture.db.close();
});

test("JWT verification rejects tampering, expiry, and the wrong audience", async () => {
  const nowSeconds = 1_800_000_000;
  const valid = await signAccessToken(
    {
      aud: "austin-hike-bike-atlas-web",
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: "austin-hike-bike-atlas",
      jti: "token-id",
      sub: "user-id",
      tokenVersion: 0,
      typ: "access",
    },
    JWT_SECRET,
  );
  assert.equal(
    (await verifyAccessToken(valid, JWT_SECRET, nowSeconds)).sub,
    "user-id",
  );
  await assert.rejects(
    verifyAccessToken(`${valid.slice(0, -1)}x`, JWT_SECRET, nowSeconds),
    /Invalid session/u,
  );
  await assert.rejects(
    verifyAccessToken(valid, JWT_SECRET, nowSeconds + 61),
    /Invalid session/u,
  );

  const wrongAudience = await signAccessToken(
    {
      aud: "another-app",
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: "austin-hike-bike-atlas",
      jti: "token-id",
      sub: "user-id",
      tokenVersion: 0,
      typ: "access",
    },
    JWT_SECRET,
  );
  await assert.rejects(
    verifyAccessToken(wrongAudience, JWT_SECRET, nowSeconds),
    /Invalid session/u,
  );
});

test("registration upgrades the same anonymous owner and preserves rides", async () => {
  const fixture = createFixture();
  const { body: anonymousBody, jar } = await bootstrap(fixture);
  const anonymousInstallation = jar.atlas_installation;
  fixture.db.database
    .prepare("INSERT INTO rides (id, user_id, started_at) VALUES (?, ?, ?)")
    .run("existing-ride", anonymousBody.user.id, 1_800_000_000_000);
  const oldAccess = jar.atlas_access;

  const registration = await fixture.handler(
    request("/api/auth/register", {
      cookies: jar,
      body: {
        email: " Rider@Example.com ",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(registration, jar);
  const registrationBody = await registration.json();

  assert.equal(registration.status, 200);
  assert.equal(registrationBody.user.id, anonymousBody.user.id);
  assert.equal(registrationBody.user.accountType, "registered");
  assert.equal(registrationBody.user.email, "rider@example.com");
  assert.equal(registrationBody.retainedRideCount, 1);
  assert.equal(
    fixture.db.database
      .prepare("SELECT user_id FROM rides WHERE id = ?")
      .get("existing-ride").user_id,
    anonymousBody.user.id,
  );

  const oldSession = await fixture.handler(
    request("/api/auth/me", {
      method: "GET",
      cookies: { atlas_access: oldAccess },
    }),
  );
  assert.equal(oldSession.status, 401);

  const current = await fixture.handler(
    request("/api/auth/me", { method: "GET", cookies: jar }),
  );
  assert.equal(current.status, 200);

  const secondAnonymous = await bootstrap(fixture, {}, "192.0.2.21");
  const duplicateEmail = await fixture.handler(
    request("/api/auth/register", {
      cookies: secondAnonymous.jar,
      ip: "192.0.2.21",
      body: {
        email: "rider@example.com",
        password: "another secure password",
      },
    }),
  );
  assert.equal(duplicateEmail.status, 409);
  const secondStillAnonymous = await fixture.handler(
    request("/api/auth/me", {
      method: "GET",
      cookies: secondAnonymous.jar,
    }),
  );
  assert.equal(secondStillAnonymous.status, 200);
  assert.equal(
    (await secondStillAnonymous.json()).user.accountType,
    "anonymous",
  );

  const cannotRestoreRegistered = await bootstrap(
    fixture,
    { atlas_installation: anonymousInstallation },
    "192.0.2.22",
  );
  assert.equal(cannotRestoreRegistered.result.status, 201);
  assert.notEqual(cannotRestoreRegistered.body.user.id, anonymousBody.user.id);
  fixture.db.close();
});

test("login, refresh rotation, logout, and origin checks protect sessions", async () => {
  const fixture = createFixture();
  const { jar } = await bootstrap(fixture);
  const registration = await fixture.handler(
    request("/api/auth/register", {
      cookies: jar,
      body: {
        email: "rider@example.com",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(registration, jar);

  const loginJar = {};
  const login = await fixture.handler(
    request("/api/auth/login", {
      ip: "192.0.2.9",
      body: {
        email: "rider@example.com",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(login, loginJar);
  assert.equal(login.status, 200, await login.clone().text());
  const oldRefresh = loginJar.atlas_refresh;
  const accessBeforeLogout = loginJar.atlas_access;

  const simultaneousRefreshes = await Promise.all([
    fixture.handler(
      request("/api/auth/refresh", {
        cookies: { atlas_refresh: oldRefresh },
        ip: "192.0.2.9",
      }),
    ),
    fixture.handler(
      request("/api/auth/refresh", {
        cookies: { atlas_refresh: oldRefresh },
        ip: "192.0.2.10",
      }),
    ),
  ]);
  const successfulRefresh = simultaneousRefreshes.find(
    (result) => result.status === 200,
  );
  const concurrentRefresh = simultaneousRefreshes.find(
    (result) => result.status === 409,
  );
  assert.ok(successfulRefresh);
  assert.ok(concurrentRefresh);
  applyCookies(successfulRefresh, loginJar);
  assert.notEqual(loginJar.atlas_refresh, oldRefresh);
  assert.equal(concurrentRefresh.status, 409);
  assert.equal(concurrentRefresh.headers.get("retry-after"), "1");

  const onceRotatedRefresh = loginJar.atlas_refresh;
  const stillUsableAfterConcurrentRefresh = await fixture.handler(
    request("/api/auth/refresh", { cookies: loginJar, ip: "192.0.2.11" }),
  );
  applyCookies(stillUsableAfterConcurrentRefresh, loginJar);
  assert.equal(stillUsableAfterConcurrentRefresh.status, 200);
  assert.notEqual(loginJar.atlas_refresh, onceRotatedRefresh);

  fixture.setNow(1_800_000_005_001);
  const replay = await fixture.handler(
    request("/api/auth/refresh", {
      cookies: { atlas_refresh: oldRefresh },
      ip: "192.0.2.12",
    }),
  );
  assert.equal(replay.status, 401);

  const replayRevokedRotatedToken = await fixture.handler(
    request("/api/auth/refresh", {
      cookies: { atlas_refresh: loginJar.atlas_refresh },
      ip: "192.0.2.13",
    }),
  );
  assert.equal(replayRevokedRotatedToken.status, 401);

  const crossOrigin = await fixture.handler(
    new Request(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie: `atlas_refresh=${loginJar.atlas_refresh}`,
        origin: "https://attacker.example",
      },
    }),
  );
  assert.equal(crossOrigin.status, 403);

  const logout = await fixture.handler(
    request("/api/auth/logout", { cookies: loginJar }),
  );
  applyCookies(logout, loginJar);
  assert.equal(logout.status, 204);
  assert.deepEqual(loginJar, {});

  const revokedAccess = await fixture.handler(
    request("/api/auth/me", {
      method: "GET",
      cookies: { atlas_access: accessBeforeLogout },
    }),
  );
  assert.equal(revokedAccess.status, 401);
  fixture.db.close();
});

test("refresh rotation does not extend cookies past the session expiry", async () => {
  const start = 1_800_000_000_000;
  const fixture = createFixture(start);
  const { jar } = await bootstrap(fixture);
  const registration = await fixture.handler(
    request("/api/auth/register", {
      cookies: jar,
      body: {
        email: "rider@example.com",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(registration, jar);

  const loginJar = {};
  const login = await fixture.handler(
    request("/api/auth/login", {
      body: {
        email: "rider@example.com",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(login, loginJar);

  fixture.setNow(start + 30 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000);
  const refreshed = await fixture.handler(
    request("/api/auth/refresh", { cookies: loginJar }),
  );
  assert.equal(refreshed.status, 200);
  const cookies = refreshed.headers.getSetCookie();
  assert.match(
    cookies.find((value) => value.startsWith("atlas_access=")),
    /Max-Age=300/u,
  );
  assert.match(
    cookies.find((value) => value.startsWith("atlas_refresh=")),
    /Max-Age=300/u,
  );
  fixture.db.close();
});

test("logout revokes a session when given a rotated refresh token", async () => {
  const fixture = createFixture();
  const { jar } = await bootstrap(fixture);
  const registration = await fixture.handler(
    request("/api/auth/register", {
      cookies: jar,
      body: {
        email: "rider@example.com",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(registration, jar);

  const loginJar = {};
  const login = await fixture.handler(
    request("/api/auth/login", {
      body: {
        email: "rider@example.com",
        password: "correct horse battery staple",
      },
    }),
  );
  applyCookies(login, loginJar);
  const rotatedRefresh = loginJar.atlas_refresh;
  const refreshed = await fixture.handler(
    request("/api/auth/refresh", { cookies: loginJar }),
  );
  applyCookies(refreshed, loginJar);
  delete loginJar.atlas_access;

  const logout = await fixture.handler(
    request("/api/auth/logout", {
      cookies: { atlas_refresh: rotatedRefresh },
    }),
  );
  assert.equal(logout.status, 204);

  const revoked = await fixture.handler(
    request("/api/auth/refresh", { cookies: loginJar }),
  );
  assert.equal(revoked.status, 401);
  fixture.db.close();
});

test("missing secrets fail closed", async () => {
  const fixture = createFixture();
  const unavailable = createAuthHandler({ db: fixture.db });
  const result = await unavailable(request("/api/auth/anonymous"));
  assert.equal(result.status, 503);
  fixture.db.close();
});
