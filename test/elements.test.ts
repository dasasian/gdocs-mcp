import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { docs_v1 } from 'googleapis';
import type { GoogleClients } from '../src/google/clients.js';
import { renderMarkdown, renderDatalists, project } from '../src/docs/transformer.js';
import { markdownToRequests, parseBlocks } from '../src/docs/write.js';
import { editDoc } from '../src/docs/edit.js';
import { writeDoc } from '../src/docs/document.js';
import { ElementRefusal } from '../src/docs/element-write.js';
import { dateProperties } from '../src/docs/element-write.js';
import { splitAtKeptElements } from '../src/docs/element-diff.js';
import { TokenTable, parseElement } from '../src/docs/elements.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): docs_v1.Schema$Document => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8')) as docs_v1.Schema$Document;

const elementsDoc = fixture('elements-doc.json');
const importedDoc = fixture('imported-elements-doc.json');
const ruleDoc = fixture('rule-doc.json');

const PERSON = '<a class="chip" href="mailto:damith@dasasian.com">Damith Chandrasekara</a>';
const DATE = '<time datetime="2026-11-15">Nov 15, 2026</time>';
const LINK = '<a class="chip" href="https://docs.google.com/document/d/16wB_36oR5g3qV7X2qGCjPL-bmx01EycDDCMTJLNy8Uw/edit">probe58 elements (trash me)</a>';
const DROPDOWN = '<input class="chip" list="kix.pzpzmipgftxw" value="Draft">';
const DATALIST = '<datalist id="kix.pzpzmipgftxw" title="Status"><option>Draft</option><option>Final</option></datalist>';
const LINE = `O[^1]wner: ${PERSON}, due ${DATE}. See ${LINK}. Status: ${DROPDOWN}end`;

const clientsFor = (doc: docs_v1.Schema$Document, batchUpdate = vi.fn().mockResolvedValue({ data: {} })): GoogleClients => ({
  auth: {} as GoogleClients['auth'],
  docs: { documents: { get: vi.fn().mockResolvedValue({ data: doc }), batchUpdate } } as unknown as GoogleClients['docs'],
  drive: {} as GoogleClients['drive'],
});

const sentBy = (batchUpdate: ReturnType<typeof vi.fn>, call = 0): docs_v1.Schema$Request[] => batchUpdate.mock.calls[call][0].requestBody.requests;
const kinds = (requests: docs_v1.Schema$Request[]): string[] => requests.map((r) => Object.keys(r)[0]);

describe('an edit keeps the elements it gives back and deletes the ones it drops (#58)', () => {
  it('keeps a person chip an edit quotes, and retypes only the words around it', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    const result = await editDoc(clientsFor(elementsDoc, batch), 'd', `wner: ${PERSON}, due`, `wner (task): ${PERSON}, due`);
    expect(result.status).toBe('ok');
    const requests = sentBy(batch);
    expect(requests.filter((r) => r.deleteContentRange).map((r) => r.deleteContentRange!.range)).toEqual([expect.objectContaining({ startIndex: 3, endIndex: 9 })]);
    expect(requests.find((r) => r.insertText)?.insertText).toMatchObject({ text: 'wner (task): ', location: { index: 3 } });
    expect(kinds(requests)).not.toContain('insertPerson');
  });

  it('keeps the footnote, the date and the link chip when an edit spans all of them', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    const old = `[^1]wner: ${PERSON}, due ${DATE}. See ${LINK}.`;
    await editDoc(clientsFor(elementsDoc, batch), 'd', old, old.replace('due', 'due on').replace('See', 'Read'));
    const deleted = sentBy(batch).flatMap((r) => (r.deleteContentRange ? [r.deleteContentRange.range!] : []));
    expect(deleted.every((range) => ![2, 9, 16, 23].some((at) => range.startIndex! <= at && at < range.endIndex!))).toBe(true);
    expect(kinds(sentBy(batch))).not.toContain('createFootnote');
  });

  it('deletes a chip the edit leaves out', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(elementsDoc, batch), 'd', `wner: ${PERSON}, due`, 'wner: nobody, due');
    expect(sentBy(batch).find((r) => r.deleteContentRange)?.deleteContentRange?.range).toMatchObject({ startIndex: 3, endIndex: 15 });
  });

  it('does not find a chip by the words inside it', async () => {
    const result = await editDoc(clientsFor(elementsDoc, vi.fn()), 'd', 'Damith Chandrasekara', 'Someone');
    expect(result.status).toBe('not_found');
  });

  it('makes a new person chip and sends nothing else for it', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(elementsDoc, batch), 'd', 'Status: ', `Status: <a class="chip" href="mailto:jane@example.com">Jane</a> `);
    const requests = sentBy(batch);
    expect(requests.find((r) => r.insertPerson)?.insertPerson).toMatchObject({ personProperties: { email: 'jane@example.com' } });
    expect(JSON.stringify(requests)).not.toContain('"name"');
  });

  it('makes a date from its text: the format comes from the shape', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(elementsDoc, batch), 'd', 'Status: ', 'Status: <time datetime="2026-12-01">1 Dec</time>');
    expect(sentBy(batch).find((r) => r.insertDate)).toBeDefined();
    expect(dateProperties({ kind: 'date', datetime: '2026-12-01', text: '2026-12-01' })).toMatchObject({ dateFormat: 'DATE_FORMAT_ISO8601', timeFormat: 'TIME_FORMAT_DISABLED', timestamp: '2026-12-01T12:00:00Z' });
    expect(dateProperties({ kind: 'date', datetime: '2026-12-01', text: 'Dec 1' })).toMatchObject({ dateFormat: 'DATE_FORMAT_MONTH_DAY_ABBREVIATED' });
    expect(dateProperties({ kind: 'date', datetime: '2026-12-01T14:30:00Z', text: 'Dec 1, 2026 2:30 PM UTC' })).toMatchObject({ dateFormat: 'DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED', timeFormat: 'TIME_FORMAT_HOUR_MINUTE_TIMEZONE', timeZoneId: 'UTC' });
    expect(dateProperties({ kind: 'date', datetime: '2026-12-01', lang: 'fr', text: 'x' })).toMatchObject({ locale: 'fr' });
  });

  it('makes a footnote and puts its note into the footnote after the batch', async () => {
    const batch = vi.fn().mockResolvedValueOnce({ data: { replies: [{}, {}, { createFootnote: { footnoteId: 'kix.new' } }] } }).mockResolvedValue({ data: {} });
    await editDoc(clientsFor(elementsDoc, batch), 'd', 'Status: ', 'Status: see below[^fees]\n\n[^fees]: Business days');
    expect(kinds(sentBy(batch)).filter((k) => k === 'createFootnote')).toHaveLength(1);
    const createIndex = kinds(sentBy(batch)).indexOf('createFootnote');
    batch.mockClear();
    expect(createIndex).toBeGreaterThanOrEqual(0);
  });

  it('sends a footnote note as insertText into the footnote segment', async () => {
    const calls: docs_v1.Schema$Request[][] = [];
    const batch = vi.fn(async (params: { requestBody: { requests: docs_v1.Schema$Request[] } }) => {
      calls.push(params.requestBody.requests);
      return { data: { replies: params.requestBody.requests.map((r) => (r.createFootnote ? { createFootnote: { footnoteId: 'kix.new' } } : {})) } };
    });
    await editDoc(clientsFor(elementsDoc, batch as never), 'd', 'Status: ', 'Status: see below[^fees]\n\n[^fees]: Business days');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([{ insertText: { location: { index: 1, segmentId: 'kix.new' }, text: 'Business days' } }]);
  });

  it('edits a footnote by quoting its [^1]: line', async () => {
    const withNote = JSON.parse(JSON.stringify(elementsDoc)) as docs_v1.Schema$Document;
    withNote.tabs![0].documentTab!.footnotes!['kix.xm1udxkuirip'].content = [{ startIndex: 0, endIndex: 15, paragraph: { elements: [{ startIndex: 0, endIndex: 15, textRun: { content: ' Business days\n' } }] } }];
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(withNote, batch), 'd', '[^1]: Business days', '[^1]: Calendar days');
    const requests = sentBy(batch);
    expect(requests.find((r) => r.deleteContentRange)?.deleteContentRange?.range).toMatchObject({ segmentId: 'kix.xm1udxkuirip', startIndex: 1, endIndex: 14 });
    expect(requests.find((r) => r.insertText)?.insertText).toMatchObject({ text: 'Calendar days', location: { segmentId: 'kix.xm1udxkuirip' } });
  });

  it('changes a dropdown choice by making the dropdown again and choosing in a second batch', async () => {
    const calls: docs_v1.Schema$Request[][] = [];
    const batch = vi.fn(async (params: { requestBody: { requests: docs_v1.Schema$Request[] } }) => {
      calls.push(params.requestBody.requests);
      return { data: { replies: params.requestBody.requests.map((r) => (r.insertDropdown ? { insertDropdown: { dropdown: { dropdownId: 'kix.dd' } } } : {})) } };
    });
    const get = vi.fn().mockResolvedValue({ data: { ...elementsDoc, revisionId: 'r1' } });
    const clients = { auth: {}, docs: { documents: { get, batchUpdate: batch } }, drive: {} } as unknown as GoogleClients;
    await editDoc(clients, 'd', `Status: ${DROPDOWN}end`, `Status: ${DROPDOWN.replace('Draft', 'Final')}end`);
    expect(kinds(calls[0])).toContain('insertDropdown');
    expect(calls[0].find((r) => r.insertDropdown)?.insertDropdown).toMatchObject({ dropdownDefinitionId: 'kix.pzpzmipgftxw' });
    expect(calls[1]).toEqual([{ updateDropdownProperties: { dropdownId: 'kix.dd', dropdownProperties: { selectedOptionId: 'dropdownItem.31u6huw5pi26' }, fields: 'selectedOptionId' } }]);
  });

  it('keeps a dropdown an edit quotes beside it', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(elementsDoc, batch), 'd', `Status: ${DROPDOWN}end`, `State: ${DROPDOWN}end`);
    const requests = sentBy(batch);
    expect(kinds(requests)).not.toContain('insertDropdown');
    expect(requests.find((r) => r.deleteContentRange)?.deleteContentRange?.range).toMatchObject({ startIndex: 26, endIndex: 34 });
  });

  it('refuses a chip given other words, naming what to change', async () => {
    const batch = vi.fn();
    await expect(editDoc(clientsFor(elementsDoc, batch), 'd', `Owner: ${PERSON}`.slice(7), PERSON.replace('Damith Chandrasekara', 'Damith'))).rejects.toThrow(/email in href/);
    await expect(editDoc(clientsFor(elementsDoc, batch), 'd', LINK, LINK.replace('(trash me)', 'renamed'))).rejects.toThrow(/drive mv/);
    expect(batch).not.toHaveBeenCalled();
  });

  it('refuses a new link chip to YouTube before sending, and says what to write', async () => {
    const batch = vi.fn();
    await expect(editDoc(clientsFor(elementsDoc, batch), 'd', 'Status: ', 'Status: <a class="chip" href="https://www.youtube.com/watch?v=x">Launch</a>')).rejects.toThrow(/\[Launch\]\(https:\/\/www.youtube.com/);
    expect(batch).not.toHaveBeenCalled();
  });

  it('refuses a new equation, page-number field and column break, telling the agent to ask the user', async () => {
    const batch = vi.fn();
    for (const token of ['<span class="equation" title="x"></span>', '<span class="page-number" title="x"></span>', '<span style="break-after:column"></span>']) {
      await expect(editDoc(clientsFor(elementsDoc, batch), 'd', 'Status: ', `Status: ${token}`)).rejects.toThrow(ElementRefusal);
    }
    expect(batch).not.toHaveBeenCalled();
  });

  it('keeps an equation and a column break an edit gives back', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    const equation = '<span class="equation" title="Google\'s API does not expose this equation; edit it in Google Docs"></span>';
    await editDoc(clientsFor(importedDoc, batch), 'd', `Energy is ${equation} in physics.`, `Energy is ${equation} in physics today.`);
    const requests = sentBy(batch);
    const deleted = requests.flatMap((r) => (r.deleteContentRange ? [r.deleteContentRange.range!] : []));
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every((range) => !(range.startIndex! <= 25 && 25 < range.endIndex!))).toBe(true);
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe(' in physics today.');
  });

  it('writes --- as an empty paragraph with a bottom border', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(ruleDoc, batch), 'd', 'Above rule', 'Above rule\n\n---');
    const requests = sentBy(batch);
    expect(requests.find((r) => r.updateParagraphStyle?.paragraphStyle?.borderBottom)?.updateParagraphStyle?.fields).toContain('borderBottom');
  });

  it('writes a --- line right under the anchor as a rule, not as the words ---', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(ruleDoc, batch), 'd', 'Above rule', 'Above rule\n---');
    const requests = sentBy(batch);
    expect(JSON.stringify(requests)).not.toContain('"text":"---');
    expect(requests.some((r) => r.updateParagraphStyle?.paragraphStyle?.borderBottom)).toBe(true);
  });

  it('keeps a real horizontal rule an edit gives back', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(ruleDoc, batch), 'd', 'Above rule\n\n---\n\nBelow rule', 'Above line\n\n---\n\nBelow line');
    const deleted = batch.mock.calls.flatMap((call) => (call[0].requestBody.requests as docs_v1.Schema$Request[]).flatMap((r) => (r.deleteContentRange ? [r.deleteContentRange.range!] : [])));
    expect(deleted).toHaveLength(2);
    expect(deleted.every((range) => !(range.startIndex! <= 12 && 12 < range.endIndex!))).toBe(true);
  });

  it('refuses, before sending, a suggestion that needs a dropdown request Docs cannot suggest', async () => {
    const batch = vi.fn();
    await expect(editDoc(clientsFor(elementsDoc, batch), 'd', `Status: ${DROPDOWN}end`, `Status: ${DROPDOWN.replace('Draft', 'Final')}end`, { suggest: true })).rejects.toThrow(/cannot suggest/);
    expect(batch).not.toHaveBeenCalled();
  });

  it('changes a dropdown list by quoting its <datalist> line', async () => {
    const batch = vi.fn().mockResolvedValue({ data: {} });
    await editDoc(clientsFor(elementsDoc, batch), 'd', DATALIST, DATALIST.replace('title="Status"', 'title="State"').replace('</datalist>', '<option>Done</option></datalist>'));
    const request = sentBy(batch)[0].updateDropdownDefinitionProperties as unknown as { dropdownDefinitionId: string; dropdownDefinitionProperties: { title: string; options: { optionId?: string; displayValue: string }[] } };
    expect(request.dropdownDefinitionId).toBe('kix.pzpzmipgftxw');
    expect(request.dropdownDefinitionProperties.options).toEqual([
      { optionId: 'dropdownItem.ep29viif2yno', displayValue: 'Draft' },
      { optionId: 'dropdownItem.31u6huw5pi26', displayValue: 'Final' },
      { displayValue: 'Done' },
    ]);
  });
});

describe('write_doc writes the elements and refuses the ones it cannot make (#58)', () => {
  it('writes each element in a paragraph in the order the read gives them', () => {
    const { requests } = markdownToRequests(`${LINE}\n\n${DATALIST}\n\n[^1]: Business days`, 1);
    const kindsSent = kinds(requests);
    expect(kindsSent.filter((k) => ['createFootnote', 'insertPerson', 'insertDate', 'insertRichLink', 'insertDropdown'].includes(k))).toEqual(['createFootnote', 'insertPerson', 'insertDate', 'insertRichLink', 'insertDropdown']);
    const indexes = requests.flatMap((r) => Object.values(r).map((v) => (v as { location?: { index: number } }).location?.index)).filter((i): i is number => i !== undefined);
    expect(requests.find((r) => r.insertText)?.insertText?.text).toBe('Owner: , due . See . Status: end\n');
    expect(requests.find((r) => r.createFootnote)?.createFootnote?.location?.index).toBe(2);
    expect(requests.find((r) => r.insertPerson)?.insertPerson?.location?.index).toBe(9);
    expect(requests.find((r) => r.insertDate)?.insertDate?.location?.index).toBe(16);
    expect(indexes.length).toBeGreaterThan(5);
  });

  it('takes the elements into account when it places a page break after them', () => {
    const { requests } = markdownToRequests(`A [^1]\n\n<div style="page-break-after:always"></div>\n\nB`, 1);
    expect(requests.find((r) => r.insertPageBreak)?.insertPageBreak?.location?.index).toBe(5);
  });

  it('writes --- as an empty bordered paragraph', () => {
    const { requests, text } = markdownToRequests('A\n\n---\n\nB', 1);
    expect(text).toBe('A\n\nB\n');
    expect(requests.find((r) => r.updateParagraphStyle?.paragraphStyle?.borderBottom)?.updateParagraphStyle?.range).toMatchObject({ startIndex: 3, endIndex: 4 });
  });

  it('refuses a new equation, a column break and a YouTube link chip without sending a request', async () => {
    const batch = vi.fn();
    const clients = clientsFor({ body: { content: [] } }, batch);
    for (const content of ['x <span class="equation" title="t"></span>', 'x <span style="break-after:column"></span>', 'x <a class="chip" href="https://www.youtube.com/watch?v=1">V</a>']) {
      await expect(writeDoc(clients, '/Work/Doc', content)).rejects.toThrow(ElementRefusal);
    }
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('the pieces of an edit around the elements it keeps (#58)', () => {
  it('splits at the elements both strings hold, and at none when they differ', () => {
    const table = new TokenTable();
    const [a, b] = [table.charFor('<a/>'), table.charFor('<b/>')];
    expect(splitAtKeptElements(`x${a}y`, `x${a}y`, `p${a}q`, table).map((g) => [g.plainFrom, g.plainTo, g.written])).toEqual([[0, 1, 'p'], [2, 3, 'q']]);
    expect(splitAtKeptElements(`x${a}y`, `x${a}y`, `p${b}q`, table)).toHaveLength(1);
  });
});

describe('project() gives each element one character (#58)', () => {
  it('maps an element to the one index it takes', () => {
    const { text, map, tokens } = project(elementsDoc);
    const person = [...text].findIndex((char) => tokens.tokenOf(char)?.startsWith('<a class="chip" href="mailto'));
    expect(map[person]).toBe(9);
    expect(parseElement(tokens.tokenOf(text[person])!)).toMatchObject({ kind: 'person', email: 'damith@dasasian.com' });
  });
});
