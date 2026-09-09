import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { executeLens, validateSpec, type EngineIO, type LensSpec } from "@djgrant/lens";

const catalog = resolve(import.meta.dirname, "..");
const load = async (): Promise<LensSpec> => {
  const shared = JSON.parse(await readFile(resolve(catalog, "catalog.json"), "utf8"));
  const spec = JSON.parse(await readFile(resolve(catalog, "invoice.cancel.json"), "utf8"));
  return validateSpec({ ...spec, params: { ...shared.params, ...spec.params } });
};

const response = (url: string, status: number, body: string) => ({
  url,
  method: url.includes("mark_as_cancelled") ? "PUT" : "GET",
  status,
  body,
  timestamp: Date.now(),
});

const io = (httpFetch: NonNullable<EngineIO["httpFetch"]>): EngineIO => ({
  getIntercepted: async () => [],
  domExtract: async () => ({ url: "", title: "", value: null }),
  httpFetch,
  snapshot: async () => ({ url: "", title: "", text: "" }),
  sleep: async () => {},
});

describe("@djgrant/freeagent/cancel-invoice", () => {
  it("has a valid schema and declares its FreeAgent write", async () => {
    const spec = await load();
    expect(spec.effects.writes).toEqual([
      "FreeAgent account (marks the selected invoice as Cancelled)",
    ]);
    expect(spec.effects.idempotent).toBe(false);
    expect(spec.effects.cache).toBe(0);
  });

  it("cancels the selected invoice and returns a clear confirmation", async () => {
    const requests: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
    const spec = await load();
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request);
      if (request.method === "GET") {
        return response(request.url, 200, '<meta name="csrf-token" content="csrf-1">');
      }
      return response(request.url, 200, JSON.stringify({
        invoice: { reference: "1100", status: "Cancelled" },
      }));
    }));

    expect(requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://example.freeagent.com/invoices/123",
      }),
      expect.objectContaining({
        method: "PUT",
        url: "https://example.freeagent.com/v2/invoices/123/transitions/mark_as_cancelled",
        headers: {
          "X-CSRF-Token": "csrf-1",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json",
        },
      }),
    ]);
    expect(result).toMatchObject({
      kind: "value",
      value: {
        cancelled: true,
        invoice_id: 123,
        reference: "1100",
        status: "Cancelled",
        confirmation: "Invoice 1100 cancelled",
      },
    });
  });

  it("does not send the write when authentication is required", async () => {
    const requests: string[] = [];
    const spec = await load();
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request.url);
      return response("https://example.freeagent.com/login", 200, "Log in");
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "needs_auth" });
    expect(requests).toHaveLength(1);
  });

  it("reports a rejected cancellation instead of returning false success", async () => {
    const spec = await load();
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      if (request.method === "GET") {
        return response(request.url, 200, '<meta name="csrf-token" content="csrf-1">');
      }
      return response(request.url, 422, JSON.stringify({ errors: ["Invoice cannot be cancelled"] }));
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "rejected" });
  });
});
