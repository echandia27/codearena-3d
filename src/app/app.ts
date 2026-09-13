import { Component } from '@angular/core';
import { Arena } from './arena/arena';

@Component({
  selector: 'app-root',
  imports: [Arena],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}