const CONTEXT = 30;

/** The text around `text[start, end)`, with the span in ⟦⟧ and line breaks shown as ⏎. */
export function contextAround(text: string, start: number, end: number): string {
  const pre = text.slice(Math.max(0, start - CONTEXT), start);
  const hit = text.slice(start, end);
  const post = text.slice(end, end + CONTEXT);
  return `…${pre}⟦${hit}⟧${post}…`.replace(/\n/g, '⏎');
}
