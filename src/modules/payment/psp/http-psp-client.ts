import type {
  PspAuthorizeRequest,
  PspAuthorizeResult,
  PspCaptureRequest,
  PspCaptureResult,
  PspClient,
  PspInquiryResult,
  PspOutcome,
  PspRefundRequest,
  PspRefundResult,
  PspVoidRequest,
  PspVoidResult,
} from "./psp-client";

export type HttpPspClientOptions = {
  readonly baseUrl: string;
  /** Hard deadline for one provider call. MUST be shorter than the DB lock window (which is zero). */
  readonly timeoutMs: number;
  readonly logger: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
};

/**
 * HTTP implementation of PspClient against the simulator.
 *
 * THE MOST IMPORTANT LINE IN THIS FILE is the AbortSignal timeout: when the
 * provider does not answer in time we abort and return TIMEOUT, which the
 * caller turns into the UNKNOWN state. We never translate silence into a
 * decline, because a decline is a fact we do not have.
 */
export class HttpPspClient implements PspClient {
  constructor(private readonly options: HttpPspClientOptions) {}

  async authorize(request: PspAuthorizeRequest): Promise<PspOutcome<PspAuthorizeResult>> {
    return this.call<PspAuthorizeResult>("POST", "/psp/authorize", {
      our_reference: request.ourReference,
      amount_minor: request.amount.toString(),
      currency: request.currency,
      ...(request.fault ? { fault: request.fault } : {}),
    }, (body) => ({
      pspRef: String(body["id"]),
      status: body["status"] === "DECLINED" ? "DECLINED" : "AUTHORIZED",
      ...(body["decline_code"] ? { declineCode: String(body["decline_code"]) } : {}),
    }));
  }

  async capture(request: PspCaptureRequest): Promise<PspOutcome<PspCaptureResult>> {
    return this.call<PspCaptureResult>("POST", "/psp/capture", {
      our_reference: request.ourReference,
      psp_ref: request.pspRef,
      amount_minor: request.amount.toString(),
    }, (body) => ({
      pspRef: String(body["id"]),
      capturedAmount: BigInt(String(body["captured_amount_minor"] ?? "0")),
      status: "CAPTURED" as const,
    }));
  }

  async void(request: PspVoidRequest): Promise<PspOutcome<PspVoidResult>> {
    return this.call<PspVoidResult>(
      "POST",
      "/psp/void",
      { our_reference: request.ourReference, psp_ref: request.pspRef },
      () => ({ status: "VOIDED" as const }),
    );
  }

  async refund(request: PspRefundRequest): Promise<PspOutcome<PspRefundResult>> {
    return this.call<PspRefundResult>("POST", "/psp/refund", {
      our_reference: request.ourReference,
      psp_ref: request.pspRef,
      amount_minor: request.amount.toString(),
    }, (body) => ({
      refundedAmount: BigInt(String(body["refunded_amount_minor"] ?? "0")),
      status: body["status"] === "REFUNDED" ? ("REFUNDED" as const) : ("PARTIALLY_REFUNDED" as const),
    }));
  }

  async inquire(ourReference: string): Promise<PspOutcome<PspInquiryResult>> {
    return this.call<PspInquiryResult>(
      "GET",
      `/psp/payments/${encodeURIComponent(ourReference)}`,
      undefined,
      (body) => ({
        pspRef: String(body["id"]),
        status: String(body["status"]) as PspInquiryResult["status"],
        capturedAmount: BigInt(String(body["captured_amount_minor"] ?? "0")),
        refundedAmount: BigInt(String(body["refunded_amount_minor"] ?? "0")),
        ...(body["decline_code"] ? { declineCode: String(body["decline_code"]) } : {}),
      }),
    );
  }

  /**
   * One place where HTTP becomes the closed PspOutcome union. Everything the
   * caller must distinguish (declined vs timed out vs failed) is decided here.
   */
  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    map: (json: Record<string, unknown>) => T,
  ): Promise<PspOutcome<T>> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const text = await response.text();
      const json = (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>;

      if (response.ok) {
        return { kind: "SUCCESS", data: map(json), raw: json, latencyMs };
      }
      // 402 (or a decline code) is a business decline: a real answer.
      const error = (json["error"] ?? {}) as Record<string, unknown>;
      if (response.status === 402 || error["code"] === "card_declined") {
        return {
          kind: "DECLINED",
          code: String(error["code"] ?? "card_declined"),
          message: String(error["message"] ?? "The provider declined the payment"),
          raw: json,
          latencyMs,
        };
      }
      return {
        kind: "ERROR",
        message: String(error["message"] ?? `Provider returned ${response.status}`),
        status: response.status,
        raw: json,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (isAbort) {
        // Silence. We do not know whether the provider acted.
        this.options.logger.warn({ path, latencyMs }, "psp_call_timeout");
        return { kind: "TIMEOUT", latencyMs };
      }
      this.options.logger.warn({ err, path, latencyMs }, "psp_call_error");
      return { kind: "ERROR", message: (err as Error).message, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }
}
