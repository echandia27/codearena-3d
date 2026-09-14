import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SalasController } from './salas.controller';
import { SalasService } from './salas.service';

@Module({
  imports: [DatabaseModule],
  controllers: [SalasController],
  providers: [SalasService],
})
export class SalasModule {}