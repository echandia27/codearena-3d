import { Component, inject } from '@angular/core';
import { GameSessionService, TEMAS_VALIDOS } from '../../services/game-session.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  session = inject(GameSessionService);
  temas = TEMAS_VALIDOS;

  crear(nickname: HTMLInputElement, tema: HTMLSelectElement): void {
    this.session.crearSala(nickname.value.trim(), tema.value);
  }

  unirse(codigo: HTMLInputElement, nickname: HTMLInputElement): void {
    this.session.unirseSala(
      codigo.value.trim().toUpperCase(),
      nickname.value.trim(),
    );
  }
}