import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(path));
    else if (entry.name.endsWith('test.js')) out.push(path);
  }
  return out;
}

const tests = collect('src').sort();
for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const result = spawnSync(process.execPath, [test], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`\nALL ${tests.length} TEST FILES PASSED`);
