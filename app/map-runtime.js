export function mapOptionsForMode(isRide) {
  return {
    zoomControl: false,
    // leaflet-rotate keeps SVG vectors in the same transformed pane as the
    // tiles. Its canvas renderer can drift away from the basemap on mobile.
    preferCanvas: !isRide,
    minZoom: 9,
    rotate: true,
    rotateControl: false,
    touchRotate: false,
    shiftKeyRotate: false,
  };
}

export function forwardMapBearing(heading) {
  return (360 - heading) % 360;
}

export function nextForwardMapBearing(currentBearing, heading, weight = 0.35) {
  const targetBearing = forwardMapBearing(heading);
  const shortestTurn = ((targetBearing - currentBearing + 540) % 360) - 180;
  return (currentBearing + shortestTurn * weight + 360) % 360;
}

export function installMapSizeSync({
  map,
  mapNode,
  windowObject = window,
  ResizeObserverClass = ResizeObserver,
}) {
  let active = true;
  const syncMapSize = () => {
    windowObject.requestAnimationFrame(() => {
      if (active) map.invalidateSize({ animate: false, pan: false });
    });
  };
  const resizeObserver = new ResizeObserverClass(syncMapSize);
  resizeObserver.observe(mapNode);
  windowObject.visualViewport?.addEventListener("resize", syncMapSize);
  windowObject.visualViewport?.addEventListener("scroll", syncMapSize);

  return {
    syncMapSize,
    disconnect() {
      active = false;
      resizeObserver.disconnect();
      windowObject.visualViewport?.removeEventListener("resize", syncMapSize);
      windowObject.visualViewport?.removeEventListener("scroll", syncMapSize);
    },
  };
}
