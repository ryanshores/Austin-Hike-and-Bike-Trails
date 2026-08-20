export const GOOD_ACCURACY_METERS = 25;
export const FAIR_ACCURACY_METERS = 75;
export const MAX_USABLE_ACCURACY_METERS = 100;
export const MAX_FIX_AGE_MS = 15_000;

export function locationQuality(accuracy, ageMs = 0) {
  if (!Number.isFinite(accuracy) || accuracy < 0 || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_FIX_AGE_MS || accuracy > MAX_USABLE_ACCURACY_METERS) {
    return "unusable";
  }
  if (accuracy <= GOOD_ACCURACY_METERS) return "good";
  if (accuracy <= FAIR_ACCURACY_METERS) return "fair";
  return "poor";
}

export function locationFixAction(accuracy, hasUsableFix, ageMs = 0) {
  if (locationQuality(accuracy, ageMs) === "unusable") {
    return hasUsableFix ? "keep-last-fix" : "wait-for-accurate-fix";
  }

  return "use-fix";
}

export function isPlausibleLocationChange(distanceMeters, elapsedMs, previousAccuracy, nextAccuracy) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return false;
  const accuracyAllowance = Math.max(0, Number(previousAccuracy) || 0) + Math.max(0, Number(nextAccuracy) || 0);
  const cyclingDistanceAllowance = (elapsedMs / 1000) * 22;
  return distanceMeters <= Math.max(80, accuracyAllowance + cyclingDistanceAllowance);
}

export function smoothingWeight(accuracy) {
  const quality = locationQuality(accuracy);
  if (quality === "good") return 0.82;
  if (quality === "fair") return 0.62;
  return 0.45;
}
