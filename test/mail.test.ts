/** nodemailer 10: o e-mail de redefinição continua saindo (SMTP falso local, com AUTH). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

test('sendResetEmail entrega pelo SMTP com autenticação, texto puro e o link', async () => {
  const received: { auth: string; from: string; to: string; data: string } = { auth: '', from: '', to: '', data: '' };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 smtp.teste ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 aceito\r\n');
          } else received.data += `${line}\n`;
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-smtp.teste\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd.startsWith('AUTH PLAIN')) {
          received.auth = Buffer.from(line.slice(11), 'base64').toString('utf8');
          socket.write('235 2.7.0 ok\r\n');
        } else if (cmd.startsWith('MAIL FROM')) {
          received.from = line;
          socket.write('250 ok\r\n');
        } else if (cmd.startsWith('RCPT TO')) {
          received.to = line;
          socket.write('250 ok\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 manda\r\n');
        } else if (cmd === 'QUIT') {
          socket.end('221 tchau\r\n');
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'remetente@ln.test', SMTP_PASS: 'senha-smtp', SMTP_FROM: 'nao-responda@ln.test' });
  try {
    const { mailEnabled, sendResetEmail } = await import('../src/mail.js');
    assert.equal(mailEnabled(), true);
    await sendResetEmail('medica@ln.test', 'https://nutrolab.teste/redefinir/abc123');
    assert.equal(received.auth, '\u0000remetente@ln.test\u0000senha-smtp');
    assert.match(received.from, /<nao-responda@ln\.test>/);
    assert.match(received.to, /<medica@ln\.test>/);
    assert.match(received.data, /Subject: =\?UTF-8\?Q\?LN_Medicina_Integrada/);
    assert.match(received.data.replace(/=\n/g, ''), /https:\/\/nutrolab\.teste\/redefinir\/abc123/);
    assert.match(received.data, /Content-Type: text\/plain/i);
  } finally {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
