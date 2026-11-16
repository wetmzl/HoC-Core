import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Fixed commands only; renderer input never reaches the shell. Unknown means no Wi-Fi consent.
export async function networkStatus(platform = process.platform, run = execute) {
  try {
    const options = { timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true };
    if (platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-NetAdapter -Physical | Where-Object { $_.Status -eq "Up" } | Select-Object -ExpandProperty NdisPhysicalMedium'], options);
      return { connected: /\S/.test(stdout), wifi: /(?:^|\s)(?:9|Native802_11|WirelessLan)(?:\s|$)/i.test(stdout) };
    }
    if (platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/networksetup', ['-listallhardwareports'], options);
      const device = stdout.match(/Hardware Port: (?:Wi-Fi|AirPort)\s+Device: (\w+)/)?.[1];
      if (!device) return { connected: true, wifi: false };
      const result = await run('/usr/sbin/ipconfig', ['getifaddr', device], options);
      return { connected: Boolean(result.stdout.trim()), wifi: Boolean(result.stdout.trim()) };
    }
    const { stdout } = await run('nmcli', ['-t', '-f', 'TYPE,STATE', 'device'], options);
    return { connected: /:connected(?:\n|$)/.test(stdout), wifi: /(?:^|\n)wifi:connected(?:\n|$)/.test(stdout) };
  } catch { return { connected: true, wifi: false }; }
}
