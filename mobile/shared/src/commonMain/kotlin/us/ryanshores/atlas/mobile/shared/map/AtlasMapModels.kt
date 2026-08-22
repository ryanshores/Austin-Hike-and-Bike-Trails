package us.ryanshores.atlas.mobile.shared.map

/** A Worker viewport request. Clients must never fetch citywide facilities. */
data class MapBounds(
    val west: Double,
    val south: Double,
    val east: Double,
    val north: Double,
) {
    init {
        require(west in -180.0..180.0 && east in -180.0..180.0 && south in -90.0..90.0 && north in -90.0..90.0)
        require(west < east && south < north)
        require(east - west <= 5 && north - south <= 5)
    }

    fun queryValue(): String = "$west,$south,$east,$north"
}

enum class BikeFacilityCategory {
    OFF_ROAD,
    PROTECTED,
    STREET,
}

data class BikeFacility(
    val id: String,
    val category: BikeFacilityCategory,
    /** Longitude, latitude pairs; the MapKit host converts these to coordinates. */
    val coordinates: List<GeoCoordinate>,
)

data class GeoCoordinate(val longitude: Double, val latitude: Double)

fun classifyBikeFacility(facility: String?, lineType: String?): BikeFacilityCategory {
    val normalizedFacility = facility.orEmpty().lowercase()
    val normalizedLineType = lineType.orEmpty().lowercase()
    return when {
        normalizedLineType.contains("off-street") || normalizedFacility.contains("trail") || normalizedFacility.contains("shared use") -> BikeFacilityCategory.OFF_ROAD
        normalizedFacility.contains("protected") || normalizedFacility.contains("buffer") || normalizedFacility.contains("cycle track") || normalizedFacility.contains("wparking") -> BikeFacilityCategory.PROTECTED
        else -> BikeFacilityCategory.STREET
    }
}
