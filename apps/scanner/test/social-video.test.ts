import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectSocialVideo, renderSocialVideo, socialVideoReady, wrapSocialCaption } from '../src/social-video.js';
import type { SocialGeneratedCopy, SocialGeneratedImage } from '../src/social-media.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const available = await socialVideoReady();
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const inspectionAvailable = (() => {
  try { execFileSync(ffprobe, ['-version'], { stdio: 'ignore', timeout: 5000 }); execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 5000 }); return true; }
  catch { return false; }
})();
const content: SocialGeneratedCopy = {
  title: 'Better reports', body: 'Make the next decision clear.', hashtags: [], format: 'video',
  slides: ['First', 'Then', 'Finally'].map(heading => ({ heading, body: 'Use 100% clear facts.', imagePrompt: 'An educational scene.' })),
};

describe('social video rendering', () => {
  it('rejects a replacement that is not an MP4 before spawning a media process', async () => {
    await expect(inspectSocialVideo(new Uint8Array(128))).rejects.toMatchObject({ code: 'social_video_unavailable' });
  });
  it.skipIf(!inspectionAvailable)('measures actual uploaded video metadata and rejects a landscape replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'citevia-video-inspect-test-'));
    try {
      const vertical = join(directory, 'vertical.mp4'), horizontal = join(directory, 'horizontal.mp4');
      for (const [filename, size] of [[vertical, '360x640'], [horizontal, '640x360']])
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=12`, '-t', '1', '-c:v', 'libx264', filename], { timeout: 10000 });
      expect(await inspectSocialVideo(await readFile(vertical), { ffprobePath: ffprobe })).toEqual({ durationSeconds: 1, width: 360, height: 640 });
      await expect(inspectSocialVideo(await readFile(horizontal), { ffprobePath: ffprobe })).rejects.toMatchObject({ code: 'social_video_unavailable' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reports missing renderer support without pretending a video is available', async () => {
    expect(await socialVideoReady({ ffmpegPath: '/nonexistent/citevia-ffmpeg' })).toBe(false);
  });
  it('wraps Unicode captions and retains percent sequences as literal text', () => {
    expect(wrapSocialCaption('100% real facts %{metadata:secret}', 15)).toContain('%');
    expect(wrapSocialCaption('abcdefghijklmnop', 4)).toBe('abcd\nefgh\nijkl\nmnop');
    expect(wrapSocialCaption('😊😊😊😊😊', 4)).toBe('😊😊\n😊😊\n😊');
    expect(wrapSocialCaption('漢字漢字', 4)).toBe('漢字\n漢字');
  });
  it('refuses a missing scene rather than manufacturing video from incomplete assets', async () => {
    await expect(renderSocialVideo(content, [])).rejects.toMatchObject({ code: 'social_video_unavailable' });
  });
  it.skipIf(!available)('renders playable vertical H.264 with crossfades and literal captions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'citevia-video-test-'));
    try {
      const images: SocialGeneratedImage[] = [];
      for (const [index, color] of ['red', 'green', 'blue'].entries()) {
        const path = join(directory, `image-${index}.jpg`);
        execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=180x320`, '-frames:v', '1', path], { timeout: 5000 });
        images.push({ bytes: await readFile(path), width: 180, height: 320, mime: 'image/jpeg', requestId: null });
      }
      const result = await renderSocialVideo(content, images, { width: 180, height: 320, fps: 12, sceneSeconds: 1, timeoutMs: 15000 });
      expect(result).toMatchObject({ mime: 'video/mp4', width: 180, height: 320, durationSeconds: 2.5, hasAudio: false });
      expect(Buffer.from(result.bytes).toString('ascii', 4, 8)).toBe('ftyp');
      const output = join(directory, 'output.mp4');
      await writeFile(output, result.bytes);
      // Decode the actual output; this catches malformed frames/containers that metadata-only assertions miss.
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-f', 'null', '-'], { timeout: 5000 });
      const music = join(directory, 'original-tone.wav');
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', music], { timeout: 5000 });
      const withAudio = await renderSocialVideo(content, images, { width: 180, height: 320, fps: 12, sceneSeconds: 1, musicPath: music, timeoutMs: 15000 });
      expect(withAudio.hasAudio).toBe(true);
      await writeFile(output, withAudio.bytes);
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:a:0', '-f', 'null', '-'], { timeout: 5000 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 45000);
});
