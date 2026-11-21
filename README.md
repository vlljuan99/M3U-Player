# M3U Player

Reproductor IPTV para **iPhone y Windows** con una sola base de código. Es una aplicación web instalable (PWA) más un pequeño servidor proxy en Node.js **sin dependencias**.

Es compatible con:
- **Xtream Codes**: servidor + usuario + contraseña (la forma más completa, con categorías, películas, series y guía EPG).
- **URL M3U / M3U8**: si la URL es del tipo `get.php?username=…&password=…`, la app pasa automáticamente al modo Xtream.

## ¿Por qué un proxy?

Un navegador (Safari en iPhone, Edge o Chrome en Windows) no puede hablar directamente con la mayoría de servidores IPTV:

| Problema | Solución del proxy |
|---|---|
| CORS: el servidor IPTV no permite peticiones desde otras webs | El proxy hace las peticiones por ti |
| Servidor en `http://` y app en `https://` (contenido mixto) | Todo pasa por el mismo origen |
| Redirecciones a balanceadores en otros hosts | Se siguen y las listas HLS se reescriben con URLs firmadas |
| Windows no reproduce `.ts`/HLS de forma nativa | La app carga hls.js o mpegts.js solo cuando hace falta |

Tu usuario y contraseña se guardan **solo en tu dispositivo** (localStorage). El proxy no almacena nada.

## Uso en Windows

1. Instala [Node.js](https://nodejs.org) (versión 18 o superior).
2. Haz doble clic en `start-windows.bat`. Se abrirá `http://localhost:8080`. Por defecto **solo es accesible desde ese PC** y el proxy solo habla con tu proveedor (`IPTV_HOSTS`). Para usarlo también desde el iPhone en tu Wi-Fi, edita el `.bat` y activa `HOST=0.0.0.0` junto con una `ACCESS_KEY`.
3. Introduce el servidor, el usuario y la contraseña.
4. (Opcional) En Edge o Chrome, abre el menú y elige **Instalar M3U Player** para tenerlo como aplicación con su propio icono.

O desde una terminal:

```bash
npm start
```

## Uso en iPhone

El iPhone necesita llegar al proxy. Tienes dos opciones:

**A. En casa (red local):** con el servidor arrancado en tu PC, la consola muestra una dirección del tipo `http://192.168.1.50:8080`. Ábrela en Safari, pulsa **Compartir → Añadir a pantalla de inicio**, y tendrás un icono como si fuera una app.
> Puede que tengas que permitir Node.js en el Firewall de Windows la primera vez.

**B. En cualquier sitio:** despliega el proxy en un NAS, una Raspberry Pi o un VPS, detrás de HTTPS (Caddy, Nginx, Cloudflare Tunnel…), con Docker:

```bash
docker build -t m3u-player .
```

```bash
docker run -d --name m3u-player -p 8080:8080 -e IPTV_HOSTS=mi-proveedor.com:8080 -e ACCESS_KEY=una-clave-larga --restart unless-stopped m3u-player
```

En iPhone los directos se piden en formato HLS (`.m3u8`), que Safari reproduce de forma nativa, en segundo plano y con AirPlay.

## Despliegue en el VPS Hetzner (uso fuera de casa)

Igual que Bigotes y el resto de proyectos: vive en el VPS compartido (`167.233.99.156`), detrás del Caddy de `/opt/tilestudio`, en

**https://iptv.167-233-99-156.sslip.io**

(sslip.io resuelve a la IP del VPS, así que no hace falta comprar dominio y Caddy saca el certificado HTTPS solo).

### Una sola vez: secretos en GitHub

*Settings → Secrets and variables → Actions → New repository secret*:

| Secreto | Qué es |
|---|---|
| `HETZNER_SSH_KEY` | La clave privada SSH del VPS (la misma que en gatitos, tri-dnd…). Los secretos son por repositorio, hay que volver a añadirla aquí. |
| `M3U_ACCESS_KEY` | La clave para entrar en la app (16 caracteres o más). |
| `M3U_IPTV_HOSTS` | `host:puerto` de tu proveedor, p. ej. `proveedor.com:8080` (varios separados por comas). |

### Desplegar

Pestaña **Actions → Deploy to Hetzner → Run workflow**.

- Con **«Solo comprobar el VPS»** marcado, solo informa de disco, memoria, carga y contenedores (en el resumen del job), sin tocar nada.
- Sin marcarlo: comprueba el VPS (falla si quedan menos de 1,5 GB libres), pasa las pruebas, construye la imagen `m3u-player:<sha>` en el servidor, la arranca, recarga Caddy (validando antes su configuración para no afectar a las otras webs), hace un smoke test por HTTPS y comprueba si el VPS llega a tu proveedor. Si algo falla, vuelve a la imagen anterior.

El contenedor está limitado a 256 MB de RAM y 1 CPU, con sistema de ficheros de solo lectura, y se guardan solo las 3 últimas imágenes.

### En el iPhone

Abre la dirección en Safari, introduce la clave de acceso y después tu servidor, usuario y contraseña. Luego **Compartir → Añadir a pantalla de inicio**.

### Operación

```bash
ssh root@167.233.99.156
```

```bash
cd /opt/m3u-player && ./rollback.sh
```

```bash
docker logs --tail 100 m3u-player-app
```

> Algunos proveedores IPTV bloquean IPs de centros de datos o limitan las conexiones simultáneas. Si el workflow avisa de que el VPS no llega al proveedor, esa es la causa probable.

## Configuración (variables de entorno)

| Variable | Para qué sirve |
|---|---|
| `PORT` | Puerto (por defecto `8080`) |
| `HOST` | Interfaz de escucha (por defecto `0.0.0.0`, accesible en tu red) |
| `IPTV_HOSTS` | Hosts permitidos, separados por comas, p. ej. `mi-proveedor.com:8080`. **Recomendado**: sin esta variable el proxy acepta cualquier destino |
| `ACCESS_KEY` | Clave para entrar en la app. **Obligatoria si expones el servidor a Internet** |
| `TRUST_PROXY` | `1` detrás de Caddy/Nginx (limita intentos de clave por IP real) |
| `SECRET` | Secreto para firmar URLs. Si no lo defines, se genera uno al arrancar |
| `USER_AGENT` | User-Agent que se envía al proveedor (algunos lo exigen) |

En Windows puedes descomentar las líneas `set …` de `start-windows.bat`.

## Funciones

- TV en directo, películas y series (temporadas y episodios)
- Categorías, búsqueda instantánea y favoritos
- Guía EPG "Ahora / Después" en los canales en directo
- Canal anterior y siguiente (también con `RePág`/`AvPág`); `F` para pantalla completa y `Esc` para cerrar
- Continúa películas y episodios donde los dejaste
- Varias cuentas guardadas
- Datos de la cuenta: caducidad, conexiones y formatos
- Modo "directo sin proxy" opcional, si tu proveedor permite CORS

## Limitaciones conocidas

- **Formatos de vídeo**: los VOD en `.mkv`/`.avi` con códecs que el navegador no soporta (p. ej. AC3/DTS en Safari, HEVC en algunos Windows) no se podrán reproducir. Es una limitación del navegador, no del proxy.
- En iPhone, los directos solo en `.ts` (sin salida `m3u8` en tu proveedor) no se pueden reproducir en Safari.
- Todo el tráfico de vídeo pasa por el proxy: si lo alojas fuera de casa, ten en cuenta su ancho de banda.

## Desarrollo

```bash
npm test
```

Las pruebas levantan un servidor Xtream simulado y verifican el reenvío de la API, la lista blanca de hosts, el seguimiento de redirecciones, la reescritura y firma de listas HLS, las peticiones `Range` en VOD y la protección contra la salida de la carpeta pública.

```
server/server.js   proxy + servidor de ficheros (Node 18+, sin dependencias)
public/            aplicación web (HTML/CSS/JS), manifiesto PWA y service worker
test/              pruebas con node:test
```
