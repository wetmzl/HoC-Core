import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (!existsSync('android/app/build.gradle')) {
  const result = spawnSync('npx', ['cap', 'add', 'android'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
