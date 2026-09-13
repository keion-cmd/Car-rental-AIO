import { PrismaClient, Prisma, NotificationType, NotificationChannel, NotificationStatus } from "@prisma/client";
import type { EmailProvider } from "../notifications/provider.interface";
import { renderBookingReceived, type BookingReceivedPayload } from "../notifications/templates/booking-received";

// DATABASE IS THE RECORD: queueNotification writes the row; sending happens
// later via processQueuedNotifications. A slow or failing provider must
// never delay or fail the caller's transaction.

export const prisma = new PrismaClient();

const MAX_ATTEMPTS = 3;

export interface QueueNotificationInput {
  type: NotificationType;
  channel: NotificationChannel;
  recipient: string;
  bookingId?: string;
  templateKey: string;
  payload: Prisma.InputJsonValue;
}

export async function queueNotification(input: QueueNotificationInput, tx?: Prisma.TransactionClient) {
  const client = tx ?? prisma;
  return client.notification.create({
    data: {
      type: input.type,
      channel: input.channel,
      recipient: input.recipient,
      bookingId: input.bookingId,
      templateKey: input.templateKey,
      payload: input.payload,
      status: NotificationStatus.QUEUED,
    },
  });
}

type TemplateRenderer = (payload: unknown) => { subject: string; text: string; html: string };

const TEMPLATES: Record<string, TemplateRenderer> = {
  "booking-received": (payload) => renderBookingReceived(payload as BookingReceivedPayload),
};

interface ClaimedNotification {
  id: string;
  recipient: string;
  templateKey: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

// Concurrency-safe claim: a single statement combining SELECT ... FOR UPDATE
// SKIP LOCKED (locks eligible rows, letting a concurrent run skip past
// anything already locked) with an UPDATE that flips them to SENDING in the
// same statement. Two workers racing on the same row: one locks and claims
// it, the other's SKIP LOCKED excludes it entirely — so it never appears in
// either result set, and never gets sent twice.
async function claimQueuedNotifications(limit: number): Promise<ClaimedNotification[]> {
  return prisma.$queryRaw<ClaimedNotification[]>`
    UPDATE notifications
    SET status = 'SENDING'::"NotificationStatus", updated_at = now()
    WHERE id IN (
      SELECT id FROM notifications
      WHERE status = 'QUEUED'::"NotificationStatus"
         OR (status = 'FAILED'::"NotificationStatus" AND attempts < ${MAX_ATTEMPTS})
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, recipient, template_key AS "templateKey", payload, attempts
  `;
}

export async function processQueuedNotifications(
  limit: number,
  provider: EmailProvider,
  now: Date = new Date()
): Promise<void> {
  const claimed = await claimQueuedNotifications(limit);

  for (const row of claimed) {
    const render = TEMPLATES[row.templateKey];
    try {
      if (!render) {
        throw new Error(`unknown templateKey: ${row.templateKey}`);
      }
      const rendered = render(row.payload);
      const result = await provider.send({
        to: row.recipient,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      await prisma.notification.update({
        where: { id: row.id },
        data: {
          status: NotificationStatus.SENT,
          providerMessageId: result.providerMessageId,
          sentAt: now,
          error: null,
        },
      });
    } catch (err) {
      await prisma.notification.update({
        where: { id: row.id },
        data: {
          status: NotificationStatus.FAILED,
          attempts: row.attempts + 1,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
