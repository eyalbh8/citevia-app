import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { PostgresRepository } from '@citevia/storage';
import { assertRealLocalData } from '../scripts/local-data.js';
import { newProject } from './fixtures/scanner.js';

it('starts with no accounts and refuses the legacy sample store without removing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'citevia-real-data-'));
  const db = await localPostgres(join(directory, 'new-workspace', 'postgres'));
  try {
    const repository = new PostgresRepository(db);
    await expect(assertRealLocalData(db)).resolves.toBeUndefined();
    expect((await db.query('SELECT id FROM accounts')).rows).toHaveLength(0);
    const legacy = newProject();
    await repository.saveProject(legacy, null);
    await expect(assertRealLocalData(db)).rejects.toThrow('legacy sample data');
    expect(await repository.getProject(legacy.id)).toEqual(legacy);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
