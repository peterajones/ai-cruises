/** The page was a challenge or block, not content. Different fix from a parse failure. */
export class BotWallError extends Error {
  constructor(reason, url) {
    super(`Bot wall at ${url}: ${reason}`);
    this.name = 'BotWallError';
    this.reason = reason;
    this.url = url;
  }
}

/** Parsed zero rows where rows were expected. Never treat this as "no results". */
export class EmptyResultError extends Error {
  constructor(context) {
    super(`Parsed 0 rows from ${context}. Selectors probably broke, or this was a bot wall.`);
    this.name = 'EmptyResultError';
    this.context = context;
  }
}

/**
 * Two rows share an id but describe different sailings.
 *
 * Means the id is no longer a safe dedupe key for that source — either the site
 * changed how it issues ids, or the adapter is reading the wrong field. Both
 * need a human decision, so this aborts rather than silently keeping one row.
 */
export class ConflictingDuplicateError extends Error {
  constructor(id, fields, first, second) {
    const detail = fields
      .map((f) => `${f}: ${JSON.stringify(first[f])} vs ${JSON.stringify(second[f])}`)
      .join(', ');
    super(
      `Two different sailings share the id "${id}" (${detail}). ` +
        'Dedupe would discard a real sailing — the id is not a safe key for this source.',
    );
    this.name = 'ConflictingDuplicateError';
    this.id = id;
    this.fields = fields;
  }
}
