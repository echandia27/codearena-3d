import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IaModule } from '../ia/ia.module';
import { SalasController } from './salas.controller';
import { SalasService } from './salas.service';
import { SalasGateway } from './salas.gateway';
import { PartidasService } from '../partidas/partidas.service';

@Module({
  imports: [DatabaseModule, IaModule], // IaModule exporta PreguntasService
  controllers: [SalasController],
  providers: [SalasService, SalasGateway, PartidasService],
})
export class SalasModule {}