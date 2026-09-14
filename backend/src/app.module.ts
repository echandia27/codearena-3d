import { Module } from '@nestjs/common';
import { IaModule } from './ia/ia.module';
import { SalasModule } from './salas/salas.module';

@Module({
  imports: [SalasModule, IaModule],
})
export class AppModule {}