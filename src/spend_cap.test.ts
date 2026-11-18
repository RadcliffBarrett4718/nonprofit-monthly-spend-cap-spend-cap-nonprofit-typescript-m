import assert from "node:assert/strict";
import { decideSpend, ReceiptRequest, verifyWebhook } from "./spend_cap_service.ts";

const request = ReceiptRequest.parse({ kind: "donor_receipt", recipient: "donor@example.org", campaignId: "spring", estimatedUsd: 8 });
assert.deepEqual(decideSpend(request, 95, 100), { allowed: false, nextUsd: 103, reason: "hard_cap_reached" });
assert.equal(verifyWebhook('{"event":"account.updated"}', "0a", "secret"), false);
console.log("spend decision test passed");
