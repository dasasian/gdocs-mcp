import type { GoogleClients } from '../google/clients.js';

// Sharing = Drive permissions. We already hold the `drive` scope.

export type ShareRole = 'reader' | 'commenter' | 'writer';
export type LinkAccess = ShareRole | 'none';

export interface Permission {
  id: string;
  type: string; // user | group | domain | anyone
  role: string;
  email: string | null;
  displayName: string | null;
}

const FIELDS = 'permissions(id,type,role,emailAddress,displayName)';

export async function listPermissions(clients: GoogleClients, fileId: string): Promise<Permission[]> {
  const res = await clients.drive.permissions.list({ fileId, fields: FIELDS });
  return (res.data.permissions ?? []).map((p) => ({
    id: p.id ?? '',
    type: p.type ?? '',
    role: p.role ?? '',
    email: p.emailAddress ?? null,
    displayName: p.displayName ?? null,
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
