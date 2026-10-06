import { beforeEach, vi } from "vitest";
import { internals, realImplementations } from "../../src/oauth.js";

/** The `fetch` that the tests see unless a test gives its own mock. */
export const blockedFetch: typeof fetch = async (input) => {
  throw new Error(`real network call in test: ${String(input instanceof Request ? input.url : input)}`);
};

/** Make every real network call throw. The setup file calls it once per worker and before each test. */
export function blockNetwork(): void {
  globalThis.fetch = blockedFetch;
}

/**
 * Replace `fetchOauthProfile` with a stub that resolves null, like the pytest fixture
 * `block_real_oauth_profile_fetch`. The setup file calls it before each test.
 */
export function installOauthProfileFake(): void {
  internals.fetchOauthProfile = async () => null;
}

/** Put back the real `oauth` seams. The setup file calls it after each test. */
export function restoreOauth(): void {
  Object.assign(internals, realImplementations);
}

/**
 * Opt the enclosing `describe` (or file) out of the profile stub, like the pytest marker
 * `no_oauth_profile_fake`. The network stays blocked, so the test must mock `internals.fetch`.
 */
export function useRealOauthProfileFetch(): void {
  beforeEach(() => {
    internals.fetchOauthProfile = realImplementations.fetchOauthProfile;
  });
}

/** A fake server for `internals.fetch`. It gets the URL as a string and the `RequestInit`. */
export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * Replace `internals.fetch` (the network seam of `oauth`) with `handler`, like a patch of `urlopen`.
 * The setup file restores the real seam after each test. A thrown error acts as a network failure.
 */
export function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(input instanceof Request ? input.url : String(input), init ?? {}),
  );
  internals.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** A 2xx (by default) response with a JSON body. */
export function jsonResponse(data: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(data), { status, statusText });
}

/** A response that `oauth` turns into an `HTTPError`. */
export function errorResponse(status: number, statusText: string, body = "", headers?: Record<string, string>): Response {
  return new Response(body, { status, statusText, headers });
}

/** One request header, as `Request.get_header()` gives it. */
export function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

/** The JSON body of a request. */
export function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}
