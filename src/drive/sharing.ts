import type { GoogleClients } from '../google/clients.js';

// Sharing = Drive permissions. We already hold the `drive` scope.

export type ShareRole = 'reader' | 'commenter' | 'writer';
export type LinkAccess = ShareRole | 'none';

export interface Permission {
  id: string;
  type: string; // user | group | domain | anyone
  role: string;
  /** null for domain and anyone grants — they name no person. */
  email: string | null;
  displayName: string | null;
  /** the domain a `domain` grant covers. */
  domain?: string;
  /** domain/anyone grants only: true means the file also surfaces in their search,
   *  not merely that it opens with the link. Materially different exposures. */
  allowFileDiscovery?: boolean;
  /** who this grant covers, in one readable string — a domain or anyone grant has
   *  no email, so a caller printing `email` alone shows nothing at all. */
  subject: string;
}

const FIELDS = 'permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery)';

// "alice@x.com" · "example.com (domain)" · "anyone with the link"
function subjectOf(p: { type?: string | null; emailAddress?: string | null; domain?: string | null; displayName?: string | null }): string {
  if (p.emailAddress) return p.emailAddress;
  if (p.type === 'domain') return `${p.domain ?? 'unknown domain'} (domain)`;
  if (p.type === 'anyone') return 'anyone with the link';
  return p.displayName ?? p.type ?? 'unknown';
}

export async function listPermissions(clients: GoogleClients, fileId: string): Promise<Permission[]> {
  const res = await clients.drive.permissions.list({ fileId, fields: FIELDS });
  return (res.data.permissions ?? []).map((p) => ({
    id: p.id ?? '',
    type: p.type ?? '',
    role: p.role ?? '',
    email: p.emailAddress ?? null,
    displayName: p.displayName ?? null,
    ...(p.domain ? { domain: p.domain } : {}),
    ...(p.allowFileDiscovery != null ? { allowFileDiscovery: p.allowFileDiscovery } : {}),
    subject: subjectOf(p),
  }));
}

export async function shareDoc(
  clients: GoogleClients,
  fileId: string,
  email: string,
  role: ShareRole = 'writer',
  notify = true,
): Promise<{ id: string; email: string; role: ShareRole }> {
  const res = await clients.drive.permissions.create({
    fileId,
    sendNotificationEmail: notify,
    fields: 'id',
    requestBody: { type: 'user', role, emailAddress: email },
  });
  return { id: res.data.id ?? '', email, role };
}

export interface UnshareResult {
  status: 'ok' | 'not_found' | 'refused' | 'mismatch';
  /** what was actually removed, echoed so the caller can confirm and log it. */
  removed?: { subject: string; role: string; type: string; permissionId: string };
  message?: string;
  /** on not_found, what the doc does have — so the caller can pick without a second call. */
  present?: string[];
}

// Revoke a grant. `email` covers people and groups; anything without an email —
// a domain grant, anyone-with-link — has to be addressed by the permissionId that
// list_permissions returns, which is also what makes the caller look first.
export async function unshareDoc(
  clients: GoogleClients,
  fileId: string,
  target: {
    email?: string;
    permissionId?: string;
    /** the role list_permissions reported — proceed only if it is still that.
     *  Required: revoking leaves no trace, so the caller must have looked first. */
    expectRole: string;
    /** the doc's title, if the caller wants a wrong id refused as well. */
    expectTitle?: string;
  },
): Promise<UnshareResult> {
  if (!target.email && !target.permissionId) {
    return { status: 'refused', message: 'pass email (a person or group) or permissionId (from list_permissions, for a domain or link grant).' };
  }
  if (target.expectTitle !== undefined) {
    const meta = await clients.drive.files.get({ fileId, fields: 'name', supportsAllDrives: true });
    const actual = meta.data.name ?? '';
    if (actual !== target.expectTitle) {
      return {
        status: 'mismatch',
        message: `expectTitle "${target.expectTitle}" != live doc title "${actual}". Refusing to change sharing on a different doc than intended.`,
      };
    }
  }
  const perms = await listPermissions(clients, fileId);
  const perm = target.permissionId
    ? perms.find((p) => p.id === target.permissionId)
    : perms.find((p) => p.email === target.email);

  if (!perm) {
    const who = target.permissionId ? `permissionId ${target.permissionId}` : target.email;
    return {
      status: 'not_found',
      message: `no permission matching ${who} on this doc.`,
      present: perms.map((p) => `${p.subject} (${p.role}, id ${p.id})`),
    };
  }
  // Drive rejects deleting the owner, and doing so by accident would be alarming
  // enough to be worth its own message rather than a raw API error.
  if (perm.role === 'owner') {
    return { status: 'refused', message: `${perm.subject} is the owner; ownership cannot be revoked this way.` };
  }
  // The grant may have changed since the caller listed it. Removing a writer when
  // you meant to remove a reader is not recoverable from anywhere.
  if (perm.role !== target.expectRole) {
    return {
      status: 'mismatch',
      message: `${perm.subject} currently has role "${perm.role}", not "${target.expectRole}". It changed since you listed. Re-run list_permissions and retry.`,
    };
  }
  await clients.drive.permissions.delete({ fileId, permissionId: perm.id });
  return { status: 'ok', removed: { subject: perm.subject, role: perm.role, type: perm.type, permissionId: perm.id } };
}

// Anyone-with-the-link access. role 'none' disables link sharing.
export async function setLinkAccess(
  clients: GoogleClients,
  fileId: string,
  role: LinkAccess,
): Promise<{ linkAccess: LinkAccess; url: string }> {
  const url = `https://docs.google.com/document/d/${fileId}/edit`;
  const anyone = (await listPermissions(clients, fileId)).find((p) => p.type === 'anyone');
  if (role === 'none') {
    if (anyone) await clients.drive.permissions.delete({ fileId, permissionId: anyone.id });
    return { linkAccess: 'none', url };
  }
  if (anyone) {
    await clients.drive.permissions.update({ fileId, permissionId: anyone.id, fields: 'id', requestBody: { role } });
  } else {
    await clients.drive.permissions.create({ fileId, fields: 'id', requestBody: { type: 'anyone', role } });
  }
  return { linkAccess: role, url };
}
