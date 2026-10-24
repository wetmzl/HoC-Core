import { spawnSync } from 'node:child_process';
import { imageOptions } from './image-build.mjs';

const options = imageOptions(process.argv.slice(2));
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', ...options.forwarded], {
  stdio: 'inherit', env: { ...process.env, HOC_IMAGE_MODE: options.mode, HOC_IMAGE_QUALITY: String(options.quality) }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
