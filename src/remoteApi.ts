export const DEFAULT_REMOTE_BASE_URL = "https://scripting.donutquine.dev";
export const DEFAULT_LOGIN_PATH = "/api/login";
export const DEFAULT_COOKIE_NAME = "token";

const DEPLOYED_LOGIN_FALLBACK_PATH = "/api/auth/login";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface RemoteCredentials {
  readonly username: string;
  readonly password: string;
}

export interface StoredRemoteSession {
  readonly baseUrl: string;
  readonly cookie: string;
}

export interface RemoteStore {
  loadCredentials(): Promise<RemoteCredentials | undefined>;
  saveCredentials(credentials: RemoteCredentials): Promise<void>;
  clearCredentials(): Promise<void>;
  loadSession(): Promise<StoredRemoteSession | undefined>;
  saveSession(session: StoredRemoteSession): Promise<void>;
  clearSession(): Promise<void>;
}

export interface RemoteScriptSummary {
  readonly uuid: string;
  readonly author_uuid: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly published_at: string | null;
}

export interface LoginResult {
  readonly userUuid?: string;
}

export interface RemoteApiOptions {
  readonly store: RemoteStore;
  readonly promptForCredentials: (
    savedUsername: string | undefined
  ) => Promise<RemoteCredentials | undefined>;
  readonly baseUrl?: string;
  readonly loginPath?: string;
  readonly cookieName?: string;
  readonly fetch?: RemoteFetch;
  readonly requestTimeoutMs?: number;
}

export type RemoteFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export class RemoteApiError extends Error {
  readonly status: number | undefined;
  readonly endpoint: string | undefined;

  constructor(
    message: string,
    options?: {
      readonly status?: number;
      readonly endpoint?: string;
      readonly cause?: unknown;
    }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RemoteApiError";
    this.status = options?.status;
    this.endpoint = options?.endpoint;
  }
}

export class RemoteOperationCancelledError extends Error {
  constructor() {
    super("The remote operation was cancelled.");
    this.name = "RemoteOperationCancelledError";
  }
}

interface DecodedResponse {
  readonly text: string;
  readonly json: unknown;
}

export class RemoteApi {
  private readonly store: RemoteStore;
  private readonly promptForCredentials: RemoteApiOptions["promptForCredentials"];
  private readonly baseUrl: string;
  private readonly loginPaths: readonly string[];
  private readonly cookieName: string;
  private readonly fetchImplementation: RemoteFetch;
  private readonly requestTimeoutMs: number;

  constructor(options: RemoteApiOptions) {
    this.store = options.store;
    this.promptForCredentials = options.promptForCredentials;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_REMOTE_BASE_URL);

    const loginPath = normalizeEndpointPath(options.loginPath ?? DEFAULT_LOGIN_PATH);
    this.loginPaths =
      loginPath === DEFAULT_LOGIN_PATH
        ? [loginPath, DEPLOYED_LOGIN_FALLBACK_PATH]
        : [loginPath];

    this.cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
    if (!isCookieName(this.cookieName)) {
      throw new RemoteApiError(
        `Invalid remote cookie name: ${JSON.stringify(this.cookieName)}.`
      );
    }

    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (this.fetchImplementation === undefined) {
      throw new RemoteApiError("This VS Code runtime does not provide the Fetch API.");
    }

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RemoteApiError("The remote request timeout must be greater than zero.");
    }
  }

  async login(credentials: RemoteCredentials): Promise<LoginResult> {
    const normalizedCredentials = validateCredentials(credentials);
    let lastNotFound:
      | { readonly response: Response; readonly decoded: DecodedResponse; readonly path: string }
      | undefined;

    for (const loginPath of this.loginPaths) {
      const response = await this.fetch(loginPath, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(normalizedCredentials)
      });
      const decoded = await decodeResponse(response);

      if (response.status === 404 && this.loginPaths.length > 1) {
        lastNotFound = { response, decoded, path: loginPath };
        continue;
      }

      if (!response.ok) {
        throw responseError("Login", loginPath, response, decoded);
      }

      const cookie = extractSessionCookie(
        response.headers,
        decoded.json,
        this.cookieName
      );
      if (cookie === undefined) {
        throw new RemoteApiError(
          "Login succeeded, but the response contained neither a token nor a Set-Cookie header.",
          { endpoint: loginPath }
        );
      }

      await this.store.saveCredentials(normalizedCredentials);
      await this.store.saveSession({ baseUrl: this.baseUrl, cookie });
      return { userUuid: extractUserUuid(decoded.json) };
    }

    if (lastNotFound !== undefined) {
      throw responseError(
        "Login",
        lastNotFound.path,
        lastNotFound.response,
        lastNotFound.decoded
      );
    }

    throw new RemoteApiError("No remote login endpoint is configured.");
  }

  async logout(): Promise<void> {
    await Promise.all([
      this.store.clearCredentials(),
      this.store.clearSession()
    ]);
  }

  async getAuthenticatedUser(): Promise<LoginResult> {
    const path = "/api/users/me";
    const response = await this.authenticatedRequest(path, { method: "GET" });
    const decoded = await decodeResponse(response);
    const userUuid = extractUserUuid(decoded.json);
    if (userUuid === undefined) {
      throw new RemoteApiError(
        `The response from ${path} did not contain an authenticated user UUID.`,
        { endpoint: path }
      );
    }
    return { userUuid };
  }

  async listScripts(userUuid: string): Promise<readonly RemoteScriptSummary[]> {
    await this.getAuthenticatedUser();
    const path = `/api/users/${encodeURIComponent(userUuid)}/scripts`;
    const response = await this.authenticatedRequest(path, { method: "GET" });
    const decoded = await decodeResponse(response);
    return parseScriptList(decoded.json, path);
  }

  async getScriptContent(scriptUuid: string): Promise<string> {
    const path = `/api/scripts/${encodeURIComponent(scriptUuid)}/content`;
    const response = await this.authenticatedRequest(path, { method: "GET" });
    const decoded = await decodeResponse(response);

    if (!isRecord(decoded.json) || typeof decoded.json.content !== "string") {
      throw new RemoteApiError(
        `The response from ${path} did not contain a string content field.`,
        { endpoint: path }
      );
    }

    return decoded.json.content;
  }

  async createScriptShareToken(scriptUuid: string): Promise<string> {
    const path = `/api/scripts/${encodeURIComponent(scriptUuid)}/share`;
    const response = await this.authenticatedRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const decoded = await decodeResponse(response);

    if (
      !isRecord(decoded.json) ||
      typeof decoded.json.token !== "string" ||
      decoded.json.token.length === 0
    ) {
      throw new RemoteApiError(
        `The response from ${path} did not contain a share token.`,
        { endpoint: path }
      );
    }

    return decoded.json.token;
  }

  async createScript(name: string, content: string): Promise<void> {
    const path = "/api/scripts";
    await this.authenticatedRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content })
    });
  }

  async putScriptContent(scriptUuid: string, content: string): Promise<void> {
    const path = `/api/scripts/${encodeURIComponent(scriptUuid)}/content`;
    await this.authenticatedRequest(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  }

  private async authenticatedRequest(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    let session = await this.getOrCreateSession();
    let response = await this.fetchWithCookie(path, init, session.cookie);

    if (response.status === 401 || response.status === 403) {
      await discardResponse(response);
      await this.store.clearSession();
      session = await this.authenticateFromSavedCredentials();
      response = await this.fetchWithCookie(path, init, session.cookie);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        await this.store.clearSession();
      }
      const decoded = await decodeResponse(response);
      throw responseError("Request", path, response, decoded);
    }

    return response;
  }

  private async getOrCreateSession(): Promise<StoredRemoteSession> {
    const stored = await this.store.loadSession();
    if (stored !== undefined && stored.baseUrl === this.baseUrl) {
      return stored;
    }

    if (stored !== undefined) {
      await this.store.clearSession();
    }
    return this.authenticateFromSavedCredentials();
  }

  private async authenticateFromSavedCredentials(): Promise<StoredRemoteSession> {
    let credentials = await this.store.loadCredentials();
    if (credentials === undefined) {
      credentials = await this.promptForCredentials(undefined);
    }

    if (credentials === undefined) {
      throw new RemoteOperationCancelledError();
    }

    await this.login(credentials);
    const session = await this.store.loadSession();
    if (session === undefined || session.baseUrl !== this.baseUrl) {
      throw new RemoteApiError("Login did not create a usable remote session.");
    }
    return session;
  }

  private fetchWithCookie(
    path: string,
    init: RequestInit,
    cookie: string
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Cookie", safeCookieHeader(cookie));
    return this.fetch(path, { ...init, headers });
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const endpoint = normalizeEndpointPath(path);
    const url = joinUrl(this.baseUrl, endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await this.fetchImplementation(url, {
        ...init,
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new RemoteApiError(
        timedOut
          ? `Request to ${endpoint} timed out.`
          : `Unable to reach ${this.baseUrl}: ${errorMessage(error)}`,
        { endpoint, cause: error }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateCredentials(credentials: RemoteCredentials): RemoteCredentials {
  const username = credentials.username.trim();
  if (username.length === 0 || credentials.password.length === 0) {
    throw new RemoteApiError("Username and password are required.");
  }
  return { username, password: credentials.password };
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RemoteApiError(`Invalid remote base URL: ${JSON.stringify(value)}.`, {
      cause: error
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RemoteApiError("The remote base URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RemoteApiError("The remote base URL cannot contain credentials.");
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeEndpointPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RemoteApiError("A remote endpoint path cannot be empty.");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    throw new RemoteApiError("Remote endpoint paths must be relative to the configured base URL.");
  }
  return `/${trimmed.replace(/^\/+/, "")}`;
}

function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl}/${endpoint.replace(/^\/+/, "")}`;
}

async function decodeResponse(response: Response): Promise<DecodedResponse> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return { text, json: undefined };
  }

  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text, json: undefined };
  }
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed body cleanup must not prevent the authentication retry.
  }
}

function responseError(
  operation: string,
  endpoint: string,
  response: Response,
  decoded: DecodedResponse
): RemoteApiError {
  const detail = responseDetail(decoded) ?? response.statusText;
  const suffix = detail.length === 0 ? "" : `: ${detail}`;
  return new RemoteApiError(
    `${operation} failed with HTTP ${response.status}${suffix}`,
    { status: response.status, endpoint }
  );
}

function responseDetail(decoded: DecodedResponse): string | undefined {
  if (isRecord(decoded.json)) {
    for (const key of ["error", "message", "detail"] as const) {
      const value = decoded.json[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  const text = decoded.text.trim();
  return text.length === 0 ? undefined : text.slice(0, 500);
}

function extractSessionCookie(
  headers: Headers,
  body: unknown,
  cookieName: string
): string | undefined {
  const setCookie = readSetCookieHeaders(headers)
    .flatMap(splitSetCookieHeader)
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((value): value is string =>
      value !== undefined && /^[!#$%&'*+.^_`|~\dA-Za-z-]+=[^\r\n;]*$/.test(value)
    );

  if (setCookie.length > 0) {
    return safeCookieHeader(setCookie.join("; "));
  }

  const token = extractToken(body);
  if (token === undefined) {
    return undefined;
  }
  return `${cookieName}=${cookieTokenValue(token)}`;
}

function readSetCookieHeaders(headers: Headers): readonly string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    const values = withGetSetCookie.getSetCookie();
    if (values.length > 0) {
      return values;
    }
  }

  const combined = headers.get("set-cookie");
  return combined === null ? [] : [combined];
}

function splitSetCookieHeader(value: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ",") {
      continue;
    }
    const remainder = value.slice(index + 1);
    if (/^\s*[!#$%&'*+.^_`|~\dA-Za-z-]+=/.test(remainder)) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

function extractToken(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (!isRecord(value) || depth > 2) {
    return undefined;
  }

  for (const key of ["token", "access_token", "accessToken"] as const) {
    const token = value[key];
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
  }

  for (const key of ["data", "session", "auth"] as const) {
    const token = extractToken(value[key], depth + 1);
    if (token !== undefined) {
      return token;
    }
  }
  return undefined;
}

function extractUserUuid(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["user_uuid", "author_uuid", "uuid"] as const) {
    const uuid = value[key];
    if (typeof uuid === "string" && uuid.length > 0) {
      return uuid;
    }
  }

  for (const key of ["user", "data"] as const) {
    const uuid = extractUserUuid(value[key]);
    if (uuid !== undefined) {
      return uuid;
    }
  }
  return undefined;
}

function parseScriptList(
  value: unknown,
  endpoint: string
): readonly RemoteScriptSummary[] {
  let scripts: unknown;
  if (Array.isArray(value)) {
    scripts = value;
  } else if (isRecord(value) && Array.isArray(value.scripts)) {
    scripts = value.scripts;
  } else if (isRecord(value) && typeof value.uuid === "string") {
    scripts = [value];
  }

  if (!Array.isArray(scripts)) {
    throw new RemoteApiError(
      `The response from ${endpoint} did not contain a scripts array.`,
      { endpoint }
    );
  }

  return scripts.map((script, index) => parseScriptSummary(script, endpoint, index));
}

function parseScriptSummary(
  value: unknown,
  endpoint: string,
  index: number
): RemoteScriptSummary {
  if (!isRecord(value)) {
    throw new RemoteApiError(
      `Script ${index + 1} from ${endpoint} is not an object.`,
      { endpoint }
    );
  }

  return {
    uuid: requiredString(value, "uuid", endpoint, index),
    author_uuid: requiredString(value, "author_uuid", endpoint, index),
    name: requiredString(value, "name", endpoint, index),
    created_at: requiredString(value, "created_at", endpoint, index),
    updated_at: requiredString(value, "updated_at", endpoint, index),
    published_at:
      value.published_at === null || value.published_at === undefined
        ? null
        : requiredString(value, "published_at", endpoint, index)
  };
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  endpoint: string,
  index: number
): string {
  const item = value[key];
  if (typeof item !== "string") {
    throw new RemoteApiError(
      `Script ${index + 1} from ${endpoint} has an invalid ${key} field.`,
      { endpoint }
    );
  }
  return item;
}

function isCookieName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/.test(value);
}

function cookieTokenValue(value: string): string {
  return /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)
    ? value
    : encodeURIComponent(value);
}

function safeCookieHeader(value: string): string {
  if (value.length === 0 || /[\r\n]/.test(value)) {
    throw new RemoteApiError("The saved remote session cookie is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
