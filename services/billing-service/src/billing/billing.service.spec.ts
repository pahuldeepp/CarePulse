import { Test } from '@nestjs/testing';
import { BillingService } from './billing.service';
import { UsageMeterService } from './usage-meter.service';
import { NotFoundException } from '@nestjs/common';

// ── Stripe mock — all fns defined inside factory to avoid hoisting issues ──────
jest.mock('stripe', () => {
  const mock = {
    customers:     { create: jest.fn() },
    prices:        { list: jest.fn() },
    subscriptions: { create: jest.fn() },
    invoices:      { create: jest.fn(), finalizeInvoice: jest.fn() },
    invoiceItems:  { create: jest.fn() },
    webhooks:      { constructEvent: jest.fn() },
  };
  const Ctor = jest.fn(() => mock);
  (Ctor as unknown as { _mock: typeof mock })._mock = mock;
  return Ctor;
});

// ── pg mock ───────────────────────────────────────────────────────────────────
jest.mock('pg', () => {
  const q = jest.fn();
  const Pool = jest.fn(() => ({ query: q }));
  (Pool as unknown as { _q: typeof q })._q = q;
  return { Pool };
});

type StripeMock = {
  customers:     { create: jest.Mock };
  prices:        { list: jest.Mock };
  subscriptions: { create: jest.Mock };
  invoices:      { create: jest.Mock; finalizeInvoice: jest.Mock };
  invoiceItems:  { create: jest.Mock };
  webhooks:      { constructEvent: jest.Mock };
};

function getStripeMock(): StripeMock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Ctor = require('stripe') as { _mock: StripeMock };
  return Ctor._mock;
}

function getDbQuery(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _q: jest.Mock } };
  return Pool._q;
}

describe('BillingService', () => {
  let service: BillingService;
  const usageMeter = { record: jest.fn(), summarise: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: UsageMeterService, useValue: usageMeter },
      ],
    }).compile();
    service = module.get(BillingService);
  });

  it('createSubscription creates stripe customer + sub and upserts DB row', async () => {
    const stripe = getStripeMock();
    stripe.customers.create.mockResolvedValue({ id: 'cus_1' });
    stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_1' }] });
    stripe.subscriptions.create.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      current_period_start: 1714521600,
      current_period_end:   1717200000,
    });
    getDbQuery().mockResolvedValue({ rows: [] });

    const result = await service.createSubscription('t-1', 'admin@example.com') as { tenantId: string; stripeSubId: string; status: string };
    expect(stripe.customers.create).toHaveBeenCalledWith({ email: 'admin@example.com', metadata: { tenantId: 't-1' } });
    expect(result.tenantId).toBe('t-1');
    expect(result.stripeSubId).toBe('sub_1');
    expect(result.status).toBe('active');
  });

  it('createSubscription throws NotFoundException when price not found', async () => {
    const stripe = getStripeMock();
    stripe.customers.create.mockResolvedValue({ id: 'cus_1' });
    stripe.prices.list.mockResolvedValue({ data: [] });
    await expect(service.createSubscription('t-1', 'x@x.com')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getSubscription returns DB row', async () => {
    getDbQuery().mockResolvedValue({ rowCount: 1, rows: [{ tenant_id: 't-1', status: 'active' }] });
    const result = await service.getSubscription('t-1') as { tenant_id: string };
    expect(result.tenant_id).toBe('t-1');
  });

  it('getSubscription throws NotFoundException when not found', async () => {
    getDbQuery().mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(service.getSubscription('t-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('generateInvoice computes amount and finalises stripe invoice', async () => {
    const stripe = getStripeMock();
    usageMeter.summarise.mockResolvedValue([{ metric: 'api_call', total: 1000 }]);
    getDbQuery()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ stripe_customer_id: 'cus_1' }] })
      .mockResolvedValue({ rows: [] });

    stripe.invoices.create.mockResolvedValue({ id: 'inv_1' });
    stripe.invoiceItems.create.mockResolvedValue({});
    stripe.invoices.finalizeInvoice.mockResolvedValue({ id: 'inv_1', status: 'open' });

    const result = await service.generateInvoice('t-1') as { amountCents: number };
    // 1000 api_calls × $0.001/call × 100 cents/$ = 100 cents
    expect(result.amountCents).toBe(100);
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith('inv_1');
  });

  it('handleWebhook invoice.paid sets status to paid', async () => {
    const stripe = getStripeMock();
    stripe.webhooks.constructEvent.mockReturnValue({
      type: 'invoice.paid',
      data: { object: { id: 'inv_1', metadata: {} } },
    });
    getDbQuery().mockResolvedValue({ rows: [] });

    await service.handleWebhook(Buffer.from('{}'), 'sig');
    expect(getDbQuery()).toHaveBeenCalledWith(
      expect.stringContaining("status = 'paid'"),
      ['inv_1'],
    );
  });

  it('handleWebhook customer.subscription.deleted sets status to cancelled', async () => {
    const stripe = getStripeMock();
    stripe.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', metadata: { tenantId: 't-1' } } },
    });
    getDbQuery().mockResolvedValue({ rows: [] });

    await service.handleWebhook(Buffer.from('{}'), 'sig');
    expect(getDbQuery()).toHaveBeenCalledWith(
      expect.stringContaining("status = 'cancelled'"),
      ['t-1'],
    );
  });

  it('handleWebhook throws when stripe signature invalid', async () => {
    const stripe = getStripeMock();
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    await expect(service.handleWebhook(Buffer.from('{}'), 'bad')).rejects.toThrow('Invalid signature');
  });
});
