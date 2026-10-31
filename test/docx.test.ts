import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { docxText } from '../src/docx.js';

/** Monta um ZIP mínimo (um arquivo, deflate) com diretório central, como um .docx. */
export function fakeDocx(xml: string): Buffer {
  const name = Buffer.from('word/document.xml');
  const raw = Buffer.from(xml, 'utf8');
  const data = zlib.deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, name, data]);
  const centralPart = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(centralPart.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

test('docxText: extrai parágrafos e decodifica entidades', () => {
  const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Fórmula D3 + K2</w:t></w:r></w:p><w:p><w:r><w:t>Colecalciferol 10.000 UI</w:t><w:tab/><w:t>&amp; K2 100 mcg</w:t></w:r></w:p></w:body></w:document>';
  const text = docxText(fakeDocx(xml));
  assert.match(text, /^Fórmula D3 \+ K2\n/);
  assert.match(text, /Colecalciferol 10\.000 UI\t& K2 100 mcg/);
  assert.throws(() => docxText(Buffer.from('nao é zip')), /inválido/);
});
