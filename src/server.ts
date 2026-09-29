import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clientsForAccount } from './google/clients.js';
import { resolveTab, resolveDocument } from './drive/paths.js';
import { listAccounts, findProjectConfig, findProjectConfigPath, setProjectConfig } from './auth/accounts.js';
import { listSuggestions, applySuggestions } from './docs/suggestions.js';
import { listComments, addComment, replyComment, resolveComment } from './drive/comments.js';
import { readDoc } from './docs/read.js';
import { editDoc } from './docs/edit.js';
import { createDoc, insertContent, overwriteDoc, resolveContentSource } from './docs/document.js';
import { setPageSetup, getPageSetup } from './docs/page.js';
import { insertImage, insertTable, insertRow, deleteRow, insertColumn, deleteColumn, setTableStyle, getTableStyle } from './docs/objects.js';
import { listPermissions, shareDoc, unshareDoc, setLinkAccess } from './drive/sharing.js';
import { driveShell } from './drive/shell.js';
import { downloadImages } from './drive/images.js';
import { exportDoc, EXPORT_FORMATS, type ExportFormat } from './drive/export.js';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const DIRECT_EDIT_NOTE = 'Direct edit — applied as live text, not a tracked suggestion (the Docs API cannot create suggestions).';
const UNANCHORED_COMMENT_NOTE = 'Comment added, but not anchored to specific text (the Docs/Drive API cannot anchor programmatically-created comments).';

const accountArg = {
  account: z
    .string()
    .optional()
    .describe('Google account email to use. Defaults to GDOCS_DEFAULT_ACCOUNT, or the sole account.'),
};

const tabPathArg = z
  .string()
  .describe('The doc or tab: a Drive id or URL, /folder/doc, or /folder/doc/tab (nested: /folder/doc/tab/child). A doc with one tab needs no tab step; a doc with several is refused until one is named, and the refusal lists every tab path.');

const docPathArg = z.string().describe('The doc: a Drive id or URL, or /folder/doc. A tab path names its doc.');

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
  const server = new McpServer({ name: 'gdocs-mcp', version: '0.6.0' });

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
        'Write this project’s defaults to a .gdocs-mcp.json in the current working directory (or update an existing one up the tree). Set a default account and/or a default folder (URL or id) for new docs. To set a folder by name, find it first with drive({ cmd: \'find\' }) and pass its id.',
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
        'Read a Google Doc as markdown + inline HTML. The read opens with a <style> block — one CSS rule per named style (p = Normal text, h1–h6, .title, .subtitle), in pt — and a paragraph or run shows style="…" only where it differs from its rule (text-align, line-height, margin-top/bottom/left/right, text-indent; a hanging indent is margin-left:36pt with a negative text-indent). Title and Subtitle paragraphs read as <p class="title">. List items show no indent: their nesting owns it. mode: clean (committed text, default) · tracked (suggestions shown as <ins>/<del>) · accepted · rejected. segment picks the content tree: body (default), header, footer, or all (body plus every header/footer, each labelled). Text that would otherwise read as markup is marked as literal: a paragraph wrapped in <p>…</p> ("4. Term" is a paragraph, not a list) or a backslash before a character (5 \\* 3), and \\\\ is a real backslash — write them back as read, and the document keeps only the words. A body read always reports which headers/footers exist and what they hold, since their content — a letterhead logo, a page number — is NOT part of the body and would otherwise be invisible.',
      inputSchema: {
        path: tabPathArg,
        mode: z.enum(['clean', 'tracked', 'accepted', 'rejected']).optional().describe('read mode (default clean)'),
        segment: z.enum(['body', 'header', 'footer', 'all']).optional().describe('content tree to read (default body)'),
        page: segmentArg.page,
        ...accountArg,
      },
    },
    async ({ path, mode, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await readDoc(clients, target.documentId, mode ?? 'clean', target.tabId, { segment, page }));
    },
  );

  server.registerTool(
    'edit_doc',
    {
      title: 'Edit a Google Doc',
      description:
        'Replace an exact unique snippet of text in a Google Doc (like a local file Edit). old_string is matched markup-tolerantly; ambiguous matches return surrounding context to disambiguate. new_string is interpreted as inline markdown and inline HTML (**bold**, *italic*, `code`, [text](url), `<u>`, `<span style="color:…;font-size:…pt">`, `<p style="…">`, `<p class="title">`) — the same spelling read_doc emits, so a read can be edited and written back. STYLE IS CSS, and this is the only way to change it. Restyle text you are not otherwise changing by giving the same words with different markup: old_string `<p>4. Term`, new_string `<p style="margin-left:36pt; text-indent:-18pt">4. Term` sends only style requests — no delete, no insert, so a long paragraph is never retyped and its words cannot change; markup missing from new_string is cleared (drop the wrapper to remove an indent). To restyle a whole named style, edit its rule in read_doc’s <style> block: old_string `p { font-family: Arial; font-size: 11pt`, new_string `p { font-family: Arial; font-size: 12pt` becomes one updateNamedStyle and every paragraph that does not override it follows. An unsupported property (border, float, a px length, a typo) fails the edit before any request is sent, listing every offending line and the supported set. NOTE: this is a direct edit — the change is applied as live text, not a tracked suggestion (the Docs API cannot create suggestions). If the doc has pending suggestions from other reviewers, flag to the user that your edit will sit alongside them as an accepted change.',
      inputSchema: {
        path: tabPathArg,
        old_string: z.string().describe('exact text to replace (quote a unique slice from read_doc)'),
        new_string: z.string().describe('replacement text'),
        replace_all: z.boolean().optional().describe('replace every occurrence (default false)'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, old_string, new_string, replace_all, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      const result = await editDoc(clients, target.documentId, old_string, new_string, { replaceAll: replace_all, tabId: target.tabId, segment, page });
      return json(result.status === 'ok' ? { ...result, note: DIRECT_EDIT_NOTE } : result);
    },
  );

  server.registerTool(
    'get_page_setup',
    {
      title: 'Read document page setup',
      description:
        'Read a doc’s (or tab’s) page setup — margins, page size (in points, plus a preset name if it matches letter/legal/a4/tabloid), and orientation. The read counterpart to set_page_setup; use it to mirror another document’s layout onto a new doc.',
      inputSchema: { path: tabPathArg, ...accountArg },
    },
    async ({ path, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await getPageSetup(clients, target.documentId, { tabId: target.tabId }));
    },
  );

  server.registerTool(
    'set_page_setup',
    {
      title: 'Set document page setup',
      description:
        'Set document-level page setup for a doc (or tab): page margins, page size, and orientation — the File > Page setup controls. Margins and explicit page sizes are in points (72 pt = 1 inch). pageSize is a preset (letter/legal/a4/tabloid) or an explicit {width,height} in points; orientation (portrait/landscape) swaps the page dimensions. A direct change, not a tracked suggestion.',
      inputSchema: {
        path: tabPathArg,
        marginTop: z.number().optional().describe('top margin in points (72 = 1 inch)'),
        marginBottom: z.number().optional().describe('bottom margin in points'),
        marginLeft: z.number().optional().describe('left margin in points'),
        marginRight: z.number().optional().describe('right margin in points'),
        pageSize: z
          .union([z.enum(['letter', 'legal', 'a4', 'tabloid']), z.object({ width: z.number(), height: z.number() })])
          .optional()
          .describe('a preset name, or {width,height} in points'),
        orientation: z.enum(['portrait', 'landscape']).optional().describe('portrait or landscape (orders the page width/height)'),
        ...accountArg,
      },
    },
    async ({ path, marginTop, marginBottom, marginLeft, marginRight, pageSize, orientation, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(
        await setPageSetup(clients, target.documentId, { marginTop, marginBottom, marginLeft, marginRight, pageSize, orientation }, { tabId: target.tabId }),
      );
    },
  );

  server.registerTool(
    'download_images',
    {
      title: 'Download a doc’s images',
      description:
        'Download every embedded image in a Google Doc to a local folder. Returns the objectId→filename mapping, which correlates with read_doc’s `<img src="image:<objectId>">` markers so you can rewrite them to local paths (the inverse of publishing).',
      inputSchema: {
        path: tabPathArg,
        dir: z.string().describe('absolute local folder to save images into (created if missing)'),
        ...accountArg,
      },
    },
    async ({ path, dir, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await downloadImages(clients, target.documentId, dir, target.tabId));
    },
  );

  server.registerTool(
    'insert_image',
    {
      title: 'Insert an image',
      description:
        'Insert an inline image from a public URL or a local file (uploaded to Drive, embedded, then the temp upload removed). Position via at (top/end/or a unique text anchor), size via width/height (points), and align left/center/right. Set segment:"header" for a letterhead logo — that is where a repeating, correctly-sized logo belongs, and it is why a template’s logo is invisible to a body read. A direct edit, not a tracked suggestion. Note: floating/text-wrapped images are not supported by the Docs API.',
      inputSchema: {
        path: tabPathArg,
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
        ...accountArg,
      },
    },
    async ({ path, uri, at, width, height, align, baseDir, segment, page, createSegment, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await insertImage(clients, target.documentId, uri, { at, width, height, align, baseDir, tabId: target.tabId, segment, page, createSegment }));
    },
  );

  server.registerTool(
    'insert_table',
    {
      title: 'Insert a table',
      description:
        'Insert a rows×columns table, optionally populated from a 2D array of cell text — cell text may use inline markdown (**bold**, *italic*, `code`, [links](url)). Per-column alignment via align. Position via at (top/end/or a unique text anchor, default end). A direct edit, not a tracked suggestion.',
      inputSchema: {
        path: tabPathArg,
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
        ...accountArg,
      },
    },
    async ({ path, rows, columns, data, columnWidths, headerShade, align, at, segment, page, createSegment, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await insertTable(clients, target.documentId, rows, columns, { at, tabId: target.tabId, data, columnWidths, headerShade, align, segment, page, createSegment }));
    },
  );

  server.registerTool(
    'list_suggestions',
    {
      title: 'List suggestions in a doc',
      description:
        'List pending suggestions (tracked changes) in a Google Doc as before→after diffs, in document order. Returns the doc `title` and, per suggestion, a human-readable `preview` — pass these verbatim as documentTitle/expectedChange to apply_suggestions. Note: the Docs API exposes no author or timestamp for suggestions.',
      inputSchema: { path: tabPathArg, ...segmentArg, ...accountArg },
    },
    async ({ path, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await listSuggestions(clients, target.documentId, target.tabId, { segment, page }));
    },
  );

  server.registerTool(
    'apply_suggestions',
    {
      title: 'Accept/reject one or more suggestions',
      description:
        'Resolve one or more pending suggestions (from list_suggestions) in ONE atomic update: accept keeps the proposed text, reject keeps the original. Pass one resolution to resolve a single suggestion, or several at once — required for suggestions that overlap or adjoin each other (a "cluster"), which cannot be resolved one at a time without corrupting neighbours. You MUST include every suggestion in any cluster you touch; a partially-resolved cluster is refused (status "incomplete"). documentTitle is checked against the live document first (status "wrong_doc" on mismatch, e.g. an id from a different, similarly-titled document). Copy each suggestion\'s `preview` from list_suggestions into its `expectedChange` (verified before applying). If the result includes a `conflicts` array, two suggestions genuinely conflicted (one inserts text inside another\'s deletion, both accepted) — it was auto-resolved by keeping the insertion; surface this to the user as NOT a clean merge.',
      inputSchema: {
        path: tabPathArg,
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
        ...accountArg,
      },
    },
    async ({ path, documentTitle, resolutions, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await applySuggestions(clients, target.documentId, documentTitle, resolutions, target.tabId, { segment, page }));
    },
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List comments on a doc',
      description:
        'List comments on a Google Doc (author display name, quoted text, body, resolved status, replies). Author email is not available via the Drive API.',
      inputSchema: { path: docPathArg, ...accountArg },
    },
    async ({ path, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
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
        path: docPathArg,
        content: z.string(),
        replyTo: z.string().optional().describe('a comment id (from list_comments) to reply to; omit to start a new top-level comment'),
        ...accountArg,
      },
    },
    async ({ path, content, replyTo, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
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
        path: docPathArg,
        commentId: z.string(),
        reopen: z.boolean().optional().describe('reopen instead of resolve'),
        expectQuote: z.string().optional().describe('snippet of the comment’s quoted text/body; verified before resolving'),
        ...accountArg,
      },
    },
    async ({ path, commentId, reopen, expectQuote, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
      return json(await resolveComment(clients, documentId, commentId, reopen ?? false, { expectQuote }));
    },
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create a new Google Doc',
      description:
        'Create a new Google Doc with a title and optional initial content (rendered as markdown). Optionally place it in a Drive folder (by folder URL or id); otherwise it goes to My Drive root. Style is CSS, in the spelling read_doc emits: a leading <style> block sets the named styles (p, h1–h6, .title, .subtitle), <p style="…"> / <hN style="…"> / <p class="title"> style a paragraph, <span style="…"> a run. Supported: text-align, line-height, margin-top/bottom/left/right, text-indent (pt; text-indent is relative to margin-left), and on spans/rules font-family, font-size, font-weight, font-style, text-decoration, color. Any other property fails the whole write before anything is sent, listing every offending line. For long documents, pass contentFile (a local path) instead of content so the server reads the body directly — retyping a long doc inline can silently drop or fuse text.',
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
        'Insert NEW markdown-rendered content at a structural position — no anchor text required. `at`: "end" (default, the end of the doc/tab) · "top" · a unique text snippet to insert immediately after. Use this where edit_doc can\u2019t reach: adding a paragraph after a table that ends the doc (a table\u2019s cells can\u2019t anchor an insert outside the table, and the trailing empty paragraph has no text to match), or appending to an empty doc. Use edit_doc instead when you are replacing or extending existing text. Content is full markdown (headings, lists, tables, images), same renderer as create_doc. Style is CSS, in the spelling read_doc emits: a leading <style> block sets the named styles (p, h1–h6, .title, .subtitle), <p style="…"> / <hN style="…"> / <p class="title"> style a paragraph, <span style="…"> a run. Supported: text-align, line-height, margin-top/bottom/left/right, text-indent (pt; text-indent is relative to margin-left), and on spans/rules font-family, font-size, font-weight, font-style, text-decoration, color. Any other property fails the whole write before anything is sent, listing every offending line. A direct edit, not a tracked suggestion.',
      inputSchema: {
        path: tabPathArg,
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
        ...accountArg,
      },
    },
    async ({ path, content, contentFile, at, segment, page, createSegment, baseDir, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      const src = await resolveContentSource({ content, contentFile, baseDir });
      if (src.content === undefined) throw new Error('Provide content or contentFile.');
      const result = await insertContent(clients, target.documentId, src.content, { at, tabId: target.tabId, baseDir: src.baseDir, segment, page, createSegment });
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
        path: docPathArg,
        dir: z.string().describe('absolute local folder to save the export into (created if missing)'),
        format: z.enum(EXPORT_FORMATS as [ExportFormat, ...ExportFormat[]]).optional().describe('default pdf'),
        filename: z.string().optional().describe('override the filename (default: the doc\u2019s title + extension)'),
        ...accountArg,
      },
    },
    async ({ path, dir, format, filename, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
      return json(await exportDoc(clients, documentId, dir, { format, filename }));
    },
  );



  server.registerTool(
    'overwrite_doc',
    {
      title: 'Overwrite a doc (guarded)',
      description:
        'Replace the entire body of a doc (or one tab) with markdown-rendered content; the new paragraphs start unstyled, so anything not in the markdown (including indents) is gone. Style is CSS, in the spelling read_doc emits: a leading <style> block sets the named styles (p, h1–h6, .title, .subtitle), <p style="…"> / <hN style="…"> / <p class="title"> style a paragraph, <span style="…"> a run. Supported: text-align, line-height, margin-top/bottom/left/right, text-indent (pt; text-indent is relative to margin-left), and on spans/rules font-family, font-size, font-weight, font-style, text-decoration, color. Any other property fails the whole write before anything is sent, listing every offending line. Refuses if comments/suggestions are present (would orphan them) unless force=true. Pass expectTitle (the doc’s title) — shown for confirmation and verified against the live doc before replacing. For long documents, pass contentFile instead of content so the server reads the body directly (retyping a long doc inline can silently drop text). A direct edit, not a tracked suggestion.',
      inputSchema: {
        path: tabPathArg,
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
        ...accountArg,
      },
    },
    async ({ path, content, contentFile, force, expectTitle, baseDir, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      const src = await resolveContentSource({ content, contentFile, baseDir });
      if (src.content === undefined) throw new Error('Provide content or contentFile.');
      return json(await overwriteDoc(clients, target.documentId, src.content, { force, tabId: target.tabId, baseDir: src.baseDir, expectTitle }));
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
        path: tabPathArg,
        ...cellArg,
        op: z.enum(['insert_row', 'delete_row', 'insert_column', 'delete_column']).describe('the structural edit to perform'),
        side: z
          .enum(['before', 'after'])
          .optional()
          .describe('for inserts: which side of `cell` to add on — rows after=below (default)/before=above; columns after=right (default)/before=left. Ignored for deletes.'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, cell, op, side, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      const after = side !== 'before'; // default 'after'
      const seg = { segment, page, tabId: target.tabId };
      switch (op) {
        case 'insert_row':
          return json(await insertRow(clients, target.documentId, cell, { below: after, ...seg }));
        case 'delete_row':
          return json(await deleteRow(clients, target.documentId, cell, seg));
        case 'insert_column':
          return json(await insertColumn(clients, target.documentId, cell, { right: after, ...seg }));
        case 'delete_column':
          return json(await deleteColumn(clients, target.documentId, cell, seg));
      }
    },
  );

  server.registerTool(
    'get_table_style',
    {
      title: 'Read an existing table’s style',
      description:
        'Read the style of the table containing the given cell text: per-column widths (points), how many header rows are pinned, and the matched cell’s padding, background and per-side borders. The read counterpart to set_table_style — use it to check a change took, to preserve a table’s look while rewriting it, or to copy one table’s layout onto another. Column widths come back in the exact shape set_table_style accepts. Table-wide facts (widths, header rows) are reported for the whole table; padding/background/borders are reported for the MATCHED cell, since cells in one table can differ and a table-wide answer would have to guess. Note Docs gives every cell 5pt padding by default, so padding is reported even on a table nobody has styled.',
      inputSchema: {
        path: tabPathArg,
        cell: z.string().describe('text of any cell in the target table (locates the table)'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, cell, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await getTableStyle(clients, target.documentId, cell, { segment, page, tabId: target.tabId }));
    },
  );

  server.registerTool(
    'set_table_style',
    {
      title: 'Style an existing table',
      description:
        'Edit style/layout of an existing table (located by any cell’s text): cell padding (pt), background color (hex), cell borders, column widths (pt), and pinned header rows. scope selects which cells padding/background/border hit — table (default), row, column, or cell (the row/column of the matched cell). Fixes e.g. thin left padding that clips the first letter of cells; border {width:0} makes a table borderless; headerRows repeats the top rows on every page. A direct edit, not a tracked suggestion.',
      inputSchema: {
        path: tabPathArg,
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
        ...accountArg,
      },
    },
    async ({ path, cell, scope, padding, backgroundColor, border, columnWidths, headerRows, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await setTableStyle(clients, target.documentId, cell, { scope, padding, backgroundColor, border, columnWidths, headerRows, segment, page, tabId: target.tabId }));
    },
  );




  server.registerTool(
    'drive',
    {
      title: 'Drive as a filesystem',
      description:
        'Navigate and reorganise Google Drive with shell commands: ls, find, mkdir, cp, mv. Arguments are positional and follow the usual shell forms. ' +
        'ls [path] — list a folder (default My Drive root). find <text> [-type d|f] — search everything by name, including files no path can reach. ' +
        'mkdir [-p] <path> — create a folder. cp <src> <dst> — duplicate a file (preserves headers/footers, image sizing and exact formatting, which a markdown round-trip cannot rebuild). ' +
        'mv <src> <dst> — move and/or rename, as on a filesystem: an existing folder as <dst> means "into it", anything else means "to that name". ' +
        'Paths start with / or ~ (My Drive); /shared/<drive name> is a shared drive, /shared-with-me the files others shared with you, and /lost+found the files you own that are in no folder at all. ' +
        'Anything not starting with / or ~ is read as a Drive id or URL, so ids from any other tool can be pasted straight in. ' +
        'Drive permits two files with the same name in one folder and folds case when matching, unlike any real filesystem — a path that matches more than one thing is refused with the candidates listed, never guessed. ' +
        'A doc is a folder of tabs: ls <doc> lists its tabs, ls <folder> shows each doc with its tab count, and a path continues into tabs (/Work/Contract/Part 2/Ch.4; a tab step may also be a tabId). ' +
        'mv on a tab renames it, nests it (dst is another tab, or a new name under one) or un-nests it (dst is the doc), and `index` reorders it; a tab cannot leave its doc, and cp of a tab is refused. ' +
        'Content is edited with edit_doc/overwrite_doc, not here; there is no rm, and nothing here deletes a tab.',
      inputSchema: {
        cmd: z.enum(['ls', 'find', 'mkdir', 'cp', 'mv']),
        args: z
          .array(z.string())
          .optional()
          .describe('positional arguments for cmd, e.g. ["/Work/Roof", "/Archive"] for mv'),
        expectName: z
          .string()
          .optional()
          .describe('mv only: the name the source is expected to have; the move is refused if it resolved to something else'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('mv of a tab only: its position among its new siblings, 0 first. Without it a tab keeps its place, or goes first when nested.'),
        acceptOwnershipTransfer: z
          .boolean()
          .optional()
          .describe('mv only: required to move into /shared/… , which hands ownership to that drive\'s organisation and cannot be undone'),
        ...accountArg,
      },
    },
    async ({ cmd, args, expectName, index, acceptOwnershipTransfer, account }) => {
      const clients = await clientsForAccount(account);
      return json(await driveShell(clients, cmd, args ?? [], { expectName, acceptOwnershipTransfer, index }));
    },
  );

  server.registerTool(
    'list_permissions',
    {
      title: 'List who a doc is shared with',
      description: 'List the permissions on a Google Doc (people, groups, domain, anyone-with-link) with their roles. Each entry carries a `subject` naming who it covers — an email, "<domain> (domain)", or "anyone with the link" — since a domain or link grant has no email. For those, `allowFileDiscovery: true` means the file also surfaces in that audience\'s search, not merely that it opens with the link. Note a doc created under a Workspace domain may already carry a domain grant before you share it.',
      inputSchema: { path: docPathArg, ...accountArg },
    },
    async ({ path, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
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
        path: docPathArg,
        email: z.string().optional().describe('person to share with; omit to set anyone-with-link access instead'),
        role: z.enum(['reader', 'commenter', 'writer', 'none']).optional().describe('access level; default writer. "none" (link only) disables link sharing.'),
        notify: z.boolean().optional().describe('when sharing with a person, send a notification email (default true)'),
        ...accountArg,
      },
    },
    async ({ path, email, role, notify, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
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
      description:
        'Revoke a grant on a Google Doc. Pass `email` for a person or a group. A grant with no email — a domain-wide grant, or anyone-with-link — has no email to pass, so address it by `permissionId` from list_permissions (run that first; it also tells you the role you are about to remove). Refuses to touch the owner. `expectRole` is REQUIRED — run list_permissions first and echo the role back; a permission change is recorded nowhere and cannot be restored from version history, so this is the only thing standing between a misaimed call and a silent, unrecoverable revocation. Note a doc created under a Workspace domain may carry a domain grant nobody explicitly added.',
      inputSchema: {
        path: docPathArg,
        email: z.string().optional().describe('person or group to revoke; omit when using permissionId'),
        permissionId: z
          .string()
          .optional()
          .describe('id from list_permissions — the only way to revoke a domain or anyone-with-link grant'),
        expectRole: z
          .string()
          .describe(
            "REQUIRED — the grant's current role as list_permissions reported it (reader/commenter/writer). Verified first: if it changed since you looked, nothing is removed. Revoking leaves no record anywhere, so this makes you look before you cut.",
          ),
        expectTitle: z.string().optional().describe('the doc’s title; verified before revoking so a wrong id is refused'),
        ...accountArg,
      },
    },
    async ({ path, email, permissionId, expectRole, expectTitle, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
      return json(await unshareDoc(clients, documentId, { email, permissionId, expectRole, expectTitle }));
    },
  );

  return server;
}
