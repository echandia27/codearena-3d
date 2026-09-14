import { Component, inject } from '@angular/core';
import { Arena } from './arena/arena';
import { Home } from './pages/home/home';
import { Lobby } from './pages/lobby/lobby';
import { Resultados } from './pages/resultados/resultados';
import { GameSessionService } from './services/game-session.service';

@Component({
  selector: 'app-root',
  imports: [Arena, Home, Lobby, Resultados],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  session = inject(GameSessionService);
}