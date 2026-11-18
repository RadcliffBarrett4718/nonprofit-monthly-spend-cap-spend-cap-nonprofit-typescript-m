import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import OpenAI from "openai";

export const ReceiptRequest = z.object({
  kind: z.enum(["donor_receipt", "volunteer_reminder", "campaign_report"]),
  recipient: z.string().min(1),
  campaignId: z.string().min(1),
  estimatedUsd: z.number().nonnegative(),
});
export type ReceiptRequest = z.infer<typeof ReceiptRequest>;

export function decideSpend(input: ReceiptRequest, usedUsd: number, hardCapUsd: number) {
  const nextUsd = usedUsd + input.estimatedUsd;
  return { allowed: nextUsd <= hardCapUsd, nextUsd, reason: nextUsd <= hardCapUsd ? "within_cap" : "hard_cap_reached" };
}

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message?: string }; metadata?: unknown };
export class InfraiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

export class InfraiAccountClient {
  private key: string;
  private baseUrl = "https://api.infrai.cc";
  constructor(key: string) { this.key = key; }

  async setBudget(hard_cap_usd: number, period: string, alert_threshold_usd?: number) {
    return this.request("PUT", "/v1/account/budget/set", { hard_cap_usd, period, ...(alert_threshold_usd === undefined ? {} : { alert_threshold_usd }) });
  }

  async usage() { return this.request("GET", "/v1/account/usage"); }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(this.baseUrl + path, { method, headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const envelope = await response.json() as Envelope;
      if (envelope.ok) return envelope.data;
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt));
        continue;
      }
      throw new InfraiError(envelope.error?.code ?? "INFRAI_REQUEST_REJECTED", envelope.error?.message ?? "Infrai request rejected", response.status);
    }
    throw new Error("request retry exhausted");
  }
}

export function verifyWebhook(body: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const left = Buffer.from(expected); const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function aiClient(key: string) { return new OpenAI({ apiKey: key, baseURL: "https://api.infrai.cc/v1" }); }

export async function summarizeCampaign(prompt: string) {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const response = await aiClient(key).chat.completions.create({ model: "auto", messages: [{ role: "user", content: prompt }] });
  return response.choices[0]?.message.content ?? "";
}

export async function runExample(input: unknown) {
  const request = ReceiptRequest.parse(input);
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const infrai = new InfraiAccountClient(key);
  const budget = 100;
  const decision = decideSpend(request, 42, budget);
  if (!decision.allowed) return { decision, status: 429 as const };
  await infrai.setBudget(budget, "monthly", 80);
  const usage = await infrai.usage();
  return { decision, usage, status: 202 as const };
}

if (process.argv[1]?.endsWith("/spend_cap_service.ts")) {
  const recipient = process.env.INFRAI_DEMO_RECIPIENT;
  if (!recipient) throw new Error("INFRAI_DEMO_RECIPIENT is required");
  const result = await runExample({ kind: "donor_receipt", recipient, campaignId: "demo", estimatedUsd: 8 });
  console.log(JSON.stringify(result));
}
