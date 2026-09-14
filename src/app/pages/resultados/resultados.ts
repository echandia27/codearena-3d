import { Component, inject } from '@angular/core';
import { GameSessionService } from '../../services/game-session.service';

@Component({
  selector: 'app-resultados',
  templateUrl: './resultados.html',
  styleUrl: './resultados.css',
})
export class Resultados {
  session = inject(GameSessionService);

  volverAlInicio(): void {
    this.session.reiniciar();
  }
}