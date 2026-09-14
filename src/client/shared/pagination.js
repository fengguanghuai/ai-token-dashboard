export function paginateRows(rows, requestedPage, pageSize = 50) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 50;
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(pageCount, Math.max(1, Math.trunc(requestedPage) || 1));
  const offset = (page - 1) * size;
  return {
    page, pageCount, total: rows.length,
    start: rows.length ? offset + 1 : 0,
    end: Math.min(offset + size, rows.length),
    rows: rows.slice(offset, offset + size)
  };
}
