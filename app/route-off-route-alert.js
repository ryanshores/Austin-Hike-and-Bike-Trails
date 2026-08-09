import { createElement } from "react";

export function RouteOffRouteAlert({ busy, fixFresh, message, onReroute }) {
  return createElement(
    "aside",
    { className: "ride-off-route-alert", role: "alert", "aria-live": "assertive" },
    createElement(
      "div",
      null,
      createElement("p", { className: "eyebrow" }, "Off route"),
      createElement("strong", null, "You appear to have left the highlighted route."),
      createElement(
        "span",
        null,
        message || (fixFresh
          ? "Rerouting uses your last trustworthy GPS fix and keeps your safety preference."
          : "Waiting for a fresh good or fair GPS fix before rerouting."),
      ),
    ),
    createElement(
      "button",
      { type: "button", disabled: busy || !fixFresh, onClick: onReroute },
      busy ? "Finding route…" : fixFresh ? "Reroute" : "Waiting for GPS",
    ),
  );
}
