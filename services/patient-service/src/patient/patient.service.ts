import { Injectable } from '@nestjs/common';

@Injectable()
export class PatientService {
  async findOne(id: string) {
    // S2: Prisma query + RLS goes here
    return { id, status: 'stub' };
  }

  async create(data: any) {
    // S2: Prisma $transaction + outbox_events insert goes here
    return { ...data, id: crypto.randomUUID() };
  }
}
