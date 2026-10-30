/**
 * self-improve.ts — Orchestrator: runs the full Self-Harness loop
 */
import { execFileSync } from "child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HARNESS = dirname(dirname(fileURLToPath(import.meta.url)));

const SCRIPTS: [string, string[]][] = [
  ["post-session.ts", []],
  ["git-miner.ts", []],
  ["ticket-miner.ts", []],
  ["issue-scanner.ts", []],
  ["world-model.ts", ["train"]],
  ["pr-creator.ts", []],
];

console.log("🔄 Self-Harness Improvement Loop");
console.log(new Date().toISOString());

for (const [script, args] of SCRIPTS) {
  console.log(`\n=== ${script} ${args.join(" ")} ===`);
  try {
    const out = execFileSync(process.execPath, ["run", join(HARNESS, "src", script), ...args], {
      encoding: "utf-8", 
      timeout: 120000,
      cwd: HARNESS
    });
    console.log(out);
  } catch (e: any) {
    console.error(e.stderr || e.message);
  }
}

console.log("\n✅ Self-improvement cycle complete");
