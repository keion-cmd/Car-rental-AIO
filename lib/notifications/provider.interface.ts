// No real provider is chosen in this phase. Implementations live here so a
// later phase can add a real adapter (SES, Postmark, ...) without touching
// notification.service.ts, which depends only on this interface.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendResult {
  providerMessageId: string;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

// Logs subject and recipient only — never the body, never any payload
// field. Stands in for a real provider during local development.
export class ConsoleEmailProvider implements EmailProvider {
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    console.log(`[email] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
    return { providerMessageId: `console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }
}

// Records nothing. For tests that need a provider but must not send or log
// anything — call sites that assert on the provider should use a mock
// instead, this is purely a safe no-op default.
export class NoopEmailProvider implements EmailProvider {
  async send(): Promise<EmailSendResult> {
    return { providerMessageId: `noop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }
}
