import { lineCapResult } from './line-cap-lib.mjs';

const { cap, count, location } = await lineCapResult();
console.log(`${count} lines in ${location} (cap ${cap})`);
if (count > cap) process.exitCode = 1;
