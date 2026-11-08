import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "../../src/modules/common/logger";
import { HttpPspClient } from "../../src/modules/payment/psp/http-psp-client";
import { createPspSimulator } from "../../src/psp-simulator/psp-app";
import { PspStore } from "../../src/psp-simulator/psp-state";

export const PSP_TEST_SECRET = "test-psp-callback-secret";

/**
 * Runs the real PSP simulator on an ephemeral port and returns a real HTTP
 * client for it. Nothing is mocked: the tests exercise actual sockets, actual
 * timeouts and actual JSON, which is where the interesting bugs live.
 */
export type PspHarness = {
  readonly baseUrl: string;
  readonly store: PspStore;
  readonly client: HttpPspClient;
  readonly close: () => Promise<void>;
};

export async function startPspHarness(options: { timeoutMs?: number } = {}): Promise<PspHarness> {
  const store = new PspStore();
  const logger = createLogger("silent", false);
  const app = createPspSimulator({
    logger,
    callbackSecret: PSP_TEST_SECRET,
    callbackUrl: "http://127.0.0.1:0/v1/internal/psp/callbacks",
    store,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const client = new HttpPspClient({
    baseUrl,
    timeoutMs: options.timeoutMs ?? 300,
    logger,
  });

  return {
    baseUrl,
    store,
    client,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Direct access to the simulator HTTP surface, for fault injection in tests. */
export async function pspFetch(
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
