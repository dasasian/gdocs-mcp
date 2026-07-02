import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clientsForAccount } from './google/clients.js';
import { listAccounts, findProjectConfig, findProjectConfigPath, setProjectConfig } from './auth/accounts.js';
import { listSuggestions, applySuggestion, applySuggestions } from './docs/suggestions.js';
import { listComments, addComment, replyComment, resolveComment } from './drive/comments.js';
import { readDoc } from './docs/read.js';
import { editDoc } from './docs/edit.js';
import { createDoc, overwriteDoc, renameDoc, moveDoc, listTabs, addTab, renameTab, deleteTab } from './docs/document.js';
import { formatDoc } from './docs/format.js';
import { insertImage, insertTable, insertRow, deleteRow, insertColumn, deleteColumn } from './docs/objects.js';
import { listPermissions, shareDoc, unshareDoc, setLinkAccess } from './drive/sharing.js';
import { listFolder, searchDrive } from './drive/files.js';
import { downloadImages } from './drive/images.js';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const accountArg = {
  account: z
    .string()
    .optional()
    .describe('Google account email to use. Defaults to GDOCS_DEFAULT_ACCOUNT, or the sole account.'),
};

const tabArg = {
  tab: z
    .string()
    .optional()
    .describe('Target a specific tab by tabId or title (from list_tabs). Defaults to the first tab.'),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: 'gdocs-mcp', version: '0.1.0' });

  server.registerTool(
    'list_accounts',
    {
      title: 'List authorized Google accounts',
      description: 'List the Google accounts that have been authorized for this server.',
      inputSchema: {},
    },
    async () => json({ accounts: await listAccounts() }),
  );

  server.registerTool(
    'set_project_default',
    {
      title: 'Set this project’s default account/folder',
      description:
        'Write this project’s defaults to a .gdocs-mcp.json in the current working directory (or update an existing one up the tree). Set a default account and/or a default folder (URL or id) for new docs. To set a folder by name, search_drive for it first and pass its id.',
      inputSchema: {
        account: z.string().optional().describe('default Google account email (must be authorized)'),
        folder: z.string().optional().describe('default Drive folder (URL or id) for new docs'),
      },
    },
    async ({ account, folder }) => {
      if (account) {
        const accts = await listAccounts();
        if (!accts.includes(account)) {
          return json({ error: `Account "${account}" is not authorized. Run \`gdocs-mcp add-account\` first.`, authorized: accts });
        }
      }
      const { path, config } = setProjectConfig({ account, folder });
      return json({ ok: true, path, config });
    },
  );

  server.registerTool(
    'get_project_config',
    {
      title: 'Show this project’s gdocs defaults',
      description: 'Show the effective .gdocs-mcp.json defaults (account/folder) for the current working directory, and where the file is.',
      inputSchema: {},
    },
    async () => json({ path: findProjectConfigPath() ?? null, config: findProjectConfig() }),
  );

  server.registerTool(
    'read_doc',
    {
      title: 'Read a Google Doc',
      description:
        'Read a Google Doc as markdown + inline HTML. mode: clean (committed text, default) · tracked (suggestions shown as <ins>/<del>) · accepted · rejected.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        mode: z.enum(['clean', 'tracked', 'accepted', 'rejected']).optional().describe('read mode (default clean)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, mode, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await readDoc(clients, documentId, mode ?? 'clean', tab));
    },
  );

  server.registerTool(
    'edit_doc',
    {
      title: 'Edit a Google Doc',
      description:
        'Replace an exact unique snippet of text in a Google Doc (like a local file Edit). old_string is matched markup-tolerantly; ambiguous matches return surrounding context to disambiguate. new_string is interpreted as inline markdown (**bold**, *italic*, `code`, [text](url)).',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        old_string: z.string().describe('exact text to replace (quote a unique slice from read_doc)'),
        new_string: z.string().describe('replacement text'),
        replace_all: z.boolean().optional().describe('replace every occurrence (default false)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, old_string, new_string, replace_all, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await editDoc(clients, documentId, old_string, new_string, { replaceAll: replace_all, tab }));
    },
  );

  server.registerTool(
    'format_doc',
    {
      title: 'Format text in a doc',
      description:
        'Apply styling to an existing unique text snippet in place (no content change): bold/italic/underline/strikethrough, color (hex), fontSize (pt), fontFamily, link, and paragraph alignment.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        target_string: z.string().describe('exact text to style (quote a unique slice from read_doc)'),
        style: z
          .object({
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
            underline: z.boolean().optional(),
            strikethrough: z.boolean().optional(),
            color: z.string().optional().describe('hex, e.g. #1a73e8'),
            fontSize: z.number().optional().describe('points'),
            fontFamily: z.string().optional(),
            link: z.string().optional().describe('url'),
            align: z.enum(['left', 'center', 'right', 'justify']).optional(),
          })
          .describe('styles to apply'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, target_string, style, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await formatDoc(clients, documentId, target_string, style, { tab }));
    },
  );

  server.registerTool(
    'download_images',
    {
      title: 'Download a doc’s images',
      description:
        'Download every embedded image in a Google Doc to a local folder. Returns the objectId→filename mapping, which correlates with read_doc’s `![](image:<objectId>)` markers so you can rewrite them to local paths (the inverse of publishing).',
      inputSchema: {
        documentId: z.string(),
        dir: z.string().describe('absolute local folder to save images into (created if missing)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, dir, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await downloadImages(clients, documentId, dir, tab));
    },
  );

  server.registerTool(
    'insert_image',
    {
      title: 'Insert an image',
      description:
        'Insert an inline image from a public URL. Position via at (top/end/or a unique text anchor), size via width/height (points), and align left/center/right. Note: floating/text-wrapped images are not supported by the Docs API.',
      inputSchema: {
        documentId: z.string(),
        uri: z.string().describe('public image URL'),
        at: z.string().optional().describe('"top", "end", or a unique text snippet to insert after (default top)'),
        width: z.number().optional().describe('points'),
        height: z.number().optional().describe('points'),
        align: z.enum(['left', 'center', 'right']).optional(),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, uri, at, width, height, align, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await insertImage(clients, documentId, uri, { at, width, height, align, tab }));
    },
  );

  server.registerTool(
    'insert_table',
    {
      title: 'Insert a table',
      description:
        'Insert a rows×columns table, optionally populated from a 2D array of cell text. Position via at (top/end/or a unique text anchor, default end).',
      inputSchema: {
        documentId: z.string(),
        rows: z.number().int().positive(),
        columns: z.number().int().positive(),
        data: z.array(z.array(z.string())).optional().describe('row-major cell text, e.g. [["A","B"],["1","2"]]'),
        columnWidths: z.array(z.number()).optional().describe('fixed width per column, in points'),
        headerShade: z.string().optional().describe('hex background color for the first row, e.g. #f1f3f4'),
        at: z.string().optional().describe('"top", "end", or a unique text snippet to insert after (default end)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, rows, columns, data, columnWidths, headerShade, at, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await insertTable(clients, documentId, rows, columns, { at, tab, data, columnWidths, headerShade }));
    },
  );

  server.registerTool(
    'list_suggestions',
    {
      title: 'List suggestions in a doc',
      description:
        'List pending suggestions (tracked changes) in a Google Doc as before→after diffs, in document order. Returns the doc `title` and, per suggestion, a human-readable `preview` — pass these verbatim as documentTitle/expectedChange to apply_suggestion. Note: the Docs API exposes no author or timestamp for suggestions.',
      inputSchema: { documentId: z.string().describe('Google Doc id'), ...tabArg, ...accountArg },
    },
    async ({ documentId, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await listSuggestions(clients, documentId, tab));
    },
  );

  server.registerTool(
    'apply_suggestion',
    {
      title: 'Accept or reject a suggestion',
      description:
        'Resolve a pending suggestion by id (from list_suggestions): accept keeps the proposed text, reject keeps the original. Cleanly removes the suggestion. ' +
        'Always call list_suggestions first and copy its `title` and the suggestion\'s `preview` verbatim into documentTitle/expectedChange — this is what a human reviewing the tool call sees, and it is also checked against the live suggestion before applying, so a stale or wrong id is rejected instead of silently resolved. ' +
        'If the suggestion overlaps or adjoins others (a cluster), this returns status "cluster" with the members — resolve them together via apply_suggestions instead (resolving a cluster one-at-a-time corrupts neighbours).',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        documentTitle: z.string().describe("The document's title, from list_suggestions' `title` field. Shown for confirmation only."),
        suggestionId: z.string().describe('suggestion id from list_suggestions'),
        expectedChange: z
          .string()
          .describe(
            "The suggestion's `preview` string, copied exactly from list_suggestions. Shown for confirmation, and must match the live suggestion or the call is rejected.",
          ),
        decision: z.enum(['accept', 'reject']),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, documentTitle: _documentTitle, suggestionId, expectedChange, decision, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await applySuggestion(clients, documentId, suggestionId, decision, expectedChange, tab));
    },
  );

  server.registerTool(
    'apply_suggestions',
    {
      title: 'Accept/reject multiple suggestions atomically',
      description:
        'Resolve several suggestions in ONE atomic update — required for suggestions that overlap or adjoin each other (a "cluster"), which cannot be resolved one at a time without corrupting neighbours. You MUST include every suggestion in any cluster you touch; a partially-resolved cluster is refused (status "incomplete"). Copy each suggestion\'s `preview` from list_suggestions into its `expectedChange` (verified before applying).',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        documentTitle: z.string().describe("The document's title, from list_suggestions. Shown for confirmation only."),
        resolutions: z
          .array(
            z.object({
              suggestionId: z.string(),
              decision: z.enum(['accept', 'reject']),
              expectedChange: z.string().describe("the suggestion's `preview` from list_suggestions"),
            }),
          )
          .describe('one entry per suggestion to resolve'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, documentTitle: _documentTitle, resolutions, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await applySuggestions(clients, documentId, resolutions, tab));
    },
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List comments on a doc',
      description:
        'List comments on a Google Doc (author display name, quoted text, body, resolved status, replies). Author email is not available via the Drive API.',
      inputSchema: { documentId: z.string().describe('Google Doc id'), ...accountArg },
    },
    async ({ documentId, account }) => {
      const clients = await clientsForAccount(account);
      return json(await listComments(clients, documentId));
    },
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment',
      description: 'Add a comment to a Google Doc. Note: API-created comments are not anchored to specific text.',
      inputSchema: { documentId: z.string(), content: z.string(), ...accountArg },
    },
    async ({ documentId, content, account }) => {
      const clients = await clientsForAccount(account);
      return json(await addComment(clients, documentId, content));
    },
  );

  server.registerTool(
    'reply_comment',
    {
      title: 'Reply to a comment',
      description: 'Reply to a comment thread by comment id.',
      inputSchema: { documentId: z.string(), commentId: z.string(), content: z.string(), ...accountArg },
    },
    async ({ documentId, commentId, content, account }) => {
      const clients = await clientsForAccount(account);
      return json(await replyComment(clients, documentId, commentId, content));
    },
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve or reopen a comment',
      description: 'Resolve (or reopen) a comment thread by comment id.',
      inputSchema: {
        documentId: z.string(),
        commentId: z.string(),
        reopen: z.boolean().optional().describe('reopen instead of resolve'),
        ...accountArg,
      },
    },
    async ({ documentId, commentId, reopen, account }) => {
      const clients = await clientsForAccount(account);
      return json(await resolveComment(clients, documentId, commentId, reopen ?? false));
    },
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create a new Google Doc',
      description:
        'Create a new Google Doc with a title and optional initial content (rendered as markdown). Optionally place it in a Drive folder (by folder URL or id); otherwise it goes to My Drive root.',
      inputSchema: {
        title: z.string(),
        content: z.string().optional(),
        folder: z.string().optional().describe('Drive folder URL or id to create the doc in'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths against (e.g. the markdown file’s folder)'),
        ...accountArg,
      },
    },
    async ({ title, content, folder, baseDir, account }) => {
      const clients = await clientsForAccount(account);
      return json(await createDoc(clients, title, content, { folder, baseDir }));
    },
  );

  server.registerTool(
    'move_doc',
    {
      title: 'Move a doc to a folder',
      description: 'Move an existing Google Doc into a Drive folder (by folder URL or id).',
      inputSchema: { documentId: z.string(), folder: z.string().describe('Drive folder URL or id'), ...accountArg },
    },
    async ({ documentId, folder, account }) => {
      const clients = await clientsForAccount(account);
      return json(await moveDoc(clients, documentId, folder));
    },
  );

  server.registerTool(
    'overwrite_doc',
    {
      title: 'Overwrite a doc (guarded)',
      description:
        'Replace the entire body of a doc (or one tab) with markdown-rendered content. Refuses if comments/suggestions are present (would orphan them) unless force=true.',
      inputSchema: {
        documentId: z.string(),
        content: z.string().describe('markdown content'),
        force: z.boolean().optional().describe('proceed even if comments/suggestions would be lost'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths against (e.g. the markdown file’s folder)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, content, force, baseDir, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await overwriteDoc(clients, documentId, content, { force, tab, baseDir }));
    },
  );

  server.registerTool(
    'rename_doc',
    {
      title: 'Rename a doc',
      description: 'Rename a Google Doc (changes its Drive file name / title).',
      inputSchema: { documentId: z.string(), name: z.string(), ...accountArg },
    },
    async ({ documentId, name, account }) => {
      const clients = await clientsForAccount(account);
      return json(await renameDoc(clients, documentId, name));
    },
  );

  const cellArg = { cell: z.string().describe('text identifying a cell in the target table') };

  server.registerTool(
    'insert_row',
    {
      title: 'Insert a table row',
      description: 'Insert a row into the table containing the given cell text. Preserves the rest of the table.',
      inputSchema: { documentId: z.string(), ...cellArg, below: z.boolean().optional().describe('insert below (default) vs above'), ...tabArg, ...accountArg },
    },
    async ({ documentId, cell, below, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await insertRow(clients, documentId, cell, { below, tab }));
    },
  );

  server.registerTool(
    'delete_row',
    {
      title: 'Delete a table row',
      description: 'Delete the row containing the given cell text.',
      inputSchema: { documentId: z.string(), ...cellArg, ...tabArg, ...accountArg },
    },
    async ({ documentId, cell, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await deleteRow(clients, documentId, cell, { tab }));
    },
  );

  server.registerTool(
    'insert_column',
    {
      title: 'Insert a table column',
      description: 'Insert a column into the table containing the given cell text.',
      inputSchema: { documentId: z.string(), ...cellArg, right: z.boolean().optional().describe('insert to the right (default) vs left'), ...tabArg, ...accountArg },
    },
    async ({ documentId, cell, right, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await insertColumn(clients, documentId, cell, { right, tab }));
    },
  );

  server.registerTool(
    'delete_column',
    {
      title: 'Delete a table column',
      description: 'Delete the column containing the given cell text.',
      inputSchema: { documentId: z.string(), ...cellArg, ...tabArg, ...accountArg },
    },
    async ({ documentId, cell, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await deleteColumn(clients, documentId, cell, { tab }));
    },
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List a Drive folder',
      description: 'List the files and subfolders directly inside a Drive folder (by URL or id). Defaults to My Drive root.',
      inputSchema: {
        folder: z.string().optional().describe('folder URL or id (default My Drive root)'),
        ...accountArg,
      },
    },
    async ({ folder, account }) => {
      const clients = await clientsForAccount(account);
      return json(await listFolder(clients, folder));
    },
  );

  server.registerTool(
    'search_drive',
    {
      title: 'Search Drive by name',
      description: 'Find files/folders whose name contains the query. Optionally restrict to folders or documents.',
      inputSchema: {
        query: z.string(),
        type: z.enum(['folder', 'document', 'any']).optional().describe('restrict results (default any)'),
        ...accountArg,
      },
    },
    async ({ query, type, account }) => {
      const clients = await clientsForAccount(account);
      return json(await searchDrive(clients, query, type ?? 'any'));
    },
  );

  server.registerTool(
    'list_permissions',
    {
      title: 'List who a doc is shared with',
      description: 'List the permissions on a Google Doc (people, groups, domain, anyone-with-link) with their roles.',
      inputSchema: { documentId: z.string(), ...accountArg },
    },
    async ({ documentId, account }) => {
      const clients = await clientsForAccount(account);
      return json(await listPermissions(clients, documentId));
    },
  );

  server.registerTool(
    'share_doc',
    {
      title: 'Share a doc with someone',
      description: 'Grant a person access to a Google Doc by email, as reader/commenter/writer. Optionally send a notification email.',
      inputSchema: {
        documentId: z.string(),
        email: z.string().describe('email to share with'),
        role: z.enum(['reader', 'commenter', 'writer']).optional().describe('default writer'),
        notify: z.boolean().optional().describe('send notification email (default true)'),
        ...accountArg,
      },
    },
    async ({ documentId, email, role, notify, account }) => {
      const clients = await clientsForAccount(account);
      return json(await shareDoc(clients, documentId, email, role ?? 'writer', notify ?? true));
    },
  );

  server.registerTool(
    'unshare_doc',
    {
      title: 'Remove someone’s access',
      description: 'Revoke a person’s direct access to a Google Doc by email.',
      inputSchema: { documentId: z.string(), email: z.string(), ...accountArg },
    },
    async ({ documentId, email, account }) => {
      const clients = await clientsForAccount(account);
      return json(await unshareDoc(clients, documentId, email));
    },
  );

  server.registerTool(
    'set_link_access',
    {
      title: 'Set anyone-with-link access',
      description: 'Set link sharing for a Google Doc: reader/commenter/writer for anyone with the link, or none to disable.',
      inputSchema: {
        documentId: z.string(),
        role: z.enum(['reader', 'commenter', 'writer', 'none']),
        ...accountArg,
      },
    },
    async ({ documentId, role, account }) => {
      const clients = await clientsForAccount(account);
      return json(await setLinkAccess(clients, documentId, role));
    },
  );

  server.registerTool(
    'list_tabs',
    {
      title: 'List document tabs',
      description: 'List the tabs in a Google Doc (tabId, title, index, nesting).',
      inputSchema: { documentId: z.string(), ...accountArg },
    },
    async ({ documentId, account }) => {
      const clients = await clientsForAccount(account);
      return json(await listTabs(clients, documentId));
    },
  );

  server.registerTool(
    'add_tab',
    {
      title: 'Add a tab',
      description: 'Add a new tab to a Google Doc. Returns the new tabId. Optionally set position (index) and parent tab for nesting.',
      inputSchema: {
        documentId: z.string(),
        title: z.string(),
        index: z.number().optional().describe('position among tabs'),
        parentTabId: z.string().optional().describe('nest under this tab'),
        ...accountArg,
      },
    },
    async ({ documentId, title, index, parentTabId, account }) => {
      const clients = await clientsForAccount(account);
      return json(await addTab(clients, documentId, title, { index, parentTabId }));
    },
  );

  server.registerTool(
    'rename_tab',
    {
      title: 'Rename a tab',
      description: 'Rename a tab by tabId.',
      inputSchema: { documentId: z.string(), tabId: z.string(), title: z.string(), ...accountArg },
    },
    async ({ documentId, tabId, title, account }) => {
      const clients = await clientsForAccount(account);
      return json(await renameTab(clients, documentId, tabId, title));
    },
  );

  server.registerTool(
    'delete_tab',
    {
      title: 'Delete a tab',
      description: 'Delete a tab by tabId (cascades to child tabs).',
      inputSchema: { documentId: z.string(), tabId: z.string(), ...accountArg },
    },
    async ({ documentId, tabId, account }) => {
      const clients = await clientsForAccount(account);
      return json(await deleteTab(clients, documentId, tabId));
    },
  );

  return server;
}
