export type AtlasUser = {
  id: string;
  accountType: "anonymous" | "registered";
  email: string | null;
  displayName: string | null;
};

export type RideSummary = {
  id: string;
  status: "recording" | "completed" | "abandoned";
  title: string | null;
  startedAt: number;
  endedAt: number | null;
  distanceMeters: number;
  acceptedPointCount: number;
};

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest(input: string, init: RequestInit = {}) {
  const options = { ...init, credentials: "same-origin" as const };
  let response = await fetch(input, options);
  if (response.status !== 401 || input === "/api/auth/refresh") return response;
  const refresh = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
  });
  if (!refresh.ok) return response;
  response = await fetch(input, options);
  return response;
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "Request failed");
  return body as T;
}

export async function ensureUser() {
  let response = await apiRequest("/api/auth/me");
  if (response.status === 401) {
    response = await fetch("/api/auth/anonymous", {
      method: "POST",
      credentials: "same-origin",
    });
  }
  return readJson<{ user: AtlasUser }>(response);
}
