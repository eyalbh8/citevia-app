import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ create: vi.fn(), migrate: vi.fn(), close: vi.fn() }));
vi.mock('@citevia/storage', () => ({ migrationDatabase: state.create, migrateDatabase: state.migrate }));
import { handler } from '../apps/migrations/src/handler.js';
beforeEach(() => {
  state.close.mockReset().mockResolvedValue(undefined);
  state.create.mockReset().mockReturnValue({ close: state.close });
  state.migrate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });
describe('dedicated IAM migration entrypoint', () => {
  it('accepts only the explicit migration operation and closes its dedicated database', async () => {
    await expect(handler({ kind: 'database:migrate' })).resolves.toEqual({ migrated: true });
    expect(state.migrate).toHaveBeenCalledExactlyOnceWith(state.create.mock.results[0].value);
    expect(state.close).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { Records: [] }, { kind: 'database:migrate', sql: 'DROP TABLE users' }, { kind: 'reconcile' }])('rejects unexpected input before credentials load', async event => {
    await expect(handler(event)).rejects.toThrow();
    expect(state.create).not.toHaveBeenCalled();
  });
  it('honors a migration freeze', async () => {
    vi.stubEnv('CITEVIA_MAINTENANCE_MODE', 'true');
    await expect(handler({ kind: 'database:migrate' })).resolves.toEqual({ maintenance: true });
    expect(state.create).not.toHaveBeenCalled();
  });
  it('closes its connection if migration fails', async () => {
    state.migrate.mockRejectedValueOnce(new Error('checksum mismatch'));
    await expect(handler({ kind: 'database:migrate' })).rejects.toThrow('checksum mismatch');
    expect(state.close).toHaveBeenCalledOnce();
  });
});
