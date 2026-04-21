import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { BillingService } from './billing.service';
import { UsageMeterService } from './usage-meter.service';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly usageMeter: UsageMeterService,
  ) {}

  @Get('subscription/:tenantId')
  getSubscription(@Param('tenantId') tenantId: string) {
    return this.billing.getSubscription(tenantId);
  }

  @Post('subscription')
  createSubscription(@Body() body: { tenantId: string; email: string; plan?: string }) {
    return this.billing.createSubscription(body.tenantId, body.email, body.plan);
  }

  @Get('usage/:tenantId')
  getUsage(@Param('tenantId') tenantId: string) {
    return this.billing.getUsage(tenantId);
  }

  @Post('invoice/:tenantId')
  @HttpCode(202)
  generateInvoice(@Param('tenantId') tenantId: string) {
    return this.billing.generateInvoice(tenantId);
  }

  @Post('webhook/stripe')
  @HttpCode(200)
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') sig: string,
  ) {
    await this.billing.handleWebhook(req.rawBody as Buffer, sig);
    return { received: true };
  }
}
