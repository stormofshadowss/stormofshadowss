// Numbers the boxes on a board in READING ORDER: row by row from the top, left to right within a row. Boxes whose vertical centres are close (within half a typical box height) are the same row,
// so a slightly crooked row still reads left to right. Returns the boxes' indexes in that order. (The editor does the same sums on screen so the numbers match once saved.)
export function readingOrder(boxes) {
  if (!boxes.length) return [];
  const items = boxes.map((b, i) => ({ i, cx: b.x + b.w / 2, cy: b.y + b.h / 2 }));
  const hs = boxes.map((b) => b.h).sort((a, b) => a - b), tol = (hs[Math.floor(hs.length / 2)] || 0.05) * 0.5;
  items.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const rows = []; let anchor = null;
  for (const it of items) { if (!rows.length || it.cy - anchor > tol) { rows.push([it]); anchor = it.cy; } else rows[rows.length - 1].push(it); }
  return rows.flatMap((r) => r.sort((a, b) => a.cx - b.cx || a.cy - b.cy)).map((it) => it.i);
}
