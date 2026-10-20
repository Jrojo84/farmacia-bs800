# Farmacia BS N° 800 · Aviación del Ejército — Puesta en marcha

App web (funciona en celular y se puede "instalar") para despacho, ingreso y control mensual de medicamentos. Usa Firebase (gratis) para usuarios y datos.

## 1. Crear el proyecto en Firebase
1. Entra a https://console.firebase.google.com → **Agregar proyecto** (puedes desactivar Analytics).
2. **Authentication** → Comenzar → Método de acceso → habilita **Correo electrónico/contraseña**.
3. **Firestore Database** → Crear base de datos → modo **producción** → región `southamerica-east1` (o la más cercana).
4. **Firestore → Reglas**: borra lo que haya, pega el contenido de `firestore.rules` y **Publicar**.
5. **Configuración del proyecto (⚙) → Tus apps → Web (</>)**: registra la app y copia el objeto `firebaseConfig` en `js/config.js`.

## 2. Crear tu cuenta de administrador
En **Authentication → Users → Agregar usuario**:
- Correo: `admin@farmacia.app`
- Contraseña: la que tú elijas

En la app ingresas con usuario **admin** y esa contraseña. Las demás cuentas las creas desde la pestaña **Usuarios** de la app.

> Si cambias `ADMIN_USUARIO` o `DOMINIO` en `js/config.js`, cambia también el correo en `firestore.rules` y vuelve a publicarlas.

## 3. Escudos
Copia en la carpeta `img/`: `logo-aviacion.png`, `logo-bs800.png` y `logo-sanidad.png` (este último es la marca de agua).

## Probar sin Firebase (modo demostración)
Mientras `js/config.js` diga `PEGAR_AQUI`, la app funciona con datos de ejemplo guardados solo en el navegador.
Ejecuta `python3 -m http.server 8080` en la carpeta y abre http://localhost:8080 — usuarios `admin` / `admin123` y `tecnico` / `demo123`.

## 4. Publicar (Firebase Hosting)
```bash
npm install -g firebase-tools
firebase login
cd farmacia-sanidad
firebase init hosting     # proyecto existente · carpeta pública: .  · single-page: No · no sobrescribir index.html
firebase deploy
```
Te dará una dirección tipo `https://tu-proyecto.web.app`. Ábrela en el celular → menú del navegador → **Agregar a pantalla de inicio**.

Para probar en tu computadora antes de publicar: `npx serve .` y abre la dirección que muestra (no funciona abriendo el `index.html` con doble clic).

## 5. Cargar los medicamentos
En **Ingreso → + Nuevo medicamento**:
- **Medicamento**: el nombre con su gramaje (ej. "Paracetamol 500 mg"). Al escribir aparecen los que **ya existen**; si es el mismo, usa **Ingresar stock**.
- **Presentación**: se elige de una lista fija y se muestra abreviada y larga (ej. "TAB - Tableta").
- **Vía**: opcional.
- **Stock inicial**: empieza en 0; si pones una cantidad, pide N° de acta y fecha de caducidad.
- Una vez creado, **el medicamento no se puede modificar**. Otro gramaje u otra presentación = medicamento nuevo.

Las listas de presentaciones y vías están al final de `js/config.js`; para agregar una opción, añádela ahí.

## 6. "Olvidé mi contraseña" (función del servidor)
Una página web no puede cambiar la contraseña de otra persona; por eso hay una pequeña función en `functions/index.js` que solo el administrador puede usar.
1. En Firebase: **Uso y facturación → Modificar plan → Blaze** (pide una tarjeta; trae un uso gratuito mensual y esta función prácticamente no genera costo). Conviene crear una **alerta de presupuesto** (por ejemplo US$ 1).
2. En la computadora, dentro de la carpeta del proyecto:
```bash
npm install -g firebase-tools
firebase login
firebase use --add            # elige tu proyecto
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```
**Cómo se usa:** el usuario toca **¿Olvidaste tu contraseña?** y escribe usuario y DNI. Al administrador le aparece la solicitud en **Usuarios** (número rojo en el menú). **Enviar contraseña** genera una temporal y abre WhatsApp con el mensaje para su celular registrado. Al entrar con ella, la app le obliga a crear una nueva.

## Cuentas
- Cualquiera puede **registrarse** desde la pantalla de inicio con nombre, DNI, celular, usuario y contraseña.
- La cuenta queda **pendiente** hasta que el administrador la apruebe en **Usuarios** (número rojo en el menú).

## Avisos (solo administrador, abajo de la pantalla)
- Al ingresar se avisa de los medicamentos que **vencen en 2 meses o menos**. El aviso dura **10 segundos**; si alguno vence en **1 mes o menos** (o ya venció), dura **1 minuto**.
- Solo se sugiere **eliminar** un medicamento agotado si **no se abasteció en más de un año** desde el último abastecimiento general.
- **Anular** y **Corregir** un ingreso solo se pueden hacer **el mismo día** en que se registró.
- **Deshacer**: justo después de ingresar stock o crear un medicamento aparece "¿Te equivocaste? Deshacer" (20 s). Después, en **Movimientos** cada ingreso tiene **Anular**: descuenta ese stock y queda registrado como anulación (no se borra el historial). No se puede anular si ya se despachó parte de ese ingreso.
- No se puede ingresar con fecha de caducidad anterior a hoy.
- **Corregir**: si un ingreso ya no se puede anular (porque se despachó parte), en Movimientos usa **Corregir** para poner la cantidad y el N° de acta correctos. La cantidad no puede ser menor que lo ya despachado; queda registrado como "Corrección".
- **Lotes vencidos**: no se pueden despachar. El administrador ve el botón rojo **Baja** en esa fila: lo saca del stock como "Baja (vencido)", en la fecha que indiques (cuenta como salida en el mes de esa fecha).

## Secciones (menú lateral)
| Sección | Quién | Qué hace |
|---|---|---|
| **Despacho** | Todos | Paciente con DNI, **grado** (lista en `js/config.js`) y nombre y apellido. Tabla (una fila por fecha de vencimiento, la más próxima sombreada) + **+**: cantidad que sale y, en el primero, DNI y nombre y apellido del paciente. Se arma la lista del paciente arriba, se sigue buscando abajo y al final **Despachar → Conforme**. |
| **Ingreso** | Admin | Tabla + botón **+**: N° de acta de entrega, cantidad, fecha de caducidad; muestra total anterior y total actual. Avisa si queda con dos fechas. |
| **Control visible** | Todos | Tabla + **Ver**: saldo anterior, sale, ingresa y saldo total por mes (cierre el **25**), el último mes primero, desde enero de 2026. |
| **Movimientos** | Todos | Todo lo que entró y salió en el mes, el último primero. Columnas: N° de movimiento (1 = el primero del mes), fecha (dd/mm/aa), hora (24 h), movimiento, medicamento, vence, cantidad, saldo, responsable, **paciente** y **acta de entrega**. **Descargar PDF**: total general del mes o por medicamento. |
| **Usuarios** | Todos | Admin: datos de todas las cuentas y aprobación. Usuario: sus propios datos. |

La tabla principal es la misma en todas, en orden alfabético y numerada en ese orden (N° 1 = primero alfabéticamente): medicamento, unidad de medida, presentación, una fila por fecha de caducidad con su stock (la más próxima sombreada) y el total del medicamento. En amarillo lo que vence en menos de 90 días, en rojo lo vencido.
El historial de movimientos no se puede editar ni borrar. El día de cierre y el mes de inicio se cambian en `js/config.js`.
