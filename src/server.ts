import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clientsForAccount } from './google/clients.js';
import { listAccounts, findProjectConfig, findProjectConfigPath, setProjectConfig } from './auth/accounts.js';
import { listSuggestions, applySuggestions } from './docs/suggestions.js';
import { listComments, addComment, replyComment, resolveComment } from './drive/comments.js';
import { readDoc } from './docs/read.js';
import { editDoc } from './docs/edit.js';
import { createDoc, copyDoc, insertContent, overwriteDoc, updateDoc, listTabs, addTab, renameTab, deleteTab, resolveContentSource } from './docs/document.js';
import { setStyle } from './docs/format.js';
import { setPageSetup, getPageSetup } from './docs/page.js';
import { getStyle } from './docs/inspect.js';
import { insertImage, insertTable, insertRow, deleteRow, insertColumn, deleteColumn, setTableStyle } from './docs/objects.js';
import { listPermissions, shareDoc, unshareDoc, setLinkAccess } from './drive/sharing.js';
import { listFolder, searchDrive, createFolder } from './drive/files.js';
import { downloadImages } from './drive/images.js';
import { exportDoc, EXPORT_FORMATS, type ExportFormat } from './drive/export.js';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// The Docs API cannot create tracked suggestions or anchor comments to text — every write is direct.
// Surfaced in the tool result (not just the schema description) so a calling agent sees it in the moment.
const DIRECT_EDIT_NOTE = 'Direct edit — applied as live text, not a tracked suggestion (the Docs API cannot create suggestions).';
const UNANCHORED_COMMENT_NOTE = 'Comment added, but not anchored to specific text (the Docs/Drive API cannot anchor programmatically-created comments).';

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

const segmentArg = {
  segment: z
    .enum(['body', 'header', 'footer'])
    .optional()
    .describe('which content tree to target: body (default), or the page header/footer. Header/footer content is invisible to a body read — a letterhead logo lives there.'),
  page: z
    .enum(['default', 'first', 'even'])
    .optional()
    .describe('which header/footer, when a doc defines more than one (default-page, first-page, even-page). Omit to use whichever exists.'),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: 'gdocs-mcp', version: '0.3.0' });

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
        'Read a Google Doc as markdown + inline HTML. mode: clean (committed text, default) · tracked (suggestions shown as <ins>/<del>) · accepted · rejected. segment picks the content tree: body (default), header, footer, or all (body plus every header/footer, each labelled). A body read always reports which headers/footers exist and what they hold, since their content — a letterhead logo, a page number — is NOT part of the body and would otherwise be invisible.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        mode: z.enum(['clean', 'tracked', 'accepted', 'rejected']).optional().describe('read mode (default clean)'),
        segment: z.enum(['body', 'header', 'footer', 'all']).optional().describe('content tree to read (default body)'),
        page: segmentArg.page,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, mode, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await readDoc(clients, documentId, mode ?? 'clean', tab, { segment, page }));
    },
  );

  server.registerTool(
    'edit_doc',
    {
      title: 'Edit a Google Doc',
      description:
        'Replace an exact unique snippet of text in a Google Doc (like a local file Edit). old_string is matched markup-tolerantly; ambiguous matches return surrounding context to disambiguate. new_string is interpreted as inline markdown (**bold**, *italic*, `code`, [text](url)). NOTE: this is a direct edit — the change is applied as live text, not a tracked suggestion (the Docs API cannot create suggestions). If the doc has pending suggestions from other reviewers, flag to the user that your edit will sit alongside them as an accepted change.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        old_string: z.string().describe('exact text to replace (quote a unique slice from read_doc)'),
        new_string: z.string().describe('replacement text'),
        replace_all: z.boolean().optional().describe('replace every occurrence (default false)'),
        ...segmentArg,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, old_string, new_string, replace_all, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      const result = await editDoc(clients, documentId, old_string, new_string, { replaceAll: replace_all, tab, segment, page });
      return json(result.status === 'ok' ? { ...result, note: DIRECT_EDIT_NOTE } : result);
    },
  );

  server.registerTool(
    'set_style',
    {
      title: 'Style text in a doc',
      description:
        'Apply styling to existing text in place (no content change), the way you select text in Docs and apply formatting. Pick ONE target: `from` (+ optional `to`) to style a selection — from the start of the unique `from` snippet to the end of the unique `to` snippet (omit `to` to style just `from`); or `whole_document: true` to style the entire doc/tab (e.g. one font throughout, without per-paragraph calls). Styles: bold/italic/underline/strikethrough, color (hex), fontSize (pt), fontFamily, link, paragraph alignment, and paragraph spacing (spaceBefore/spaceAfter in pt, lineSpacing %). Use inspect_style first to read current spacing/fonts. NOTE: a direct style change, not a tracked suggestion.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        from: z.string().optional().describe('start anchor: a unique text snippet to style from (quote a slice from read_doc). Required unless whole_document is set.'),
        to: z.string().optional().describe('optional end anchor: a unique snippet; styles the whole span from the start of `from` to the end of `to` (a selection). Must appear after `from`.'),
        whole_document: z.boolean().optional().describe('style the entire document (or tab, or the targeted header/footer) instead of a selection — e.g. to set one font throughout. Mutually exclusive with from/to.'),
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
            spaceBefore: z.number().optional().describe('points of space above the paragraph'),
            spaceAfter: z.number().optional().describe('points of space below the paragraph'),
            lineSpacing: z.number().optional().describe('percent of single spacing (100=single, 150=1.5x)'),
          })
          .describe('styles to apply'),
        ...segmentArg,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, from, to, whole_document, style, segment, page, tab, account }) => {
      if (whole_document && from !== undefined) {
        throw new Error('Provide either whole_document or from/to, not both.');
      }
      if (!whole_document && from === undefined) {
        throw new Error('Provide a `from` anchor (with optional `to`), or set whole_document.');
      }
      const target = whole_document ? { whole: true as const } : { from: from!, to };
      const clients = await clientsForAccount(account);
      return json(await setStyle(clients, documentId, target, style, { tab, segment, page }));
    },
  );

  server.registerTool(
    'get_page_setup',
    {
      title: 'Read document page setup',
      description:
        'Read a doc’s (or tab’s) page setup — margins, page size (in points, plus a preset name if it matches letter/legal/a4/tabloid), and orientation. The read counterpart to set_page_setup; use it to mirror another document’s layout onto a new doc.',
      inputSchema: { documentId: z.string().describe('Google Doc id'), ...tabArg, ...accountArg },
    },
    async ({ documentId, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await getPageSetup(clients, documentId, { tab }));
    },
  );

  server.registerTool(
    'set_page_setup',
    {
      title: 'Set document page setup',
      description:
        'Set document-level page setup for a doc (or tab): page margins, page size, and orientation — the File > Page setup controls, which set_style can’t reach. Margins and explicit page sizes are in points (72 pt = 1 inch). pageSize is a preset (letter/legal/a4/tabloid) or an explicit {width,height} in points; orientation (portrait/landscape) swaps the page dimensions. A direct change, not a tracked suggestion.',
      inputSchema: {
        documentId: z.string().describe('Google Doc id'),
        marginTop: z.number().optional().describe('top margin in points (72 = 1 inch)'),
        marginBottom: z.number().optional().describe('bottom margin in points'),
        marginLeft: z.number().optional().describe('left margin in points'),
        marginRight: z.number().optional().describe('right margin in points'),
        pageSize: z
          .union([z.enum(['letter', 'legal', 'a4', 'tabloid']), z.object({ width: z.number(), height: z.number() })])
          .optional()
          .describe('a preset name, or {width,height} in points'),
        orientation: z.enum(['portrait', 'landscape']).optional().describe('portrait or landscape (orders the page width/height)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, marginTop, marginBottom, marginLeft, marginRight, pageSize, orientation, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(
        await setPageSetup(clients, documentId, { marginTop, marginBottom, marginLeft, marginRight, pageSize, orientation }, { tab }),
      );
    },
  );

  server.registerTool(
    'get_style',
    {
      title: 'Read computed style at a text anchor',
      description:
        'Read the effective (inherited-resolved) style at a unique text snippet — read_doc’s markdown can’t express these; the read counterpart to set_style. Returns paragraph style (namedStyleType, alignment, spaceBefore/spaceAfter in pt, lineSpacing %, and whether spacing is inherited) and text style (bold/italic/underline/strikethrough, fontSize pt, fontFamily, color hex, link). Use it to diagnose things markdown hides — e.g. an unexpected gap between paragraphs is spacing (spaceAfter>0), not a blank line, and is fixed with set_style’s spaceAfter, not edit_doc.',
      inputSchema: {
        documentId: z.string(),
        target_string: z.string().describe('exact text to read the style of (quote a unique slice from read_doc)'),
        ...segmentArg,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, target_string, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await getStyle(clients, documentId, target_string, { tab, segment, page }));
    },
  );

  server.registerTool(
    'download_images',
    {
      title: 'Download a doc’s images',
      description:
        'Download every embedded image in a Google Doc to a local folder. Returns the objectId→filename mapping, which correlates with read_doc’s `<img src="image:<objectId>">` markers so you can rewrite them to local paths (the inverse of publishing).',
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
        'Insert an inline image from a public URL or a local file (uploaded to Drive, embedded, then the temp upload removed). Position via at (top/end/or a unique text anchor), size via width/height (points), and align left/center/right. Set segment:"header" for a letterhead logo — that is where a repeating, correctly-sized logo belongs, and it is why a template’s logo is invisible to a body read. A direct edit, not a tracked suggestion. Note: floating/text-wrapped images are not supported by the Docs API.',
      inputSchema: {
        documentId: z.string(),
        uri: z.string().describe('public image URL, or a path to a local image file (absolute, or relative to baseDir)'),
        at: z.string().optional().describe('"top", "end", or a unique text snippet to insert after (default top)'),
        width: z.number().optional().describe('points'),
        height: z.number().optional().describe('points'),
        align: z.enum(['left', 'center', 'right']).optional(),
        baseDir: z.string().optional().describe('absolute dir to resolve a relative local `uri` against'),
        ...segmentArg,
        createSegment: z
          .boolean()
          .optional()
          .describe('when segment is header/footer and the doc has none, create it first (the letterhead case). Only the default header/footer can be created via the API.'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, uri, at, width, height, align, baseDir, segment, page, createSegment, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await insertImage(clients, documentId, uri, { at, width, height, align, baseDir, tab, segment, page, createSegment }));
    },
  );

  server.registerTool(
    'insert_table',
    {
      title: 'Insert a table',
      description:
        'Insert a rows×columns table, optionally populated from a 2D array of cell text — cell text may use inline markdown (**bold**, *italic*, `code`, [links](url)). Per-column alignment via align. Position via at (top/end/or a unique text anchor, default end). A direct edit, not a tracked suggestion.',
      inputSchema: {
        documentId: z.string(),
        rows: z.number().int().positive(),
        columns: z.number().int().positive(),
        data: z.array(z.array(z.string())).optional().describe('row-major cell text, e.g. [["A","B"],["1","2"]]'),
        columnWidths: z.array(z.number()).optional().describe('fixed width per column, in points'),
        headerShade: z.string().optional().describe('hex background color for the first row, e.g. #f1f3f4'),
        align: z
          .array(z.enum(['left', 'center', 'right', 'justify']).nullable())
          .optional()
          .describe('per-column text alignment, e.g. ["left","right"]; null or "left" leaves a column at the default'),
        at: z.string().optional().describe('"top", "end", or a unique text snippet to insert after (default end)'),
        ...segmentArg,
        createSegment: z
          .boolean()
          .optional()
          .describe('when segment is header/footer and the doc has none, create it first. Only the default header/footer can be created via the API.'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, rows, columns, data, columnWidths, headerShade, align, at, segment, page, createSegment, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await insertTable(clients, documentId, rows, columns, { at, tab, data, columnWidths, headerShade, align, segment, page, createSegment }));
    },
  );

  server.registerTool(
    'list_suggestions',
    {
      title: 'List suggestions in a doc',
      description:
        'List pending suggestions (tracked changes) in a Google Doc as before→after diffs, in document order. Returns the doc `title` and, per suggestion, a human-readable `preview` — pass these verbatim as documentTitle/expectedChange to apply_suggestion. Note: the Docs API exposes no author or timestamp for suggestions.',
      inputSchema: { documentId: z.string().describe('Google Doc id'), ...segmentArg, ...tabArg, ...accountArg },
    },
    async ({ documentId, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await listSuggestions(clients, documentId, tab, { segment, page }));
    },
  );

  server.registerTool(
    'apply_suggestions',
    {
      title: 'Accept/reject one or more suggestions',
      description:
        'Resolve one or more pending suggestions (from list_suggestions) in ONE atomic update: accept keeps the proposed text, reject keeps the original. Pass one resolution to resolve a single suggestion, or several at once — required for suggestions that overlap or adjoin each other (a "cluster"), which cannot be resolved one at a time without corrupting neighbours. You MUST include every suggestion in any cluster you touch; a partially-resolved cluster is refused (status "incomplete"). documentTitle is checked against the live document first (status "wrong_doc" on mismatch, e.g. an id from a different, similarly-titled document). Copy each suggestion\'s `preview` from list_suggestions into its `expectedChange` (verified before applying). If the result includes a `conflicts` array, two suggestions genuinely conflicted (one inserts text inside another\'s deletion, both accepted) — it was auto-resolved by keeping the insertion; surface this to the user as NOT a clean merge.',
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
        ...segmentArg,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, documentTitle, resolutions, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await applySuggestions(clients, documentId, documentTitle, resolutions, tab, { segment, page }));
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
      title: 'Add a comment or reply',
      description:
        'Add a comment to a Google Doc, or reply to an existing comment thread by passing replyTo (a comment id from list_comments). A new comment (no replyTo) is not anchored to specific text — the Docs/Drive API cannot anchor programmatically-created comments.',
      inputSchema: {
        documentId: z.string(),
        content: z.string(),
        replyTo: z.string().optional().describe('a comment id (from list_comments) to reply to; omit to start a new top-level comment'),
        ...accountArg,
      },
    },
    async ({ documentId, content, replyTo, account }) => {
      const clients = await clientsForAccount(account);
      if (replyTo !== undefined) return json(await replyComment(clients, documentId, replyTo, content));
      return json({ ...(await addComment(clients, documentId, content)), note: UNANCHORED_COMMENT_NOTE });
    },
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve or reopen a comment',
      description:
        'Resolve (or reopen) a comment thread by comment id. Pass expectQuote (a snippet of the comment’s quoted text or body, from list_comments) — shown for confirmation and verified against the live comment, so a wrong/stale id is refused instead of resolving the wrong thread.',
      inputSchema: {
        documentId: z.string(),
        commentId: z.string(),
        reopen: z.boolean().optional().describe('reopen instead of resolve'),
        expectQuote: z.string().optional().describe('snippet of the comment’s quoted text/body; verified before resolving'),
        ...accountArg,
      },
    },
    async ({ documentId, commentId, reopen, expectQuote, account }) => {
      const clients = await clientsForAccount(account);
      return json(await resolveComment(clients, documentId, commentId, reopen ?? false, { expectQuote }));
    },
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create a new Google Doc',
      description:
        'Create a new Google Doc with a title and optional initial content (rendered as markdown). Optionally place it in a Drive folder (by folder URL or id); otherwise it goes to My Drive root. For long documents, pass contentFile (a local path) instead of content so the server reads the body directly — retyping a long doc inline can silently drop or fuse text.',
      inputSchema: {
        title: z.string(),
        content: z.string().optional(),
        contentFile: z
          .string()
          .optional()
          .describe(
            'path to a local markdown/text file to use as the body, read directly by the server — preferred for long documents so the body is passed through mechanically rather than retyped inline (which can silently drop text). Absolute, or relative to baseDir. Mutually exclusive with content.',
          ),
        folder: z.string().optional().describe('Drive folder URL or id to create the doc in'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths against (e.g. the markdown file’s folder)'),
        ...accountArg,
      },
    },
    async ({ title, content, contentFile, folder, baseDir, account }) => {
      const clients = await clientsForAccount(account);
      const src = await resolveContentSource({ content, contentFile, baseDir });
      return json(await createDoc(clients, title, src.content, { folder, baseDir: src.baseDir }));
    },
  );

  server.registerTool(
    'insert_content',
    {
      title: 'Insert content at a position',
      description:
        'Insert NEW markdown-rendered content at a structural position — no anchor text required. `at`: "end" (default, the end of the doc/tab) · "top" · a unique text snippet to insert immediately after. Use this where edit_doc can\u2019t reach: adding a paragraph after a table that ends the doc (a table\u2019s cells can\u2019t anchor an insert outside the table, and the trailing empty paragraph has no text to match), or appending to an empty doc. Use edit_doc instead when you are replacing or extending existing text. Content is full markdown (headings, lists, tables, images), same renderer as create_doc. A direct edit, not a tracked suggestion.',
      inputSchema: {
        documentId: z.string(),
        content: z.string().optional().describe('markdown content to insert (or use contentFile)'),
        contentFile: z
          .string()
          .optional()
          .describe('path to a local markdown/text file to insert, read directly by the server \u2014 preferred for long content. Absolute, or relative to baseDir. Mutually exclusive with content.'),
        at: z
          .string()
          .optional()
          .describe('"end" (default) | "top" | a unique text snippet to insert right after'),
        ...segmentArg,
        createSegment: z
          .boolean()
          .optional()
          .describe('when segment is header/footer and the doc has none, create it first (the letterhead case). Only the default header/footer can be created via the API.'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths against'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, content, contentFile, at, segment, page, createSegment, baseDir, tab, account }) => {
      const clients = await clientsForAccount(account);
      const src = await resolveContentSource({ content, contentFile, baseDir });
      if (src.content === undefined) throw new Error('Provide content or contentFile.');
      const result = await insertContent(clients, documentId, src.content, { at, tab, baseDir: src.baseDir, segment, page, createSegment });
      return json(result.status === 'ok' ? { ...result, note: DIRECT_EDIT_NOTE } : result);
    },
  );

  server.registerTool(
    'export_doc',
    {
      title: 'Export a doc to a file',
      description:
        'Export a Google Doc to a real file on disk \u2014 pdf (default), docx, odt, rtf, txt, html, epub, or md. Google renders it server-side (File > Download in the UI), so page setup, pagination and layout match the editor. Returns the local path and byte size. Note: Drive refuses to export files larger than 10 MB.',
      inputSchema: {
        documentId: z.string(),
        dir: z.string().describe('absolute local folder to save the export into (created if missing)'),
        format: z.enum(EXPORT_FORMATS as [ExportFormat, ...ExportFormat[]]).optional().describe('default pdf'),
        filename: z.string().optional().describe('override the filename (default: the doc\u2019s title + extension)'),
        ...accountArg,
      },
    },
    async ({ documentId, dir, format, filename, account }) => {
      const clients = await clientsForAccount(account);
      return json(await exportDoc(clients, documentId, dir, { format, filename }));
    },
  );

  server.registerTool(
    'copy_doc',
    {
      title: 'Duplicate an existing Doc',
      description:
        'Duplicate a Google Doc (Drive’s "Make a copy"), optionally with a new name and/or into a Drive folder (URL or id). Prefer this over recreating a doc with create_doc when a template is involved — a copy preserves headers/footers, image sizing and exact formatting, none of which survive a markdown round-trip. Defaults: Drive’s "Copy of …" name, and the source doc’s folder.',
      inputSchema: {
        documentId: z.string().describe('the doc to copy (URL or id)'),
        name: z.string().optional().describe('name for the copy (default: Drive’s "Copy of …")'),
        folder: z.string().optional().describe('Drive folder URL or id to put the copy in (default: same as source)'),
        ...accountArg,
      },
    },
    async ({ documentId, name, folder, account }) => {
      const clients = await clientsForAccount(account);
      return json(await copyDoc(clients, documentId, { name, folder }));
    },
  );

  server.registerTool(
    'update_doc',
    {
      title: 'Update a doc’s name and/or folder',
      description:
        'Update a Google Doc’s metadata: rename it (name) and/or move it to a Drive folder (folder, by URL or id). Provide name, folder, or both. When moving, pass expectTitle (the doc’s title) — shown for confirmation and verified against the live doc before moving; if it doesn’t match, nothing is changed. (Content edits use edit_doc/overwrite_doc, not this.)',
      inputSchema: {
        documentId: z.string(),
        name: z.string().optional().describe('new name/title for the doc'),
        folder: z.string().optional().describe('Drive folder URL or id to move the doc into'),
        expectTitle: z.string().optional().describe('the doc’s current title; verified before moving so a wrong id is refused'),
        ...accountArg,
      },
    },
    async ({ documentId, name, folder, expectTitle, account }) => {
      const clients = await clientsForAccount(account);
      return json(await updateDoc(clients, documentId, { name, folder, expectTitle }));
    },
  );

  server.registerTool(
    'overwrite_doc',
    {
      title: 'Overwrite a doc (guarded)',
      description:
        'Replace the entire body of a doc (or one tab) with markdown-rendered content. Refuses if comments/suggestions are present (would orphan them) unless force=true. Pass expectTitle (the doc’s title) — shown for confirmation and verified against the live doc before replacing. For long documents, pass contentFile instead of content so the server reads the body directly (retyping a long doc inline can silently drop text). A direct edit, not a tracked suggestion.',
      inputSchema: {
        documentId: z.string(),
        content: z.string().optional().describe('markdown content (or use contentFile)'),
        contentFile: z
          .string()
          .optional()
          .describe(
            'path to a local markdown/text file to use as the new body, read directly by the server — preferred for long documents so the body is passed through mechanically rather than retyped inline (which can silently drop text). Absolute, or relative to baseDir. Mutually exclusive with content.',
          ),
        force: z.boolean().optional().describe('proceed even if comments/suggestions would be lost'),
        expectTitle: z.string().optional().describe('the doc’s title; verified before overwriting so a wrong id is refused'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths against (e.g. the markdown file’s folder)'),
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, content, contentFile, force, expectTitle, baseDir, tab, account }) => {
      const clients = await clientsForAccount(account);
      const src = await resolveContentSource({ content, contentFile, baseDir });
      if (src.content === undefined) throw new Error('Provide content or contentFile.');
      return json(await overwriteDoc(clients, documentId, src.content, { force, tab, baseDir: src.baseDir, expectTitle }));
    },
  );

  const cellArg = { cell: z.string().describe('text identifying a cell in the target table') };

  server.registerTool(
    'edit_table',
    {
      title: 'Insert or delete a table row/column',
      description:
        'Structurally edit the table containing the given cell text: insert or delete a row or column. `op` picks the operation; `side` picks which side an insert goes on (for rows: after=below (default)/before=above; for columns: after=right (default)/before=left) and is ignored for deletes. Deletes remove the row/column that contains `cell`.',
      inputSchema: {
        documentId: z.string(),
        ...cellArg,
        op: z.enum(['insert_row', 'delete_row', 'insert_column', 'delete_column']).describe('the structural edit to perform'),
        side: z
          .enum(['before', 'after'])
          .optional()
          .describe('for inserts: which side of `cell` to add on — rows after=below (default)/before=above; columns after=right (default)/before=left. Ignored for deletes.'),
        ...segmentArg,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, cell, op, side, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      const after = side !== 'before'; // default 'after'
      const seg = { segment, page, tab };
      switch (op) {
        case 'insert_row':
          return json(await insertRow(clients, documentId, cell, { below: after, ...seg }));
        case 'delete_row':
          return json(await deleteRow(clients, documentId, cell, seg));
        case 'insert_column':
          return json(await insertColumn(clients, documentId, cell, { right: after, ...seg }));
        case 'delete_column':
          return json(await deleteColumn(clients, documentId, cell, seg));
      }
    },
  );

  server.registerTool(
    'set_table_style',
    {
      title: 'Style an existing table',
      description:
        'Edit style/layout of an existing table (located by any cell’s text): cell padding (pt), background color (hex), cell borders, column widths (pt), and pinned header rows. scope selects which cells padding/background/border hit — table (default), row, column, or cell (the row/column of the matched cell). Fixes e.g. thin left padding that clips the first letter of cells; border {width:0} makes a table borderless; headerRows repeats the top rows on every page. A direct edit, not a tracked suggestion.',
      inputSchema: {
        documentId: z.string(),
        cell: z.string().describe('text of any cell in the target table (locates the table)'),
        scope: z.enum(['table', 'row', 'column', 'cell']).optional().describe('default table'),
        padding: z
          .object({
            left: z.number().optional(),
            right: z.number().optional(),
            top: z.number().optional(),
            bottom: z.number().optional(),
          })
          .optional()
          .describe('cell padding in points'),
        backgroundColor: z.string().optional().describe('hex, e.g. #f1f3f4'),
        border: z
          .object({
            width: z.number().optional().describe('points; 0 hides the border (borders cannot be transparent)'),
            color: z.string().optional().describe('hex, e.g. #cccccc (default #000000)'),
            dashStyle: z.enum(['SOLID', 'DOT', 'DASH']).optional(),
            sides: z
              .array(z.enum(['top', 'bottom', 'left', 'right']))
              .optional()
              .describe('which edges to set (default all four)'),
          })
          .optional()
          .describe('cell borders, over the same scope as padding/background'),
        columnWidths: z
          .array(z.object({ index: z.number(), width: z.number() }))
          .optional()
          .describe('set specific column widths (points) by column index'),
        headerRows: z
          .number()
          .optional()
          .describe('repeat the top N rows on every page (Docs’ "pin header rows"); 0 unpins. Independent of scope.'),
        ...segmentArg,
        ...tabArg,
        ...accountArg,
      },
    },
    async ({ documentId, cell, scope, padding, backgroundColor, border, columnWidths, headerRows, segment, page, tab, account }) => {
      const clients = await clientsForAccount(account);
      return json(await setTableStyle(clients, documentId, cell, { scope, padding, backgroundColor, border, columnWidths, headerRows, segment, page, tab }));
    },
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List a Drive folder',
      description:
        'List the files and subfolders directly inside a Drive folder (by URL or id). Defaults to My Drive root. Each entry carries its parent folder(s) (id + name) so a result can be traced upward.',
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
      description:
        'Find files/folders whose name contains the query. Optionally restrict to folders or documents. Each result carries its parent folder(s) (id + name), so you can tell where a hit lives — and create a sibling next to it.',
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
    'create_folder',
    {
      title: 'Create a Drive folder',
      description:
        'Create a folder in Google Drive, optionally inside a parent folder (URL or id); otherwise it goes to My Drive root. To nest under a folder you only know by name, search_drive for it first and pass its id.',
      inputSchema: {
        name: z.string().describe('name for the new folder'),
        folder: z.string().optional().describe('parent folder URL or id (default My Drive root)'),
        ...accountArg,
      },
    },
    async ({ name, folder, account }) => {
      const clients = await clientsForAccount(account);
      return json(await createFolder(clients, name, folder));
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
      title: 'Share a doc (person or link)',
      description:
        'Grant access to a Google Doc. With `email`, share with that person as reader/commenter/writer (optionally sending a notification). Without `email`, set anyone-with-link access to that role, or role "none" to disable link sharing. (To revoke a specific person’s access, use unshare_doc.)',
      inputSchema: {
        documentId: z.string(),
        email: z.string().optional().describe('person to share with; omit to set anyone-with-link access instead'),
        role: z.enum(['reader', 'commenter', 'writer', 'none']).optional().describe('access level; default writer. "none" (link only) disables link sharing.'),
        notify: z.boolean().optional().describe('when sharing with a person, send a notification email (default true)'),
        ...accountArg,
      },
    },
    async ({ documentId, email, role, notify, account }) => {
      const clients = await clientsForAccount(account);
      if (email !== undefined) {
        if (role === 'none') throw new Error('role "none" is only for link access (omit email); use unshare_doc to revoke a person.');
        return json(await shareDoc(clients, documentId, email, role ?? 'writer', notify ?? true));
      }
      return json(await setLinkAccess(clients, documentId, role ?? 'reader'));
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
      description:
        'Delete a tab by tabId (cascades to child tabs). expectTitle (the tab’s title from list_tabs) is REQUIRED — it is shown in the confirmation and verified against the live tab, so an opaque/stale tabId cannot silently delete the wrong tab.',
      inputSchema: {
        documentId: z.string(),
        tabId: z.string(),
        expectTitle: z.string().describe('the tab’s title (from list_tabs); verified before deleting'),
        ...accountArg,
      },
    },
    async ({ documentId, tabId, expectTitle, account }) => {
      const clients = await clientsForAccount(account);
      return json(await deleteTab(clients, documentId, tabId, { expectTitle }));
    },
  );

  return server;
}
