import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RouteGuidanceCard } from "../app/route-guidance-card.js";

test("stock-provider safety warnings render alongside maneuver guidance", () => {
  const html = renderToStaticMarkup(RouteGuidanceCard({
    destinationLabel: "Mueller Lake Park",
    maneuver: { instruction: "Turn right on Manor Road.", distanceMiles: 0.2 },
    progress: {
      remainingMiles: 2.1,
      maneuverDistanceMiles: 0.1,
      safetyWarning: {
        active: true,
        distanceMiles: 0,
        reason: "not in the Atlas trails list",
      },
    },
    totalMiles: 3,
  }));

  assert.match(html, /Turn right on Manor Road\./);
  assert.match(html, /Lower-safety section now/);
  assert.match(html, /not in the Atlas trails list/);
  assert.match(html, /2\.1 mi remaining to Mueller Lake Park/);
});
