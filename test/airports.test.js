import test from 'node:test';
import assert from 'node:assert/strict';
import { airportFor, airportName } from '../airports.js';

// Every departure port in the 2026-10-07 data, and every end port seen in the fixtures
// and in Holland America's Alaska feed.
const PORTS = {
  'Vancouver, B.C., CA': 'YVR', 'Vancouver, Canada': 'YVR',
  'Fort Lauderdale': 'FLL', 'Ft. Lauderdale, Florida': 'FLL', 'Fort Lauderdale, Florida, US': 'FLL',
  'Fairbanks, Alaska': 'FAI', 'Miami': 'MIA', 'Miami, Florida': 'MIA',
  'Anchorage, Alaska, US': 'ANC', 'Whittier, Alaska, US': 'ANC',
  'Seattle': 'SEA', 'Seattle, Washington': 'SEA', 'Seattle, Washington, US': 'SEA',
  'Los Angeles, California': 'LAX', 'Tokyo, Japan': 'HND', 'Tokyo (Yokohama), Japan': 'HND',
  'Sydney, Australia': 'SYD', 'Port Canaveral (Orlando), Florida': 'MCO', 'Orlando (Port Canaveral)': 'MCO',
  'Barcelona': 'BCN', 'Barcelona, Spain': 'BCN', 'San Juan, Puerto Rico': 'SJU',
  'Southampton (for London), England': 'LHR', 'Brisbane, Australia': 'BNE',
  'San Francisco, California': 'SFO', 'Singapore': 'SIN',
  'New York City (Manhattan or Brooklyn), New York': 'JFK', 'Honolulu, Hawaii': 'HNL',
  'Copenhagen, Denmark': 'CPH', 'Barbados': 'BGI', 'Perth (Fremantle), Australia': 'PER',
  'Ravenna, Italy': 'BLQ', 'Civitavecchia (for Rome), Italy': 'FCO', 'Civitavecchia (Rome), Italy': 'FCO',
  'Athens (Piraeus), Greece': 'ATH', 'Athens (Piraeus)': 'ATH', 'Piraeus (Athens), Greece': 'ATH',
  'Trieste (for Venice), Italy': 'TRS', 'Trieste (Venice), Italy': 'TRS',
  'San Antonio (for Santiago), Chile': 'SCL', 'Buenos Aires, Argentina': 'EZE',
  'Helsinki, Finland': 'HEL', 'San Diego, California, US': 'SAN',
  'Amsterdam, The Netherlands': 'AMS', 'Rotterdam, The Netherlands': 'AMS',
  'Boston, Massachusetts, US': 'BOS', 'Montreal, Quebec, Canada': 'YUL',
  'Quebec City, Quebec, Canada': 'YQB', 'Reykjavik, Iceland': 'KEF',
  'Laem Chabang (for Bangkok),Thailand': 'BKK',
};

test('every known port maps to its airport', () => {
  for (const [port, code] of Object.entries(PORTS)) assert.equal(airportFor(port), code, port);
});

test('a port naming a nearby city maps to that city, not a namesake', () => {
  // "San Antonio (for Santiago)" is in Chile: SCL, never San Antonio, Texas.
  assert.equal(airportFor('San Antonio (for Santiago), Chile'), 'SCL');
  // Trieste names Venice too; the longer, more specific match wins.
  assert.equal(airportFor('Trieste (for Venice), Italy'), 'TRS');
});

test('an unknown port is null, never a guess', () => {
  assert.equal(airportFor('Nowhere Bay, Atlantis'), null);
  assert.equal(airportFor(''), null);
  assert.equal(airportFor(null), null);
});

test('codes have a name for display', () => {
  assert.equal(airportName('YYZ'), 'Toronto');
  assert.equal(airportName('ANC'), 'Anchorage');
  assert.equal(airportName('XXX'), null);
});
