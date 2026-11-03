# Bandeja en vivo

Página web protegida con contraseña que muestra **solo los correos que llegan mientras está abierta**.
No muestra el historial: al recargar la página, la lista vuelve a empezar vacía.

Sirve, por ejemplo, para que otras personas vean un código de verificación que llega a una cuenta
compartida, sin darles acceso al resto del correo.

## Por qué no es solo HTML

- **El navegador no puede leer correo por sí mismo.** Hace falta un servidor que se conecte a la cuenta
  por **IMAP**, el protocolo de *lectura* (SMTP solo sirve para *enviar*).
- **Una contraseña escrita en el HTML la puede ver cualquiera** con "Ver código fuente". Aquí la
  contraseña vive en el servidor, como variable de entorno, y nunca llega al navegador.

## Cómo funciona

```
Navegador ──(contraseña, cookie de sesión)──▶ Servidor Node.js ──(IMAP solo lectura)──▶ Tu correo
                 consulta cada 4 s                guarda en memoria solo
                                                  los correos nuevos (máx. 1 h)
```

- El servidor abre el buzón en **modo solo lectura**: no marca correos como leídos ni borra nada.
- Al arrancar, anota cuál es el último correo del buzón y **solo descarga los que llegan después**.
- Cada pestaña abierta solo ve los correos posteriores al momento en que se abrió. Esto lo comprueba
  el servidor, así que no se puede saltar desde el navegador.
- No usa base de datos: todo está en memoria y se pierde al reiniciar el servidor.

## Seguridad incluida

| Riesgo | Protección |
| --- | --- |
| Ver la contraseña en el código | Solo existe en el servidor (variable `APP_PASSWORD`) |
| Probar contraseñas a la fuerza | 5 intentos fallidos por IP → bloqueo de 15 min, más 1 s de espera por fallo |
| Contraseña débil | El servidor no arranca si tiene menos de 12 caracteres |
| Robo de la sesión | Cookie `HttpOnly`, `Secure` y `SameSite=Strict`; caduca a las 8 h |
| Código malicioso dentro de un correo | El HTML del correo se muestra aislado (`sandbox` + CSP): sin scripts ni formularios |
| Ver el historial de correo | El servidor nunca lo descarga |
| Aparecer en Google | `noindex` en todas las páginas |

**Límites a tener en cuenta:**
- Quien entra con la contraseña ve todos los correos nuevos de ese buzón. Para limitarlo, usa
  `FROM_FILTER` (por ejemplo, `FROM_FILTER=netflix.com`).
- Las imágenes de los correos se cargan desde sus servidores de origen, igual que en cualquier lector
  de correo.

## 1. Preparar la cuenta de correo (Gmail)

1. Activa la **verificación en 2 pasos** en tu cuenta de Google.
2. Crea una **contraseña de aplicación** en <https://myaccount.google.com/apppasswords>.
3. Usa esa clave de 16 letras como `IMAP_PASS` (no tu contraseña normal).

Otros proveedores: busca los datos IMAP de tu proveedor (servidor, puerto 993). Las cuentas personales
de Outlook/Hotmail ya no aceptan contraseña por IMAP (exigen OAuth), así que con ellas no funciona tal
cual.

## 2. Probar en tu computadora

Requiere Node.js 22 o superior para `npm run dev` (en el hosting basta con la versión 20).

```bash
npm install
cp .env.example .env          # y rellena los valores
openssl rand -base64 18       # genera una buena APP_PASSWORD
npm run dev
```

Abre <http://localhost:3000>, entra con la contraseña y envíate un correo: aparecerá en unos segundos.

## 3. Publicarlo gratis en Render

1. Sube este proyecto a un repositorio **privado** de GitHub (el `.gitignore` ya excluye `.env`).
2. En <https://render.com>: **New → Web Service** y conecta el repositorio.
3. Configuración:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance type: `Free`
4. En **Environment**, añade `APP_PASSWORD`, `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` (y las opcionales
   que quieras de `.env.example`).
5. Despliega. Render te da una dirección `https://….onrender.com` con HTTPS incluido.

> En el plan gratuito, Render **duerme el servidor tras 15 minutos sin visitas**, y al volver a
> entrar tarda cerca de un minuto en despertar. Mientras la página está abierta, el servidor no se
> duerme. Si la persona suele abrir la página justo *después* de que llegó el código, configura
> `LOOKBACK_MINUTES=3` para incluir los correos de los últimos 3 minutos.
> Las condiciones del plan gratuito pueden cambiar; revísalas en la web de Render.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `APP_PASSWORD` | sí | Contraseña de acceso a la página (mín. 12 caracteres) |
| `IMAP_HOST` | sí | Servidor IMAP, p. ej. `imap.gmail.com` |
| `IMAP_USER` | sí | Dirección de correo |
| `IMAP_PASS` | sí | Contraseña IMAP (en Gmail, contraseña de aplicación) |
| `IMAP_PORT` | no | Por defecto `993` |
| `IMAP_SECURE` | no | `false` para conexiones sin TLS directo. Por defecto `true` |
| `IMAP_MAILBOX` | no | Carpeta a vigilar. Por defecto `INBOX` |
| `LOOKBACK_MINUTES` | no | Incluir correos de los últimos N minutos al abrir la página. Por defecto `0` |
| `FROM_FILTER` | no | Solo remitentes que contengan alguno de estos textos, separados por comas |
| `TRUST_PROXY` | no | Número de proxies delante del servidor. Por defecto `1` (Render) |

Para cambiar la contraseña de acceso, cambia `APP_PASSWORD` en Render y redespliega: todas las
sesiones abiertas se cierran.

## Archivos

```
server.js      Servidor web: login, sesiones, límite de intentos, API
mail.js        Conexión IMAP en vivo y memoria temporal de correos nuevos
views/         Páginas HTML (solo se entregan pasando por el login)
public/        CSS y JavaScript del navegador (sin datos sensibles)
```
# SMTP-Online
