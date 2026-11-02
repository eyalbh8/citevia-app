import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Official v8.30.1 release checksums, verified before executing the scanner.
const version = '8.30.1';
const releases = {
  'darwin-arm64': ['darwin_arm64', 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'],
  'darwin-x64': ['darwin_x64', 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709'],
  'linux-arm64': ['linux_arm64', 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'],
  'linux-x64': ['linux_x64', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
};
const release = releases[`${process.platform}-${process.arch}`];
if (!release) throw new Error(`Unsupported secret-scanner platform: ${process.platform}-${process.arch}`);

const directory = await mkdtemp(join(tmpdir(), 'citevia-gitleaks-'));
try {
  const [platform, checksum] = release;
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Secret scanner download failed: HTTP ${response.status}`);
  const archive = join(directory, 'gitleaks.tar.gz');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (actual !== checksum) throw new Error('Secret scanner checksum mismatch');
  execFileSync('tar', ['-xzf', archive, '-C', directory, 'gitleaks'], { stdio: 'inherit' });
  execFileSync(join(directory, 'gitleaks'), ['git', '--log-opts=--all', '--redact', '--no-banner', '.'], { stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
