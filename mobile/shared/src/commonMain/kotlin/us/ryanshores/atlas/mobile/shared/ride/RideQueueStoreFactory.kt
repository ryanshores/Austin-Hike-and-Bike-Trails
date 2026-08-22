package us.ryanshores.atlas.mobile.shared.ride

interface RideQueueStoreFactory {
    fun create(): SqliteRideQueue
}
