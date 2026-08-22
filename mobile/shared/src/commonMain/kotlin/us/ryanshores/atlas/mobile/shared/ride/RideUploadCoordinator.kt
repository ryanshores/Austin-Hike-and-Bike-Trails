package us.ryanshores.atlas.mobile.shared.ride

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import us.ryanshores.atlas.mobile.shared.auth.NativeSession
import us.ryanshores.atlas.mobile.shared.auth.NativeSessionStore

class RideUploadCoordinator(
    private val queue: SqliteRideQueue,
    private val api: RideApi,
    private val sessionStore: NativeSessionStore,
    private val batchIdFactory: () -> String,
) {
    private val mutex = Mutex()

    suspend fun synchronize(
        nowMilliseconds: Long,
        sessionOwnerId: String,
        maximumBatches: Int = 10,
        maximumPointsPerBatch: Long = 100,
    ): RideSyncResult {
        require(nowMilliseconds >= 0) { "nowMilliseconds must be nonnegative" }
        require(sessionOwnerId.isNotBlank()) { "sessionOwnerId must not be blank" }
        require(maximumBatches in 1..100) { "maximumBatches must be between 1 and 100" }
        require(maximumPointsPerBatch in 1..100) { "maximumPointsPerBatch must be between 1 and 100" }

        mutex.lock()
        return try {
            synchronizeLocked(
                nowMilliseconds = nowMilliseconds,
                sessionOwnerId = sessionOwnerId,
                maximumBatches = maximumBatches,
                maximumPointsPerBatch = maximumPointsPerBatch,
            )
        } finally {
            mutex.unlock()
        }
    }

    private suspend fun synchronizeLocked(
        nowMilliseconds: Long,
        sessionOwnerId: String,
        maximumBatches: Int,
        maximumPointsPerBatch: Long,
    ): RideSyncResult {
        val active = try {
            queue.activeRide()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return failure(RideSyncPhase.LOCAL_QUEUE)
        } ?: return RideSyncResult.NoActiveRide
        if (active.ownerId != sessionOwnerId) {
            return RideSyncResult.IdentityMismatch(active.ownerId, sessionOwnerId)
        }
        val session = try {
            sessionStore.load().session
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return failure(RideSyncPhase.SESSION_STORE)
        }
        if (session == null || !session.isComplete()) return RideSyncResult.AuthenticationRequired
        if (session.ownerId != sessionOwnerId) {
            return RideSyncResult.IdentityMismatch(active.ownerId, session.ownerId)
        }
        val context = SessionContext(session)

        when (
            val created = authorized(context, RideSyncPhase.CREATE_RIDE) { token ->
                api.createRide(token, active)
            }
        ) {
            is AuthorizedResult.Failure -> return created.result
            is AuthorizedResult.Success -> if (created.value.rideId != active.rideId) {
                return failure(RideSyncPhase.CREATE_RIDE)
            }
        }

        var uploadedPointCount = 0
        repeat(maximumBatches) {
            val next = try {
                queue.nextUploadBatch(
                    newBatchId = batchIdFactory(),
                    nowMilliseconds = nowMilliseconds,
                    maximumPoints = maximumPointsPerBatch,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                return failure(RideSyncPhase.LOCAL_QUEUE, uploadedPointCount = uploadedPointCount)
            }
            when (next) {
                NextUploadBatchResult.Empty -> {
                    val current = try {
                        queue.activeRide()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        return failure(
                            RideSyncPhase.LOCAL_QUEUE,
                            uploadedPointCount = uploadedPointCount,
                        )
                    } ?: return RideSyncResult.NoActiveRide
                    if (current.status == RideRecordingStatus.RECORDING) {
                        return RideSyncResult.RecordingSynced(uploadedPointCount)
                    }
                    return completeRide(context, current.rideId, uploadedPointCount)
                }

                is NextUploadBatchResult.Expired -> return RideSyncResult.Expired(
                    rideId = next.rideId,
                    oldestRecordedAtMilliseconds = next.oldestRecordedAtMilliseconds,
                    uploadedPointCount = uploadedPointCount,
                )

                is NextUploadBatchResult.FutureDated -> return RideSyncResult.FutureDated(
                    rideId = next.rideId,
                    recordedAtMilliseconds = next.recordedAtMilliseconds,
                    retryAtMilliseconds = next.retryAtMilliseconds,
                    uploadedPointCount = uploadedPointCount,
                )

                is NextUploadBatchResult.Ready -> {
                    val batch = next.batch
                    when (
                        val uploaded = authorized(context, RideSyncPhase.UPLOAD_BATCH) { token ->
                            api.uploadBatch(token, batch)
                        }
                    ) {
                        is AuthorizedResult.Failure -> {
                            if (
                                uploaded.result.statusCode == 400 &&
                                batch.points.first().point.recordedAtMilliseconds <
                                nowMilliseconds - MAX_SERVER_POINT_AGE_MILLISECONDS
                            ) {
                                return RideSyncResult.Expired(
                                    rideId = batch.rideId,
                                    oldestRecordedAtMilliseconds =
                                        batch.points.first().point.recordedAtMilliseconds,
                                    uploadedPointCount = uploadedPointCount,
                                )
                            }
                            return uploaded.result.withUploadedCount(uploadedPointCount)
                        }
                        is AuthorizedResult.Success -> {
                            val requiredAcceptedCount = batch.points.last().sequence + 1
                            if (uploaded.value.acceptedPointCount < requiredAcceptedCount) {
                                return failure(
                                    RideSyncPhase.UPLOAD_BATCH,
                                    uploadedPointCount = uploadedPointCount,
                                )
                            }
                            val acknowledged = try {
                                queue.acknowledgeBatch(batch.batchId)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Throwable) {
                                return failure(
                                    RideSyncPhase.LOCAL_QUEUE,
                                    uploadedPointCount = uploadedPointCount,
                                )
                            }
                            if (acknowledged != batch.points.size) {
                                return failure(
                                    RideSyncPhase.LOCAL_QUEUE,
                                    uploadedPointCount = uploadedPointCount,
                                )
                            }
                            uploadedPointCount += acknowledged
                        }
                    }
                }
            }
        }
        return RideSyncResult.MoreWork(uploadedPointCount)
    }

    private suspend fun completeRide(
        context: SessionContext,
        rideId: String,
        uploadedPointCount: Int,
    ): RideSyncResult {
        return when (
            val completed = authorized(context, RideSyncPhase.COMPLETE_RIDE) { token ->
                api.completeRide(token, rideId)
            }
        ) {
            is AuthorizedResult.Failure -> completed.result.withUploadedCount(uploadedPointCount)
            is AuthorizedResult.Success -> {
                if (completed.value.rideId != rideId) {
                    return failure(
                        RideSyncPhase.COMPLETE_RIDE,
                        uploadedPointCount = uploadedPointCount,
                    )
                }
                val finished = try {
                    queue.finishCompletionIfQueueEmpty()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    return failure(RideSyncPhase.LOCAL_QUEUE, uploadedPointCount = uploadedPointCount)
                }
                if (!finished) {
                    failure(RideSyncPhase.LOCAL_QUEUE, uploadedPointCount = uploadedPointCount)
                } else {
                    RideSyncResult.RideCompleted(rideId, uploadedPointCount)
                }
            }
        }
    }

    private suspend fun <T> authorized(
        context: SessionContext,
        phase: RideSyncPhase,
        operation: suspend (accessToken: String) -> RideApiResult<T>,
    ): AuthorizedResult<T> {
        val first = operation(context.session.accessToken)
        if (first !is RideApiResult.HttpFailure || first.statusCode != 401 || context.refreshAttempted) {
            return first.toAuthorizedResult(phase)
        }

        context.refreshAttempted = true
        val refreshed = api.refresh(context.session.refreshToken)
        val recoveredFromInstallation = refreshed !is RideApiResult.Success
        var replacement = when (refreshed) {
            is RideApiResult.Success -> refreshed.value.toNativeSession(context.session)
            else -> {
                if (!refreshed.canRecoverWithInstallation()) {
                    return AuthorizedResult.Failure(refreshed.toFailure(RideSyncPhase.REFRESH_SESSION))
                }
                restoreAnonymousSession(context.session)
                    ?: return AuthorizedResult.Failure(refreshed.toFailure(RideSyncPhase.REFRESH_SESSION))
            }
        }
        if (!replacement.isComplete()) {
            if (recoveredFromInstallation) {
                return AuthorizedResult.Failure(failure(RideSyncPhase.REFRESH_SESSION))
            }
            replacement = restoreAnonymousSession(context.session)
                ?: return AuthorizedResult.Failure(failure(RideSyncPhase.REFRESH_SESSION))
            if (!replacement.isComplete()) {
                return AuthorizedResult.Failure(failure(RideSyncPhase.REFRESH_SESSION))
            }
        }
        if (!saveSession(replacement)) {
            if (recoveredFromInstallation) {
                return AuthorizedResult.Failure(failure(RideSyncPhase.SESSION_STORE))
            }
            replacement = restoreAnonymousSession(context.session)
                ?: return AuthorizedResult.Failure(failure(RideSyncPhase.SESSION_STORE))
            if (!replacement.isComplete() || !saveSession(replacement)) {
                return AuthorizedResult.Failure(failure(RideSyncPhase.SESSION_STORE))
            }
        }
        context.session = replacement
        return operation(replacement.accessToken).toAuthorizedResult(phase)
    }

    private suspend fun restoreAnonymousSession(previous: NativeSession): NativeSession? {
        val installationCredential = previous.installationCredential?.takeIf(String::isNotBlank)
            ?: return null
        val restored = api.restoreAnonymousSession(installationCredential)
        if (restored !is RideApiResult.Success) return null
        if (restored.value.ownerId != previous.ownerId) return null
        return NativeSession(
            accessToken = restored.value.accessToken,
            refreshToken = restored.value.refreshToken,
            installationCredential = previous.installationCredential,
            ownerId = restored.value.ownerId,
        )
    }

    private fun RefreshSessionResponse.toNativeSession(previous: NativeSession) = NativeSession(
        accessToken = accessToken,
        refreshToken = refreshToken,
        installationCredential = previous.installationCredential,
        ownerId = previous.ownerId,
    )

    private fun RideApiResult<*>.canRecoverWithInstallation(): Boolean = when (this) {
        RideApiResult.InvalidResponse,
        RideApiResult.Unavailable,
        -> true

        is RideApiResult.HttpFailure -> statusCode == 401 || statusCode == 409 || statusCode >= 500
        is RideApiResult.Success -> false
    }

    private fun saveSession(session: NativeSession): Boolean = try {
        sessionStore.save(session)
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        false
    }

    private fun <T> RideApiResult<T>.toAuthorizedResult(phase: RideSyncPhase): AuthorizedResult<T> =
        when (this) {
            is RideApiResult.Success -> AuthorizedResult.Success(value)
            else -> AuthorizedResult.Failure(toFailure(phase))
        }

    private fun RideApiResult<*>.toFailure(phase: RideSyncPhase): RideSyncResult.RecoverableFailure =
        when (this) {
            is RideApiResult.HttpFailure -> failure(
                phase = phase,
                statusCode = statusCode,
                retryAfterSeconds = retryAfterSeconds,
            )

            RideApiResult.InvalidResponse,
            RideApiResult.Unavailable,
            is RideApiResult.Success,
            -> failure(phase)
        }

    private fun failure(
        phase: RideSyncPhase,
        statusCode: Int? = null,
        retryAfterSeconds: Long? = null,
        uploadedPointCount: Int = 0,
    ) = RideSyncResult.RecoverableFailure(
        phase = phase,
        statusCode = statusCode,
        retryAfterSeconds = retryAfterSeconds,
        uploadedPointCount = uploadedPointCount,
    )

    private fun RideSyncResult.RecoverableFailure.withUploadedCount(count: Int): RideSyncResult.RecoverableFailure =
        copy(uploadedPointCount = count)

    private data class SessionContext(
        var session: NativeSession,
        var refreshAttempted: Boolean = false,
    )

    private sealed class AuthorizedResult<out T> {
        data class Success<T>(val value: T) : AuthorizedResult<T>()
        data class Failure(val result: RideSyncResult.RecoverableFailure) : AuthorizedResult<Nothing>()
    }

    private companion object {
        const val MAX_SERVER_POINT_AGE_MILLISECONDS = 24L * 60 * 60 * 1_000
    }
}

enum class RideSyncPhase {
    SESSION_STORE,
    CREATE_RIDE,
    REFRESH_SESSION,
    UPLOAD_BATCH,
    COMPLETE_RIDE,
    LOCAL_QUEUE,
}

sealed class RideSyncResult {
    data object NoActiveRide : RideSyncResult()
    data object AuthenticationRequired : RideSyncResult()

    data class IdentityMismatch(
        val activeOwnerId: String,
        val sessionOwnerId: String,
    ) : RideSyncResult()

    data class RecordingSynced(val uploadedPointCount: Int) : RideSyncResult()

    data class RideCompleted(
        val rideId: String,
        val uploadedPointCount: Int,
    ) : RideSyncResult()

    data class MoreWork(val uploadedPointCount: Int) : RideSyncResult()

    data class Expired(
        val rideId: String,
        val oldestRecordedAtMilliseconds: Long,
        val uploadedPointCount: Int,
    ) : RideSyncResult()

    data class FutureDated(
        val rideId: String,
        val recordedAtMilliseconds: Long,
        val retryAtMilliseconds: Long,
        val uploadedPointCount: Int,
    ) : RideSyncResult()

    data class RecoverableFailure(
        val phase: RideSyncPhase,
        val statusCode: Int?,
        val retryAfterSeconds: Long?,
        val uploadedPointCount: Int,
    ) : RideSyncResult()
}
