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

export async function unshareDoc(
  clients: GoogleClients,
  fileId: string,
  email: string,
): Promise<{ removed: string | null; message?: string }> {
  const perm = (await listPermissions(clients, fileId)).find((p) => p.email === email);
  if (!perm) return { removed: null, message: `no direct permission for ${email}` };
  await clients.drive.permissions.delete({ fileId, permissionId: perm.id });
  return { removed: email };
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
