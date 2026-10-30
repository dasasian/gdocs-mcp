import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clientsForAccount } from './google/clients.js';
import { resolveTab, resolveDocument } from './drive/paths.js';
import { listAccounts, findProjectConfig, findProjectConfigPath, setProjectConfig } from './auth/accounts.js';
import { listSuggestions, applySuggestions } from './docs/suggestions.js';
import { listComments, replyToComment, resolveComment } from './docs/comments.js';
import { addComment } from './docs/add-comment.js';
import { readDoc } from './docs/read.js';
import { editDoc } from './docs/edit.js';
import { writeDoc, resolveContentSource } from './docs/document.js';
import { setPageSetup, getPageSetup } from './docs/page.js';
import { listPermissions, shareDoc, unshareDoc, setLinkAccess } from './drive/sharing.js';
import { driveShell } from './drive/shell.js';
import { downloadImages } from './drive/images.js';
import { exportDoc, EXPORT_FORMATS, type ExportFormat } from './drive/export.js';

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const DIRECT_EDIT_NOTE = 'Direct edit — applied as live text, not a tracked suggestion (the Docs API cannot create suggestions).';

const accountArg = {
  account: z
    .string()
    .optional()
    .describe('Google account email to use. Defaults to GDOCS_DEFAULT_ACCOUNT, or the sole account.'),
};

const tabPathArg = z
  .string()
  .describe('The doc or tab: a Drive id or URL, /folder/doc, or /folder/doc/tab (nested: /folder/doc/tab/child). A doc with one tab needs no tab step; a doc with several is refused until one is named, and the refusal lists every tab path.');

const writePathArg = z
  .string()
  .describe('The doc or tab to write: /folder/doc, /folder/doc/tab, /folder/doc/tab/child, or a doc id or URL followed by tab steps. A path that does not exist yet is created (only its last step may be new).');

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

export interface ServerOptions {
  defaultFolderPath?: string;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'gdocs-mcp', version: '0.7.0' });

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
        'Write this project’s defaults to a .gdocs-mcp.json in the current working directory (or update an existing one up the tree). Set a default account and/or a default folder (URL or id). The folder is where write_doc is told new docs go: a new doc given as a bare name or at the top of My Drive is refused once, naming the folder and the full path to call. It is read when the server starts, so write_doc\u2019s description shows a change after a restart; the refusal reads it fresh. To set a folder by name, find it first with drive({ cmd: \'find\' }) and pass its id.',
      inputSchema: {
        account: z.string().optional().describe('default Google account email (must be authorized)'),
        folder: z.string().optional().describe('default Drive folder (URL or id): where write_doc says a bare-named new doc will go'),
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
        'Read a Google Doc as markdown + inline HTML. The read opens with a <style> block — one CSS rule per named style (p = Normal text, h1–h6, .title, .subtitle), in pt — and a paragraph or run shows style="…" only where it differs from its rule (text-align, line-height, margin-top/bottom/left/right, text-indent; a hanging indent is margin-left:36pt with a negative text-indent). Title and Subtitle paragraphs read as <p class="title">. A page break reads as <div style="page-break-after:always"></div> on its own line, where the break is. List items show no indent: their nesting owns it. mode: clean (committed text, default) · tracked (suggestions shown as <ins>/<del>) · accepted · rejected. segment picks the content tree: body (default), header, footer, or all (body plus every header/footer, each labelled). Text that would otherwise read as markup is marked as literal: a paragraph wrapped in <p>…</p> ("4. Term" is a paragraph, not a list) or a backslash before a character (5 \\* 3), and \\\\ is a real backslash — write them back as read, and the document keeps only the words. A body read always reports which headers/footers exist and what they hold, since their content — a letterhead logo, a page number — is NOT part of the body and would otherwise be invisible.',
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
        'Replace an exact unique snippet of text in a Google Doc (like a local file Edit). old_string is matched markup-tolerantly; ambiguous matches return surrounding context to disambiguate; a table is matched as its rows, in the form read_doc shows it (a pipe table, or the HTML <table> of a styled one). INSERTING IS AN EDIT: quote the text to add after (or before), write it back in new_string, and add the new content to it. Text from old_string that comes back unchanged is kept as it is, with its style, comments and suggestions, so old_string `| Total | $4,200 |` and new_string `| Total | $4,200 |\\n\\nPayment due within 30 days.` leaves the table alone and adds the paragraph after it; a match that ends in a table puts the new blocks after the whole table. An anchor in the middle of a paragraph splits the paragraph there. A new block carries its own style, not its anchor’s: a paragraph added after a heading, a Title or a list item is Normal text with no bullet unless the markdown says otherwise, while text added inside an existing paragraph keeps that paragraph’s style. An empty doc, tab, header or footer has nothing to anchor on: use write_doc. new_string is the same markdown and inline HTML write_doc takes: headings, lists, tables, images (`<img src width height>` or `![alt](src)`; a centered one is `<p style="text-align:center"><img …></p>`, local files resolve against baseDir), page breaks, and inline constructs (**bold**, *italic*, `code`, [text](url), `<u>`, `<span style="color:…;font-size:…pt">`, `<p style="…">`, `<p class="title">`, and a page break as a line of its own: `<div style="page-break-after:always"></div>`, so new_string `Title page\\n<div style="page-break-after:always"></div>` puts what follows on a new page; old_string can span a break) — the same spelling read_doc emits, so a read can be edited and written back. STYLE IS CSS, and this is the only way to change it. Restyle text you are not otherwise changing by giving the same words with different markup: old_string `<p>4. Term`, new_string `<p style="margin-left:36pt; text-indent:-18pt">4. Term` sends only style requests — no delete, no insert, so a long paragraph is never retyped and its words cannot change; markup missing from new_string is cleared (drop the wrapper to remove an indent). To restyle a whole named style, edit its rule in read_doc’s <style> block: old_string `p { font-family: Arial; font-size: 11pt`, new_string `p { font-family: Arial; font-size: 12pt` becomes one updateNamedStyle and every paragraph that does not override it follows. An unsupported property (border, float, a px length, a typo) fails the edit before any request is sent, listing every offending line and the supported set. TABLE STYLE is CSS on the table’s HTML, changed the same way: read_doc shows a table with any cell or row style, wide or short columns, pinned rows or merged cells as <table style> with <col style="width:120pt">, <tr style="height:40pt"> (a minimum), <thead> (exactly the pinned rows), <td style> (border, padding, background, vertical-align) and colspan or rowspan, one row per line, while a table with nothing but Docs defaults stays a pipe table. old_string `<td>Client</td>`, new_string `<td style="background:#eeeeee">Client</td>` sends only the style request, and every cell whose words come back unchanged is kept, not retyped; styling a pipe table is giving the whole table back as HTML with the same words. A table edit that changes rows, columns or merges is a comparison: quote the rows around the change, write the rows you want, and only the difference is sent, an insertTableRow, deleteTableRow, insertTableColumn, deleteTableColumn, mergeTableCells or unmergeTableCells plus the text of the cells that changed, so cells you did not change keep their comments and style. A new row or column copies the style of the row above (the row below when the row above is a header row) or the column to its left (to its right for a new first column), and a style you write on it wins; links are not copied. A row or column you move is a delete and an insert: when comments quote its text the first call is refused with a confirmLoss string, so ask the user and pass it back as confirmLoss after their yes. A change that cannot be read cleanly (a row that could be an edit of either of two new rows, a table that shares no row with the old one, a column added without its <col> line) is refused and says what to quote; a table is never rewritten whole. NOTE: this is a direct edit — the change is applied as live text, not a tracked suggestion (the Docs API cannot create suggestions). If the doc has pending suggestions from other reviewers, flag to the user that your edit will sit alongside them as an accepted change.',
      inputSchema: {
        path: tabPathArg,
        old_string: z.string().describe('exact text to replace (quote a unique slice from read_doc)'),
        new_string: z.string().optional().describe('replacement markdown (or use contentFile)'),
        contentFile: z
          .string()
          .optional()
          .describe('path to a local markdown/text file to use as new_string, read directly by the server — preferred for long text. Absolute, or relative to baseDir. Mutually exclusive with new_string.'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths and contentFile against'),
        replace_all: z.boolean().optional().describe('replace every occurrence (default false)'),
        confirmLoss: z
          .string()
          .optional()
          .describe('the confirmLoss string from the refusal of a table edit that moves a row or column whose text comments quote, passed back exactly, after the user has agreed that those comments are lost. Never needed otherwise.'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, old_string, new_string, contentFile, baseDir, replace_all, confirmLoss, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      const src = await resolveContentSource({ content: new_string, contentFile, baseDir });
      if (src.content === undefined) throw new Error('Provide new_string or contentFile.');
      const result = await editDoc(clients, target.documentId, old_string, src.content, { replaceAll: replace_all, tabId: target.tabId, segment, page, baseDir: src.baseDir, confirmLoss });
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
    'list_suggestions',
    {
      title: 'List suggestions in a doc',
      description:
        'List the pending suggestions (tracked changes) in a Google Doc, in document order. Each has an `id`, a `summary` (Docs’ own words for it, as in the Docs sidebar, e.g. Replace: “30” with “45”), a `context` (the change in its sentence, [deleted→inserted], so two suggestions with the same summary can be told apart), and its author and time. Returns the doc `title`. Pass the title as expectTitle and each context as expectContext to apply_suggestions. segment: "header" or "footer" lists that one’s suggestions.',
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
        'Accept or reject pending suggestions (from list_suggestions) in one update. Each one is resolved on its own, exactly as clicking the check or the cross in Docs: accept keeps the proposed change, reject restores the original. Two suggestions that touch each other (by different people) are decided one at a time, and the text comes out as Docs makes it; to decide them together, pass both. A style-only suggestion resolves like any other. expectTitle is checked against the live document first (status "wrong_doc" on a mismatch, e.g. an id from a different, similarly-titled document), and each expectContext is checked against the live suggestion (status "error" on a mismatch or an id that is gone); nothing is changed unless all match. Pass the `title` and each suggestion’s `context` from list_suggestions, verbatim.',
      inputSchema: {
        path: tabPathArg,
        expectTitle: z.string().describe('the document’s title, from list_suggestions; checked before anything is changed'),
        resolutions: z
          .array(
            z.object({
              suggestionId: z.string(),
              decision: z.enum(['accept', 'reject']),
              expectContext: z.string().describe('the suggestion’s `context` from list_suggestions, verbatim'),
            }),
          )
          .describe('one entry per suggestion to resolve'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, expectTitle, resolutions, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const target = await resolveTab(clients, path);
      return json(await applySuggestions(clients, target.documentId, expectTitle, resolutions, target.tabId, { segment, page }));
    },
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List comments on a doc',
      description:
        'List the comments on a Google Doc, each with the text it is on (`quotedText`), the sentence around it (`context`, the text in ⟦⟧), its author (a display name, never an email) and time, whether it is open or resolved, its body and its replies. A comment with a `range` is on that part of the doc, in the body or in a header or footer, and moves with its text; a comment with none was made in Drive and has only its quoted text. Pass a comment’s `id` as replyTo to add_comment, and its `quotedText` as expectQuotedText to resolve_comment.',
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
        'Comment on text in a Google Doc: `quotedText` is the text the comment sits on, found the way edit_doc finds old_string (markup-tolerant; text that matches more than once is refused with the context of each match, so quote more of it). The comment stays on that text as it moves. Docs has no comment on the whole doc, so quotedText is required; put overall feedback on the title, or on its first words. The tab comes from path, and segment: "header" or "footer" comments in the page header or footer. To reply to an existing comment instead, pass replyTo (a comment id from list_comments) and no quotedText; the reply goes to the doc named by path, whatever its tab.',
      inputSchema: {
        path: tabPathArg,
        content: z.string().describe('the comment, or the reply'),
        quotedText: z.string().optional().describe('the text to comment on; required unless replyTo is given'),
        replyTo: z.string().optional().describe('a comment id (from list_comments) to reply to; omit to start a new comment'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, content, quotedText, replyTo, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      if (replyTo !== undefined) {
        const { documentId } = await resolveDocument(clients, path);
        return json(await replyToComment(clients, documentId, replyTo, content));
      }
      if (quotedText === undefined) throw new Error('quotedText is required to start a comment: Docs has no comment without a range. Quote the text the comment is about, or pass replyTo to reply.');
      const target = await resolveTab(clients, path);
      return json(await addComment(clients, target.documentId, content, quotedText, { tabId: target.tabId, segment, page }));
    },
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve or reopen a comment',
      description:
        'Resolve (or reopen) a comment thread by comment id. expectQuotedText is REQUIRED: the `quotedText` list_comments gave for that comment, exactly. It is checked against the live comment first, so a stale or wrong id is refused instead of resolving the wrong thread.',
      inputSchema: {
        path: docPathArg,
        commentId: z.string(),
        expectQuotedText: z.string().describe('the comment’s quotedText from list_comments; verified before the comment is changed'),
        reopen: z.boolean().optional().describe('reopen instead of resolve'),
        ...accountArg,
      },
    },
    async ({ path, commentId, expectQuotedText, reopen, account }) => {
      const clients = await clientsForAccount(account);
      const { documentId } = await resolveDocument(clients, path);
      return json(await resolveComment(clients, documentId, commentId, { expectQuotedText, reopen }));
    },
  );

  server.registerTool(
    'export_doc',
    {
      title: 'Export a doc to a file',
      description:
        'Export a Google Doc to a real file on disk \u2014 pdf (default), docx, odt, rtf, txt, html, epub, or md. Google renders it server-side (File > Download in the UI), so page setup, pagination and layout match the editor. A doc path exports every tab; a tab path (/folder/doc/tab) exports only that tab, through an endpoint Google does not document and rate-limits — if it fails the call is refused and says so, it never falls back to the whole doc. Returns the local path and byte size. Note: Drive refuses to export files larger than 10 MB.',
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
      const { documentId, tab } = await resolveDocument(clients, path);
      return json(await exportDoc(clients, documentId, dir, { format, filename, tab }));
    },
  );



  const rootCreates = new Set<string>();

  const writeDocTool = server.registerTool(
    'write_doc',
    {
      title: 'Write a doc or a tab',
      description:
        'Write markdown-rendered content to a path, like the local Write tool. A path that names nothing is CREATED and never asks, but only an absolute path (or a Drive id or URL start) creates: a bare name like Contract is refused with the full path to call. When the project has a default folder for new docs, a new doc at the top of My Drive (/Contract) is refused once too, with the default folder\u2019s full path to call, so the user is told where it goes first; the same call repeated goes through: /Work/Contract creates a doc in the folder /Work, /Work/Contract/Notes a tab in that doc, /Work/Contract/Part 2/Ch.4 a child tab under Part 2 (only the last step may be new; make the folder with drive mkdir first). A path that names something is REPLACED, and the first call is refused with a loss summary — the paragraphs of text and everything a read cannot carry that the replace would take with it: comments, suggestions, tab stops, person/date/link chips, links to bookmarks, section breaks, column breaks — plus a confirmLoss string. Ask the user before anything else — show them what would be lost and wait for a yes; never pass confirmLoss on your own. Only after their yes, call again with the same content and confirmLoss set to that string exactly. If the doc changed in between, the string no longer matches and the call is refused again with a fresh summary. A doc with several tabs needs a tab step (the refusal lists them); a doc with one tab means that tab. Nothing to lose, nothing to ask: an empty doc, tab, header or footer is written without the refusal. segment: "header" or "footer" writes the page header or footer of an existing doc instead of its body: a missing default one is created and written, an existing one with content is replaced after the same confirmLoss round-trip, and a missing first-page or even-page one (page: "first" / "even") is refused with the instruction to turn on Different first page in Docs. Replacing keeps the doc’s title, sharing and other tabs but the new paragraphs start unstyled, so anything not in the markdown (including indents) is gone; prefer edit_doc to change a document, which keeps everything its anchor does not cover. Style is CSS, in the spelling read_doc emits: a leading <style> block sets the named styles (p, h1–h6, .title, .subtitle), <p style="…"> / <hN style="…"> / <p class="title"> style a paragraph, <span style="…"> a run. Supported: text-align, line-height, margin-top/bottom/left/right, text-indent (pt; text-indent is relative to margin-left), and on spans/rules font-family, font-size, font-weight, font-style, text-decoration, color. Any other property fails the whole write before anything is sent, listing every offending line. A page break is <div style="page-break-after:always"></div> on a line of its own (also accepted: <hr style="page-break-before:always">, break-before: page, break-after: page); any other <div> or <hr> is refused. For long documents, pass contentFile instead of content so the server reads the body directly (retyping a long doc inline can silently drop text). Returns images ({src, objectId}) for pushed images. A direct edit, not a tracked suggestion.',
      inputSchema: {
        path: writePathArg,
        content: z.string().optional().describe('markdown content (or use contentFile)'),
        contentFile: z
          .string()
          .optional()
          .describe(
            'path to a local markdown/text file to use as the body, read directly by the server — preferred for long documents so the body is passed through mechanically rather than retyped inline (which can silently drop text). Absolute, or relative to baseDir. Mutually exclusive with content.',
          ),
        confirmLoss: z
          .string()
          .optional()
          .describe('the confirmLoss string from the refusal, passed back exactly, after the user has agreed to what it lists. Never needed when creating.'),
        baseDir: z.string().optional().describe('absolute dir to resolve relative local image paths against (e.g. the markdown file’s folder)'),
        ...segmentArg,
        ...accountArg,
      },
    },
    async ({ path, content, contentFile, confirmLoss, baseDir, segment, page, account }) => {
      const clients = await clientsForAccount(account);
      const src = await resolveContentSource({ content, contentFile, baseDir });
      if (src.content === undefined) throw new Error('Provide content or contentFile.');
      return json(await writeDoc(clients, path, src.content, { confirmLoss, baseDir: src.baseDir, defaultFolder: findProjectConfig().folder, rootCreates, segment, page }));
    },
  );

  if (options.defaultFolderPath) {
    writeDocTool.update({ description: `${writeDocTool.description} This project's default folder for new docs is ${options.defaultFolderPath}.` });
  }

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
        'Content is edited with edit_doc and written with write_doc, not here; there is no rm, and nothing here deletes a tab. A tab is made by write_doc to a new path.',
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
