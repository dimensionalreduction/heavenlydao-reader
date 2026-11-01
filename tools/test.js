// Runs every test in test/ one after the other and lists the ones that failed: npm test
// (Each test is a plain Node script that exits non-zero on failure; any one can also be run alone: node test/<name>.test.js)
// Another folder of such tests: node extension/tools/test.js site/test (the site's, as the Test site task and the site's publishing run them)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "test");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
const failed = [];
for (const file of files) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(dir, file)], { encoding: "utf8" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (run.status === 0) {
    console.log(`ok    ${file} (${secs} s)`);
  } else {
    failed.push(file);
    console.log(`FAIL  ${file} (${secs} s)\n` + (run.stdout + run.stderr).trim().split("\n").slice(-15).map((l) => "      " + l).join("\n"));
  }
}
console.log(failed.length ? `\n${failed.length} of ${files.length} failed: ${failed.join(", ")}` : `\nall ${files.length} passed`);
process.exit(failed.length ? 1 : 0);
