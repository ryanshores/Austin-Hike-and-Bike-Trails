# City/OSM conflation spike

This is the go/no-go experiment for issue #9. It measures whether an Austin-area Valhalla bicycle route can be associated with City bicycle-facility geometry closely enough to support City-authoritative safety labels. It is not a planner feature and does not change production routing.

`data/conflation-cases.json` contains 18 named connections spanning separated paths, protected and painted facilities, ordinary and OSM-only connectors, trail crossings, City-only or misaligned facilities, and divided-road endpoints. The runner samples the returned route every 20 m and classifies each sample as City-matched, ambiguous (multiple labels), or unmatched. Only a single unambiguous City match counts as coverage; the latter two conditions must remain unknown in any safety response.

Run the spike against a pinned, Austin-area Valhalla instance:

```bash
node scripts/run-conflation-spike.mjs \
  --routing-url https://YOUR_VALHALLA_HOST \
  --output /tmp/austin-conflation
```

The command writes JSON and Markdown artifacts with the City dataset version, routing graph version, tolerance (25 m by default), sampling density (20 m by default), and per-connection mileage. Do not commit provider URLs or generated reports containing infrastructure details.

## Decision rule

Runtime matching remains viable only if the artifacts show high, stable coverage for every facility category and no material ambiguity around crossings or divided-road endpoints. Otherwise, import normalized City classifications while building routing tiles. In either case, retain the conservative rule: unmatched or ambiguous sections are not bicycle-safe.
