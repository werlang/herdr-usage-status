#!/usr/bin/env node
// Print GitHub Copilot's live premium-request quota as JSON for the
// usage-status mod. Uses the CLI's own SDK, so no AI request is made.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Locate the SDK next to the installed `copilot` binary. */
function sdkEntry() {
  const cli = execFileSync("which", ["copilot"], { encoding: "utf8" }).trim();
  const root = dirname(realpathSync(cli));
  const packages = join(root, "node_modules", "@github");
  for (const name of readdirSync(packages)) {
    if (!name.startsWith("copilot-")) continue;
    const entry = join(packages, name, "copilot-sdk", "index.js");
    if (existsSync(entry)) return entry;
  }
  throw new Error("Copilot SDK not found");
}

/** Pick the quota the user actually spends: premium requests, then chat. */
function premiumQuota(snapshots) {
  const quota = snapshots.premium_interactions ?? snapshots.premium_requests ?? snapshots.chat;
  if (!quota) throw new Error("no Copilot quota snapshot");
  return {
    unlimited: Boolean(quota.isUnlimitedEntitlement),
    entitlement: quota.entitlementRequests ?? 0,
    used: quota.usedRequests ?? 0,
    remaining: quota.remainingPercentage ?? 100,
  };
}

async function main() {
  let client;
  try {
    const sdk = await import(pathToFileURL(sdkEntry()).href);
    client = new sdk.CopilotClient();
    await client.start();
    const result = await client.rpc.account.getQuota({});
    console.log(JSON.stringify({ ok: true, premium: premiumQuota(result?.quotaSnapshots ?? {}) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 200) }));
  } finally {
    try { await client?.stop(); } catch {}
  }
}

main();
