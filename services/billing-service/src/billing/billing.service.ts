import { Injectable, NotFoundException } from '@nestjs/common';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { UsageMeterService } from './usage-meter.service';
import { createLogger, format, transports } from 'winston';

const log = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

const UNIT_RATES: Record<string, number> = {
  api_call:      0.001,   // $0.001 per call  (0.1 cents)
  device_active: 5.00,    // $5.00  per device (500 cents)
  alert_fired:   0.01,    // $0.01  per alert  (1 cent)
};

@Injectable()
export class BillingService {
  constructor(private readonly usageMeter: UsageMeterService) {}

  async createSubscription(tenantId: string, email: string, plan = 'standard'): Promise<object> {
    const customer = await stripe.customers.create({ email, metadata: { tenantId } });
    const prices = await stripe.prices.list({ lookup_keys: [plan], expand: ['data.product'] });

    if (!prices.data.length) {
      throw new NotFoundException(`Stripe price with lookup_key="${plan}" not found`);
    }

    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: prices.data[0].id }],
      metadata: { tenantId },
    });

    await pool.query(
      `INSERT INTO tenant_subscriptions
         (tenant_id, stripe_customer_id, stripe_sub_id, plan, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
       ON CONFLICT (tenant_id) DO UPDATE SET
         stripe_customer_id   = EXCLUDED.stripe_customer_id,
         stripe_sub_id        = EXCLUDED.stripe_sub_id,
         plan                 = EXCLUDED.plan,
         status               = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end   = EXCLUDED.current_period_end,
         updated_at           = now()`,
      [
        tenantId,
        customer.id,
        sub.id,
        plan,
        sub.status,
        sub.current_period_start,
        sub.current_period_end,
      ],
    );

    log.info({ msg: 'subscription_created', tenantId, stripeSubId: sub.id, plan });
    return { tenantId, stripeSubId: sub.id, plan, status: sub.status };
  }

  async getSubscription(tenantId: string): Promise<object> {
    const rows = await pool.query(
      `SELECT * FROM tenant_subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!rows.rowCount) throw new NotFoundException('Subscription not found');
    return rows.rows[0];
  }

  async getUsage(tenantId: string): Promise<object> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const summary = await this.usageMeter.summarise(tenantId, periodStart, periodEnd);
    return { tenantId, periodStart, periodEnd, metrics: summary };
  }

  async generateInvoice(tenantId: string): Promise<object> {
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const summary = await this.usageMeter.summarise(tenantId, periodStart, periodEnd);
    const amountCents = Math.round(
      summary.reduce((acc, { metric, total }) => acc + total * (UNIT_RATES[metric] ?? 0) * 100, 0),
    );

    const subRows = await pool.query(
      `SELECT stripe_customer_id FROM tenant_subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!subRows.rowCount) throw new NotFoundException('No subscription for tenant');
    const customerId: string = subRows.rows[0].stripe_customer_id;

    const inv = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false,
      metadata: { tenantId },
    });

    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: inv.id,
      amount: amountCents,
      currency: 'usd',
      description: `CarePulse usage ${periodStart.toISOString().slice(0, 7)}`,
    });

    const finalized = await stripe.invoices.finalizeInvoice(inv.id ?? '');

    await pool.query(
      `INSERT INTO billing_invoices
         (tenant_id, stripe_invoice_id, amount_cents, status, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, finalized.id, amountCents, finalized.status ?? 'open', periodStart, periodEnd],
    );

    log.info({ msg: 'invoice_generated', tenantId, invoiceId: finalized.id, amountCents });
    return { tenantId, invoiceId: finalized.id, amountCents, status: finalized.status };
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err: unknown) {
      log.warn({ msg: 'stripe_webhook_sig_invalid', error: (err as Error).message });
      throw err;
    }

    log.info({ msg: 'stripe_webhook_received', type: event.type });

    switch (event.type) {
      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice;
        await pool.query(
          `UPDATE billing_invoices SET status = 'paid' WHERE stripe_invoice_id = $1`,
          [inv.id],
        );
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const tenantId = inv.metadata?.tenantId;
        await pool.query(
          `UPDATE billing_invoices SET status = 'payment_failed' WHERE stripe_invoice_id = $1`,
          [inv.id],
        );
        if (tenantId) {
          await pool.query(
            `UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now() WHERE tenant_id = $1`,
            [tenantId],
          );
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const tenantId = sub.metadata?.tenantId;
        if (tenantId) {
          await pool.query(
            `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now() WHERE tenant_id = $1`,
            [tenantId],
          );
          log.info({ msg: 'subscription_cancelled', tenantId, stripeSubId: sub.id });
        }
        break;
      }
      default:
        log.info({ msg: 'stripe_webhook_unhandled', type: event.type });
    }
  }
}
