export function elevationSummary(value) {
  if (!Array.isArray(value?.range_height) || value.range_height.length < 2) {
    throw new Error("Valhalla returned no usable elevation profile.");
  }
  const heights = value.range_height.map((sample) =>
    sample?.[1] === null || sample?.[1] === undefined ? Number.NaN : Number(sample[1]));
  if (heights.some((height) => !Number.isFinite(height))) {
    throw new Error("Valhalla returned a non-finite elevation sample.");
  }
  return {
    samples: heights.length,
    minimumMeters: Math.min(...heights),
    maximumMeters: Math.max(...heights),
  };
}

function rounded(value) {
  return Number(value.toFixed(4));
}

export function reportSummary(results) {
  const successful = results.filter((result) => result.status === "ok");
  const totals = { routeMiles: 0, matchedMiles: 0, ambiguousMiles: 0, unmatchedMiles: 0 };
  const categories = {};
  const facilities = {};
  for (const result of successful) {
    const category = categories[result.category] ?? { connections: 0, routeMiles: 0, matchedMiles: 0, ambiguousMiles: 0, unmatchedMiles: 0 };
    category.connections += 1;
    for (const field of Object.keys(totals)) {
      totals[field] += result[field];
      category[field] += result[field];
    }
    categories[result.category] = category;
    for (const [facility, miles] of Object.entries(result.facilityMiles)) {
      facilities[facility] = (facilities[facility] ?? 0) + miles;
    }
  }
  const finish = (value) => ({
    ...Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, key === "connections" ? amount : rounded(amount)])),
    coverageRatio: value.routeMiles === 0 ? 0 : rounded(value.matchedMiles / value.routeMiles),
  });
  return {
    total: results.length,
    succeeded: successful.length,
    failed: results.length - successful.length,
    totals: finish(totals),
    categories: Object.fromEntries(Object.entries(categories).map(([category, value]) => [category, finish(value)])),
    facilities: Object.fromEntries(Object.entries(facilities).sort((left, right) => right[1] - left[1]).map(([facility, miles]) => [facility, rounded(miles)])),
  };
}

export function markdownReport(report) {
  const rows = report.results.map((result) => {
    if (result.status !== "ok") {
      const error = String(result.error).replaceAll("|", "\\|").replaceAll(/\s+/g, " ");
      return `| ${result.id} | ${result.category} | failed | - | - | - | - | ${error} |`;
    }
    return `| ${result.id} | ${result.category} | ok | ${(result.coverageRatio * 100).toFixed(2)}% | ${result.matchedMiles.toFixed(2)} | ${result.ambiguousMiles.toFixed(2)} | ${result.unmatchedMiles.toFixed(2)} | ${result.elevation.samples} samples |`;
  }).join("\n");
  const categoryRows = Object.entries(report.summary.categories).map(([category, value]) =>
    `| ${category} | ${value.connections} | ${(value.coverageRatio * 100).toFixed(2)}% | ${value.matchedMiles.toFixed(2)} | ${value.ambiguousMiles.toFixed(2)} | ${value.unmatchedMiles.toFixed(2)} |`).join("\n");
  const facilityRows = Object.entries(report.summary.facilities).map(([facility, miles]) => `| ${facility} | ${miles.toFixed(2)} |`).join("\n");
  return `# City/OSM conflation spike results\n\nGenerated: ${report.generatedAt}\n\n- City dataset: ${report.cityDataset}\n- Routing graph: ${report.routingGraph}\n- Valhalla version: ${report.valhallaVersion}\n- Valhalla image: ${report.valhallaImage}\n- OSM extract: ${report.osmExtract.source}\n- OSM extract date: ${report.osmExtract.date}\n- OSM extract MD5: ${report.osmExtract.md5}\n- Tolerance: ${report.toleranceMeters} m\n- Sample spacing: ${report.sampleSpacingMeters} m\n- Successful connections: ${report.summary.succeeded}/${report.summary.total}\n- Overall unambiguous City coverage: ${(report.summary.totals.coverageRatio * 100).toFixed(2)}%\n\n## Connection results\n\n| Connection | Category | Status | City coverage | Matched mi | Ambiguous mi | Unmatched mi | Elevation |\n| --- | --- | --- | ---: | ---: | ---: | ---: | --- |\n${rows}\n\n## Results by fixture category\n\n| Category | Connections | City coverage | Matched mi | Ambiguous mi | Unmatched mi |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${categoryRows}\n\n## Unambiguous matched mileage by City label\n\nAmbiguous mileage is intentionally excluded because it cannot be assigned to one City safety label.\n\n| City label | Matched mi |\n| --- | ---: |\n${facilityRows}\n\nA zero or low coverage result is evidence to investigate, not a reason to promote a route section to a safe class.\n`;
}
