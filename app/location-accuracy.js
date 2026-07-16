export const MAX_USABLE_ACCURACY_METERS = 250;

export function locationFixAction(accuracy, hasUsableFix) {
  if (!Number.isFinite(accuracy) || accuracy > MAX_USABLE_ACCURACY_METERS) {
    return hasUsableFix ? "keep-last-fix" : "wait-for-accurate-fix";
  }

  return "use-fix";
}
