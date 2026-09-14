import { Module } from '@nestjs/common';
import { SalasModule } from './salas/salas.module';

@Module({
  imports: [SalasModule],
})
export class AppModule {}