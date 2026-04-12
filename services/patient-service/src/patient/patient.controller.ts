import { Controller, Get, Post, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { PatientService } from './patient.service';
import { CreatePatientDto } from '../patients/create-patient.usecase';

@Controller('patients')
export class PatientController {
  constructor(private readonly patientService: PatientService) {}

  /** GET /v1/patients/:id — fetch a single patient by ID */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.patientService.findOne(id);
  }

  /** POST /v1/patients — create a patient + emit PatientCreated outbox event */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreatePatientDto) {
    return this.patientService.create(body);
  }
}
