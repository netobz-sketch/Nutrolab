import nodemailer from 'nodemailer';

export function mailEnabled(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function appUrl(): string {
  return (process.env.APP_URL ?? '').replace(/\/$/, '');
}

export async function sendResetEmail(to: string, link: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER ?? '', pass: process.env.SMTP_PASS ?? '' },
  });
  const sender = process.env.SMTP_SENDER_NAME ?? 'NutroLab';
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '';
  await transport.sendMail({
    from: `"${sender.replace(/"/g, '')}" <${from}>`,
    to,
    subject: 'NutroLab: redefinição de senha',
    text: `Recebemos um pedido para redefinir a sua senha do NutroLab.\n\nAbra este link em até 1 hora:\n${link}\n\nSe você não pediu, ignore esta mensagem; a senha atual continua valendo.`,
  });
}
