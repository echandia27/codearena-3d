import { Component, inject } from '@angular/core';
import { GameSessionService } from '../../services/game-session.service';

@Component({
  selector: 'app-lobby',
  templateUrl: './lobby.html',
  styleUrl: './lobby.css',
})
export class Lobby {
  session = inject(GameSessionService);

  copiarCodigo(): void {
    const codigo = this.session.sala()?.codigo;
    if (codigo) {
      navigator.clipboard.writeText(codigo);
    }
  }

  marcarListo(): void {
    this.session.marcarListo();
  }
}