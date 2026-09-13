// Server-side only — rendered by notification.service.ts, never in a client
// component. All money/date values arrive pre-formatted; no arithmetic
// happens in this file. Must NEVER receive a licence number, token, key, or
// any signed URL.

export interface BookingReceivedLineItem {
  description: string;
  amount: string;
}

export interface BookingReceivedPayload {
  reference: string;
  vehicleName: string;
  pickupAt: string;
  pickupLocationName: string;
  returnAt: string;
  returnLocationName: string;
  durationLabel: string;
  lineItems: BookingReceivedLineItem[];
  subtotal: string;
  tax: string;
  total: string;
  securityDeposit: string;
  driverFullName: string;
  contactEmail: string;
  contactPhone: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderBookingReceived(payload: BookingReceivedPayload): RenderedEmail {
  const subject = `Booking received — ${payload.reference}`;

  const lineItemsText = payload.lineItems.map((li) => `  - ${li.description}: ${li.amount}`).join("\n");
  const lineItemsHtml = payload.lineItems
    .map((li) => `<tr><td>${li.description}</td><td>${li.amount}</td></tr>`)
    .join("\n");

  const text = `Hi ${payload.driverFullName},

Your booking is received. Reference: ${payload.reference}

Vehicle: ${payload.vehicleName}

Pickup: ${payload.pickupAt} at ${payload.pickupLocationName}
Return: ${payload.returnAt} at ${payload.returnLocationName}
Duration: ${payload.durationLabel}

Price breakdown:
${lineItemsText}
  Subtotal: ${payload.subtotal}
  Tax: ${payload.tax}
  Total: ${payload.total}

Security deposit (refundable, not included in total): ${payload.securityDeposit}

What to bring at pickup: your driver's licence, a valid government ID, and the deposit card.

Cancellation terms: free cancellation up to 24 hours before pickup. The deposit is refunded after a damage-free return.

Questions? Contact us at ${payload.contactEmail} or ${payload.contactPhone}, and quote reference ${payload.reference}.
`;

  const html = `<div>
  <p>Hi ${payload.driverFullName},</p>
  <p>Your booking is received. Reference: <strong>${payload.reference}</strong></p>
  <p>Vehicle: ${payload.vehicleName}</p>
  <p>Pickup: ${payload.pickupAt} at ${payload.pickupLocationName}<br/>
  Return: ${payload.returnAt} at ${payload.returnLocationName}<br/>
  Duration: ${payload.durationLabel}</p>
  <table>
    ${lineItemsHtml}
    <tr><td>Subtotal</td><td>${payload.subtotal}</td></tr>
    <tr><td>Tax</td><td>${payload.tax}</td></tr>
    <tr><td><strong>Total</strong></td><td><strong>${payload.total}</strong></td></tr>
  </table>
  <p>Security deposit (refundable, not included in total): ${payload.securityDeposit}</p>
  <p>What to bring at pickup: your driver's licence, a valid government ID, and the deposit card.</p>
  <p>Cancellation terms: free cancellation up to 24 hours before pickup. The deposit is refunded after a damage-free return.</p>
  <p>Questions? Contact us at ${payload.contactEmail} or ${payload.contactPhone}, and quote reference ${payload.reference}.</p>
</div>`;

  return { subject, text, html };
}
