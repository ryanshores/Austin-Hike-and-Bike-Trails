# Ride heatmap design

Issue #7 is delivered in separate, reviewable phases. This document defines
the private aggregation and API phase. A community heatmap is not enabled by
this work.

## Product decisions

- **Intensity:** accumulated route-segment distance in metres. This reflects
  travel rather than GPS callback frequency. The response also includes the
  number of distinct rides that contributed to a cell, so the map can explain
  its data without exposing raw route points.
- **Date ranges:** private requests support `30d`, `90d`, `365d`, and `all`.
  Completed rides are stored in UTC daily buckets, allowing rolling ranges to
  exclude older data precisely.
- **Resolution:** the API selects a geohash precision from map zoom: 5 at
  zoom 0-12, 6 at 13-14, and 7 at 15-22. A completed ride is aggregated at
  every supported precision, so requests do not scan raw points.
- **Unavailable and empty states:** the API reports authentication and input
  errors explicitly. A successful request with no cells returns an empty
  `cells` array. The map-layer PR owns loading, offline, and rendering states.
- **Deletion:** a ride's cell contributions are deleted with the ride. SQLite
  triggers decrement its derived cells and remove empty cells in the same
  transaction.

## Private data flow

Only completed rides contribute. For each pair of accepted consecutive points,
the server calculates its geodesic distance and assigns that distance to the
segment midpoint's geohash cell. Contributions for the same ride, day, cell,
and resolution are combined before writing. This prevents repeated callbacks
from creating repeated ride counts while preserving the total travelled
distance.

`ride_heat_cell_contributions` is the per-ride source for deletion. Its
insert/delete triggers maintain owner-scoped `ride_heat_cells`, which is the
only table read by `GET /api/heatmap`. The endpoint requires the verified
session, valid visible-map bounds, and a supported zoom/range. It returns at
most 1,000 cells and refuses an over-dense viewport instead of silently
truncating results.

## Community phase (not enabled)

The later community phase is a separate database and UI path, not an option
on the private endpoint. Before it can be implemented, it requires the issue's
explicit completed-ride opt-in, endpoint trimming or spatial blurring, minimum
distinct-rider and ride thresholds, coarse low-zoom cells, filter resistance,
prompt rebuilds after withdrawal/deletion, and a sparse-data privacy review.
The eventual `Community ride heat` toggle must remain distinct from `My ride
heat` and must never opt a rider in implicitly.
