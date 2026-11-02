import { spawn } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ProviderError } from './provider.js';
import type { SocialGeneratedCopy, SocialGeneratedImage, SocialGeneratedVideo } from './social-media.js';

export interface SocialVideoOptions {
  ffmpegPath?: string;
  fontPath?: string;
  /** Optional local soundtrack with commercial publication rights. TikTok may attach its library track at publication instead. */
  musicPath?: string;
  timeoutMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  sceneSeconds?: number;
}
function settings(options: SocialVideoOptions = {}) {
  const executable = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const font = options.fontPath || process.env.SOCIAL_FONT_PATH;
  const music = options.musicPath || process.env.SOCIAL_MUSIC_PATH;
  return {
    ffmpegPath: executable.includes('/') ? resolve(executable) : executable,
    fontPath: font ? resolve(font) : undefined,
    musicPath: music ? resolve(music) : undefined,
    timeoutMs: options.timeoutMs ?? 150_000,
    width: options.width ?? 1080, height: options.height ?? 1920, fps: options.fps ?? 24, sceneSeconds: options.sceneSeconds ?? 6,
  };
}
function failure(message = 'Video rendering could not be completed.'): ProviderError {
  return new ProviderError('social_video_unavailable', message, false);
}
/** No shell: generated captions never become command arguments or filter expressions. */
function run(binary: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = (value: Buffer) => { output = (output + value.toString()).slice(-120_000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); reject(failure()); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !expired) resolve(output);
      else reject(failure(expired ? 'Video rendering exceeded its time limit.' : undefined));
    });
  });
}

export async function socialVideoReady(options?: SocialVideoOptions): Promise<boolean> {
  const config = settings(options);
  try {
    const [filters, encoders] = await Promise.all([
      run(config.ffmpegPath, ['-hide_banner', '-filters'], undefined, 5000),
      run(config.ffmpegPath, ['-hide_banner', '-encoders'], undefined, 5000),
    ]);
    if (!['drawtext', 'zoompan', 'xfade'].every(name => new RegExp(`\\b${name}\\b`).test(filters)) || !/\blibx264\b/.test(encoders)) return false;
    if (config.fontPath) await access(config.fontPath);
    if (config.musicPath) await access(config.musicPath);
    // Also verifies that the deployment has a usable font, not just the drawtext filter.
    if (!config.fontPath) await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1',
      '-vf', 'drawtext=text=Ready:fontsize=10:fontcolor=white', '-frames:v', '1', '-f', 'null', '-'], undefined, 5000);
    return true;
  } catch { return false; }
}

/** Inspect a replacement upload locally; never trust its filename or browser-reported duration. */
export async function inspectSocialVideo(bytes: Uint8Array, options: { ffprobePath?: string; timeoutMs?: number } = {}): Promise<{ durationSeconds: number; width: number; height: number }> {
  if (bytes.byteLength < 100 || bytes.byteLength > 100 * 1024 * 1024 || Buffer.from(bytes).toString('ascii', 4, 8) !== 'ftyp')
    throw failure('Choose a valid MP4 video up to 100 MB.');
  const ffmpeg = settings().ffmpegPath;
  const binary = options.ffprobePath || (ffmpeg.includes('/') ? join(dirname(ffmpeg), 'ffprobe') : 'ffprobe');
  const directory = await mkdtemp(join(tmpdir(), 'citevia-social-inspect-'));
  try {
    const filename = join(directory, 'replacement.mp4');
    await writeFile(filename, bytes);
    const output = await run(binary, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,duration:format=duration', '-of', 'json', filename], directory, options.timeoutMs ?? 20_000);
    const parsed = JSON.parse(output) as { streams?: { codec_name?: string; width?: number; height?: number; duration?: string }[]; format?: { duration?: string } };
    const stream = parsed.streams?.[0];
    const durationSeconds = Number(parsed.format?.duration ?? stream?.duration), width = Number(stream?.width), height = Number(stream?.height);
    if (!stream || !['h264', 'hevc'].includes(stream.codec_name || '') || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 360 || height < 640 || width > 4096 || height > 4096 || width / height < 0.5 || width / height > 0.6)
      throw failure('Choose a vertical H.264 or H.265 MP4 video, between 360 × 640 and 4096 × 4096 pixels, no longer than 10 minutes.');
    return { durationSeconds, width, height };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw failure('This video could not be inspected. Replace it with a valid vertical MP4 video.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function wrapSocialCaption(value: string, columns = 28): string {
  const glyphWidth = (value: string) => /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}\uff01-\uff60]/u.test(value) ? 2 : 1;
  const width = (value: string) => [...value].reduce((sum, glyph) => sum + glyphWidth(glyph), 0);
  const words = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const chunks = [...word];
    while (width(chunks.join('')) > columns) {
      if (line) { lines.push(line); line = ''; }
      let chunk = '';
      while (chunks.length && width(chunk) + glyphWidth(chunks[0]) <= columns) chunk += chunks.shift();
      if (!chunk) chunk = chunks.shift()!;
      lines.push(chunk);
    }
    const remaining = chunks.join('');
    if (width(line) + width(remaining) + (line ? 1 : 0) > columns) { lines.push(line); line = remaining; }
    else line += (line ? ' ' : '') + remaining;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Produces an actual H.264 MP4 with motion, crossfades and literal, phone-sized captions. */
export async function renderSocialVideo(content: SocialGeneratedCopy, images: SocialGeneratedImage[], options?: SocialVideoOptions): Promise<SocialGeneratedVideo> {
  const config = settings(options);
  const { width, height, fps, sceneSeconds } = config;
  if (content.format !== 'video' || content.slides.length !== 3 || images.length !== 3)
    throw failure('A social video requires exactly three generated storyboard scenes.');
  if (![width, height, fps].every(Number.isInteger) || width < 180 || width > 1080 || height < 320 || height > 1920 || width * 16 !== height * 9 ||
    width % 2 || height % 2 || fps < 12 || fps > 30 || sceneSeconds < 1 || sceneSeconds > 10 || config.timeoutMs <= 0 || config.timeoutMs > 180_000)
    throw failure('Video rendering settings are invalid.');
  if (images.some(image => image.mime !== 'image/jpeg' || !image.bytes.length || image.bytes.length > 15 * 1024 * 1024 || image.width * 16 !== image.height * 9))
    throw failure('Video scenes must be valid vertical JPEG images.');
  const captions = content.slides.map(slide => wrapSocialCaption(slide.heading + '\n' + slide.body));
  if (captions.some(caption => caption.split('\n').length > 8)) throw failure('Video scene captions are too long for the frame.');
  const directory = await mkdtemp(join(tmpdir(), 'citevia-social-video-'));
  const transition = Math.min(0.5, sceneSeconds / 4);
  const durationSeconds = sceneSeconds * images.length - transition * (images.length - 1);
  try {
    for (let index = 0; index < images.length; index++) {
      await writeFile(join(directory, `scene-${index}.jpg`), images[index].bytes);
      await writeFile(join(directory, `caption-${index}.txt`), captions[index], 'utf8');
    }
    if (config.fontPath) await copyFile(config.fontPath, join(directory, 'font.ttf'));
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1'];
    for (let index = 0; index < images.length; index++) args.push('-loop', '1', '-framerate', String(fps), '-t', String(sceneSeconds), '-i', `scene-${index}.jpg`);
    if (config.musicPath) args.push('-stream_loop', '-1', '-i', config.musicPath);
    const fontSize = Math.round(width * 0.046), margin = Math.round(width * 0.075);
    const filters = images.map((_image, index) =>
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
      `zoompan=z='min(1.04,1+on*0.0002)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${fps},` +
      `setsar=1,settb=1/${fps},setpts=PTS-STARTPTS,format=yuv420p,` +
      `drawbox=x=${margin}:y=ih*0.56:w=iw-${margin * 2}:h=ih*0.31:color=black@0.60:t=fill,` +
      `drawtext=${config.fontPath ? 'fontfile=font.ttf:' : ''}textfile=caption-${index}.txt:expansion=none:fontcolor=white:fontsize=${fontSize}:line_spacing=${Math.round(fontSize * 0.25)}:x=(w-tw)/2:y=h*0.585[v${index}]`);
    filters.push(`[v0][v1]xfade=transition=fade:duration=${transition}:offset=${sceneSeconds - transition}[transition1]`);
    filters.push(`[transition1][v2]xfade=transition=fade:duration=${transition}:offset=${(sceneSeconds - transition) * 2}[video]`);
    if (config.musicPath) filters.push(`[3:a]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=${durationSeconds - 0.5}:d=0.5[audio]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[video]');
    if (config.musicPath) args.push('-map', '[audio]', '-c:a', 'aac', '-b:a', '128k');
    else args.push('-an');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-threads', '2', '-movflags', '+faststart', '-t', String(durationSeconds), 'post.mp4');
    await run(config.ffmpegPath, args, directory, config.timeoutMs);
    const output = join(directory, 'post.mp4');
    const info = await stat(output);
    if (info.size < 100 || info.size > 100 * 1024 * 1024) throw failure('Rendered video has an invalid size.');
    const bytes = await readFile(output);
    if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw failure('Rendering did not produce an MP4.');
    return { bytes, mime: 'video/mp4', width, height, durationSeconds, hasAudio: !!config.musicPath };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
