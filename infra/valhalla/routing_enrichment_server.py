#!/usr/bin/env python3
"""Read-only localhost API for graph-versioned routing enrichment records."""

from __future__ import annotations

import argparse
import json
import sqlite3
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


MAX_BODY_BYTES = 65_536
MAX_EDGE_IDS = 500
MAX_EDGE_ID_LENGTH = 256
VALID_DIRECTIONS = {None, "forward", "backward"}


def valid_identifier(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value and len(value) <= MAX_EDGE_ID_LENGTH else None


def json_object(value: str | None) -> dict[str, Any] | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


class EnrichmentServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], database: Path):
        super().__init__(address, EnrichmentRequestHandler)
        self.database = database.resolve()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(f"{self.database.as_uri()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        return connection


class EnrichmentRequestHandler(BaseHTTPRequestHandler):
    server: EnrichmentServer

    def log_message(self, _format: str, *_arguments: Any) -> None:
        # Cloudflare Access supplies request observability at the ingress; do not
        # duplicate caller paths or request data in this private sidecar's logs.
        return

    def send_json(self, value: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/health":
            self.send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return
        try:
            with self.server.connect() as connection:
                count = connection.execute(
                    "SELECT COUNT(*) FROM routing_enrichment_manifests",
                ).fetchone()[0]
        except sqlite3.Error:
            self.send_json({"status": "unavailable"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        if count < 1:
            self.send_json({"status": "unavailable"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        self.send_json({"status": "ready"})

    def read_request_json(self) -> dict[str, Any] | None:
        content_length = self.headers.get("Content-Length")
        try:
            length = int(content_length or "")
        except ValueError:
            self.send_json({"error": "Content-Length is required."}, HTTPStatus.LENGTH_REQUIRED)
            return None
        if length < 1:
            self.send_json({"error": "Request body is required."}, HTTPStatus.BAD_REQUEST)
            return None
        if length > MAX_BODY_BYTES:
            self.send_json({"error": "Request body is too large."}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json({"error": "Request body must be valid JSON."}, HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(value, dict):
            self.send_json({"error": "Request body must be an object."}, HTTPStatus.BAD_REQUEST)
            return None
        return value

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/v1/lookup":
            self.send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
            return
        request = self.read_request_json()
        if request is None:
            return
        graph_version = valid_identifier(request.get("routingGraphVersion"))
        edge_ids_value = request.get("edgeIds")
        if not graph_version or not isinstance(edge_ids_value, list):
            self.send_json({"error": "routingGraphVersion and edgeIds are required."}, HTTPStatus.BAD_REQUEST)
            return
        if len(edge_ids_value) > MAX_EDGE_IDS:
            self.send_json({"error": f"At most {MAX_EDGE_IDS} edge IDs are allowed."}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        edge_ids = list(dict.fromkeys(valid_identifier(value) for value in edge_ids_value))
        if None in edge_ids:
            self.send_json({"error": "Every edge ID must be a non-empty string."}, HTTPStatus.BAD_REQUEST)
            return
        if not edge_ids:
            self.send_json({"routingGraphVersion": graph_version, "records": []})
            return
        placeholders = ", ".join("?" for _ in edge_ids)
        try:
            with self.server.connect() as connection:
                rows = connection.execute(
                    f"""
                    SELECT edge_id, travel_direction, city_match_json, city_json,
                           osm_json, classification_json
                    FROM routing_edge_enrichments
                    WHERE routing_graph_version = ? AND edge_id IN ({placeholders})
                    """,
                    [graph_version, *edge_ids],
                ).fetchall()
        except sqlite3.Error:
            self.send_json({"status": "unavailable"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        records = []
        for row in rows:
            city_match = json_object(row["city_match_json"])
            osm = json_object(row["osm_json"])
            classification = json_object(row["classification_json"])
            city = None if row["city_json"] is None else json_object(row["city_json"])
            direction = row["travel_direction"]
            if not city_match or osm is None or not classification or (row["city_json"] is not None and city is None):
                continue
            if direction not in VALID_DIRECTIONS:
                continue
            records.append({
                "edgeId": row["edge_id"],
                "travelDirection": direction,
                "cityMatch": city_match,
                "city": city,
                "osm": osm,
                "classification": classification,
            })
        self.send_json({"routingGraphVersion": graph_version, "records": records})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8003)
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65_535:
        raise SystemExit("Port must be between 1 and 65535.")
    server = EnrichmentServer((arguments.host, arguments.port), arguments.database)
    server.serve_forever()


if __name__ == "__main__":
    main()
