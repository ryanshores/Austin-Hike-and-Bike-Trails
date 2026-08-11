#!/usr/bin/env python3
"""Build an atomically replaced, graph-versioned SQLite routing sidecar."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
EXPECTED_TOLERANCE_METERS = 25
EXPECTED_SAMPLE_SPACING_METERS = 20
EXPECTED_MINIMUM_COVERAGE = 0.8
MAX_EDGE_ID_LENGTH = 256
VALID_CITY_MATCH_STATUSES = {"matched", "partial", "ambiguous", "unmatched"}
VALID_FINDINGS = {
    "atlas",
    "osm-fallback",
    "not-in-trails-list",
    "unknown",
    "known-less-safe",
    "bicycle-prohibited",
}
VALID_SOURCES = {"city", "osm", "city-osm", "atlas-trail"}
VALID_DIRECTIONS = {None, "forward", "backward"}
REQUIRED_MANIFEST_FIELDS = (
    "cityDatasetVersion",
    "cityDatasetSha256",
    "routingEdgesSha256",
    "osmExtractSource",
    "osmExtractDate",
    "osmExtractChecksum",
    "routingGraphVersion",
    "valhallaImage",
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def require_string(value: Any, label: str, maximum_length: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum_length:
        raise ValueError(f"{label} must be a non-empty string no longer than {maximum_length} characters.")
    return value.strip()


def require_object(value: Any, label: str, nullable: bool = False) -> dict[str, Any] | None:
    if value is None and nullable:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object.")
    return value


def require_finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number.")
    return float(value)


def validated_manifest(value: Any) -> dict[str, str]:
    manifest = require_object(value, "Artifact manifest")
    result = {
        field: require_string(manifest.get(field), f"Artifact manifest {field}")
        for field in REQUIRED_MANIFEST_FIELDS
    }
    if len(result["routingGraphVersion"]) > MAX_EDGE_ID_LENGTH:
        raise ValueError("Artifact manifest routingGraphVersion is too long.")
    return result


def validated_city_match(value: Any, label: str) -> dict[str, Any]:
    city_match = require_object(value, label)
    status = city_match.get("status")
    if status not in VALID_CITY_MATCH_STATUSES:
        raise ValueError(f"{label} has an unsupported status.")
    coverage_ratio = require_finite_number(city_match.get("coverageRatio"), f"{label} coverageRatio")
    if coverage_ratio < 0 or coverage_ratio > 1:
        raise ValueError(f"{label} coverageRatio must be between zero and one.")
    for field in ("matchedMiles", "ambiguousMiles", "unmatchedMiles"):
        if require_finite_number(city_match.get(field), f"{label} {field}") < 0:
            raise ValueError(f"{label} {field} must not be negative.")
    return city_match


def validated_classification(value: Any, label: str) -> dict[str, Any]:
    classification = require_object(value, label)
    finding = classification.get("finding")
    source = classification.get("source")
    safety_class = classification.get("safetyClass")
    if finding not in VALID_FINDINGS or source not in VALID_SOURCES:
        raise ValueError(f"{label} has an unsupported finding or source.")
    if safety_class is None:
        if finding != "bicycle-prohibited":
            raise ValueError(f"{label} may omit safetyClass only for a bicycle prohibition.")
    elif isinstance(safety_class, bool) or not isinstance(safety_class, int) or safety_class not in range(4):
        raise ValueError(f"{label} safetyClass must be an integer from zero through three.")
    require_string(classification.get("reason"), f"{label} reason")
    return classification


def validated_edge(value: Any, index: int) -> dict[str, Any]:
    edge = require_object(value, f"Artifact edge {index}")
    edge_id = require_string(edge.get("edgeId"), f"Artifact edge {index} edgeId", MAX_EDGE_ID_LENGTH)
    direction = edge.get("travelDirection")
    if direction not in VALID_DIRECTIONS:
        raise ValueError(f"Artifact edge {edge_id} has an unsupported travelDirection.")
    return {
        "edgeId": edge_id,
        "travelDirection": direction,
        "cityMatch": validated_city_match(edge.get("cityMatch"), f"Artifact edge {edge_id} cityMatch"),
        "city": require_object(edge.get("city"), f"Artifact edge {edge_id} city", nullable=True),
        "osm": require_object(edge.get("osm"), f"Artifact edge {edge_id} osm"),
        "classification": validated_classification(
            edge.get("classification"), f"Artifact edge {edge_id} classification",
        ),
    }


def validated_artifact(buffer: bytes) -> tuple[dict[str, str], list[dict[str, Any]]]:
    try:
        artifact = json.loads(buffer)
    except json.JSONDecodeError as error:
        raise ValueError(f"Artifact is not valid JSON: {error.msg}.") from error
    if not isinstance(artifact, dict) or artifact.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"Artifact schemaVersion must equal {SCHEMA_VERSION}.")
    manifest = validated_manifest(artifact.get("manifest"))
    if artifact["manifest"].get("toleranceMeters") != EXPECTED_TOLERANCE_METERS:
        raise ValueError(f"Artifact toleranceMeters must equal {EXPECTED_TOLERANCE_METERS}.")
    if artifact["manifest"].get("sampleSpacingMeters") != EXPECTED_SAMPLE_SPACING_METERS:
        raise ValueError(f"Artifact sampleSpacingMeters must equal {EXPECTED_SAMPLE_SPACING_METERS}.")
    if artifact["manifest"].get("minimumCoverage") != EXPECTED_MINIMUM_COVERAGE:
        raise ValueError(f"Artifact minimumCoverage must equal {EXPECTED_MINIMUM_COVERAGE}.")
    edges_value = artifact.get("edges")
    if not isinstance(edges_value, list):
        raise ValueError("Artifact edges must be an array.")
    edges = [validated_edge(value, index) for index, value in enumerate(edges_value)]
    edge_ids = [edge["edgeId"] for edge in edges]
    if len(edge_ids) != len(set(edge_ids)):
        raise ValueError("Artifact contains duplicate edge IDs.")
    summary = require_object(artifact.get("summary"), "Artifact summary")
    if summary.get("edges") != len(edges):
        raise ValueError("Artifact summary edge count does not match its edge records.")
    return manifest, edges


def create_database(path: Path, manifest: dict[str, str], edges: list[dict[str, Any]], artifact_sha256: str) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("PRAGMA synchronous = FULL")
        connection.executescript(
            """
            CREATE TABLE routing_enrichment_manifests (
              routing_graph_version TEXT PRIMARY KEY NOT NULL,
              artifact_sha256 TEXT NOT NULL,
              manifest_json TEXT NOT NULL
            );
            CREATE TABLE routing_edge_enrichments (
              routing_graph_version TEXT NOT NULL,
              edge_id TEXT NOT NULL,
              travel_direction TEXT,
              city_match_json TEXT NOT NULL,
              city_json TEXT,
              osm_json TEXT NOT NULL,
              classification_json TEXT NOT NULL,
              PRIMARY KEY (routing_graph_version, edge_id),
              FOREIGN KEY (routing_graph_version)
                REFERENCES routing_enrichment_manifests(routing_graph_version)
                ON DELETE CASCADE,
              CHECK (travel_direction IS NULL OR travel_direction IN ('forward', 'backward'))
            ) WITHOUT ROWID;
            """
        )
        graph_version = manifest["routingGraphVersion"]
        connection.execute(
            "INSERT INTO routing_enrichment_manifests VALUES (?, ?, ?)",
            (graph_version, artifact_sha256, canonical_json(manifest)),
        )
        connection.executemany(
            """
            INSERT INTO routing_edge_enrichments (
              routing_graph_version, edge_id, travel_direction, city_match_json,
              city_json, osm_json, classification_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    graph_version,
                    edge["edgeId"],
                    edge["travelDirection"],
                    canonical_json(edge["cityMatch"]),
                    None if edge["city"] is None else canonical_json(edge["city"]),
                    canonical_json(edge["osm"]),
                    canonical_json(edge["classification"]),
                )
                for edge in sorted(edges, key=lambda edge: edge["edgeId"])
            ],
        )
        connection.commit()
        connection.execute("VACUUM")
    finally:
        connection.close()


def build(artifact_path: Path, output_path: Path) -> dict[str, Any]:
    artifact_buffer = artifact_path.read_bytes()
    manifest, edges = validated_artifact(artifact_buffer)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent,
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        create_database(
            temporary_path,
            manifest,
            edges,
            hashlib.sha256(artifact_buffer).hexdigest(),
        )
        os.chmod(temporary_path, 0o640)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return {
        "routingGraphVersion": manifest["routingGraphVersion"],
        "edges": len(edges),
        "artifactSha256": hashlib.sha256(artifact_buffer).hexdigest(),
        "output": str(output_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    print(canonical_json(build(arguments.artifact, arguments.output)))


if __name__ == "__main__":
    main()
