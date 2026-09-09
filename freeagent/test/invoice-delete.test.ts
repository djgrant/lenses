import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { executeLens, validateSpec, type EngineIO, type LensSpec } from "@djgrant/lens";

const catalog = resolve(import.meta.dirname, "..");
const load = async (file: string): Promise<LensSpec> => {
  const shared = JSON.parse(await readFile(resolve(catalog, "catalog.json"), "utf8"));
  const spec = JSON.parse(await readFile(resolve(catalog, file), "utf8"));
  return validateSpec({ ...spec, params: { ...shared.params, ...spec.params } });
};

const response = (url: string, method: string, status: number, body = "") => ({
  url,
  method,
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

const page = '<meta name="csrf-token" content="csrf-1">';

describe("@djgrant/freeagent/delete-invoice", () => {
  it("declares permanent deletion and never uses FreeAgent's bad-debt transition", async () => {
    const spec = await load("invoice.delete.json");
    expect(JSON.stringify(spec)).not.toContain("mark_as_cancelled");
    expect(spec.effects.writes).toEqual([
      "FreeAgent account (marks the selected unpaid invoice as Draft and permanently deletes it, reversing its accounting entries)",
    ]);
    expect(spec.effects.idempotent).toBe(false);
    expect(spec.effects.cache).toBe(0);
  });

  it("makes an unpaid invoice draft and then permanently deletes it", async () => {
    const requests: Array<{ url: string; method: string; headers?: Record<string, string> }> = [];
    const spec = await load("invoice.delete.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request);
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      if (request.url.endsWith("/transitions/mark_as_draft")) {
        return response(request.url, request.method, 200, JSON.stringify({
          invoice: { reference: "1100", status: "Draft" },
        }));
      }
      return response(request.url, request.method, 200);
    }));

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "https://example.freeagent.com/invoices/123" },
      { method: "PUT", url: "https://example.freeagent.com/v2/invoices/123/transitions/mark_as_draft" },
      { method: "DELETE", url: "https://example.freeagent.com/v2/invoices/123" },
    ]);
    expect(requests.slice(1).map((request) => request.headers)).toEqual([
      {
        "X-CSRF-Token": "csrf-1",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
      {
        "X-CSRF-Token": "csrf-1",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
    ]);
    expect(result).toMatchObject({
      kind: "value",
      value: {
        deleted: true,
        invoice_id: 123,
        reference: "1100",
        confirmation: "Invoice 1100 permanently deleted",
      },
    });
  });

  it("does not send a write when authentication is required", async () => {
    const requests: string[] = [];
    const spec = await load("invoice.delete.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request.url);
      return response("https://example.freeagent.com/login", request.method, 200, "Log in");
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "needs_auth" });
    expect(requests).toHaveLength(1);
  });

  it("does not delete when FreeAgent rejects the draft transition", async () => {
    const requests: string[] = [];
    const spec = await load("invoice.delete.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request.url);
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      return response(request.url, request.method, 422, JSON.stringify({ errors: ["Invoice cannot be made draft"] }));
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "rejected" });
    expect(requests).toHaveLength(2);
  });

  it("does not delete after a false-success draft response", async () => {
    const requests: string[] = [];
    const spec = await load("invoice.delete.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request.url);
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      return response(request.url, request.method, 200, JSON.stringify({
        invoice: { reference: "1100", status: "Written-off" },
      }));
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "rejected" });
    expect(requests).toHaveLength(2);
  });

  it("reports a rejected delete instead of claiming success", async () => {
    const spec = await load("invoice.delete.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      if (request.url.endsWith("/transitions/mark_as_draft")) {
        return response(request.url, request.method, 200, JSON.stringify({
          invoice: { reference: "1100", status: "Draft" },
        }));
      }
      return response(request.url, request.method, 422, JSON.stringify({ errors: ["Invoice cannot be deleted"] }));
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "rejected" });
  });
});

describe("@djgrant/freeagent/reopen-written-off-invoice", () => {
  it("uses FreeAgent's documented reopen transition", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const spec = await load("invoice.reopen.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      requests.push(request);
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      return response(request.url, request.method, 200, JSON.stringify({
        invoice: { reference: "1100", status: "Open" },
      }));
    }));

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "https://example.freeagent.com/invoices/123" },
      { method: "PUT", url: "https://example.freeagent.com/v2/invoices/123/transitions/mark_as_sent" },
    ]);
    expect(result).toMatchObject({
      kind: "value",
      value: {
        reopened: true,
        invoice_id: 123,
        reference: "1100",
        status: "Open",
        confirmation: "Invoice 1100 reopened",
      },
    });
  });

  it("reports a rejected reopen instead of claiming success", async () => {
    const spec = await load("invoice.reopen.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      return response(request.url, request.method, 422, JSON.stringify({ errors: ["Invoice is not written off"] }));
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "rejected" });
  });

  it("rejects a false-success response that leaves the invoice written off", async () => {
    const spec = await load("invoice.reopen.json");
    const result = await executeLens(spec, { account: "example", invoice_id: 123 }, io(async (request) => {
      if (request.method === "GET") return response(request.url, request.method, 200, page);
      return response(request.url, request.method, 200, JSON.stringify({
        invoice: { reference: "1100", status: "Written-off" },
      }));
    }));

    expect(result).toMatchObject({ kind: "outcome", name: "rejected" });
  });
});
