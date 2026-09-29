import type { docs_v1 } from 'googleapis';
import { namedStylesOf } from './structure.js';
import { rgbToHex } from './color.js';
import { NAMED_STYLE_BY_SELECTOR, type RuleSelector, type CssAlign } from './markdown-spec.js';
import {
  declarationsFor,
  ruleBody,
  parseRuleCss,
  paragraphCssChange,
  diffCss,
  paragraphStyleUpdate,
  textStyleUpdate,
  withoutUndefined,
  type ParagraphCss,
  type TextCss,
} from './css.js';

export interface StyleRule {
  selector: RuleSelector;
  paragraph: ParagraphCss;
  text: TextCss;
}

const SELECTORS = Object.keys(NAMED_STYLE_BY_SELECTOR) as RuleSelector[];

const CSS_BY_DOCS_ALIGNMENT: Record<string, CssAlign> = {
  START: 'left',
  CENTER: 'center',
  END: 'right',
  JUSTIFIED: 'justify',
};

const magnitude = (d: docs_v1.Schema$Dimension | undefined): number | undefined => d?.magnitude ?? (d ? 0 : undefined);
const nonZero = (n: number): number | undefined => (n === 0 ? undefined : n);

function ruleOf(named: docs_v1.Schema$NamedStyle, selector: RuleSelector): StyleRule {
  const ps = named.paragraphStyle ?? {};
  const ts = named.textStyle ?? {};
  const start = magnitude(ps.indentStart) ?? 0;
  const first = magnitude(ps.indentFirstLine) ?? 0;
  const rgb = ts.foregroundColor?.color?.rgbColor;
  const paragraph: ParagraphCss = {
    align: ps.alignment ? CSS_BY_DOCS_ALIGNMENT[ps.alignment] : undefined,
    lineHeight: ps.lineSpacing ? ps.lineSpacing / 100 : undefined,
    marginTop: magnitude(ps.spaceAbove),
    marginBottom: magnitude(ps.spaceBelow),
    marginLeft: nonZero(start),
    marginRight: nonZero(magnitude(ps.indentEnd) ?? 0),
    textIndent: nonZero(first - start),
  };
  const text: TextCss = {
    fontFamily: ts.weightedFontFamily?.fontFamily ?? undefined,
    fontSize: ts.fontSize?.magnitude ?? undefined,
    color: rgb ? rgbToHex(rgb) : undefined,
    bold: ts.bold ? true : undefined,
    italic: ts.italic ? true : undefined,
    underline: ts.underline ? true : undefined,
    strikethrough: ts.strikethrough ? true : undefined,
  };
  return { selector, paragraph: withoutUndefined(paragraph), text: withoutUndefined(text) };
}

export function styleRulesOf(doc: docs_v1.Schema$Document, tabId?: string): StyleRule[] {
  const styles = namedStylesOf(doc, tabId);
  const rules: StyleRule[] = [];
  for (const selector of SELECTORS) {
    const named = styles.find((s) => s.namedStyleType === NAMED_STYLE_BY_SELECTOR[selector]);
    if (!named) continue;
    const rule = ruleOf(named, selector);
    if (declarationsFor(rule.paragraph, rule.text).length) rules.push(rule);
  }
  return rules;
}

export function renderStyleBlock(rules: StyleRule[]): string {
  if (!rules.length) return '';
  const lines = rules.map((r) => `${r.selector} { ${ruleBody(declarationsFor(r.paragraph, r.text))} }`);
  return ['<style>', ...lines, '</style>'].join('\n');
}

const RULE_RE = /([^{}]*)\{([^{}]*)\}/g;
const STYLE_BLOCK_RE = /<style>([\s\S]*?)<\/style>/i;

/** `firstLine` is the line of the opening <style> in the caller's text, so issues can name real lines. */
export function parseStyleBlock(markup: string, firstLine = 1): { rules: StyleRule[]; issues: string[] } {
  const block = STYLE_BLOCK_RE.exec(markup);
  if (!block) return { rules: [], issues: [] };
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyStartLine = firstLine + markup.slice(0, block.index + '<style>'.length).split('\n').length - 1;
  const rules: StyleRule[] = [];
  const issues: string[] = [];
  let consumedTo = 0;
  for (const m of body.matchAll(RULE_RE)) {
    const line = bodyStartLine + body.slice(0, m.index + m[1].length - m[1].trimStart().length).split('\n').length - 1;
    consumedTo = m.index + m[0].length;
    const selector = m[1].trim().toLowerCase();
    if (!Object.hasOwn(NAMED_STYLE_BY_SELECTOR, selector)) {
      issues.push(`line ${line}: <style> selector "${selector}" is not supported`);
      continue;
    }
    const parsed = parseRuleCss(m[2]);
    for (const issue of parsed.issues) issues.push(`line ${line}: <style> ${selector} { ${issue} }`);
    rules.push({ selector: selector as RuleSelector, paragraph: parsed.css.paragraph, text: parsed.css.text });
  }
  const stray = body.slice(consumedTo).trim();
  if (stray) issues.push(`line ${bodyStartLine}: <style> has text outside any rule: "${stray.slice(0, 40)}"`);
  return { rules, issues };
}

const isEmptyChange = (change: { set: object; cleared: unknown[] }): boolean =>
  Object.keys(change.set).length === 0 && change.cleared.length === 0;

/** One updateNamedStyle per rule whose declarations differ from `current`; `current` empty means set everything given. */
export function namedStyleRequests(next: StyleRule[], current: StyleRule[] = [], tabId?: string): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];
  for (const rule of next) {
    const before = current.find((c) => c.selector === rule.selector);
    const paragraphChange = paragraphCssChange(before?.paragraph ?? {}, rule.paragraph);
    const textChange = diffCss(before?.text ?? {}, rule.text);
    if (isEmptyChange(paragraphChange) && isEmptyChange(textChange)) continue;
    const p = paragraphStyleUpdate(paragraphChange.set, paragraphChange.cleared);
    const t = textStyleUpdate(textChange.set, textChange.cleared);
    const fields = [
      'namedStyleType',
      ...p.fields.map((f) => `paragraphStyle.${f}`),
      ...t.fields.map((f) => `textStyle.${f}`),
    ].join(',');
    const updateNamedStyle = {
      namedStyle: { namedStyleType: NAMED_STYLE_BY_SELECTOR[rule.selector], paragraphStyle: p.style, textStyle: t.style },
      fields,
      ...(tabId ? { tabId } : {}),
    };
    requests.push({ updateNamedStyle } as unknown as docs_v1.Schema$Request);
  }
  return requests;
}

export interface EffectiveStyles {
  named?: docs_v1.Schema$NamedStyle;
  normal?: docs_v1.Schema$NamedStyle;
}

export function effectiveStylesFor(doc: docs_v1.Schema$Document, namedStyleType: string, tabId?: string): EffectiveStyles {
  const styles = namedStylesOf(doc, tabId);
  return {
    named: styles.find((s) => s.namedStyleType === namedStyleType),
    normal: styles.find((s) => s.namedStyleType === 'NORMAL_TEXT'),
  };
}

const inherited = (eff: EffectiveStyles, pick: (ps: docs_v1.Schema$ParagraphStyle) => docs_v1.Schema$Dimension | undefined): number =>
  magnitude(eff.named?.paragraphStyle && pick(eff.named.paragraphStyle)) ?? magnitude(eff.normal?.paragraphStyle && pick(eff.normal.paragraphStyle)) ?? 0;

/** What a paragraph says for itself, against what its named style already gives it. */
export function paragraphCssOf(ps: docs_v1.Schema$ParagraphStyle | undefined, eff: EffectiveStyles): ParagraphCss {
  const direct = ps ?? {};
  const css: ParagraphCss = {};

  const inheritedAlign = eff.named?.paragraphStyle?.alignment ?? eff.normal?.paragraphStyle?.alignment ?? 'START';
  const align = direct.alignment;
  if (align && align !== 'ALIGNMENT_UNSPECIFIED' && align !== inheritedAlign) css.align = CSS_BY_DOCS_ALIGNMENT[align] ?? 'justify';

  const inheritedLine = eff.named?.paragraphStyle?.lineSpacing ?? eff.normal?.paragraphStyle?.lineSpacing ?? 100;
  if (direct.lineSpacing && direct.lineSpacing !== inheritedLine) css.lineHeight = direct.lineSpacing / 100;

  const spacing = [
    ['marginTop', direct.spaceAbove, (p: docs_v1.Schema$ParagraphStyle) => p.spaceAbove ?? undefined],
    ['marginBottom', direct.spaceBelow, (p: docs_v1.Schema$ParagraphStyle) => p.spaceBelow ?? undefined],
    ['marginRight', direct.indentEnd, (p: docs_v1.Schema$ParagraphStyle) => p.indentEnd ?? undefined],
  ] as const;
  for (const [key, dimension, pick] of spacing) {
    const value = magnitude(dimension ?? undefined);
    if (value !== undefined && value !== inherited(eff, pick)) css[key] = value;
  }

  const directStart = magnitude(direct.indentStart ?? undefined);
  const directFirst = magnitude(direct.indentFirstLine ?? undefined);
  if (directStart !== undefined || directFirst !== undefined) {
    const inheritedStart = inherited(eff, (p) => p.indentStart ?? undefined);
    const inheritedFirst = inherited(eff, (p) => p.indentFirstLine ?? undefined);
    const start = directStart ?? inheritedStart;
    const indent = (directFirst ?? inheritedFirst) - start;
    const startDiffers = start !== inheritedStart;
    let showsIndent = indent !== inheritedFirst - inheritedStart;
    const showsMargin = startDiffers || (showsIndent && start !== 0);
    if (showsMargin && indent !== 0) showsIndent = true;
    if (showsMargin) css.marginLeft = start;
    if (showsIndent) css.textIndent = indent;
  }
  return css;
}
