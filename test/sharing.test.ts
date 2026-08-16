import { describe, it, expect, vi } from 'vitest';
import type { GoogleClients } from '../src/google/clients.js';
import { listPermissions, unshareDoc } from '../src/drive/sharing.js';

// The shapes Drive actually returns. A domain or anyone grant carries no
// emailAddress at all, which is why `subject` exists: a caller printing `email`
// for those shows nothing, and "who can see this" is the question the tool is for.
const RAW = [
  { id: '1', type: 'user', role: 'owner', emailAddress: 'owner@x.com', displayName: 'Owner' },
  { id: '2', type: 'user', role: 'commenter', emailAddress: 'alice@x.com', displayName: 'Alice' },
  { id: '3', type: 'domain', role: 'reader', domain: 'x.com', allowFileDiscovery: true },
  { id: '4', type: 'anyone', role: 'reader', allowFileDiscovery: false },
  { id: '5', type: 'group', role: 'writer', emailAddress: 'team@x.com', displayName: 'Team' },
];

function clientsFor(permissions: unknown[], list = vi.fn()): GoogleClients {
  list.mockResolvedValue({ data: { permissions } });
  return {
    auth: {} as GoogleClients['auth'],
    docs: {} as GoogleClients['docs'],
    drive: { permissions: { list } } as unknown as GoogleClients['drive'],
  } as GoogleClients;
}

describe('listPermissions (#42)', () => {
  it('names every audience, including the ones with no email', async () => {
    const perms = await listPermissions(clientsFor(RAW), 'd');
    expect(perms.map((p) => p.subject)).toEqual([
      'owner@x.com',
      'alice@x.com',
      'x.com (domain)',
      'anyone with the link',
      'team@x.com',
    ]);
  });

  it('never renders an entry as null or empty', async () => {
    const perms = await listPermissions(clientsFor(RAW), 'd');
    for (const p of perms) expect(p.subject).toBeTruthy();
  });

  it('surfaces the domain a domain grant covers', async () => {
    const perms = await listPermissions(clientsFor(RAW), 'd');
    expect(perms.find((p) => p.type === 'domain')?.domain).toBe('x.com');
  });

  // Discoverable-in-search and reachable-with-a-link are different exposures.
  it('distinguishes discoverable from link-only', async () => {
    const perms = await listPermissions(clientsFor(RAW), 'd');
    expect(perms.find((p) => p.type === 'domain')?.allowFileDiscovery).toBe(true);
    expect(perms.find((p) => p.type === 'anyone')?.allowFileDiscovery).toBe(false);
  });

  it('omits allowFileDiscovery for grants that have no such concept', async () => {
    const perms = await listPermissions(clientsFor(RAW), 'd');
    expect(perms.find((p) => p.email === 'alice@x.com')).not.toHaveProperty('allowFileDiscovery');
  });

  it('asks Drive for the fields it needs, or they come back undefined', async () => {
    const list = vi.fn();
    await listPermissions(clientsFor(RAW, list), 'd');
    const fields = list.mock.calls[0][0].fields as string;
    for (const f of ['domain', 'allowFileDiscovery', 'emailAddress', 'type', 'role', 'id']) {
      expect(fields).toContain(f);
    }
  });

  it('falls back rather than throwing on a shape it does not recognise', async () => {
    const perms = await listPermissions(clientsFor([{ id: '9', role: 'reader' }]), 'd');
    expect(perms[0].subject).toBe('unknown');
  });
});

// ---- #41: revoking a grant that has no email -------------------------------
//
// unshareDoc matched on `p.email === email`. A domain or anyone grant carries no
// emailAddress, so it could never match — and every doc created under a Workspace
// domain has one. Visible in list_permissions, unremovable by any tool.

function clientsForUnshare(permissions: unknown[], del = vi.fn().mockResolvedValue({})): { clients: GoogleClients; del: typeof del } {
  const list = vi.fn().mockResolvedValue({ data: { permissions } });
  return {
    del,
    clients: {
      auth: {} as GoogleClients['auth'],
      docs: {} as GoogleClients['docs'],
      drive: { permissions: { list, delete: del } } as unknown as GoogleClients['drive'],
    } as GoogleClients,
  };
}

describe('unshareDoc (#41)', () => {
  it('revokes a domain grant by permissionId — previously impossible', async () => {
    const { clients, del } = clientsForUnshare(RAW);
    const r = await unshareDoc(clients, 'd', { permissionId: '3' });
    expect(r.status).toBe('ok');
    expect(r.removed).toEqual({ subject: 'x.com (domain)', role: 'reader', type: 'domain', permissionId: '3' });
    expect(del.mock.calls[0][0]).toMatchObject({ permissionId: '3' });
  });

  it('revokes the anyone-with-link grant too', async () => {
    const { clients } = clientsForUnshare(RAW);
    expect((await unshareDoc(clients, 'd', { permissionId: '4' })).removed?.subject).toBe('anyone with the link');
  });

  it('still revokes a person by email', async () => {
    const { clients, del } = clientsForUnshare(RAW);
    const r = await unshareDoc(clients, 'd', { email: 'alice@x.com' });
    expect(r.status).toBe('ok');
    expect(r.removed?.role).toBe('commenter');
    expect(del.mock.calls[0][0]).toMatchObject({ permissionId: '2' });
  });

  it('echoes the role it removed, so the caller can undo it if that was wrong', async () => {
    const { clients } = clientsForUnshare(RAW);
    expect((await unshareDoc(clients, 'd', { email: 'team@x.com' })).removed?.role).toBe('writer');
  });

  it('refuses the owner rather than letting Drive reject it', async () => {
    const { clients, del } = clientsForUnshare(RAW);
    const r = await unshareDoc(clients, 'd', { permissionId: '1' });
    expect(r.status).toBe('refused');
    expect(r.message).toContain('owner');
    expect(del).not.toHaveBeenCalled();
  });

  it('lists what is present when nothing matches, so the caller need not re-list', async () => {
    const { clients, del } = clientsForUnshare(RAW);
    const r = await unshareDoc(clients, 'd', { email: 'nobody@x.com' });
    expect(r.status).toBe('not_found');
    expect(r.present).toHaveLength(RAW.length);
    expect(r.present?.[2]).toContain('x.com (domain)');
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses when given no selector at all', async () => {
    const { clients, del } = clientsForUnshare(RAW);
    expect((await unshareDoc(clients, 'd', {})).status).toBe('refused');
    expect(del).not.toHaveBeenCalled();
  });
});
