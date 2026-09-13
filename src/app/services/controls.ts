import { Injectable } from '@angular/core';

/**
 * Registro del estado del teclado.
 * Los eventos solo ANOTAN teclas; el juego pregunta por estado en cada frame.
 */
@Injectable({ providedIn: 'root' }) // 'root' = una única instancia en toda la app
export class Controls {
  private readonly pressed = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (event) => {
      // Si el usuario está escribiendo en un input (ej: nickname en el lobby),
      // el juego NO debe capturar esas teclas
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Evita que Space haga scroll de la página
      if (event.code === 'Space') {
        event.preventDefault();
      }

      this.pressed.add(event.code);
    });

    window.addEventListener('keyup', (event) => {
      this.pressed.delete(event.code);
    });

    // Si la ventana pierde el foco (alt-tab), soltar todas las teclas:
    // evita un drone "poseído" que sigue volando solo
    window.addEventListener('blur', () => this.pressed.clear());
  }

  /** ¿Está presionada esta tecla ahora mismo? */
  isPressed(code: string): boolean {
    return this.pressed.has(code);
  }
}