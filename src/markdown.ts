import { h } from './views/html.js';

function inline(text: string): string {
  return h(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Renderizador mínimo para o relatório (títulos, listas, tabelas, citações, parágrafos). */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listType) out.push(`</${listType}>`);
    listType = null;
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^\s*$/.test(line)) {
      closeList();
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      closeList();
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      const cells = (r: string) => r.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
      const header = cells(rows[0] ?? '');
      const body = rows.slice(2);
      out.push('<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      body.forEach((r) => out.push('<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'));
      out.push('</tbody></table>');
      continue;
    }
    if (line.startsWith('>')) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      i += 1;
      continue;
    }
    const ul = /^\s*-\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (listType !== type) {
        closeList();
        listType = type;
        out.push(`<${type}>`);
      }
      out.push(`<li>${inline((ul ?? ol)?.[1] ?? '')}</li>`);
      i += 1;
      continue;
    }
    if (/^\s{3,}\S/.test(line) && listType) {
      out.push(`<li class="cont">${inline(line.trim())}</li>`);
      i += 1;
      continue;
    }
    closeList();
    out.push(`<p>${inline(line.trim())}</p>`);
    i += 1;
  }
  closeList();
  return out.join('\n');
}
