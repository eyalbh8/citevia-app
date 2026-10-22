import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire as createAssetRequire } from 'node:module';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import type { BlogDraft } from '@citevia/core';

let initialized: Promise<Uint8Array[]> | undefined;
async function renderer() {
  if (!initialized)
    initialized = (async () => {
      const bundle = new URL('./agent-assets/', import.meta.url);
      const assets = existsSync(bundle)
        ? bundle
        : new URL('../assets/', import.meta.url);
      const wasm = existsSync(bundle)
        ? new URL('index_bg.wasm', bundle)
        : createAssetRequire(import.meta.url).resolve(
            '@resvg/resvg-wasm/index_bg.wasm',
          );
      await initWasm(await readFile(wasm));
      return Promise.all(
        ['NotoSans-Regular.ttf', 'NotoSansHebrew.ttf'].map((file) =>
          readFile(new URL('fonts/' + file, assets)),
        ),
      );
    })();
  return initialized;
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );
function lines(value: string, size: number) {
  const words = value.split(/\s+/);
  const result: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).length > size && current) {
      result.push(current);
      current = '';
    }
    current = (current ? current + ' ' : '') + word;
  }
  if (current) result.push(current);
  return result.slice(0, 3);
}
function text(
  value: string,
  x: number,
  y: number,
  size: number,
  width: number,
  color = '#182440',
) {
  return lines(value, width)
    .map(
      (line, index) =>
        '<text x="' +
        x +
        '" y="' +
        (y + index * (size + 7)) +
        '" font-family="Noto Sans" font-size="' +
        size +
        '" fill="' +
        color +
        '">' +
        escape(line) +
        '</text>',
    )
    .join('');
}
/** Rasterizes a controlled example-data panel; never captures private pages or arbitrary URLs. */
export async function renderExampleScreenshot(
  example: BlogDraft['examples'][number],
) {
  const fonts = await renderer();
  const width = 1200,
    height = Math.max(560, 350 + example.rows.length * 90);
  const colWidth = 1080 / example.columns.length;
  const header = example.columns
    .map((label, i) =>
      text(
        label,
        60 + i * colWidth,
        225,
        21,
        Math.floor(colWidth / 12),
        '#5c4ce4',
      ),
    )
    .join('');
  const rows = example.rows
    .map(
      (row, i) =>
        '<rect x="40" y="' +
        (265 + i * 90) +
        '" width="1120" height="90" fill="' +
        (i % 2 ? '#ffffff' : '#f4f5fb') +
        '"/>' +
        row
          .map((cell, j) =>
            text(
              cell,
              60 + j * colWidth,
              294 + i * 90,
              19,
              Math.floor(colWidth / 11),
            ),
          )
          .join(''),
    )
    .join('');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '" viewBox="0 0 1200 ' +
    height +
    '"><rect width="1200" height="' +
    height +
    '" rx="24" fill="#e9ecf5"/><rect x="20" y="20" width="1160" height="' +
    (height - 40) +
    '" rx="18" fill="white"/><rect x="20" y="20" width="1160" height="54" rx="18" fill="#182440"/><circle cx="48" cy="47" r="6" fill="#ff8e88"/><circle cx="70" cy="47" r="6" fill="#ffd77a"/><circle cx="92" cy="47" r="6" fill="#84d5b4"/>' +
    text('EXAMPLE DATA · ILLUSTRATIVE', 130, 53, 16, 90, '#ffffff') +
    text(example.title, 60, 125, 29, 68) +
    header +
    rows +
    text(
      'Illustrative example — not measured account results',
      60,
      height - 45,
      17,
      110,
      '#657087',
    ) +
    '</svg>';
  const resvg = new Resvg(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: 'Noto Sans' },
    fitTo: { mode: 'width', value: 1200 },
  });
  const rendered = resvg.render();
  try {
    return {
      id: example.id,
      dataUrl:
        'data:image/png;base64,' +
        Buffer.from(rendered.asPng()).toString('base64'),
    };
  } finally {
    rendered.free();
    resvg.free();
  }
}
