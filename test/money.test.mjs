import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, format, extract } from "../client/js/core/money.js";

test("parse: strings, commas, integers, floats -> cents", () => {
  assert.deepEqual(parse("42.50"), { ok: true, cents: 4250 });
  assert.deepEqual(parse("3,20"), { ok: true, cents: 320 });
  assert.deepEqual(parse("7"), { ok: true, cents: 700 });
  assert.deepEqual(parse(7), { ok: true, cents: 700 });
  assert.deepEqual(parse(7.5), { ok: true, cents: 750 });
});

test("parse: rejects junk and negatives", () => {
  assert.equal(parse("12 foo").ok, false);
  assert.equal(parse("abc").ok, false);
  assert.equal(parse("-5").ok, false);
  assert.equal(parse(-5).ok, false);
  assert.equal(parse("").ok, false);
});

test("format: cents -> decimal string, with sign for negatives", () => {
  assert.equal(format(4250), "42.50");
  assert.equal(format(700), "7.00");
  assert.equal(format(5), "0.05");
  assert.equal(format(-4250), "-42.50");
});

test("extract: pull the first price token out of OCR text", () => {
  assert.deepEqual(extract("€12.50"), { ok: true, cents: 1250 });
  assert.deepEqual(extract("total 3,20 zł"), { ok: true, cents: 320 });
  assert.equal(extract("no price here").ok, false);
});
