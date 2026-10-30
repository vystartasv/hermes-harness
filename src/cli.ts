#!/usr/bin/env bun
/**
 * CLI entry point for @vilius/hermes-harness
 * Usage: hermes-harness <command> [args]
 *
 * Commands:
 *   post-session     Mine latest Hermes session for failure patterns
 *   mine-tickets     Read ticket.md resolutions from ADO ledger
 *   scan-issues      Scan configured GitHub repositories
 *   world-train      Train world model on accumulated patterns
 *   world-predict    Predict failure probability for a context
 *   self-improve     Full improvement cycle (all of the above)
 *   init [dir]       Init .harness/config.json in a project directory
 */
import { execFileSync } from "child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HARNESS = dirname(dirname(fileURLToPath(import.meta.url)));
const HELP = `hermes-harness <command> [args]

Commands:
  post-session              Mine latest Hermes session patterns
  mine-tickets              Read configured ticket sources
  mine-git                 Build models for repos in HARNESS_REPOS
  repo-query <text>        Search locally built repo models
  seed-harvest             Clone public seed repos and build a seed model
  seed-query <text>        Search the seed model (run seed-harvest first)
  seed-export              Export the built seed model
  scan-issues               Scan repos configured by HARNESS_GITHUB_REPOS
  world-train               Train the local world model
  world-predict <text>      Evaluate a prediction from the local model
  init [dir]               Create .harness/config.json without replacing one
  self-improve             Run the full local improvement cycle
  --help                   Show this help

Set HARNESS_DATA_DIR to choose where local models are stored.`;

const COMMANDS: Record<string, [string, string[]]> = {
  "post-session":  ["post-session.ts", []],
  "mine-tickets":  ["ticket-miner.ts", []],
  "mine-git":      ["git-miner.ts", []],
  "seed-harvest":  ["seed.ts", ["harvest"]],
  "seed-query":    ["seed.ts", ["query"]],
  "seed-export":   ["seed.ts", ["export"]],
  "repo-query":    ["repo-query.ts", []],
  "scan-issues":   ["issue-scanner.ts", []],
  "world-train":   ["world-model.ts", ["train"]],
  "world-predict": ["world-model.ts", ["evaluate"]],
  "self-improve":  ["self-improve.ts", []],
};

const cmd = process.argv[2] || "--help";
const extra = process.argv.slice(3);

if (["--help", "-h", "help"].includes(cmd)) {
  console.log(HELP);
  process.exit(0);
}

if (cmd === "init") {
  const dir = extra[0] || ".";
  const { writeFileSync, mkdirSync, existsSync } = await import("fs");
  const configFile = join(dir, ".harness", "config.json");
  if (existsSync(configFile)) {
    console.error(`Refusing to overwrite ${configFile}`);
    process.exit(1);
  }
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    datasources: ["sessions", "tickets", "github-issues"],
    targets: [],
    world_model: "~/.hermes-harness/models/world-model.json",
  }, null, 2));
  console.log(`✅ .harness/config.json created in ${dir}`);
  process.exit(0);
}

if (!COMMANDS[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Available: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(1);
}

const [script, args] = COMMANDS[cmd];
try {
  const out = execFileSync(
    process.execPath,
    ["run", join(HARNESS, "src", script), ...args, ...extra],
    { encoding: "utf-8", timeout: 180000, cwd: HARNESS }
  );
  console.log(out);
} catch (e: any) {
  console.error(e.stderr || e.message);
  process.exit(1);
}
