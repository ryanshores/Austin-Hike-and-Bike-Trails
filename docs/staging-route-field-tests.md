# Route-planning staging and field test

This checklist verifies an isolated preview or the long-lived `staging` branch
before a route-planning release. It does not authorize a production deployment.
Use public downtown endpoints rather than a tester's home, workplace, or live
ride location in screenshots, logs, and issue notes.

## API acceptance probe

Use the commit-specific or branch-stable Workers preview URL. The probe calls
only same-origin Atlas endpoints, so it exercises the Worker-to-provider
Cloudflare Access boundary without exposing a service token to the shell or
browser:

```bash
npm run staging:route-check -- \
  --base-url https://<atlas-preview-host>
```

The default coordinates are public downtown points and the default preference
is `protected-or-separated`. To verify a particular UI selection, pass one of
the four supported preferences plus public coordinates:

```bash
npm run staging:route-check -- \
  --base-url https://<atlas-preview-host> \
  --start 30.2672,-97.7431 \
  --destination 30.2604,-97.7611 \
  --safety-preference fully-separated
```

The command verifies routing health, a normalized route geometry, miles,
ascent/descent, safety mileage, divergence details, maneuvers, dataset/graph
versions, and the absence of client-visible ETA, duration, arrival, speed, or
time fields. A failure is a staging failure; do not bypass it by calling the
Valhalla hostname directly.

## Browser and device checklist

Record the preview URL, browser/device, date, route preference, graph version,
and probe result. Do not record private locations or Cloudflare Access tokens.

1. **Mouse and keyboard:** Submit each endpoint through place search; use the
   result list with Arrow keys, Home/End, Enter, and Escape. Verify the visible
   selected result matches the endpoint marker.
2. **Map selection:** Enter `Choose on map` for start and destination
   separately. Pan and zoom first, then tap/click once to set the intended
   target. Verify ordinary panning does not change either endpoint.
3. **Marker drag:** Drag each endpoint marker to a public nearby point. Verify
   the label becomes `Dropped pin`, the marker persists, and a new route uses
   that point.
4. **Preference and route card:** Test all four safety preferences. Confirm a
   route can use ordinary bicycle-legal connectors as fallback, while the card
   and map show continuous lower-safety divergence sections, total miles,
   ascent/descent, safety mileage, and no ETA/duration/speed wording.
5. **Mobile viewport:** On a phone-sized viewport in portrait and landscape,
   plan a route, inspect the less-safe-section list, and start guidance. Ensure
   controls remain reachable without horizontal page scrolling.
6. **Guidance handoff:** Tap `Start guidance`; confirm Ride Mode receives the
   destination, route line, next maneuver, remaining miles, and the selected
   safety preference.
7. **Location quality:** With a simulated or actual coarse/stale fix, confirm
   Ride Mode waits rather than recentering or advancing guidance. With a later
   trustworthy fix, confirm it starts normally and retains the last good point
   if accuracy degrades again.
8. **Off-route and reroute:** Use accepted location samples or a safe public
   test route to create a meaningful departure. Confirm the alert appears only
   after the configured confirmation policy, does not reroute automatically,
   and keeps the old route when a replacement fails. Use `Reroute` explicitly
   and verify the selected safety preference is retained.
9. **Network boundary:** In browser developer tools, confirm planner and
   reroute requests target only `/api/geocode`, `/api/routes`, and
   `/api/routing-health`; neither the routing nor geocoding provider hostname
   may appear in browser traffic.

Only mark this checklist complete after a tester has run it against staging on
at least one touch device and one keyboard-capable browser. Automated tests and
the API probe support the result but do not substitute for that field evidence.
