import { createElement } from "react";

import { formatMiles } from "./route-planner-utils.js";

export function RouteGuidanceCard({ destinationLabel, maneuver, progress, totalMiles }) {
  const warning = progress?.safetyWarning ?? null;
  const maneuverDistance = maneuver && progress?.maneuverDistanceMiles !== null
    ? progress?.maneuverDistanceMiles ?? maneuver.distanceMiles
    : null;

  return createElement(
    "aside",
    { className: "ride-guidance-card", "aria-label": "Active route guidance", "aria-live": "polite" },
    createElement(
      "div",
      { className: "ride-guidance-main" },
      createElement("p", { className: "eyebrow" }, "Next direction"),
      createElement("h2", null, maneuver?.instruction ?? "Follow the highlighted route."),
      warning && createElement(
        "p",
        { className: "ride-safety-warning" },
        createElement(
          "strong",
          null,
          warning.active ? "Lower-safety section now" : `Lower-safety section in ${formatMiles(warning.distanceMiles)}`,
        ),
        createElement("span", null, warning.reason),
      ),
    ),
    createElement(
      "p",
      { className: "ride-guidance-distance" },
      createElement("strong", null, maneuverDistance === null ? "Route" : formatMiles(maneuverDistance)),
      createElement(
        "span",
        null,
        `${formatMiles(progress?.remainingMiles ?? totalMiles)} remaining to ${destinationLabel}`,
      ),
    ),
  );
}
