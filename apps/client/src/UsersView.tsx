import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Plus, Search, ShieldCheck, UserMinus } from 'lucide-react';
import type { Page, Project, User, UserAccount } from '@citevia/core';
import { ApiError, query, request, useApi } from './api';
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  formatDate,
  Spinner,
} from './components';

export default function UsersView({
  self,
  notify,
  onChanged,
}: {
  self: User;
  notify: (message: string) => void;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState(''),
    [debounced, setDebounced] = useState(''),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<string>(),
    [email, setEmail] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setCursors([undefined]);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const users = useApi<Page<User>>(
    `/admin/users${query({ q: debounced, limit: 25, cursor: cursors.at(-1) })}`,
    revision,
  );
  function refresh() {
    setRevision((v) => v + 1);
    onChanged();
  }
  async function importUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await request<{ user: User }>('/admin/users/import', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setSelected(result.user.id);
      setEmail('');
      refresh();
      notify('Descope user saved. Assign their accounts below.');
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Users and account access</h2>
            <p className="card-description">
              Users see their assigned accounts. System admins can access every
              account.
            </p>
          </div>
          <ShieldCheck size={20} />
        </div>
        <form className="card-content" onSubmit={(e) => void importUser(e)}>
          <label className="field">
            Import an existing Descope user by email
            <input
              type="email"
              required
              maxLength={320}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <p className="scan-options">
            A verified, active Descope identity is required. Users are also
            saved automatically when they sign in. Importing sends no invitation
            or email.
          </p>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={busy || !email.trim()}
            >
              <Plus size={13} />
              {busy ? 'Looking up…' : 'Import user'}
            </button>
          </div>
          <ErrorNotice error={error} />
        </form>
      </section>
      <section className="card" style={{ marginTop: 20 }}>
        <div className="filter-bar">
          <label className="search-box">
            <Search size={14} />
            <input
              aria-label="Search users"
              type="search"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="scan-options">{users.data?.total ?? 0} users</span>
        </div>
        <ErrorNotice error={users.error} />
        {users.loading && !users.data ? (
          <Spinner label="Loading users…" />
        ) : !users.data?.items.length ? (
          <Empty
            title="No matching users"
            description="Try another search or import an existing Descope identity."
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>System role</th>
                    <th>Status</th>
                    <th>Last seen</th>
                    <th>Access</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <strong>
                          {[user.name, user.lastName]
                            .filter(Boolean)
                            .join(' ') || user.email}
                        </strong>
                        <small className="prompt-category">{user.email}</small>
                      </td>
                      <td>
                        <Badge
                          value={user.isSystemAdmin ? 'positive' : 'neutral'}
                          label={user.isSystemAdmin ? 'System admin' : 'User'}
                        />
                      </td>
                      <td>
                        <Badge
                          value={user.disabled ? 'failed' : 'completed'}
                          label={user.disabled ? 'Disabled' : 'Enabled'}
                        />
                      </td>
                      <td>{formatDate(user.lastSeenAt, true)}</td>
                      <td>
                        <button
                          className="button button-outline"
                          onClick={() => setSelected(user.id)}
                        >
                          Manage
                          <ArrowRight size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>Page {cursors.length}</span>
              <div className="page-buttons">
                <button
                  disabled={cursors.length === 1}
                  onClick={() => setCursors((v) => v.slice(0, -1))}
                >
                  Previous
                </button>
                <button
                  disabled={!users.data.nextCursor}
                  onClick={() =>
                    setCursors((v) => [...v, users.data!.nextCursor!])
                  }
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      {selected && (
        <UserAccess
          key={selected}
          id={selected}
          self={self}
          onClose={() => setSelected(undefined)}
          onChanged={refresh}
          notify={notify}
        />
      )}
    </>
  );
}
type Detail = { user: User; accounts: UserAccount[] };
function UserAccess({
  id,
  self,
  onClose,
  onChanged,
  notify,
}: {
  id: string;
  self: User;
  onClose: () => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const loaded = useApi<Detail>(
    `/admin/users/${encodeURIComponent(id)}`,
    revision,
  );
  const [record, setRecord] = useState<Detail>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  const [search, setSearch] = useState(''),
    [debounced, setDebounced] = useState(''),
    [projectId, setProjectId] = useState(''),
    [role, setRole] = useState<'viewer' | 'owner'>('viewer');
  useEffect(() => {
    if (loaded.data) setRecord(loaded.data);
  }, [loaded.data]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const projects = useApi<Page<Project>>(
    `/projects${query({ q: debounced, limit: 25 })}`,
  );
  async function mutate(
    path: string,
    method: string,
    values: Record<string, unknown>,
    message: string,
  ) {
    if (!record) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await request<{ user: User; accounts?: UserAccount[] }>(
        path,
        {
          method,
          body: JSON.stringify({ version: record.user.version, ...values }),
        },
      );
      setRecord((previous) => ({
        user: updated.user,
        accounts: updated.accounts ?? previous!.accounts,
      }));
      setProjectId('');
      onChanged();
      notify(message);
    } catch (error) {
      setError(error as Error);
      if (error instanceof ApiError && error.status === 409)
        setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  const path = `/admin/users/${encodeURIComponent(id)}`,
    user = record?.user;
  return (
    <Drawer title="User access" onClose={busy ? () => {} : onClose}>
      <ErrorNotice error={loaded.error || error} />
      {!record || !user ? (
        <Spinner label="Loading access…" />
      ) : (
        <div className="form-stack">
          <div>
            <h2 className="card-title">
              {[user.name, user.lastName].filter(Boolean).join(' ') ||
                user.email}
            </h2>
            <p className="card-description">{user.email}</p>
            <p className="scan-options">Descope ID: {user.descopeUserId}</p>
          </div>
          <section className="access-section">
            <h3 className="drawer-section-title">System access</h3>
            <p className="scan-options">
              {user.isSystemAdmin
                ? 'System admins can view and manage all accounts.'
                : 'This user can access only the accounts assigned below.'}
            </p>
            <div className="form-actions">
              <button
                className="button button-outline"
                disabled={busy || id === self.id}
                onClick={() =>
                  void mutate(
                    path,
                    'PATCH',
                    { isSystemAdmin: !user.isSystemAdmin },
                    'System role updated.',
                  )
                }
              >
                {user.isSystemAdmin
                  ? 'Change to regular user'
                  : 'Make system admin'}
              </button>
              <button
                className="button button-outline"
                disabled={busy || id === self.id}
                onClick={() =>
                  void mutate(
                    path,
                    'PATCH',
                    { disabled: !user.disabled },
                    user.disabled
                      ? 'User access enabled.'
                      : 'User access disabled.',
                  )
                }
              >
                {user.disabled ? 'Enable access' : 'Disable access'}
              </button>
            </div>
            {id === self.id && (
              <p className="scan-options">
                Another system admin must change your own system access.
              </p>
            )}
          </section>
          <section className="access-section">
            <h3 className="drawer-section-title">Assigned accounts</h3>
            <p className="scan-options">
              Viewer: read results. Owner: manage prompts, brandbook, settings
              and scans. Only system admins create accounts or assign users.
            </p>
            {record.accounts.length ? (
              record.accounts.map((account) => (
                <div className="user-account-row" key={account.projectId}>
                  <strong>{account.projectName}</strong>
                  <select
                    aria-label={`Access to ${account.projectName}`}
                    disabled={busy}
                    value={account.role}
                    onChange={(e) =>
                      void mutate(
                        `${path}/accounts/${encodeURIComponent(account.projectId)}`,
                        'PUT',
                        { role: e.target.value },
                        'Account access updated.',
                      )
                    }
                  >
                    <option value="viewer">Viewer</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`Remove access to ${account.projectName}`}
                    title="Remove account access"
                    onClick={() =>
                      void mutate(
                        `${path}/accounts/${encodeURIComponent(account.projectId)}`,
                        'DELETE',
                        {},
                        'Account access removed.',
                      )
                    }
                  >
                    <UserMinus size={15} />
                  </button>
                </div>
              ))
            ) : (
              <p className="scan-options">
                No explicit assignments.
                {user.isSystemAdmin
                  ? ' This user can still access every account as a system admin.'
                  : ''}
              </p>
            )}
          </section>
          <section className="access-section">
            <h3 className="drawer-section-title">Assign an account</h3>
            <ErrorNotice error={projects.error} />
            <label className="field">
              Find account
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setProjectId('');
                }}
              />
            </label>
            <label className="field">
              Account
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={busy || projects.loading}
              >
                <option value="">Select an account</option>
                {projects.data?.items
                  .filter(
                    (p) => !record.accounts.some((a) => a.projectId === p.id),
                  )
                  .map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
              <small>
                {projects.data?.nextCursor
                  ? 'Search by account name or domain to find more accounts.'
                  : 'Only accounts without an explicit assignment are listed.'}
              </small>
            </label>
            <label className="field">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'viewer' | 'owner')}
                disabled={busy}
              >
                <option value="viewer">Viewer</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <button
              className="button button-primary"
              disabled={busy || !projectId}
              onClick={() =>
                void mutate(
                  `${path}/accounts/${encodeURIComponent(projectId)}`,
                  'PUT',
                  { role },
                  'Account assigned.',
                )
              }
            >
              <Plus size={13} />
              Assign account
            </button>
          </section>
        </div>
      )}
    </Drawer>
  );
}
