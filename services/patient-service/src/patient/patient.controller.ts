import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { PatientService } from './patient.service';

@Controller('patients')
export class PatientController {
  constructor(private readonly patientService: PatientService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.patientService.findOne(id);
  }

  @Post()
  create(@Body() body: any) {
    // S2: CreatePatient use-case with transactional outbox goes here
    return this.patientService.create(body);
  }
}
