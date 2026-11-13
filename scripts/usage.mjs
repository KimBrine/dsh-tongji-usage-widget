import { queryUsage } from '../lib/api.js';
const range = process.argv[2] || 'today';
try {
  const report = await queryUsage({ range });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
