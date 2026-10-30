const COMMENT_ONLY_REFUSAL = /comment-only access is not sufficient/i;

export class CommentOnlyAccess extends Error {}

export const MUST_SUGGEST_MESSAGE = 'You have comment access to this doc, so you can only suggest on it: pass suggest: true.';

export const CANNOT_RESOLVE_MESSAGE = 'You have comment access to this doc. Comment access can reject your own suggestions only: accepting, and rejecting another person’s suggestion, need edit access.';

/** Runs `write`, and when Google refuses it for comment-only access, throws `CommentOnlyAccess` with `explanation` in its place. Any other error passes through. */
export async function explainingCommentOnlyAccess<T>(explanation: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Error && COMMENT_ONLY_REFUSAL.test(error.message)) throw new CommentOnlyAccess(explanation, { cause: error });
    throw error;
  }
}
