import assert from 'node:assert/strict';
import {
  nonNegativeInt,
  positiveInt,
  positiveNumber
} from '../zbrowse/gateway/config-values.js';

assert.equal(positiveInt('3', 1), 3);
assert.equal(positiveInt('0', 1), 1);
assert.equal(positiveInt('-4', 1), 1);
assert.equal(positiveInt('3junk', 1), 1);
assert.equal(positiveInt('3.5', 1), 1);
assert.equal(positiveInt('garbage', 7), 7);

assert.equal(nonNegativeInt('0', 1), 0);
assert.equal(nonNegativeInt('2', 1), 2);
assert.equal(nonNegativeInt('-1', 1), 1);
assert.equal(nonNegativeInt('2junk', 1), 1);
assert.equal(nonNegativeInt('2.5', 1), 1);
assert.equal(nonNegativeInt('garbage', 3), 3);

assert.equal(positiveNumber('0.5', 1), 0.5);
assert.equal(positiveNumber('2', 1), 2);
assert.equal(positiveNumber('0', 1), 1);
assert.equal(positiveNumber('2junk', 1), 1);
assert.equal(positiveNumber('NaN', 1), 1);

console.log('zBrowse config value tests passed');
