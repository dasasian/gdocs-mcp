import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clientsForAccount } from './google/clients.js';
import { listAccounts } from './auth/accounts.js';
import { listSuggestions, applySuggestion } from './docs/suggestions.js';
import { listComments, addComment, replyComment, resolveComment } from './drive/comments.js';
import { readDoc } from './docs/read.js';
import { editDoc } from './docs/edit.js';
import { createDoc, overwriteDoc, renameDoc, listTabs, addTab, renameTab, deleteTab } from './docs/document.js';
import { formatDoc } from './docs/format.js';
import { insertImage, insertTable } from './docs/objects.js';
import { listPermissions, shareDoc, unshareDoc, setLinkAccess } from './drive/sharing.js';

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
        'List pending suggestions (tracked changes) in a Google Doc as before→after diffs, in document order. Note: the Docs API exposes no author or timestamp for suggestions.',
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
        'Resolve a pending suggestion by id (from list_suggestions): accept keeps the proposed text, reject keeps the original. Cleanly removes the suggestion.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        suggestionId: z.string().describe('suggestion id from list_suggestions'),
        decision: z.enum(['accept', 'reject']),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, suggestionId, decision, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await applySuggestion(clients, documentId, suggestionId, decision, tab));
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
        'Create a new Google Doc with a title and optional initial content. Content is rendered as markdown (headings, paragraphs, bold/italic/links, bullet + ordered lists).',
      inputSchema: { title: z.string(), content: z.string().optional(), ...accountArg },
    },
    async ({ title, content, account }) => {
      const clients = await clientsForAccount(account);
      return json(await createDoc(clients, title, content));
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
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, content, force, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await overwriteDoc(clients, documentId, content, { force, tab }));
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
