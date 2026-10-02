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
