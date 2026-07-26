import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

function auditTimestamps() {
  return {
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  };
}

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    accountType: text("account_type", {
      enum: ["anonymous", "registered"],
    })
      .notNull()
      .default("anonymous"),
    email: text("email"),
    passwordHash: text("password_hash"),
    passwordAlgorithm: text("password_algorithm"),
    passwordParameters: text("password_parameters", { mode: "json" }).$type<
      Record<string, number | string>
    >(),
    displayName: text("display_name"),
    tokenVersion: integer("token_version").notNull().default(0),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    registeredAt: integer("registered_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    ...auditTimestamps(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    index("users_account_type_last_seen_idx").on(
      table.accountType,
      table.lastSeenAt,
    ),
    check(
      "users_account_type_check",
      sql`${table.accountType} in ('anonymous', 'registered')`,
    ),
    check(
      "users_registered_credentials_check",
      sql`(
        (${table.accountType} = 'anonymous'
          and ${table.email} is null
          and ${table.passwordHash} is null
          and ${table.passwordAlgorithm} is null
          and ${table.passwordParameters} is null
          and ${table.registeredAt} is null)
        or
        (${table.accountType} = 'registered'
          and ${table.email} is not null
          and length(${table.email}) > 0
          and ${table.passwordHash} is not null
          and length(${table.passwordHash}) > 0
          and ${table.passwordAlgorithm} is not null
          and length(${table.passwordAlgorithm}) > 0
          and ${table.passwordParameters} is not null
          and ${table.registeredAt} is not null)
      )`,
    ),
    check(
      "users_email_normalized_check",
      sql`${table.email} is null
        or ${table.email} = lower(trim(${table.email}))`,
    ),
    check("users_token_version_check", sql`${table.tokenVersion} >= 0`),
  ],
);

export const anonymousInstallations = sqliteTable(
  "anonymous_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationSecretHash: text("installation_secret_hash").notNull(),
    userAgentFamily: text("user_agent_family"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("anonymous_installations_secret_hash_unique").on(
      table.installationSecretHash,
    ),
    index("anonymous_installations_user_idx").on(table.userId),
    index("anonymous_installations_last_seen_idx").on(table.lastSeenAt),
  ],
);

export const rides = sqliteTable(
  "rides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["recording", "completed", "abandoned"],
    })
      .notNull()
      .default("recording"),
    title: text("title"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    distanceMeters: real("distance_meters").notNull().default(0),
    acceptedPointCount: integer("accepted_point_count").notNull().default(0),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    ...auditTimestamps(),
  },
  (table) => [
    index("rides_user_started_idx").on(table.userId, table.startedAt),
    index("rides_user_status_idx").on(table.userId, table.status),
    check(
      "rides_status_check",
      sql`${table.status} in ('recording', 'completed', 'abandoned')`,
    ),
    check(
      "rides_status_timestamps_check",
      sql`(
        (${table.status} = 'recording' and ${table.endedAt} is null)
        or
        (${table.status} in ('completed', 'abandoned')
          and ${table.endedAt} is not null)
      )`,
    ),
    check(
      "rides_chronology_check",
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
    check(
      "rides_distance_check",
      sql`${table.distanceMeters} >= 0`,
    ),
    check(
      "rides_point_count_check",
      sql`${table.acceptedPointCount} >= 0`,
    ),
  ],
);

export const rideUploadBatches = sqliteTable(
  "ride_upload_batches",
  {
    id: text("id").primaryKey(),
    rideId: text("ride_id")
      .notNull()
      .references(() => rides.id, { onDelete: "cascade" }),
    firstSequence: integer("first_sequence").notNull(),
    pointCount: integer("point_count").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("ride_upload_batches_id_ride_unique").on(
      table.id,
      table.rideId,
    ),
    uniqueIndex("ride_upload_batches_ride_sequence_unique").on(
      table.rideId,
      table.firstSequence,
    ),
    index("ride_upload_batches_ride_idx").on(table.rideId),
    check(
      "ride_upload_batches_first_sequence_check",
      sql`${table.firstSequence} >= 0`,
    ),
    check(
      "ride_upload_batches_point_count_check",
      sql`${table.pointCount} > 0`,
    ),
  ],
);

export const ridePoints = sqliteTable(
  "ride_points",
  {
    id: text("id").primaryKey(),
    rideId: text("ride_id").notNull(),
    uploadBatchId: text("upload_batch_id").notNull(),
    sequence: integer("sequence").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    accuracyMeters: real("accuracy_meters").notNull(),
    altitudeMeters: real("altitude_meters"),
    speedMetersPerSecond: real("speed_meters_per_second"),
    headingDegrees: real("heading_degrees"),
    quality: text("quality", { enum: ["good", "fair", "poor"] }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.uploadBatchId, table.rideId],
      foreignColumns: [rideUploadBatches.id, rideUploadBatches.rideId],
      name: "ride_points_batch_ride_fk",
    }).onDelete("cascade"),
    uniqueIndex("ride_points_ride_sequence_unique").on(
      table.rideId,
      table.sequence,
    ),
    index("ride_points_batch_idx").on(table.uploadBatchId),
    index("ride_points_ride_recorded_idx").on(
      table.rideId,
      table.recordedAt,
    ),
    check("ride_points_sequence_check", sql`${table.sequence} >= 0`),
    check(
      "ride_points_latitude_check",
      sql`${table.latitude} between -90 and 90`,
    ),
    check(
      "ride_points_longitude_check",
      sql`${table.longitude} between -180 and 180`,
    ),
    check(
      "ride_points_accuracy_check",
      sql`${table.accuracyMeters} >= 0 and ${table.accuracyMeters} <= 100`,
    ),
    check(
      "ride_points_speed_check",
      sql`${table.speedMetersPerSecond} is null or ${table.speedMetersPerSecond} >= 0`,
    ),
    check(
      "ride_points_heading_check",
      sql`${table.headingDegrees} is null
        or (${table.headingDegrees} >= 0 and ${table.headingDegrees} < 360)`,
    ),
    check(
      "ride_points_quality_accuracy_check",
      sql`(
        (${table.quality} = 'good' and ${table.accuracyMeters} <= 25)
        or
        (${table.quality} = 'fair'
          and ${table.accuracyMeters} > 25
          and ${table.accuracyMeters} <= 75)
        or
        (${table.quality} = 'poor'
          and ${table.accuracyMeters} > 75
          and ${table.accuracyMeters} <= 100)
      )`,
    ),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("auth_sessions_refresh_token_hash_unique").on(
      table.refreshTokenHash,
    ),
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expires_idx").on(table.expiresAt),
    check(
      "auth_sessions_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const authRefreshTokens = sqliteTable(
  "auth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => authSessions.id, { onDelete: "cascade" }),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("auth_refresh_tokens_session_idx").on(table.sessionId),
  ],
);

export const authRateLimits = sqliteTable(
  "auth_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    count: integer("count").notNull(),
    resetAt: integer("reset_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("auth_rate_limits_reset_idx").on(table.resetAt)],
);
