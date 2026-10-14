import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema, buildSystemPrompt } from '../brain.js';

const values = {
  line: ['Holland America'], ship: ['Westerdam'], destination: ['alaska'],
  departurePort: ['Vancouver, B.C., CA'], cabin: ['interior'], nights: [7],
  tripType: ['cruise', 'cruisetour'],
};

test('the model can only choose a tripType that exists in the data', () => {
  const schema = buildSchema(values);
  assert.deepEqual(schema.properties.tripType, {
    anyOf: [{ type: 'string', enum: ['cruise', 'cruisetour'] }, { type: 'null' }],
  });
  assert.ok(schema.required.includes('tripType'));
});

test('the prompt says what a cruisetour is called', () => {
  const prompt = buildSystemPrompt({ from: '2027-04-24', to: '2027-09-30' });
  assert.match(prompt, /cruisetour/);
  assert.match(prompt, /Denali/);
});

test('the model can express ratings and views, and only whole stars 1 to 5', () => {
  const schema = buildSchema(values);
  for (const f of ['minRating', 'hideRatedAtMost']) {
    assert.deepEqual(schema.properties[f], {
      anyOf: [{ type: 'integer', enum: [1, 2, 3, 4, 5] }, { type: 'null' }],
    });
    assert.ok(schema.required.includes(f));
  }
  assert.deepEqual(schema.properties.viewed, { anyOf: [{ type: 'boolean' }, { type: 'null' }] });
});

test("the prompt explains the shopper's own ratings", () => {
  const prompt = buildSystemPrompt({ from: '2027-04-24', to: '2027-09-30' });
  assert.match(prompt, /minRating/);
  assert.match(prompt, /hideRatedAtMost/);
  assert.match(prompt, /haven't seen/);
});
