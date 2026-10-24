import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const AUDIO_ENCODING = Object.freeze({ codec: 'opus', bgmKbps: 80, effectKbps: 64, bgmVbr: 'constrained', effectVbr: 'on' });
export const isAudioPath = path => /\.(?:mp3|ogg|opus|wav|flac|m4a|aac)$/i.test(path);

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.on('data', bytes => errors.push(bytes));
    child.on('error', error => reject(new Error(`Audio build requires ffmpeg (with libopus) and ffprobe on PATH: ${error.message}`)));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(`${command} failed (${code}): ${Buffer.concat(errors).toString().trim()}`)));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

let encoder;
async function encoderVersion() {
  // Include the installed toolchain in the cache identity rather than reusing
  // bytes produced by a different FFmpeg build after an upgrade.
  return encoder ??= run('ffmpeg', ['-version']).then(bytes => bytes.toString());
}

export async function buildAudio(bytes, source, { cacheDir } = {}) {
  const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'json', '-i', 'pipe:0'], bytes)).toString());
  if (probe.streams?.length !== 1) throw new Error(`Expected one audio stream: ${source}`);
  const sourceCodec = probe.streams[0].codec_name;
  const retainedOpus = sourceCodec === 'opus';
  const bgm = /(?:^|\/)bgm\//i.test(source);
  const kbps = bgm ? AUDIO_ENCODING.bgmKbps : AUDIO_ENCODING.effectKbps;
  const vbr = bgm ? AUDIO_ENCODING.bgmVbr : AUDIO_ENCODING.effectVbr;
  const output = retainedOpus ? source : source.replace(/\.[^/.]+$/, '') + '.opus';
  let result = bytes, version;
  if (!retainedOpus) {
    version = await encoderVersion();
    const settings = { ...AUDIO_ENCODING, kbps, vbr, application: 'audio', compressionLevel: 10, bitexact: true };
    const key = sha(JSON.stringify({ version, settings, source: sha(bytes) }));
    const cached = cacheDir && join(cacheDir, `${key}.opus`);
    try { result = cached ? await readFile(cached) : undefined; }
    catch (error) { if (error.code !== 'ENOENT') throw error; result = undefined; }
    if (!result) {
      result = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', vbr, '-compression_level', '10', '-application', 'audio', '-flags:a', '+bitexact', '-fflags', '+bitexact', '-f', 'opus', 'pipe:1'], bytes);
      if (cached) {
        await mkdir(dirname(cached), { recursive: true });
        const temporary = `${cached}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, result); await rename(temporary, cached); }
        finally { await rm(temporary, { force: true }); }
      }
    }
  }
  return { bytes: result, record: { source, output, sourceCodec, retainedOpus, kbps: retainedOpus ? null : kbps, vbr: retainedOpus ? null : vbr, encoder: version?.split('\n')[0] ?? null, sourceBytes: bytes.length, bytes: result.length, sourceSha256: sha(bytes), sha256: sha(result) } };
}
