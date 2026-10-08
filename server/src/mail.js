import nodemailer from 'nodemailer';

// Three modes: smtp (real), console (print to the container log), memory (tests).
export function createMailer(cfg) {
  if (cfg.mail.mode === 'memory') {
    const outbox = [];
    return { outbox, async send(m) { outbox.push(m); } };
  }
  if (cfg.mail.mode === 'console') {
    return { async send(m) { console.log(`\n[mail → ${m.to}] ${m.subject}\n${m.text}\n`); } };
  }
  const transport = nodemailer.createTransport({
    host: cfg.mail.smtp.host, port: cfg.mail.smtp.port, secure: cfg.mail.smtp.secure,
    auth: cfg.mail.smtp.user ? { user: cfg.mail.smtp.user, pass: cfg.mail.smtp.pass } : undefined,
  });
  return { async send(m) { await transport.sendMail({ from: cfg.mail.from, ...m }); } };
}
