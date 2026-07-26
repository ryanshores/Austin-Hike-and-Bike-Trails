import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle/", import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function createTestDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  for (const migrationFile of migrationFiles) {
    const migration = readFileSync(
      join(migrationsDirectory, migrationFile),
      "utf8",
    );
    database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  }

  return database;
}

function insertAnonymousUser(database, id) {
  database.prepare("INSERT INTO users (id) VALUES (?)").run(id);
}

test("route-history migrations create the required tables and indexes", () => {
  assert.ok(migrationFiles.length > 0, "expected at least one SQL migration");
  const database = createTestDatabase();

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  assert.deepEqual(tables, [
    "anonymous_installations",
    "auth_sessions",
    "ride_points",
    "ride_upload_batches",
    "rides",
    "users",
  ]);

  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map(({ name }) => name);
  for (const requiredIndex of [
    "users_email_unique",
    "rides_user_started_idx",
    "ride_points_ride_sequence_unique",
    "ride_upload_batches_ride_sequence_unique",
    "auth_sessions_refresh_token_hash_unique",
  ]) {
    assert.ok(indexes.includes(requiredIndex), `missing ${requiredIndex}`);
  }

  database.close();
});

test("user rows enforce anonymous and registered credential states", () => {
  const database = createTestDatabase();
  insertAnonymousUser(database, "anonymous-user");

  assert.throws(
    () =>
      database
        .prepare(
          "INSERT INTO users (id, account_type, email) VALUES (?, 'anonymous', ?)",
        )
        .run("invalid-anonymous", "anonymous@example.com"),
    /CHECK constraint failed/,
  );

  const insertRegistered = database.prepare(`
    INSERT INTO users (
      id,
      account_type,
      email,
      password_hash,
      password_algorithm,
      password_parameters,
      registered_at
    ) VALUES (?, 'registered', ?, ?, ?, ?, ?)
  `);
  insertRegistered.run(
    "registered-user",
    "rider@example.com",
    "password-hash",
    "argon2id",
    '{"memoryKiB":19456,"iterations":2,"parallelism":1}',
    Date.now(),
  );

  assert.throws(
    () =>
      insertRegistered.run(
        "duplicate-email",
        "rider@example.com",
        "another-password-hash",
        "argon2id",
        '{"memoryKiB":19456,"iterations":2,"parallelism":1}',
        Date.now(),
      ),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () =>
      insertRegistered.run(
        "unnormalized-email",
        "Rider2@Example.com",
        "password-hash",
        "argon2id",
        '{"memoryKiB":19456,"iterations":2,"parallelism":1}',
        Date.now(),
      ),
    /CHECK constraint failed/,
  );

  database.close();
});

test("ride points enforce quality, ordering, and batch ownership", () => {
  const database = createTestDatabase();
  insertAnonymousUser(database, "user-a");
  insertAnonymousUser(database, "user-b");

  const insertRide = database.prepare(
    "INSERT INTO rides (id, user_id, started_at) VALUES (?, ?, ?)",
  );
  insertRide.run("ride-a", "user-a", 1_000);
  insertRide.run("ride-b", "user-b", 1_000);

  const insertBatch = database.prepare(`
    INSERT INTO ride_upload_batches (id, ride_id, first_sequence, point_count)
    VALUES (?, ?, ?, ?)
  `);
  insertBatch.run("batch-a", "ride-a", 0, 1);
  insertBatch.run("batch-b", "ride-b", 0, 1);

  const insertPoint = database.prepare(`
    INSERT INTO ride_points (
      id,
      ride_id,
      upload_batch_id,
      sequence,
      recorded_at,
      latitude,
      longitude,
      accuracy_meters,
      quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertPoint.run(
    "point-a",
    "ride-a",
    "batch-a",
    0,
    1_000,
    30.2672,
    -97.7431,
    12,
    "good",
  );

  for (const [index, accuracy, quality] of [
    [1, 25, "good"],
    [2, 25.1, "fair"],
    [3, 75, "fair"],
    [4, 75.1, "poor"],
    [5, 100, "poor"],
  ]) {
    insertPoint.run(
      `quality-boundary-${index}`,
      "ride-a",
      "batch-a",
      index,
      1_000 + index,
      30.2672,
      -97.7431,
      accuracy,
      quality,
    );
  }

  assert.throws(
    () =>
      insertPoint.run(
        "mismatched-quality",
        "ride-a",
        "batch-a",
        6,
        2_000,
        30.2673,
        -97.7432,
        100,
        "good",
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      insertPoint.run(
        "coarse-point",
        "ride-a",
        "batch-a",
        7,
        2_000,
        30.2673,
        -97.7432,
        4_000,
        "poor",
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      insertPoint.run(
        "foreign-batch-point",
        "ride-a",
        "batch-b",
        8,
        2_000,
        30.2673,
        -97.7432,
        15,
        "good",
      ),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      insertPoint.run(
        "duplicate-sequence",
        "ride-a",
        "batch-a",
        0,
        2_000,
        30.2673,
        -97.7432,
        15,
        "good",
      ),
    /UNIQUE constraint failed/,
  );

  database.close();
});

test("deleting a user cascades through private route and session data", () => {
  const database = createTestDatabase();
  insertAnonymousUser(database, "user-to-delete");
  database
    .prepare(
      `INSERT INTO anonymous_installations
        (id, user_id, installation_secret_hash)
       VALUES (?, ?, ?)`,
    )
    .run("installation", "user-to-delete", "installation-secret-hash");
  database
    .prepare(
      `INSERT INTO auth_sessions
        (id, user_id, refresh_token_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      "session",
      "user-to-delete",
      "refresh-token-hash",
      Date.now() + 60_000,
    );
  database
    .prepare("INSERT INTO rides (id, user_id, started_at) VALUES (?, ?, ?)")
    .run("ride-to-delete", "user-to-delete", 1_000);
  database
    .prepare(
      `INSERT INTO ride_upload_batches
        (id, ride_id, first_sequence, point_count)
       VALUES (?, ?, ?, ?)`,
    )
    .run("batch-to-delete", "ride-to-delete", 0, 1);
  database
    .prepare(
      `INSERT INTO ride_points
        (id, ride_id, upload_batch_id, sequence, recorded_at, latitude,
         longitude, accuracy_meters, quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "point-to-delete",
      "ride-to-delete",
      "batch-to-delete",
      0,
      1_000,
      30.2672,
      -97.7431,
      12,
      "good",
    );

  database.prepare("DELETE FROM users WHERE id = ?").run("user-to-delete");

  for (const table of [
    "users",
    "anonymous_installations",
    "auth_sessions",
    "rides",
    "ride_upload_batches",
    "ride_points",
  ]) {
    const { count } = database
      .prepare(`SELECT count(*) AS count FROM ${table}`)
      .get();
    assert.equal(count, 0, `expected ${table} to be empty`);
  }

  database.close();
});
