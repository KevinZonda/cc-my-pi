import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectDir = fileURLToPath(new URL("../", import.meta.url));

test("packed extension runs git commands after Pi-style installation without peers", { timeout: 120_000 }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "cc-my-pi-install-"));
  const npm = (args, cwd = fixture) => execFileSync("npm", args, {
    cwd, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", fixture], projectDir));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "install-fixture", private: true, type: "module" }));
    npm(["install", join(fixture, packed.filename), "--legacy-peer-deps", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]);
    // npm ls fails on incompatible Effect peers even with --legacy-peer-deps.
    npm(["ls", "effect", "@effect/platform-node", "@effect/platform-node-shared"]);
    const lock = JSON.parse(readFileSync(join(fixture, "package-lock.json"), "utf8"));
    assert.equal(Object.keys(lock.packages).some((path) => path.endsWith("/ioredis")), false);
    assert.equal(Object.keys(lock.packages).some((path) => path.endsWith("/@earendil-works/pi-coding-agent")), false);
    // Node cannot strip TypeScript inside node_modules. Copy the two packed
    // runtime files beside it; bare imports still resolve the installed tree.
    mkdirSync(join(fixture, "runtime"));
    for (const file of ["runtime.ts", "process.ts"]) {
      copyFileSync(join(fixture, "node_modules/cc-my-pi/extensions/statusline/git-info/src", file), join(fixture, "runtime", file));
    }
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { createRuntime } from "./runtime/runtime.ts";
      import { runCommand } from "./runtime/process.ts";
      const runtime = createRuntime();
      try {
        const result = await runtime.runPromise(runCommand("git", ["--version"], process.cwd(), 5_000));
        assert.equal(result.code, 0);
        assert.match(result.stdout, /^git version /);
        console.log("git statusline runtime OK");
      } finally {
        await runtime.dispose();
      }
    `], { cwd: fixture, encoding: "utf8", timeout: 15_000 });
    assert.match(output, /git statusline runtime OK/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
