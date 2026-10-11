import assert from "node:assert/strict";
import test from "node:test";
import { parseDelimitedTable } from "../../src/plugins/web/ui/utils/csv.js";

test("CSV preview parses quoted delimiters, escaped quotes, CRLF and multiline values", () => {
  const result = parseDelimitedTable(
    '\ufeffname,description,value\r\n"Alpha, Beta","say ""hello""",3\r\nGamma,"line1\nline2",4\r\n',
    ",",
  );
  assert.deepEqual(result.rows, [
    ["name", "description", "value"],
    ["Alpha, Beta", 'say "hello"', "3"],
    ["Gamma", "line1\nline2", "4"],
  ]);
  assert.equal(result.truncatedRows, false);
  assert.equal(result.truncatedColumns, false);
});

test("TSV preview respects tab delimiter and limits number of rows and columns", () => {
  const result = parseDelimitedTable(
    "a\tb\tc\n1\t2\t3\n4\t5\t6\n7\t8\t9",
    "\t",
    2,
    2,
  );
  assert.deepEqual(result.rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.equal(result.truncatedRows, true);
  assert.equal(result.truncatedColumns, true);
});

test("CSV empty input and final newline do not generate spurious rows", () => {
  assert.deepEqual(parseDelimitedTable("", ",").rows, []);
  assert.deepEqual(parseDelimitedTable("header\n", ",").rows, [["header"]]);
  assert.deepEqual(parseDelimitedTable("a,b\n1,2\n", ",").rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});
