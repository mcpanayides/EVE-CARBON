#!/usr/bin/env node
'use strict';
// Runs the opt-in render stress spec with STRESS=1 set, without needing
// cross-env: `VAR=x cmd` is POSIX-only and `set VAR=x&&` is cmd.exe-only, and
// this repo builds on both.
//
//   npm run stress:data     # build the 90-character / 100k-asset database
//   npm run stress:render   # render against it and print the timings
const { spawnSync } = require('child_process');

const extra = process.argv.slice(2);
const r = spawnSync('npx',
  ['playwright', 'test', 'e2e/assets-stress.spec.js', ...extra],
  { stdio: 'inherit', shell: true, env: { ...process.env, STRESS: '1' } });
process.exit(r.status == null ? 1 : r.status);
