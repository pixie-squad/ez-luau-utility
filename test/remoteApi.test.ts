import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteApi,
  RemoteApiError,
  type RemoteCredentials,
  type RemoteFetch,
  type RemoteStore,
  type StoredRemoteSession
} from "../src/remoteApi";

const BASE_URL = "https://example.test";
const USER_UUID = "1b0c4bad-db85-46e0-8603-43909f5d6b25";
const SCRIPT_UUID = "01a01315-96db-70f3-afd4-861baf115e52";

class MemoryRemoteStore implements RemoteStore {
  credentials: RemoteCredentials | undefined;
  session: StoredRemoteSession | undefined;

  async loadCredentials(): Promise<RemoteCredentials | undefined> {
    return this.credentials;
  }

  async saveCredentials(credentials: RemoteCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async clearCredentials(): Promise<void> {
    this.credentials = undefined;
  }

  async loadSession(): Promise<StoredRemoteSession | undefined> {
    return this.session;
  }

  async saveSession(session: StoredRemoteSession): Promise<void> {
    this.session = session;
  }

  async clearSession(): Promise<void> {
    this.session = undefined;
  }
}

test("logs in with username/password and sends a returned token as a cookie", async () => {
  const store = new MemoryRemoteStore();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: RemoteFetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === `${BASE_URL}/api/login`) {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        username: "alice",
        password: "secret"
      });
      return jsonResponse({ token: "abc/+=", user_uuid: USER_UUID });
    }

    if (url === `${BASE_URL}/api/users/me`) {
      assert.equal(header(init, "Cookie"), "token=abc/+=");
      return jsonResponse({ uuid: USER_UUID });
    }

    assert.equal(url, `${BASE_URL}/api/users/${USER_UUID}/scripts`);
    assert.equal(header(init, "Cookie"), "token=abc/+=");
    return jsonResponse({ scripts: [scriptSummary()] });
  };
  const api = makeApi(store, fetch);

  const login = await api.login({ username: "alice", password: "secret" });
  const scripts = await api.listScripts(USER_UUID);

  assert.equal(login.userUuid, USER_UUID);
  assert.deepEqual(store.credentials, { username: "alice", password: "secret" });
  assert.deepEqual(store.session, {
    baseUrl: BASE_URL,
    cookie: "token=abc/+="
  });
  assert.deepEqual(scripts, [scriptSummary()]);
  assert.equal(calls.length, 3);
});

test("falls back to the deployed login route and preserves Set-Cookie sessions", async () => {
  const store = new MemoryRemoteStore();
  const calledUrls: string[] = [];
  const fetch: RemoteFetch = async (input, init = {}) => {
    const url = String(input);
    calledUrls.push(url);

    if (url === `${BASE_URL}/api/login`) {
      return new Response(null, { status: 404 });
    }
    if (url === `${BASE_URL}/api/auth/login`) {
      return jsonResponse(
        { user: { uuid: USER_UUID } },
        {
          headers: {
            "Set-Cookie": "session=server-cookie; Path=/; HttpOnly; SameSite=Lax"
          }
        }
      );
    }

    assert.equal(url, `${BASE_URL}/api/scripts/${SCRIPT_UUID}/content`);
    assert.equal(header(init, "Cookie"), "session=server-cookie");
    return jsonResponse({ content: "return 42" });
  };
  const api = makeApi(store, fetch);

  const login = await api.login({ username: "alice", password: "secret" });
  const content = await api.getScriptContent(SCRIPT_UUID);

  assert.equal(login.userUuid, USER_UUID);
  assert.equal(content, "return 42");
  assert.deepEqual(calledUrls, [
    `${BASE_URL}/api/login`,
    `${BASE_URL}/api/auth/login`,
    `${BASE_URL}/api/scripts/${SCRIPT_UUID}/content`
  ]);
});

test("re-authenticates once with saved credentials after an expired cookie", async () => {
  const store = new MemoryRemoteStore();
  store.credentials = { username: "alice", password: "secret" };
  store.session = { baseUrl: BASE_URL, cookie: "token=expired" };
  const cookies: Array<string | undefined> = [];
  let loginCount = 0;

  const fetch: RemoteFetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `${BASE_URL}/api/login`) {
      loginCount += 1;
      return jsonResponse({ token: "fresh-token" });
    }

    assert.equal(url, `${BASE_URL}/api/scripts/${SCRIPT_UUID}/content`);
    cookies.push(header(init, "Cookie"));
    if (cookies.length === 1) {
      return new Response(null, { status: 401, statusText: "Unauthorized" });
    }
    return jsonResponse({ content: "fresh content" });
  };
  const api = makeApi(store, fetch, async () => {
    throw new Error("The saved credentials should be used without prompting.");
  });

  const content = await api.getScriptContent(SCRIPT_UUID);

  assert.equal(content, "fresh content");
  assert.equal(loginCount, 1);
  assert.deepEqual(cookies, ["token=expired", "token=fresh-token"]);
  assert.equal(store.session?.cookie, "token=fresh-token");
});

test("checks the current user before listing scripts and refreshes an expired session", async () => {
  const store = new MemoryRemoteStore();
  store.credentials = { username: "alice", password: "secret" };
  store.session = { baseUrl: BASE_URL, cookie: "token=expired" };
  const calls: Array<{ url: string; cookie: string | undefined }> = [];

  const fetch: RemoteFetch = async (input, init = {}) => {
    const url = String(input);
    const cookie = header(init, "Cookie");
    calls.push({ url, cookie });

    if (url === `${BASE_URL}/api/login`) {
      return jsonResponse({ token: "fresh-token", user_uuid: USER_UUID });
    }
    if (url === `${BASE_URL}/api/users/me` && cookie === "token=expired") {
      return new Response(null, { status: 401, statusText: "Unauthorized" });
    }
    if (url === `${BASE_URL}/api/users/me`) {
      assert.equal(cookie, "token=fresh-token");
      return jsonResponse({ user: { uuid: USER_UUID } });
    }

    assert.equal(url, `${BASE_URL}/api/users/${USER_UUID}/scripts`);
    assert.equal(cookie, "token=fresh-token");
    return jsonResponse({ scripts: [scriptSummary()] });
  };
  const api = makeApi(store, fetch, async () => {
    throw new Error("The saved credentials should be used without prompting.");
  });

  assert.deepEqual(await api.listScripts(USER_UUID), [scriptSummary()]);
  assert.deepEqual(calls, [
    { url: `${BASE_URL}/api/users/me`, cookie: "token=expired" },
    { url: `${BASE_URL}/api/login`, cookie: undefined },
    { url: `${BASE_URL}/api/users/me`, cookie: "token=fresh-token" },
    {
      url: `${BASE_URL}/api/users/${USER_UUID}/scripts`,
      cookie: "token=fresh-token"
    }
  ]);
});

test("uploads the exact content as JSON with the authenticated cookie", async () => {
  const store = new MemoryRemoteStore();
  store.session = { baseUrl: BASE_URL, cookie: "token=ready" };
  const source = "local value = 1\r\nreturn value\r\n";
  const fetch: RemoteFetch = async (input, init = {}) => {
    assert.equal(String(input), `${BASE_URL}/api/scripts/${SCRIPT_UUID}/content`);
    assert.equal(init.method, "PUT");
    assert.equal(header(init, "Cookie"), "token=ready");
    assert.equal(header(init, "Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), { content: source });
    return new Response(null, { status: 204 });
  };
  const api = makeApi(store, fetch);

  await api.putScriptContent(SCRIPT_UUID, source);
});

test("creates a script with its name and exact content", async () => {
  const store = new MemoryRemoteStore();
  store.session = { baseUrl: BASE_URL, cookie: "token=ready" };
  const source = "local value = 1\r\nreturn value\r\n";
  const fetch: RemoteFetch = async (input, init = {}) => {
    assert.equal(String(input), `${BASE_URL}/api/scripts`);
    assert.equal(init.method, "POST");
    assert.equal(header(init, "Cookie"), "token=ready");
    assert.equal(header(init, "Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), {
      name: "New script",
      content: source
    });
    return new Response(null, { status: 201 });
  };
  const api = makeApi(store, fetch);

  await api.createScript("New script", source);
});

test("mints a share token with the authenticated session", async () => {
  const store = authenticatedStore();
  const fetch: RemoteFetch = async (input, init = {}) => {
    assert.equal(
      String(input),
      `${BASE_URL}/api/scripts/${SCRIPT_UUID}/share`
    );
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    assert.equal(header(init, "Cookie"), "token=ready");
    assert.equal(header(init, "Content-Type"), "application/json");
    return jsonResponse({ token: "share/+ token" });
  };
  const api = makeApi(store, fetch);

  assert.equal(await api.createScriptShareToken(SCRIPT_UUID), "share/+ token");
});

test("rejects malformed content and script-list responses", async (t) => {
  await t.test("content", async () => {
    const store = authenticatedStore();
    const api = makeApi(store, async () => jsonResponse({ contents: "wrong key" }));
    await assert.rejects(
      api.getScriptContent(SCRIPT_UUID),
      (error: unknown) =>
        error instanceof RemoteApiError && /content field/.test(error.message)
    );
  });

  await t.test("script list", async () => {
    const store = authenticatedStore();
    const api = makeApi(store, async (input) =>
      String(input) === `${BASE_URL}/api/users/me`
        ? jsonResponse({ uuid: USER_UUID })
        : jsonResponse({ scripts: [{}] })
    );
    await assert.rejects(
      api.listScripts(USER_UUID),
      (error: unknown) =>
        error instanceof RemoteApiError && /invalid uuid field/.test(error.message)
    );
  });

  await t.test("share token", async () => {
    const store = authenticatedStore();
    const api = makeApi(store, async () => jsonResponse({ token: "" }));
    await assert.rejects(
      api.createScriptShareToken(SCRIPT_UUID),
      (error: unknown) =>
        error instanceof RemoteApiError && /share token/.test(error.message)
    );
  });
});

function makeApi(
  store: MemoryRemoteStore,
  fetch: RemoteFetch,
  promptForCredentials: () => Promise<RemoteCredentials | undefined> = async () =>
    undefined
): RemoteApi {
  return new RemoteApi({
    store,
    fetch,
    baseUrl: BASE_URL,
    promptForCredentials,
    requestTimeoutMs: 1_000
  });
}

function authenticatedStore(): MemoryRemoteStore {
  const store = new MemoryRemoteStore();
  store.session = { baseUrl: BASE_URL, cookie: "token=ready" };
  return store;
}

function header(init: RequestInit, name: string): string | undefined {
  return new Headers(init.headers).get(name) ?? undefined;
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function scriptSummary() {
  return {
    uuid: SCRIPT_UUID,
    author_uuid: USER_UUID,
    name: "deep error as buffer",
    created_at: "2026-08-18T04:16:17.115110Z",
    updated_at: "2026-08-19T09:24:11.068558Z",
    published_at: null
  };
}
