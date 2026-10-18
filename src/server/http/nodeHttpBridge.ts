import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Fetch rejects a body on these methods, so their request streams are not forwarded. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const toHeaders = (incoming: IncomingMessage["headers"]): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }
  return headers;
};

/** Translate a node:http request into a web Request whose signal aborts when the client leaves. */
export const toWebRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Request => {
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const method = request.method ?? "GET";
  return new Request(new URL(request.url ?? "/", origin), {
    method,
    headers: toHeaders(request.headers),
    signal: controller.signal,
    ...(BODYLESS_METHODS.has(method)
      ? {}
      : { body: Readable.toWeb(request), duplex: "half" }),
  });
};

/** Header fields for writeHead; repeated Set-Cookie values survive as one array. */
const responseHeaders = (
  headers: Headers,
): Record<string, string | string[]> => {
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of headers)
    if (name !== "set-cookie") fields[name] = value;
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) fields["set-cookie"] = cookies;
  return fields;
};

/** Stream a web Response into node:http, flushing headers and each chunk as it arrives. */
export const writeWebResponse = async (
  response: Response,
  target: ServerResponse,
): Promise<void> => {
  target.writeHead(response.status, responseHeaders(response.headers));
  target.flushHeaders();
  if (response.body === null) {
    target.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), target);
};
