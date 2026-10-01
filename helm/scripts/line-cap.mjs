import { lineCapResult } from './line-cap-lib.mjs';

const baseIndex = process.argv.indexOf('--base');
const base = baseIndex !== -1 && process.argv[baseIndex + 1] ? process.argv[baseIndex + 1] : undefined;

const { cap, count, location } = await lineCapResult({ base });
console.log(`${count} lines in ${location} (cap ${cap})`);
if (count > cap) process.exitCode = 1;
