/**
 * The only place a model is involved.
 *
 * One job: turn an unbounded English sentence into the bounded, structured filter
 * that search.js can act on. This is the part you cannot write as a chain of
 * elseifs — not because it's complicated, but because you'd have to enumerate
 * every way a person might phrase the request, and that list is infinite.
 *
 * Everything downstream of this function is ordinary code.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';

/**
 * Builds the JSON schema the response is constrained to.
 *
 * The enumerations come from values.js, derived off the scraped data — so the
 * API *enforces* that the model cannot emit a destination or cabin that isn't in
 * the dataset. With a local model this was a prompt instruction the model could
 * ignore; here it is a structural guarantee. Drift between the schema and the
 * data is impossible for the same reason: both are built from the same array.
 */
export function buildSchema(values) {
  const orNull = (schema) => ({ anyOf: [schema, { type: 'null' }] });
  const oneOf = (list, type = 'string') =>
    orNull(list.length > 0 ? { type, enum: list } : { type });

  const properties = {
    line: oneOf(values.line),
    ship: oneOf(values.ship ?? []),
    destination: oneOf(values.destination),
    departurePort: oneOf(values.departurePort),
    cabin: oneOf(values.cabin),
    tripType: oneOf(values.tripType ?? []),
    nights: oneOf(values.nights, 'integer'),
    minNights: orNull({ type: 'integer' }),
    maxNights: orNull({ type: 'integer' }),
    minPrice: orNull({ type: 'number' }),
    maxPrice: orNull({ type: 'number' }),
    dateFrom: orNull({ type: 'string', format: 'date' }),
    dateTo: orNull({ type: 'string', format: 'date' }),
    unrecognised: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Any requirement you could NOT express with the other fields — amenities, ' +
        'ship atmosphere, dining, kids clubs, adults-only. This dataset has no such ' +
        'fields, so reporting it here is correct and ignoring it silently is not.',
    },
  };

  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function buildSystemPrompt(dateRange) {
  return `You convert a cruise shopper's request into a JSON search filter.

Use null for anything the shopper did not mention. Do not guess.

Sailings in this dataset run from ${dateRange.from} to ${dateRange.to}.
Today is ${new Date().toISOString().slice(0, 10)}.

Vocabulary:
- "balcony", "verandah" mean cabin "balcony". "inside" means "interior".
  "ocean view", "outside" mean "oceanview".
- "a week", "7 nights" mean nights 7. "under a week" means maxNights 6.
  "at least 5 nights" means minNights 5.
- "out of Miami", "leaving from Miami" mean departurePort "Miami".
- "cruisetour", "land tour", "Denali", "Yukon" mean tripType "cruisetour" — a
  cruise plus land days, sold as one package. "cruise only", "no land tour" mean
  tripType "cruise". Otherwise tripType is null: show both.
- "next January" means dateFrom the 1st and dateTo the 31st of that January.

Put into "unrecognised" any requirement you could not express with the other
fields — a specific restaurant, a kids' club, a spa, an adults-only ship, or
anything about onboard amenities. Reporting it is correct; ignoring it is not.`;
}

/**
 * @param {string} question - the shopper's sentence, verbatim
 * @param {object} values - the enumeration from values.js
 * @param {{from: string, to: string}} dateRange
 * @returns {Promise<{filter: object|null, raw: string, error: string|null}>}
 */
export async function understand(question, values, dateRange) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      filter: null,
      raw: '',
      error:
        'ANTHROPIC_API_KEY is not set. Create a .env file with your key and start ' +
        'the server with `npm run serve` (which loads it).',
    };
  }

  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: buildSystemPrompt(dateRange),
      messages: [{ role: 'user', content: question }],
      output_config: {
        format: { type: 'json_schema', schema: buildSchema(values) },
      },
    });
  } catch (err) {
    // Typed SDK errors rather than string-matching the message.
    if (err instanceof Anthropic.AuthenticationError) {
      return { filter: null, raw: '', error: 'Anthropic rejected the API key (401).' };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { filter: null, raw: '', error: 'Rate limited by Anthropic — try again shortly.' };
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return { filter: null, raw: '', error: `Could not reach Anthropic: ${err.message}` };
    }
    return { filter: null, raw: '', error: `Anthropic error: ${err.message}` };
  }

  // A refusal returns HTTP 200 with an empty or partial content array, so this
  // has to be checked before reading content[0].
  if (response.stop_reason === 'refusal') {
    return {
      filter: null,
      raw: '',
      error: `Request declined by safety classifiers (${response.stop_details?.category ?? 'no category'}).`,
    };
  }

  const raw = response.content.find((b) => b.type === 'text')?.text ?? '';

  try {
    return { filter: JSON.parse(raw), raw, error: null };
  } catch (err) {
    return { filter: null, raw, error: `Model did not return usable JSON: ${err.message}` };
  }
}
