import { execFileSync } from "node:child_process";

const branch = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();

if (branch !== "main") {
  console.error(`Refusing production deploy from '${branch || "detached HEAD"}'. Switch to main first.`);
  process.exit(1);
}

execFileSync("npx", ["vinext", "deploy"], { stdio: "inherit" });
