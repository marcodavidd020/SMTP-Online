'use strict';

const ERRORS = {
  bad: 'Contraseña incorrecta.',
  locked: 'Demasiados intentos fallidos. Espera 15 minutos.',
};

const code = new URLSearchParams(location.search).get('e');
if (ERRORS[code]) {
  const el = document.getElementById('error');
  el.textContent = ERRORS[code];
  el.hidden = false;
}
