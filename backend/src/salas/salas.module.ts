import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SalasController } from './salas.controller';
import { SalasService } from './salas.service';
import { SalasGateway } from './salas.gateway';

@Module({
  imports: [DatabaseModule],
  controllers: [SalasController],
  providers: [SalasService, SalasGateway],
})
export class SalasModule {}