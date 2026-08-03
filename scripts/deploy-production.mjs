import { execFileSync } from "node:child_process";

const isWorkersBuild = process.env.WORKERS_CI === "1";
const branch = isWorkersBuild
  ? process.env.WORKERS_CI_BRANCH?.trim()
  : execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();

if (branch !== "main") {
  console.error(`Refusing production deploy from '${branch || "detached HEAD"}'. Switch to main first.`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  console.log("Production deployment is permitted.");
  process.exit(0);
}

execFileSync("npx", ["vinext", "deploy"], { stdio: "inherit" });
