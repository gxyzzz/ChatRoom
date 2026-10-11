export interface DelimitedTable {
  rows: string[][];
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

export function parseDelimitedTable(
  source: string,
  delimiter: "," | "\t",
  maxRows = 2001,
  maxColumns = 100,
): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncatedColumns = false;
  let truncatedRows = false;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  const pushField = () => {
    if (row.length < maxColumns) row.push(field);
    else truncatedColumns = true;
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (rows.length < maxRows) rows.push(row);
    else truncatedRows = true;
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (quoted) {
        quoted = false;
      } else if (!field) {
        quoted = true;
      } else {
        field += char;
      }
    } else if (!quoted && char === delimiter) {
      pushField();
    } else if (!quoted && (char === "\n" || char === "\r")) {
      pushRow();
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (rows.length === maxRows && index < text.length - 1) {
        truncatedRows = true;
        break;
      }
    } else {
      field += char;
    }
  }
  if (!truncatedRows && (field || row.length || quoted)) pushRow();
  return { rows, truncatedRows, truncatedColumns };
}
