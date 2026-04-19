import { Controller, Get, Post, Patch, Delete, Body, Param, HttpCode, HttpStatus, Headers } from '@nestjs/common';
import { PatientService, UpdatePatientDto } from './patient.service';
import { CreatePatientDto } from '../patients/create-patient.usecase';

@Controller('patients')
export class PatientController {
  constructor(private readonly patientService: PatientService) {}

  @Get()
  findAll(@Headers('x-tenant-id') tenantId: string) {
    return this.patientService.findAll(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.patientService.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: CreatePatientDto) {
    return this.patientService.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Headers('x-tenant-id') tenantId: string,
    @Body() body: UpdatePatientDto,
  ) {
    return this.patientService.update(id, tenantId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  softDelete(
    @Param('id') id: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.patientService.softDelete(id, tenantId);
  }
}
