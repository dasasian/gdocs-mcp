import { PAGE_BREAK_LINE } from './markdown-spec.js';

const BREAK_VALUE_BY_PROPERTY: Record<string, string> = {
  'page-break-after': 'always',
  'page-break-before': 'always',
  'break-after': 'page',
  'break-before': 'page',
};

const DIV_LINE_RE = /^<div((?:\s[^>]*)?)>\s*<\/div\s*>$/i;
const HR_LINE_RE = /^<hr((?:\s[^>]*?)?)\s*\/?>$/i;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;

const ACCEPTED = `${PAGE_BREAK_LINE}, <hr style="page-break-before:always">, break-before: page or break-after: page`;

export interface PageBreakLine {
  /** empty when the line is a page break the writer can send. */
  issues: string[];
}

type DeclarationKind = 'break' | 'hidden' | 'other';

function kindOf(declaration: string): DeclarationKind {
  const [property, ...rest] = declaration.split(':');
  const name = property.trim().toLowerCase();
  const value = rest.join(':').trim().toLowerCase();
  if (BREAK_VALUE_BY_PROPERTY[name] === value) return 'break';
  return name === 'display' && value === 'none' ? 'hidden' : 'other';
}

function issuesOfAttributes(tag: string, attrs: string): string[] {
  const found = [...attrs.matchAll(ATTR_RE)];
  const unsupportedAttributes = found.filter(([, name]) => name.toLowerCase() !== 'style').map(([, name]) => `<${tag} ${name}=…> is not supported on a page break`);
  const style = found.find(([, name]) => name.toLowerCase() === 'style')?.[2];
  if (style === undefined) return [...unsupportedAttributes, `<${tag}> with no style is not a page break; write ${ACCEPTED}`];
  const declarations = style.split(';').map((d) => d.trim()).filter(Boolean);
  const unsupportedStyles = declarations.filter((d) => kindOf(d) === 'other').map((d) => `<${tag} style> "${d}" is not a page break property`);
  const holdsBreak = declarations.some((d) => kindOf(d) === 'break');
  return [...unsupportedAttributes, ...unsupportedStyles, ...(holdsBreak || unsupportedStyles.length ? [] : [`<${tag} style> holds no page break; write ${ACCEPTED}`])];
}

/**
 * Reads one line as a page break. Undefined when the line is not a whole
 * `<div …></div>` or `<hr …>`; otherwise `issues` names what is wrong with it,
 * so a div that is not a page break is refused rather than written as text.
 */
export function parsePageBreakLine(line: string): PageBreakLine | undefined {
  const trimmed = line.trim();
  const div = DIV_LINE_RE.exec(trimmed);
  if (div) return { issues: issuesOfAttributes('div', div[1]) };
  const hr = HR_LINE_RE.exec(trimmed);
  if (hr) return { issues: issuesOfAttributes('hr', hr[1]) };
  return undefined;
}
