import { findProjectConfig, findProjectAccount } from '../auth/accounts.js';
import { clientsForAccount } from '../google/clients.js';
import { folderPathOf, parseDriveId } from './paths.js';

const LOOKUP_TIMEOUT_MS = 4000;

/**
 * The project's default folder as the model should read it: its path, or its id
 * when no path reaches it or Drive could not be asked in time. Undefined when the
 * project sets none. Never throws, since it runs before the server can answer.
 */
export async function describeDefaultFolder(): Promise<string | undefined> {
  const folder = findProjectConfig().folder;
  if (!folder) return undefined;
  const lookup = clientsForAccount(findProjectAccount())
    .then((clients) => folderPathOf(clients, folder))
    .catch(() => undefined);
  const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, LOOKUP_TIMEOUT_MS));
  return (await Promise.race([lookup, timeout])) ?? parseDriveId(folder);
}
