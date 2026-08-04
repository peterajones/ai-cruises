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
