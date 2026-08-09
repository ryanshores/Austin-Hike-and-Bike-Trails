import { createElement } from "react";

export function RouteOffRouteAlert({ busy, message, onReroute }) {
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
        message || "Rerouting uses your last trustworthy GPS fix and keeps your safety preference.",
      ),
    ),
    createElement(
      "button",
      { type: "button", disabled: busy, onClick: onReroute },
      busy ? "Finding route…" : "Reroute",
    ),
  );
}
