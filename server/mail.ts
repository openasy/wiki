// Mail: a policy's reminders and "this page changed" notes go out through the SMTP server in the file.
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  close(): void;
}

export function smtpMailer(m: NonNullable<Config["mail"]>, password: string | undefined, o: { allowPlain?: boolean } = {}): Mailer {
  const t: Transporter = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.security === "tls",
    requireTLS: m.security === "starttls" && !o.allowPlain,
    ignoreTLS: m.security === "none",
    auth: m.user && password ? { user: m.user, pass: password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      await t.sendMail({ from: m.from, to: mail.to, subject: mail.subject, text: mail.text });
    },
    close: () => t.close(),
  };
}
