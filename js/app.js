import {
  activarAppCheck,
  initializeApp, getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, updatePassword,
  getFunctions, httpsCallable, initializeFirestore, getFirestore, persistentLocalCache, collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, runTransaction, writeBatch, serverTimestamp, Timestamp,
} from "./firebase.js";
import {
  firebaseConfig, ADMIN_USUARIO, DOMINIO, MES_INICIO, DIA_CIERRE, STOCK_BAJO, DIAS_POR_VENCER,
  VIAS, PRESENTACIONES, GRADOS, RECAPTCHA_ENTERPRISE,
} from "./config.js";

const app = initializeApp(firebaseConfig);
activarAppCheck(app, RECAPTCHA_ENTERPRISE);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: persistentLocalCache() });
// Cloud Function del administrador para poner una contraseña temporal (functions/index.js)
const restablecerClave = httpsCallable(getFunctions(app), "restablecerClave");

// Segunda instancia: crea cuentas en el registro sin tocar la sesión principal.
const appSecundaria = initializeApp(firebaseConfig, "secundaria");
activarAppCheck(appSecundaria, RECAPTCHA_ENTERPRISE); // el registro también pasa por App Check
const authSecundaria = getAuth(appSecundaria);
const dbSecundaria = getFirestore(appSecundaria);

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
const estado = {
  usuario: null,        // { uid, nombre, dni, celular, usuario, admin }
  meds: [],             // { nombre (con gramaje), unidad (abreviatura), presentacion, via, lotes:[{venc,cant}], stock }
  movs: [],             // movimientos desde MES_INICIO
  usuarios: [],
  recuperaciones: [],   // solicitudes de "olvidé mi contraseña" (solo admin)
  despacho: { paciente: null, items: [] },  // pedido en curso: items [{ medId, venc, cant }]
  periodoMov: null,     // mes elegido en Movimientos
  seccion: "despacho",
};
let desuscribir = [];

const $ = (id) => document.getElementById(id);
const correoDe = (u) => `${u.trim().toLowerCase()}@${DOMINIO}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const medPorId = (id) => estado.meds.find((m) => m.id === id);
const suma = (l) => l.reduce((s, x) => s + x.cant, 0);
/** Presentación abreviada y larga: "TAB - Tableta". */
const presDe = (m) => [m?.unidad, m?.presentacion].filter(Boolean).join(" - ");

// Validaciones de los formularios
const DNI_OK = /^\d{8}$/;
const NOMBRE_OK = /^\S+(\s+\S+)+$/; // al menos nombre y apellido

/** Campo que solo acepta números enteros (sin flechas, sin decimales). */
function soloEnteros(inp) {
  inp.addEventListener("input", () => {
    const v = inp.value.replace(/\D/g, "");
    if (v !== inp.value) inp.value = v;
  });
}
document.querySelectorAll("input.entero").forEach(soloEnteros);
const campoEntero = (id, extra = "") =>
  `<input id="${id}" class="entero" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" ${extra}>`;

function toast(msg, error = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("oculto"), 3500);
}

/** Mensaje grande de confirmación ("Se despachó…", "Se ingresó…"). */
function exito(msg) {
  $("exito-msg").textContent = msg;
  $("exito").classList.remove("oculto");
  clearTimeout(exito._t);
  exito._t = setTimeout(() => $("exito").classList.add("oculto"), 2500);
}
$("exito").addEventListener("click", () => $("exito").classList.add("oculto"));

// ---------------------------------------------------------------------
// Fechas de caducidad y lotes
// ---------------------------------------------------------------------
const porVenc = (a, b) => (a.venc || "9999").localeCompare(b.venc || "9999");

/** Lotes con stock, ordenados por caducidad (el que vence primero va primero). */
function lotesDe(m) {
  const l = Array.isArray(m.lotes) ? m.lotes : m.stock > 0 ? [{ venc: "", cant: m.stock }] : [];
  return l.filter((x) => x.cant > 0).map((x) => ({ ...x })).sort(porVenc);
}

function fechaCorta(iso) {
  if (!iso) return "Sin fecha";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function estadoVenc(iso) {
  if (!iso) return "";
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dias = (new Date(iso + "T00:00") - hoy) / 864e5;
  return dias < 0 ? "vencido" : dias <= DIAS_POR_VENCER ? "por-vencer" : "";
}

// En celular el año se muestra con dos dígitos (30/06/27) para que la tabla quepa
// Fecha de caducidad fácil de elegir con el dedo: día (opcional), mes y año
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"];
function campoFecha(id, iso = "", { pasado = false } = {}) {
  const [y, m, d] = iso ? iso.split("-").map(Number) : [0, 0, 0];
  const hoy = new Date().getFullYear();
  // Caducidad: desde este año en adelante. Fecha pasada (baja): desde MES_INICIO hasta hoy
  const base = pasado
    ? Array.from({ length: hoy - +MES_INICIO.slice(0, 4) + 1 }, (_, i) => +MES_INICIO.slice(0, 4) + i)
    : Array.from({ length: 12 }, (_, i) => hoy + i);
  const anios = [...new Set([...base, ...(y ? [y] : [])])].sort();
  const opt = (v, txt, sel) => `<option value="${v}"${sel ? " selected" : ""}>${txt}</option>`;
  return `<div class="fecha-sel" id="${id}">
    <select data-p="d" aria-label="Día">${opt("", "Día")}${Array.from({ length: 31 }, (_, i) => opt(i + 1, i + 1, d === i + 1)).join("")}</select>
    <select data-p="m" aria-label="Mes">${opt("", "Mes")}${MESES.map((n, i) => opt(i + 1, n, m === i + 1)).join("")}</select>
    <select data-p="a" aria-label="Año">${opt("", "Año")}${anios.map((a) => opt(a, a, y === a)).join("")}</select>
  </div>`;
}
const hoyISO = () => new Date().toLocaleDateString("en-CA"); // AAAA-MM-DD local

/** AAAA-MM-DD; sin día se toma el último del mes (como "EXP 03/2027"). */
function leerFecha(cont) {
  const v = (p) => +cont.querySelector(`[data-p=${p}]`).value;
  const d = v("d"), m = v("m"), a = v("a");
  if (!m || !a) return "";
  const ultimo = new Date(a, m, 0).getDate();
  return `${a}-${String(m).padStart(2, "0")}-${String(d ? Math.min(d, ultimo) : ultimo).padStart(2, "0")}`;
}

const htmlFecha = (venc) => `<span class="fecha ${estadoVenc(venc)}">${venc ? fechaCorta(venc).replace(/\/(\d\d)(\d\d)$/, "/<span class=\"siglo\">$1</span>$2") : "Sin fecha"}</span>`;

/** Ficha corta del medicamento: nombre, presentación, vencimiento y stock. */
function fichaLote(m, venc, stock) {
  return `<div class="ficha">
    <div class="ficha-nombre">${esc(m.nombre)}</div>
    <div class="ficha-datos">
      <div><small>Presentación</small><b>${esc(presDe(m)) || "—"}</b></div>
      ${venc !== null ? `<div><small>Vence</small><b>${htmlFecha(venc)}</b></div>` : ""}
      <div><small>Stock actual</small><b class="grande">${stock}</b></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------
// Períodos: cierran el día DIA_CIERRE. "2026-02" = 26/01/2026 al 25/02/2026
// ---------------------------------------------------------------------
function periodoDe(d = new Date()) {
  let y = d.getFullYear(), m = d.getMonth() + 1;
  if (d.getDate() > DIA_CIERRE) { m++; if (m > 12) { m = 1; y++; } }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function periodoAnterior(key) {
  let [y, m] = key.split("-").map(Number);
  if (--m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
/** Desde el actual hasta MES_INICIO, el más reciente primero. */
function periodos() {
  const r = [];
  for (let k = periodoDe(); k >= MES_INICIO; k = periodoAnterior(k)) r.push(k);
  return r;
}
function periodoNombre(key) {
  const [y, m] = key.split("-").map(Number);
  const t = new Date(y, m - 1, 1).toLocaleDateString("es-PE", { month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function periodoRango(key) {
  const [y, m] = key.split("-").map(Number);
  const f = (d) => d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${f(new Date(y, m - 2, DIA_CIERRE + 1))} al ${f(new Date(y, m - 1, DIA_CIERRE))}`;
}

// ---------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------
function abrirModal(titulo, html, ancho = false) {
  $("modal-titulo").textContent = titulo;
  $("modal-cuerpo").innerHTML = html;
  $("modal").classList.toggle("ancho", ancho);
  $("modal").classList.remove("oculto");
  $("modal-cuerpo").querySelectorAll("input.entero").forEach(soloEnteros);
  return $("modal-cuerpo");
}
function cerrarModal() {
  $("modal").classList.remove("obligatorio");
  $("modal").classList.add("oculto");
  $("modal-cuerpo").innerHTML = "";
}
$("modal").addEventListener("click", (e) => {
  if ($("modal").classList.contains("obligatorio")) return;
  if (e.target.id === "modal" || e.target.closest("[data-cerrar]")) cerrarModal();
});

// ---------------------------------------------------------------------
// Búsqueda: reduce la tabla; si no hay coincidencias, sugiere parecidos
// ---------------------------------------------------------------------
function textoMed(m) {
  return norm(`${m.nombre} ${m.presentacion} ${m.via} ${m.unidad} ${numeroDe(m)}`);
}
function bigramas(s) {
  const r = new Set();
  for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2));
  return r;
}
function similitud(a, b) {
  const A = bigramas(a), B = bigramas(b);
  if (!A.size || !B.size) return 0;
  let c = 0;
  A.forEach((x) => B.has(x) && c++);
  return (2 * c) / (A.size + B.size);
}

const alfabetico = (a, b) =>
  a.nombre.localeCompare(b.nombre, "es") || (a.presentacion || "").localeCompare(b.presentacion || "", "es");

// El N° es la posición en orden alfabético (Amoxicilina = 1, …); se recalcula al cambiar la lista
let numeros = new Map();
function renumerar() {
  numeros = new Map([...estado.meds].sort(alfabetico).map((m, i) => [m.id, i + 1]));
}
const numeroDe = (m) => (m && numeros.get(m.id)) ?? "";

/** Devuelve { lista, aproximado } en orden alfabético. */
function buscar(q) {
  const qn = norm(q).trim();
  if (!qn) return { lista: [...estado.meds].sort(alfabetico), aproximado: false };

  const palabras = qn.split(/\s+/);
  const lista = estado.meds.filter((m) => palabras.every((p) => textoMed(m).includes(p))).sort(alfabetico);
  if (lista.length) return { lista, aproximado: false };

  // Sin coincidencias exactas: sugerir los nombres más parecidos (errores de tipeo)
  const aprox = estado.meds
    .map((m) => ({ m, s: similitud(qn, norm(m.nombre).slice(0, Math.max(qn.length + 2, 4))) }))
    .filter((x) => x.s > 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map((x) => x.m);
  return { lista: aprox, aproximado: true };
}

function resaltar(texto, q) {
  const qn = norm(q).trim();
  if (!qn) return esc(texto);
  const t = String(texto);
  const i = norm(t).indexOf(qn.split(/\s+/)[0]);
  if (i < 0) return esc(t);
  const L = qn.split(/\s+/)[0].length;
  return esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + L)) + "</mark>" + esc(t.slice(i + L));
}

// =====================================================================
//  TABLA PRINCIPAL: una fila por fecha de vencimiento
//  (un medicamento con dos fechas aparece dos veces; la más próxima va
//  primero y sombreada)
// =====================================================================
const ACCION = {
  despacho: {
    titulo: "Despachar",
    boton: (f) => f.venc && estadoVenc(f.venc) === "vencido"
      // Vencido: no se puede despachar. El admin lo da de baja; los demás lo ven bloqueado
      ? (estado.usuario?.admin && f.cant > 0
        ? `<button class="btn baja" data-baja title="Dar de baja (vencido)">Baja</button>`
        : `<button class="btn primario mas" data-accion disabled title="Vencido: no se puede despachar">+</button>`)
      : `<button class="btn primario mas" data-accion ${f.cant > 0 ? "" : "disabled"} title="Despachar">+</button>`,
  },
  ingreso: { titulo: "Ingresar", boton: () => `<button class="btn primario mas" data-accion title="Ingresar">+</button>` },
  control: { titulo: "Control", boton: () => `<button class="btn ver" data-accion>Ver</button>` },
};

// Tablas por páginas para que carguen rápido aunque haya muchos medicamentos
const POR_PAGINA = 20;
const pagina = { despacho: 1, ingreso: 1, control: 1 };

function paginador(sec, pag, total) {
  const paginas = Math.ceil(total / POR_PAGINA);
  if (paginas <= 1) return `<p class="nota centro">${total} medicamento(s)</p>`;
  const desde = (pag - 1) * POR_PAGINA + 1, hasta = Math.min(pag * POR_PAGINA, total);
  // Números visibles: primera, última y las cercanas a la actual
  const nums = [...new Set([1, pag - 1, pag, pag + 1, paginas])].filter((n) => n >= 1 && n <= paginas).sort((a, b) => a - b);
  let previo = 0;
  const botones = nums.map((n) => {
    const salto = n - previo > 1 ? `<span class="pag-salto">…</span>` : "";
    previo = n;
    return `${salto}<button class="btn pag${n === pag ? " actual" : ""}" data-pag="${n}">${n}</button>`;
  }).join("");
  return `<div class="paginador">
    <button class="btn pag flecha" data-pag="${pag - 1}" ${pag === 1 ? "disabled" : ""} title="Anterior">◀</button>
    ${botones}
    <button class="btn pag flecha" data-pag="${pag + 1}" ${pag === paginas ? "disabled" : ""} title="Siguiente">▶</button>
  </div>
  <p class="nota centro">Medicamentos ${desde} a ${hasta} de ${total}</p>`;
}

function pintarTablaMeds(sec) {
  const q = $(`buscar-${sec}`).value;
  const cont = $(`lista-${sec}`);
  const { lista, aproximado } = buscar(q);
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  const pag = (pagina[sec] = Math.min(Math.max(1, pagina[sec]), paginas));
  if (!lista.length) {
    cont.innerHTML = `<p class="vacio">${estado.meds.length ? "Sin resultados" : "Aún no hay medicamentos registrados"}</p>`;
    return;
  }
  const a = ACCION[sec];
  // Lo que ya está en el pedido de despacho se descuenta del stock que se muestra
  const reservado = (m, venc) => sec !== "despacho" ? 0 : suma(estado.despacho.items.filter((x) => x.medId === m.id && x.venc === venc));
  const cuerpo = lista.slice((pag - 1) * POR_PAGINA, pag * POR_PAGINA).map((m) => {
    const lotes = lotesDe(m);
    const filas = lotes.length ? lotes : [null];
    const n = filas.length;
    return filas.map((l, i) => {
      const venc = l ? l.venc : null;
      const cant = l ? l.cant : 0;
      const disp = cant - reservado(m, venc);
      const proximo = i === 0 && n > 1;
      // N°, nombre y presentación una sola vez por medicamento; una fila por fecha
      const datos = i > 0 ? "" : `
        <td class="num n" rowspan="${n}">${numeroDe(m)}</td>
        <td class="nombre" rowspan="${n}">${resaltar(m.nombre, q)}
          <small class="solo-movil">${esc(presDe(m))}</small>
          ${n > 1 ? `<small class="total-med">Total: <b>${m.stock ?? 0}</b></small>` : ""}</td>
        <td class="col-pres" rowspan="${n}">${esc(presDe(m))}</td>`;
      return `<tr data-med="${m.id}" data-venc="${venc ?? ""}" data-lote="${venc !== null}" class="${proximo ? "proximo" : ""}${i === n - 1 ? " fin" : ""}">
        ${datos}
        <td class="fechas lc">${venc === null ? `<span class="nota">—</span>` : htmlFecha(venc)}${proximo ? `<small class="prox">vence primero</small>` : ""}</td>
        <td class="num stock lc${(m.stock ?? 0) <= STOCK_BAJO ? " bajo" : ""}">${disp}${disp !== cant ? `<small>de ${cant}</small>` : ""}</td>
        ${sec === "control"
          ? (i === 0 ? `<td class="accion" rowspan="${n}">${a.boton({ cant: disp, venc })}</td>` : "")
          : `<td class="accion lc">${a.boton({ cant: disp, venc })}</td>`}
      </tr>`;
    }).join("");
  }).join("");
  cont.innerHTML =
    (aproximado ? `<p class="nota">No hay coincidencia exacta. ¿Quisiste decir…?</p>` : "") +
    `<div class="tabla-wrap"><table class="tabla meds ${sec}">
      <thead><tr><th>N°</th><th>Medicamento</th><th class="col-pres">Presentación</th>
        <th>F. caducidad</th><th class="num">Stock actual</th><th class="accion">${a.titulo}</th></tr></thead>
      <tbody>${cuerpo}</tbody>
    </table></div>` + paginador(sec, pag, lista.length);
}

const ABRIR = { despacho: abrirDespacho, ingreso: abrirIngreso, control: (m) => abrirControl(m) };
for (const sec of ["despacho", "ingreso", "control"]) {
  $(`buscar-${sec}`).addEventListener("input", () => { pagina[sec] = 1; pintarTablaMeds(sec); });
  $(`lista-${sec}`).addEventListener("click", (e) => {
    const p = e.target.closest("[data-pag]");
    if (p) {
      if (p.disabled) return;
      pagina[sec] = +p.dataset.pag;
      pintarTablaMeds(sec);
      $(`buscar-${sec}`).scrollIntoView({ block: "start" });
      return;
    }
    const baja = e.target.closest("[data-baja]");
    if (baja) {
      const trB = baja.closest("tr[data-med]");
      return abrirBaja(medPorId(trB.dataset.med), trB.dataset.venc);
    }
    // En Control toda la fila abre el historial; en Despacho e Ingreso solo el botón +
    const b = e.target.closest("[data-accion]");
    const tr = sec === "control" ? e.target.closest("tr[data-med]") : b?.closest("tr[data-med]");
    if (!tr || b?.disabled) return;
    ABRIR[sec](medPorId(tr.dataset.med), tr.dataset.lote === "true" ? tr.dataset.venc : null);
  });
}

/** Limpia el buscador y vuelve a la tabla general. */
function volverATabla(sec) {
  $(`buscar-${sec}`).value = "";
  pagina[sec] = 1;
  if (sec === "despacho") pintarDespacho(); else pintarTablaMeds(sec);
  window.scrollTo(0, 0);
}

// =====================================================================
//  DESPACHO: pedido por paciente
//  1) + en una fila → cantidad (y paciente, si es el primero) → Agregar
//  2) arriba se arma la lista; abajo se sigue buscando y agregando
//  3) Despachar → Conforme
// =====================================================================
function pintarDespacho() {
  const { paciente, items } = estado.despacho;
  const u = estado.usuario;
  $("despacho-curso").innerHTML = !items.length ? "" : `
    <div class="pedido">
      <div class="pedido-cab">
        <div><small>Paciente</small><b>${esc(paciente.grado)} ${esc(paciente.nombre)}</b><span>DNI ${esc(paciente.dni)}</span></div>
        <div><small>Despachado por</small><b>${esc(u.nombre)}</b></div>
      </div>
      <div class="tabla-wrap"><table class="tabla pedido-tabla">
        <thead><tr><th>N°</th><th>Medicamento</th><th>Vence</th><th class="num">Saldo</th><th class="num">Sale</th>
          <th class="num">Queda</th><th></th></tr></thead>
        <tbody>${items.map((it, i) => {
          const m = medPorId(it.medId);
          const saldo = m ? lotesDe(m).find((l) => l.venc === it.venc)?.cant ?? 0 : 0;
          const previo = suma(items.slice(0, i).filter((x) => x.medId === it.medId && x.venc === it.venc));
          const queda = saldo - previo - it.cant;
          return `<tr>
            <td class="num">${i + 1}</td>
            <td class="nombre">${esc(m?.nombre ?? "—")}<small>${esc(presDe(m))}</small><small class="solo-movil">Vence ${fechaCorta(it.venc)}</small></td>
            <td>${htmlFecha(it.venc)}</td>
            <td class="num">${saldo - previo}</td>
            <td class="num des">−${it.cant}</td>
            <td class="num total${queda < 0 ? " bajo" : ""}">${queda}</td>
            <td class="accion"><button class="btn quitar" data-quitar="${i}" title="Quitar" aria-label="Quitar">✕</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <div class="pedido-botones">
        <button id="btn-despachar" class="btn primario grande">Despachar (${items.length})</button>
        <button id="pedido-vaciar" class="btn vaciar">Eliminar todo</button>
      </div>
      <p class="nota centro pedido-nota">Busca abajo para seguir agregando medicamentos a este paciente.</p>
    </div>`;
  pintarTablaMeds("despacho");
}

$("despacho-curso").addEventListener("click", (e) => {
  const i = e.target.closest("[data-quitar]")?.dataset.quitar;
  if (i != null) {
    estado.despacho.items.splice(+i, 1);
    if (!estado.despacho.items.length) estado.despacho.paciente = null; // sin ítems se puede elegir otro paciente
    return pintarDespacho();
  }
  if (e.target.closest("#pedido-vaciar")) {
    if (confirm("¿Eliminar todo el despacho en curso?")) { estado.despacho = { paciente: null, items: [] }; pintarDespacho(); }
  }
  if (e.target.closest("#btn-despachar")) confirmarDespacho();
});

/** Pacientes de despachos anteriores (el más reciente primero), sin repetir DNI. */
function pacientesAnteriores() {
  const vistos = new Map();
  [...estado.movs].filter((x) => x.tipo === "despacho" && x.pacienteNombre)
    .sort((a, b) => (b.fecha?.seconds ?? 0) - (a.fecha?.seconds ?? 0))
    .forEach((x) => { const k = x.pacienteDni || x.pacienteNombre; if (!vistos.has(k)) vistos.set(k, { dni: x.pacienteDni || "", grado: x.pacienteGrado || "", nombre: x.pacienteNombre }); });
  return [...vistos.values()];
}
/** Sugerencias del formulario: solo pacientes ya atendidos (no los contactos del celular). */
function listasPacientes() {
  const ps = pacientesAnteriores().slice(0, 300);
  return `<datalist id="dl-pacientes">${[...new Set(ps.map((p) => p.nombre))].map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    <datalist id="dl-dni">${ps.filter((p) => p.dni).map((p) => `<option value="${esc(p.dni)}">${esc([p.grado, p.nombre].filter(Boolean).join(" "))}</option>`).join("")}</datalist>`;
}

function abrirDespacho(m, venc) {
  const { paciente, items } = estado.despacho;
  const lote = lotesDe(m).find((l) => l.venc === venc);
  if (!lote) return toast("Ese lote ya no tiene stock", true);
  if (estadoVenc(venc) === "vencido") return toast("Ese lote está vencido: no se puede despachar", true);
  const yaEnPedido = suma(items.filter((x) => x.medId === m.id && x.venc === venc));
  const disponible = lote.cant - yaEnPedido;
  const primero = !paciente;
  const c = abrirModal("Despacho", `
    ${fichaLote(m, venc, disponible)}
    ${yaEnPedido ? `<p class="nota centro">Ya hay ${yaEnPedido} de este lote en el despacho.</p>` : ""}
    <form id="f-desp" novalidate>
      <label>Cantidad que sale${campoEntero("cant", 'maxlength="6"')}</label>
      ${primero ? `
        <div class="fila">
          <label>DNI del paciente${campoEntero("pac-dni", 'maxlength="8" list="dl-dni"')}</label>
          <label>Grado<select id="pac-grado"><option value="">Selecciona…</option>${GRADOS.map((g) => `<option>${esc(g)}</option>`).join("")}</select></label>
        </div>
        <label>Nombre y apellido del paciente<input id="pac-pn" list="dl-pacientes" autocomplete="off" autocorrect="off" spellcheck="false" data-form-type="other"></label>
        ${listasPacientes()}` : ""}
      <div class="responsable"><small>Despachado por</small><b>${esc(estado.usuario.nombre)}</b></div>
      <p id="desp-error" class="error"></p>
      <div class="fila botones">
        <button type="button" class="btn grande" data-cerrar>Cancelar</button>
        <button class="btn primario grande" type="submit">Agregar</button>
      </div>
    </form>`);
  c.querySelector("#cant").focus();
  // Al escribir un DNI que ya se atendió, se completan el grado y el nombre
  c.querySelector("#pac-dni")?.addEventListener("input", (ev) => {
    if (ev.target.value.length !== 8) return;
    const p = pacientesAnteriores().find((x) => x.dni === ev.target.value);
    if (!p) return;
    if (GRADOS.includes(p.grado)) c.querySelector("#pac-grado").value = p.grado;
    c.querySelector("#pac-pn").value = p.nombre;
  });
  c.querySelector("#f-desp").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const err = (msg) => { c.querySelector("#desp-error").textContent = msg; };
    const cant = parseInt(c.querySelector("#cant").value, 10);
    if (!(cant > 0)) return err("Escribe la cantidad que sale");
    if (cant > disponible) return err(`Solo hay ${disponible} disponibles de este lote`);
    if (primero) {
      const dni = c.querySelector("#pac-dni").value.trim();
      const nombre = c.querySelector("#pac-pn").value.trim().replace(/\s+/g, " ");
      const grado = c.querySelector("#pac-grado").value;
      if (!DNI_OK.test(dni)) return err("El DNI debe tener 8 dígitos");
      if (!NOMBRE_OK.test(nombre)) return err("Escribe nombre y apellido (separados por un espacio)");
      if (!grado) return err("Elige el grado del paciente");
      estado.despacho.paciente = { dni, grado, nombre };
    }
    const ya = items.find((x) => x.medId === m.id && x.venc === venc);
    ya ? (ya.cant += cant) : items.push({ medId: m.id, venc, cant });
    cerrarModal();
    volverATabla("despacho");
    toast(`${m.nombre}: ${cant} agregado al despacho`);
  });
}

function confirmarDespacho() {
  const { paciente, items } = estado.despacho;
  const u = estado.usuario;
  const total = suma(items);
  const c = abrirModal("Confirmar despacho", `
    <div class="confirmar">
      <div><small>Paciente</small><b>${esc(paciente.grado)} ${esc(paciente.nombre)}</b> · DNI ${esc(paciente.dni)}</div>
      <div><small>Despachado por</small><b>${esc(u.nombre)}</b></div>
    </div>
    <ul class="resumen">${items.map((it) => {
      const m = medPorId(it.medId);
      return `<li><div><b>${esc(m?.nombre)}</b><small>${esc(presDe(m))} · vence ${fechaCorta(it.venc)}</small></div><span class="cant">−${it.cant}</span></li>`;
    }).join("")}</ul>
    <p class="centro"><b>${items.length}</b> medicamento(s) · <b>${total}</b> unidades</p>
    <div class="fila botones">
      <button type="button" class="btn grande" data-cerrar>Cancelar</button>
      <button id="conforme" class="btn primario grande">Conforme</button>
    </div>`);
  c.querySelector("#conforme").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    try {
      await registrarMovimientos("despacho", items, { pacienteNombre: paciente.nombre, pacienteDni: paciente.dni, pacienteGrado: paciente.grado });
      estado.despacho = { paciente: null, items: [] };
      cerrarModal();
      volverATabla("despacho");
      exito(`Se despachó ${total} unidad(es) a ${paciente.grado} ${paciente.nombre}`);
    } catch (err) {
      ev.target.disabled = false;
      toast(err.message || "Error al registrar", true);
    }
  });
}

/**
 * Ajusta los lotes y el stock y guarda un movimiento por ítem, todo o nada.
 * items: [{ medId, cant, venc }] — ingreso suma a ese lote (o lo crea); despacho lo descuenta.
 */
async function registrarMovimientos(tipo, items, extra = {}) {
  const u = estado.usuario;
  const periodo = periodoDe();
  const creados = [];
  await runTransaction(db, async (tx) => {
    creados.length = 0; // la transacción puede reintentarse
    const ids = [...new Set(items.map((x) => x.medId))];
    const snaps = await Promise.all(ids.map((id) => tx.get(doc(db, "medicamentos", id))));
    const meds = new Map();
    snaps.forEach((s) => {
      if (!s.exists()) throw new Error("Un medicamento ya no existe");
      meds.set(s.id, { d: s.data(), lotes: lotesDe(s.data()) });
    });

    const movs = items.map((it) => {
      const { d, lotes } = meds.get(it.medId);
      const antes = suma(lotes);
      const venc = it.venc || "";
      const l = lotes.find((x) => x.venc === venc);
      if (tipo === "ingreso") {
        l ? (l.cant += it.cant) : lotes.push({ venc, cant: it.cant });
      } else {
        if (!l || l.cant < it.cant) throw new Error(`Stock insuficiente de ${d.nombre} (vence ${fechaCorta(venc)}): quedan ${l?.cant ?? 0}`);
        if (venc && venc < hoyISO()) throw new Error(`${d.nombre} (vence ${fechaCorta(venc)}) está vencido: no se puede despachar`);
        l.cant -= it.cant;
      }
      return {
        tipo, periodo, fecha: serverTimestamp(),
        medId: it.medId, nombre: d.nombre, unidad: d.unidad || "", presentacion: d.presentacion || "",
        cantidad: it.cant, lotes: [{ venc, cant: it.cant }], stockAnterior: antes, stockNuevo: suma(lotes),
        uid: u.uid, usuarioNombre: u.nombre, usuarioDni: u.dni || "",
        acta: "", pacienteDni: "", pacienteNombre: "", observacion: "", ...extra,
      };
    });

    meds.forEach(({ lotes }, id) => {
      const nuevos = lotes.filter((l) => l.cant > 0).sort(porVenc);
      tx.update(doc(db, "medicamentos", id), { lotes: nuevos, stock: suma(nuevos), actualizado: serverTimestamp() });
    });
    movs.forEach((mv) => {
      const ref = doc(collection(db, "movimientos"));
      tx.set(ref, mv);
      creados.push({ id: ref.id, ...mv });
    });
  });
  return creados;
}

// =====================================================================
//  AVISOS (abajo de la pantalla, solo admin) y ANULAR / ELIMINAR
// =====================================================================

/** Muestra un aviso abajo durante `ms` milisegundos (se puede cerrar con ✕). */
function mostrarAviso(html, ms, clase = "") {
  const el = document.createElement("div");
  el.className = `aviso-abajo ${clase}`;
  el.innerHTML = `<div class="aviso-texto">${html}</div><button class="btn icono" title="Cerrar">✕</button>`;
  const cerrar = () => { el.classList.add("saliendo"); setTimeout(() => el.remove(), 250); };
  el.querySelector(".btn.icono").addEventListener("click", cerrar);
  $("avisos").append(el);
  setTimeout(cerrar, ms);
  return el;
}

/** Lotes que vencen en 2 meses o menos (incluye los ya vencidos), el más próximo primero. */
function lotesPorVencer() {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const r = [];
  for (const m of estado.meds) for (const l of lotesDe(m)) {
    if (!l.venc) continue;
    const dias = Math.round((new Date(l.venc + "T00:00") - hoy) / 864e5);
    if (dias <= 60) r.push({ m, ...l, dias });
  }
  return r.sort((a, b) => a.dias - b.dias);
}

/**
 * Agotados que no se abastecieron en más de un año desde el último abastecimiento general
 * (normalmente todo se abastece una vez al año). Solo estos se sugieren para eliminar.
 */
function sinAbastecerUnAnio() {
  const ingresos = estado.movs.filter((x) => x.tipo === "ingreso" && x.fecha);
  const ultimoGeneral = Math.max(0, ...ingresos.map((x) => x.fecha.seconds));
  if (!ultimoGeneral) return [];
  return estado.meds.filter((m) => !(m.stock > 0)).filter((m) => {
    const suyo = Math.max(m.creado?.seconds || 0, ...ingresos.filter((x) => x.medId === m.id).map((x) => x.fecha.seconds));
    return ultimoGeneral - suyo > 365 * 86400;
  }).sort(alfabetico);
}

// Los avisos se muestran una vez al ingresar, cuando ya cargaron medicamentos y movimientos
let avisosMostrados = false;
const cargado = { meds: false, movs: false };
function revisarAvisos() {
  if (avisosMostrados || !cargado.meds || !cargado.movs || !estado.usuario?.admin) return;
  avisosMostrados = true;

  const venc = lotesPorVencer();
  if (venc.length) {
    // Si algo vence en 1 mes (o ya venció) el aviso dura 1 minuto; si no, 10 segundos
    const urgente = venc.some((x) => x.dias <= 30);
    const lineas = venc.slice(0, 5).map((x) =>
      `<li><b>${esc(x.m.nombre)}</b> · ${fecha6(x.venc)} · ${x.dias < 0 ? "<b>vencido</b>" : x.dias === 0 ? "vence hoy" : `${x.dias} día(s)`} · ${x.cant} und.</li>`).join("");
    mostrarAviso(`<b>⚠ Medicamentos por vencer (2 meses o menos)</b><ul>${lineas}</ul>${venc.length > 5 ? `<small>y ${venc.length - 5} más</small>` : ""}`,
      urgente ? 60000 : 10000, urgente ? "urgente" : "");
  }

  const viejos = sinAbastecerUnAnio();
  if (viejos.length) {
    const el = mostrarAviso(`<b>${viejos.length} medicamento(s) agotado(s) sin abastecer hace más de un año.</b>
      <button class="btn" data-ver-viejos>Ver y eliminar</button>`, 60000);
    el.querySelector("[data-ver-viejos]").addEventListener("click", abrirSinAbastecer);
  }
}

function abrirSinAbastecer() {
  const lista = sinAbastecerUnAnio();
  const c = abrirModal("Sin abastecer hace más de un año", `<div id="viejos-cuerpo">
    ${lista.length ? `<ul class="resumen alertas-lista">${lista.map((m) => `<li>
        <div><b>${esc(m.nombre)}</b><small>${esc(presDe(m))} · stock 0</small></div>
        <button class="btn eliminar" data-eliminar="${m.id}">Eliminar</button>
      </li>`).join("")}</ul>` : `<p class="vacio">No hay medicamentos para eliminar</p>`}
    <p class="nota centro">Están agotados y no se abastecieron en el último abastecimiento general. El historial de movimientos se conserva.</p>
  </div>`);
  c.querySelector("#viejos-cuerpo").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-eliminar]")?.dataset.eliminar;
    if (id && (await eliminarMed(medPorId(id)))) abrirSinAbastecer();
  });
}

/**
 * Anula un ingreso registrado por error: descuenta esa cantidad del lote y guarda un
 * movimiento "anulación" (el historial no se borra).
 */
async function anularIngreso(mv, { silencioso = false } = {}) {
  const u = estado.usuario;
  const lote = (mv.lotes || [])[0] || { venc: "", cant: mv.cantidad };
  if (!esDeHoy(estado.movs.find((x) => x.id === mv.id) || mv)) {
    toast("Solo se puede anular el mismo día del ingreso", true);
    return false;
  }
  mv = { ...mv, cantidad: cantidadVigente(mv) };
  try {
    await runTransaction(db, async (tx) => {
      const ref = doc(db, "medicamentos", mv.medId);
      const s = await tx.get(ref);
      let antes = 0, despues = 0;
      if (s.exists()) {
        const lotes = lotesDe(s.data());
        antes = suma(lotes);
        const l = lotes.find((x) => x.venc === lote.venc);
        if (!l || l.cant < mv.cantidad)
          throw new Error(`No se puede anular: de ese ingreso ya se despacharon unidades (quedan ${l?.cant ?? 0} de ${mv.cantidad}).`);
        l.cant -= mv.cantidad;
        const nuevos = lotes.filter((x) => x.cant > 0);
        despues = suma(nuevos);
        tx.update(ref, { lotes: nuevos, stock: despues, actualizado: serverTimestamp() });
      }
      tx.set(doc(collection(db, "movimientos")), {
        tipo: "anulacion", ref: mv.id, periodo: periodoDe(), fecha: serverTimestamp(),
        medId: mv.medId, nombre: mv.nombre, unidad: mv.unidad || "", presentacion: mv.presentacion || "",
        cantidad: mv.cantidad, lotes: [{ venc: lote.venc, cant: mv.cantidad }], stockAnterior: antes, stockNuevo: despues,
        uid: u.uid, usuarioNombre: u.nombre, usuarioDni: u.dni || "",
        acta: mv.acta || "", pacienteDni: "", pacienteNombre: "", observacion: "Anula ingreso registrado por error",
      });
    });
    if (!silencioso) exito(`Se anuló el ingreso de ${mv.cantidad} de ${mv.nombre}`);
    return true;
  } catch (err) {
    // Si ya se despachó parte, se puede corregir la cantidad en lugar de anular
    if (/ya se despacharon/.test(err.message || "") && confirm(`${err.message}\n\n¿Quieres corregir la cantidad de ese ingreso?`)) {
      abrirCorregir(estado.movs.find((x) => x.id === mv.id) || mv);
    } else toast(err.message || "No se pudo anular", true);
    return false;
  }
}

/** Anular y corregir solo se permiten el mismo día en que se registró el ingreso. */
function esDeHoy(mv) {
  if (!mv?.fecha) return true; // recién creado, aún sin hora del servidor
  return new Date(mv.fecha.seconds * 1000).toLocaleDateString("en-CA") === hoyISO();
}

/** Cantidad vigente de un ingreso: la original más sus correcciones. */
function cantidadVigente(mv) {
  return mv.cantidad + estado.movs.filter((x) => x.tipo === "correccion" && x.ref === mv.id).reduce((s, x) => s + x.delta, 0);
}

/** Corrige la cantidad (y el N° de acta) de un ingreso que ya no se puede anular. */
function abrirCorregir(mv) {
  if (!esDeHoy(mv)) return toast("Solo se puede corregir el mismo día del ingreso", true);
  const m = medPorId(mv.medId);
  const venc = (mv.lotes || [])[0]?.venc ?? "";
  const vigente = cantidadVigente(mv);
  const enLote = m ? lotesDe(m).find((l) => l.venc === venc)?.cant ?? 0 : 0;
  const minimo = Math.max(0, vigente - enLote); // lo ya despachado de ese ingreso no se puede quitar
  const actaVigente = [...estado.movs].filter((x) => x.tipo === "correccion" && x.ref === mv.id)
    .sort((a, b) => (a.fecha?.seconds ?? 0) - (b.fecha?.seconds ?? 0)).pop()?.acta || mv.acta || "";
  const c = abrirModal("Corregir ingreso", `
    <div class="ficha">
      <div class="ficha-nombre">${esc(mv.nombre)}</div>
      <div class="ficha-datos">
        <div><small>Vence</small><b>${htmlFecha(venc)}</b></div>
        <div><small>Ingresó</small><b class="grande">${vigente}</b></div>
        <div><small>Queda del lote</small><b>${enLote}</b></div>
      </div>
    </div>
    <form id="f-corr" novalidate>
      <label>N° de acta de entrega<input id="corr-acta" value="${esc(actaVigente)}" autocomplete="off"></label>
      <label>Cantidad correcta del ingreso${campoEntero("corr-cant", `value="${vigente}" maxlength="6"`)}</label>
      <p class="nota">${minimo ? `Ya se despacharon ${minimo} de este ingreso: la cantidad no puede ser menor que ${minimo}.` : "Puedes poner la cantidad correcta."}</p>
      <p id="corr-error" class="error"></p>
      <div class="fila botones">
        <button type="button" class="btn grande" data-cerrar>Cancelar</button>
        <button class="btn primario grande" type="submit">Guardar corrección</button>
      </div>
    </form>`);
  c.querySelector("#f-corr").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (msg) => { c.querySelector("#corr-error").textContent = msg; };
    const nueva = parseInt(c.querySelector("#corr-cant").value, 10);
    const acta = c.querySelector("#corr-acta").value.trim();
    if (!(nueva >= 0)) return err("Escribe la cantidad correcta");
    if (nueva < minimo) return err(`No puede ser menor que ${minimo} (ya despachados)`);
    if (!acta) return err("Escribe el N° de acta");
    const delta = nueva - vigente;
    if (!delta && acta === actaVigente) return err("No hay cambios");
    const u = estado.usuario;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "medicamentos", mv.medId);
        const s = await tx.get(ref);
        if (!s.exists()) throw new Error("El medicamento ya no existe");
        const lotes = lotesDe(s.data());
        const antes = suma(lotes);
        let l = lotes.find((x) => x.venc === venc);
        if (!l) { l = { venc, cant: 0 }; lotes.push(l); }
        if (l.cant + delta < 0) throw new Error(`No alcanza: del lote quedan ${l.cant}`);
        l.cant += delta;
        const nuevos = lotes.filter((x) => x.cant > 0).sort(porVenc);
        tx.update(ref, { lotes: nuevos, stock: suma(nuevos), actualizado: serverTimestamp() });
        tx.set(doc(collection(db, "movimientos")), {
          tipo: "correccion", ref: mv.id, delta, periodo: periodoDe(), fecha: serverTimestamp(),
          medId: mv.medId, nombre: mv.nombre, unidad: mv.unidad || "", presentacion: mv.presentacion || "",
          cantidad: Math.abs(delta), lotes: [{ venc, cant: delta }], stockAnterior: antes, stockNuevo: suma(nuevos),
          uid: u.uid, usuarioNombre: u.nombre, usuarioDni: u.dni || "",
          acta, pacienteDni: "", pacienteNombre: "", observacion: `Corrige ingreso: ${vigente} → ${nueva}`,
        });
      });
      cerrarModal();
      exito(`Se corrigió el ingreso de ${mv.nombre}: ${vigente} → ${nueva}`);
    } catch (er) {
      err(er.message || "No se pudo corregir");
    }
  });
}

/** Da de baja un lote vencido (no es un despacho a paciente). Se puede registrar en la fecha en que ocurrió. */
function abrirBaja(m, venc) {
  const lote = lotesDe(m).find((l) => l.venc === venc);
  if (!lote) return toast("Ese lote ya no tiene stock", true);
  const c = abrirModal("Dar de baja (vencido)", `
    ${fichaLote(m, venc, lote.cant)}
    <p class="aviso-caja">Este lote está vencido y no se puede despachar. Al darlo de baja sale del stock y queda registrado como <b>Baja por vencimiento</b>.</p>
    <form id="f-baja" novalidate>
      <label>Cantidad que se da de baja${campoEntero("baja-cant", `value="${lote.cant}" maxlength="6"`)}</label>
      <div class="campo">Fecha de la baja ${campoFecha("baja-fecha", hoyISO(), { pasado: true })}</div>
      <label>Observación <small>(opcional)</small><input id="baja-obs" autocomplete="off" placeholder="Ej. destruido según acta…"></label>
      <p id="baja-error" class="error"></p>
      <div class="fila botones">
        <button type="button" class="btn grande" data-cerrar>Cancelar</button>
        <button class="btn peligro grande" type="submit">Dar de baja</button>
      </div>
    </form>`);
  c.querySelector("#f-baja").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (msg) => { c.querySelector("#baja-error").textContent = msg; };
    const cant = parseInt(c.querySelector("#baja-cant").value, 10);
    const fecha = leerFecha(c.querySelector("#baja-fecha"));
    if (!(cant > 0) || cant > lote.cant) return err(`La cantidad debe ser de 1 a ${lote.cant}`);
    if (!fecha) return err("Indica la fecha de la baja");
    if (fecha > hoyISO()) return err("La fecha de la baja no puede ser futura");
    const cuando = new Date(fecha + "T12:00");
    const u = estado.usuario;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "medicamentos", m.id);
        const s = await tx.get(ref);
        if (!s.exists()) throw new Error("El medicamento ya no existe");
        const lotes = lotesDe(s.data());
        const antes = suma(lotes);
        const l = lotes.find((x) => x.venc === venc);
        if (!l || l.cant < cant) throw new Error(`Del lote quedan ${l?.cant ?? 0}`);
        l.cant -= cant;
        const nuevos = lotes.filter((x) => x.cant > 0).sort(porVenc);
        tx.update(ref, { lotes: nuevos, stock: suma(nuevos), actualizado: serverTimestamp() });
        tx.set(doc(collection(db, "movimientos")), {
          tipo: "baja", periodo: periodoDe(cuando), fecha: Timestamp.fromDate(cuando),
          medId: m.id, nombre: m.nombre, unidad: m.unidad || "", presentacion: m.presentacion || "",
          cantidad: cant, lotes: [{ venc, cant }], stockAnterior: antes, stockNuevo: suma(nuevos),
          uid: u.uid, usuarioNombre: u.nombre, usuarioDni: u.dni || "",
          acta: "", pacienteDni: "", pacienteNombre: "",
          observacion: ["Baja por vencimiento", c.querySelector("#baja-obs").value.trim()].filter(Boolean).join(" - "),
        });
      });
      cerrarModal();
      volverATabla("despacho");
      exito(`Se dio de baja ${cant} de ${m.nombre} (vencido)`);
    } catch (er) {
      err(er.message || "No se pudo dar de baja");
    }
  });
}

/** Aviso con "Deshacer" justo después de ingresar o crear (por si se agregó mal). */
function ofrecerDeshacer(texto, deshacer) {
  const el = mostrarAviso(`<span>${texto}</span> <button class="btn deshacer">Deshacer</button>`, 20000, "deshacer-aviso");
  el.querySelector(".deshacer").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    if (await deshacer()) el.remove();
    else e.currentTarget.disabled = false;
  });
}

/** Elimina un medicamento (por error o agotado). El historial de movimientos se conserva. */
async function eliminarMed(m) {
  if (!m) return false;
  const aviso = m.stock > 0
    ? `"${m.nombre}" (${presDe(m)}) todavía tiene ${m.stock} en stock.\n\n¿Seguro que quieres eliminarlo? No se puede deshacer.`
    : `¿Eliminar "${m.nombre}" (${presDe(m)})?\n\nEl historial de movimientos se conserva.`;
  if (!confirm(aviso)) return false;
  try {
    await deleteDoc(doc(db, "medicamentos", m.id));
    // Se quita de la lista al momento (sin esperar a que la base avise)
    estado.meds = estado.meds.filter((x) => x.id !== m.id);
    renumerar();
    if (estado.seccion !== "usuarios") PINTAR[estado.seccion]();
    estado.despacho.items = estado.despacho.items.filter((x) => x.medId !== m.id);
    if (!estado.despacho.items.length) estado.despacho.paciente = null;
    exito(`Se eliminó ${m.nombre}`);
    return true;
  } catch (err) {
    toast(err.message || "No se pudo eliminar", true);
    return false;
  }
}

// =====================================================================
//  INGRESO (solo admin)
// =====================================================================
$("btn-nuevo-med").addEventListener("click", () => abrirFormMed());

function abrirIngreso(m, venc) {
  const c = abrirModal("Ingreso", `
    ${fichaLote(m, venc, m.stock ?? 0)}
    <form id="f-ing" novalidate>
      <label>N° de acta de entrega<input id="ing-acta" autocomplete="off"></label>
      <label>Cantidad ingreso${campoEntero("ing-cant", 'maxlength="6"')}</label>
      <div class="campo">Fecha de caducidad <small>(sin día = fin de mes)</small>${campoFecha("ing-venc", venc ?? "")}</div>
      <p id="ing-aviso"></p>
      <div class="totales dos">
        <div><small>Total anterior</small><b>${m.stock ?? 0}</b></div>
        <div class="disp"><small>Total actual</small><b id="ing-total">${m.stock ?? 0}</b></div>
      </div>
      <p id="ing-error" class="error"></p>
      <div class="fila botones">
        <button type="button" class="btn grande" data-cerrar>Cancelar</button>
        <button class="btn primario grande" type="submit">Ingresar</button>
      </div>
    </form>`);
  const cant = c.querySelector("#ing-cant"), vencSel = c.querySelector("#ing-venc");
  const vencInp = { get value() { return leerFecha(vencSel); } };
  const actualizar = () => {
    c.querySelector("#ing-total").textContent = (m.stock ?? 0) + (parseInt(cant.value, 10) || 0);
    // Avisa si la fecha no coincide con la que ya hay en stock
    const aviso = c.querySelector("#ing-aviso");
    const lotes = lotesDe(m);
    const otras = lotes.filter((l) => l.venc !== vencInp.value);
    if (!vencInp.value || !otras.length || lotes.some((l) => l.venc === vencInp.value)) { aviso.className = ""; aviso.innerHTML = ""; return; }
    aviso.className = "aviso-caja";
    aviso.innerHTML = `⚠ Ya hay stock con otra fecha de caducidad: ${otras.map((l) => `<b>${fechaCorta(l.venc)}</b> (${l.cant})`).join(", ")}.
      Se registrará como otra fila en la tabla.`;
  };
  cant.addEventListener("input", actualizar);
  vencSel.addEventListener("change", actualizar);
  c.querySelector("#ing-acta").focus();
  c.querySelector("#f-ing").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = (msg) => { c.querySelector("#ing-error").textContent = msg; };
    const acta = c.querySelector("#ing-acta").value.trim();
    const n = parseInt(cant.value, 10);
    if (!acta) return err("Escribe el N° de acta de entrega");
    if (!(n > 0)) return err("Escribe la cantidad que ingresa");
    if (!vencInp.value) return err("Indica el mes y el año de caducidad");
    if (vencInp.value < hoyISO()) return err("La fecha de caducidad no puede ser anterior a hoy");
    const btn = ev.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const [mv] = await registrarMovimientos("ingreso", [{ medId: m.id, cant: n, venc: vencInp.value }], { acta });
      cerrarModal();
      volverATabla("ingreso");
      exito(`Se ingresó ${n} ${m.unidad || "und."} de ${m.nombre}`);
      ofrecerDeshacer(`Ingresaste ${n} de ${esc(m.nombre)}. ¿Te equivocaste?`, () => anularIngreso(mv));
    } catch (e) {
      btn.disabled = false;
      toast(e.message || "Error al registrar", true);
    }
  });
}

/**
 * Crear un medicamento nuevo (p. ej. otro gramaje). Los datos de uno existente no se modifican.
 * Al escribir el nombre se muestran los que ya existen, para no duplicarlos.
 * Unidad, vía y presentación se eligen de las listas de config.js. El stock inicial empieza en 0.
 */
function abrirFormMed() {
  const c = abrirModal("Nuevo medicamento", `
    <form id="f-med" novalidate>
      <label>Medicamento <small>(nombre con su gramaje)</small><input name="nombre" autocomplete="off" placeholder="Ej. Paracetamol 500 mg"></label>
      <div id="med-existentes"></div>
      <div class="fila">
        <label>Presentación<select name="pres"><option value="">Selecciona…</option>
          ${PRESENTACIONES.map(([ab, largo]) => `<option value="${esc(ab)}">${esc(ab)} - ${esc(largo)}</option>`).join("")}</select></label>
        <label>Vía <small>(opcional)</small><select name="via"><option value="">Sin especificar</option>
          ${VIAS.map((v) => `<option>${esc(v)}</option>`).join("")}</select></label>
      </div>
      <p class="subtitulo">Stock inicial</p>
      <div class="fila">
        <label>Cantidad${campoEntero("med-cant", 'name="stock" value="0" maxlength="6"')}</label>
        <label class="si-stock">N° de acta<input name="acta" autocomplete="off"></label>
      </div>
      <div class="campo si-stock">Fecha de caducidad <small>(sin día = fin de mes)</small>${campoFecha("med-venc")}</div>
      <p class="nota">Revisa bien los datos: una vez creado, el medicamento no se puede modificar.</p>
      <p id="med-error" class="error"></p>
      <div class="fila botones">
        <button type="button" class="btn grande" data-cerrar>Cancelar</button>
        <button class="btn primario grande" type="submit">Crear medicamento</button>
      </div>
    </form>`);
  const f = c.querySelector("#f-med");
  const nombre = f.elements.nombre;
  nombre.focus();

  // Acta y caducidad solo se piden si el stock inicial es mayor que 0
  const cantInp = c.querySelector("#med-cant");
  const verStock = () => c.querySelectorAll(".si-stock").forEach((l) => l.classList.toggle("oculto", !(parseInt(cantInp.value, 10) > 0)));
  cantInp.addEventListener("input", verStock);
  cantInp.addEventListener("blur", () => { if (cantInp.value === "") { cantInp.value = "0"; verStock(); } });
  verStock();

  // Medicamentos que ya existen con ese nombre
  const existentes = c.querySelector("#med-existentes");
  nombre.addEventListener("input", () => {
    const q = nombre.value.trim();
    if (q.length < 2) { existentes.innerHTML = ""; return; }
    const { lista, aproximado } = buscar(q);
    existentes.innerHTML = !lista.length ? "" : `
      <div class="existentes">
        <p>${aproximado ? "¿Quisiste decir…? Estos se parecen:" : "Ya registrados:"}</p>
        ${lista.slice(0, 6).map((m) => `
          <div class="existente">
            <span><b>${resaltar(m.nombre, q)}</b><small>${esc(presDe(m))} · stock ${m.stock ?? 0}</small></span>
            <button type="button" class="btn primario" data-ingresar="${m.id}">Ingresar stock</button>
          </div>`).join("")}
        <small class="nota">Si es el mismo medicamento, usa <b>Ingresar stock</b>. Crea uno nuevo solo si cambia el gramaje o la presentación.</small>
      </div>`;
  });
  existentes.addEventListener("click", (e) => {
    const id = e.target.closest("[data-ingresar]")?.dataset.ingresar;
    if (id) { const m = medPorId(id); abrirIngreso(m, lotesDe(m)[0]?.venc ?? null); }
  });

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (msg) => { c.querySelector("#med-error").textContent = msg; };
    const d = Object.fromEntries(new FormData(f));
    const pres = PRESENTACIONES.find(([ab]) => ab === d.pres);
    const datos = { nombre: d.nombre.trim().replace(/\s+/g, " "), unidad: pres?.[0] || "", presentacion: pres?.[1] || "", via: d.via };
    const cant = parseInt(d.stock, 10) || 0;
    if (!datos.nombre) return err("Escribe el nombre del medicamento con su gramaje");
    if (!pres) return err("Elige la presentación");
    const igual = estado.meds.find((m) => norm(m.nombre) === norm(datos.nombre) && (m.unidad || "") === datos.unidad);
    if (igual) return err(`Ya existe ${igual.nombre} (${presDe(igual)}). Usa "Ingresar stock".`);
    if (cant && !d.acta.trim()) return err("Escribe el N° de acta del stock inicial");
    d.venc = leerFecha(c.querySelector("#med-venc"));
    if (cant && !d.venc) return err("Indica el mes y el año de caducidad del stock inicial");
    if (cant && d.venc < hoyISO()) return err("La fecha de caducidad no puede ser anterior a hoy");
    try {
      const [creado] = await crearMedicamentos([{ ...datos, lotes: [{ venc: cant ? d.venc : "", cant }] }], cant ? d.acta.trim() : "");
      cerrarModal();
      volverATabla("ingreso");
      exito(`Se registró ${datos.nombre} (${presDe(datos)})` + (cant ? ` con ${cant}` : " con stock 0"));
      ofrecerDeshacer(`Registraste ${esc(datos.nombre)}. ¿Te equivocaste?`, async () => {
        for (const mv of creado.movs) if (!(await anularIngreso(mv, { silencioso: true }))) return false;
        await deleteDoc(doc(db, "medicamentos", creado.medId));
        estado.meds = estado.meds.filter((x) => x.id !== creado.medId);
        renumerar();
        if (estado.seccion !== "usuarios") PINTAR[estado.seccion]();
        exito(`Se eliminó ${datos.nombre}`);
        return true;
      });
    } catch (er) {
      toast(er.message || "Error al guardar", true);
    }
  });
}

/** Crea medicamentos con sus lotes iniciales y registra ese stock como ingreso. */
async function crearMedicamentos(lista, acta = "") {
  const periodo = periodoDe();
  const u = estado.usuario;
  // Cada medicamento usa 1 + n° de lotes escrituras; un lote de Firestore admite 500
  let batch = writeBatch(db), ops = 0;
  const creados = []; // [{ medId, movs: [{ id, ... }] }]
  for (const d of lista) {
    const lotes = d.lotes.filter((l) => l.cant > 0).sort(porVenc);
    if (ops + 1 + lotes.length > 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
    const ref = doc(collection(db, "medicamentos"));
    batch.set(ref, { ...d, lotes, stock: suma(lotes), creado: serverTimestamp(), actualizado: serverTimestamp() });
    ops++;
    const creado = { medId: ref.id, movs: [] };
    creados.push(creado);
    let acumulado = 0;
    for (const l of lotes) {
      const refMov = doc(collection(db, "movimientos"));
      const mv = {
        tipo: "ingreso", periodo, fecha: serverTimestamp(), medId: ref.id,
        nombre: d.nombre, unidad: d.unidad || "", presentacion: d.presentacion || "", cantidad: l.cant, lotes: [l],
        stockAnterior: acumulado, stockNuevo: (acumulado += l.cant),
        uid: u.uid, usuarioNombre: u.nombre, usuarioDni: u.dni || "",
        acta, pacienteDni: "", pacienteNombre: "", observacion: "Stock inicial",
      };
      batch.set(refMov, mv);
      creado.movs.push({ id: refMov.id, ...mv });
      ops++;
    }
  }
  if (ops) await batch.commit();
  return creados;
}

// =====================================================================
//  CONTROL VISIBLE: por medicamento y por mes (cierre el día DIA_CIERRE),
//  el último mes primero
// =====================================================================

/**
 * { periodo → { ant, ing, des, exi } } desde MES_INICIO.
 * Se calcula hacia atrás desde el stock real: anterior = total − ingresa + sale.
 */
function historial(m) {
  const porP = {};
  for (const x of estado.movs) {
    if (x.medId !== m.id) continue;
    const r = (porP[x.periodo] ||= { ing: 0, des: 0 });
    if (x.tipo === "ingreso") r.ing += x.cantidad;
    else if (x.tipo === "anulacion") r.ing -= x.cantidad; // ingreso anulado
    else if (x.tipo === "correccion") r.ing += x.delta;    // ingreso corregido (+/−)
    else r.des += x.cantidad;                              // despacho o baja
  }
  const out = {};
  let saldo = m.stock || 0;
  for (const k of periodos()) {
    const r = porP[k] || { ing: 0, des: 0 };
    out[k] = { ant: saldo - r.ing + r.des, ing: r.ing, des: r.des, exi: saldo };
    saldo = out[k].ant;
  }
  return out;
}

function abrirControl(m) {
  const h = historial(m);
  const lista = periodos();
  if (matchMedia("(max-width: 760px)").matches) {
    // Celular: Mes | Saldo (anterior, sale, entra, total), el último mes primero
    return abrirModal("Control visible", `
      ${fichaLote(m, null, m.stock ?? 0)}
      <div class="tabla-wrap"><table class="tabla control-movil">
        <thead>
          <tr><th rowspan="2">Mes</th><th colspan="4" class="centro">Saldo</th></tr>
          <tr><th>Anterior</th><th>Sale</th><th>Entra</th><th>Total</th></tr>
        </thead>
        <tbody>${lista.map((k, i) => `<tr class="${i === 0 ? "actual" : ""}">
          <td class="mes-col">${periodoNombre(k).replace(" de ", " ")}${i === 0 ? "<small>en curso</small>" : ""}</td>
          <td>${h[k].ant}</td>
          <td class="des">${h[k].des ? "−" + h[k].des : "0"}</td>
          <td class="ing">${h[k].ing ? "+" + h[k].ing : "0"}</td>
          <td class="total">${h[k].exi}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <p class="nota centro">Cierre el ${DIA_CIERRE} de cada mes.</p>`, true);
  }
  abrirModal("Control visible", `
    ${fichaLote(m, null, m.stock ?? 0)}
    ${lista.map((k, i) => `
      <div class="mes${i === 0 ? " actual" : ""}">
        <div class="mes-cab"><span>${periodoNombre(k)}</span><small>${periodoRango(k)}${i === 0 ? " · en curso" : ""}</small></div>
        <div class="tabla-wrap"><table class="tabla control">
          <thead><tr><th>N°</th><th>Medicamento</th><th class="num">Saldo anterior</th><th class="num">Sale</th>
            <th class="num">Ingresa</th><th class="num">Saldo total</th></tr></thead>
          <tbody><tr>
            <td class="num">${numeroDe(m)}</td><td class="nombre">${esc(m.nombre)}</td>
            <td class="num">${h[k].ant}</td>
            <td class="num des">${h[k].des ? "−" + h[k].des : "0"}</td>
            <td class="num ing">${h[k].ing ? "+" + h[k].ing : "0"}</td>
            <td class="num total">${h[k].exi}</td>
          </tr></tbody>
        </table></div>
      </div>`).join("")}`, true);
}

// =====================================================================
//  MOVIMIENTOS: todo lo que entra y sale en el mes, el último primero
// =====================================================================
/** dd/mm/aa */
const fecha6 = (iso) => (iso ? fechaCorta(iso).replace(/\/\d\d(\d\d)$/, "/$1") : "Sin fecha");

/** N° de movimiento dentro del mes: 1 = el primero que se registró. */
function numerarMovs(P) {
  const orden = estado.movs.filter((x) => x.periodo === P)
    .sort((a, b) => (a.fecha?.seconds ?? 9e9) - (b.fecha?.seconds ?? 9e9) || a.id.localeCompare(b.id));
  return new Map(orden.map((x, i) => [x.id, i + 1]));
}

function fechaHora(x) {
  if (!x.fecha) return ["…", ""];
  const d = new Date(x.fecha.seconds * 1000);
  return [
    d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" }),
    d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false }),
  ];
}

function pintarMovimientos() {
  const lista = periodos();
  if (!lista.includes(estado.periodoMov)) estado.periodoMov = lista[0];
  const sel = $("mov-periodo");
  const opciones = lista.map((k) => `<option value="${k}">${periodoNombre(k)}${k === lista[0] ? " (en curso)" : ""}</option>`).join("");
  if (sel.dataset.opciones !== opciones) { sel.innerHTML = opciones; sel.dataset.opciones = opciones; }
  sel.value = estado.periodoMov;
  $("mov-rango").textContent = `Del ${periodoRango(estado.periodoMov)} (cierra el ${DIA_CIERRE} de cada mes)`;

  const q = norm($("buscar-mov").value).trim();
  const movs = estado.movs
    .filter((x) => x.periodo === estado.periodoMov)
    .filter((x) => !q || norm(`${x.nombre} ${x.presentacion} ${x.pacienteGrado || ""} ${x.pacienteNombre} ${x.pacienteDni} ${x.acta} ${x.usuarioNombre}`).includes(q))
    .sort((a, b) => (b.fecha?.seconds ?? 9e9) - (a.fecha?.seconds ?? 9e9));

  const ing = movs.reduce((s, x) => s + (x.tipo === "ingreso" ? x.cantidad : x.tipo === "anulacion" ? -x.cantidad : x.tipo === "correccion" ? x.delta : 0), 0);
  const des = movs.filter((x) => x.tipo === "despacho" || x.tipo === "baja").reduce((s, x) => s + x.cantidad, 0);
  const anulados = new Set(estado.movs.filter((x) => x.tipo === "anulacion").map((x) => x.ref));
  $("mov-totales").innerHTML = `
    <div><small>Movimientos</small><b>${movs.length}</b></div>
    <div class="ing"><small>Unidades que ingresaron</small><b>${ing}</b></div>
    <div class="des"><small>Unidades que salieron</small><b>${des}</b></div>`;

  if (!movs.length) { $("lista-movimientos").innerHTML = `<p class="vacio">Sin movimientos en este mes</p>`; return; }
  const nMov = numerarMovs(estado.periodoMov);
  let diaPrevio = "";
  $("lista-movimientos").innerHTML = `<div class="tabla-wrap"><table class="tabla movimientos">
    <thead><tr><th class="num">N°</th><th>Fecha</th><th>Hora</th><th>Movimiento</th><th>Medicamento</th><th>Vence</th>
      <th class="num">Cantidad</th><th class="num">Saldo</th><th>Responsable</th><th>Paciente</th><th>Acta de entrega</th></tr></thead>
    <tbody>${movs.map((x) => {
      const [dia, hora] = fechaHora(x);
      const nuevoDia = dia !== diaPrevio; diaPrevio = dia;
      const ingreso = x.tipo === "ingreso";
      const nada = `<span class="nota">—</span>`;
      const etiqueta = {
        ingreso: `<span class="etiqueta ing">Ingreso</span>`, anulacion: `<span class="etiqueta pend">Anulación</span>`,
        correccion: `<span class="etiqueta pend">Corrección</span>`, baja: `<span class="etiqueta des">Baja (vencido)</span>`,
      }[x.tipo] || `<span class="etiqueta des">Despacho</span>`;
      const vigente = ingreso ? cantidadVigente(x) : 0;
      const accion = !ingreso || !estado.usuario.admin ? ""
        : anulados.has(x.id) ? `<small class="anulado">Anulado</small>`
        : !esDeHoy(x) ? (vigente !== x.cantidad ? `<small class="corregido">Corregido: ${vigente}</small>` : "")
        : `<span class="acciones-mov"><button class="btn anular" data-anular="${x.id}">Anular</button><button class="btn corregir" data-corregir="${x.id}">Corregir</button></span>`
          + (vigente !== x.cantidad ? `<small class="corregido">Corregido: ahora ${vigente}</small>` : "");
      const signo = x.tipo === "correccion" ? (x.delta >= 0 ? "+" : "−") : ingreso ? "+" : "−";
      const claseCant = ingreso || (x.tipo === "correccion" && x.delta >= 0) ? "ing" : "des";
      return `<tr class="${nuevoDia ? "nuevo-dia" : ""}${anulados.has(x.id) ? " tachado" : ""}">
        <td class="num n-mov">${nMov.get(x.id) ?? ""}</td>
        <td class="fecha-col">${nuevoDia ? dia : ""}</td>
        <td class="hora-col">${hora}</td>
        <td>${etiqueta}${accion}</td>
        <td class="nombre">${esc(x.nombre)}<small>${esc(presDe(x))}</small></td>
        <td class="hora-col">${(x.lotes || []).map((l) => fecha6(l.venc)).join(", ")}</td>
        <td class="num ${claseCant}">${signo}${x.cantidad}</td>
        <td class="num">${x.stockNuevo ?? ""}</td>
        <td>${esc(x.usuarioNombre)}</td>
        <td>${x.pacienteNombre || x.pacienteDni ? `${esc([x.pacienteGrado, x.pacienteNombre].filter(Boolean).join(" "))}${x.pacienteDni ? `<small>DNI ${esc(x.pacienteDni)}</small>` : ""}` : nada}</td>
        <td>${x.acta || x.observacion ? `${esc(x.acta)}${x.observacion ? `<small>${esc(x.observacion)}</small>` : ""}` : nada}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}
$("mov-periodo").addEventListener("change", (e) => { estado.periodoMov = e.target.value; pintarMovimientos(); });
$("lista-movimientos").addEventListener("click", async (e) => {
  const corr = e.target.closest("[data-corregir]")?.dataset.corregir;
  if (corr) return abrirCorregir(estado.movs.find((x) => x.id === corr));
  const id = e.target.closest("[data-anular]")?.dataset.anular;
  const mv = id && estado.movs.find((x) => x.id === id);
  if (!mv) return;
  if (!confirm(`¿Anular el ingreso de ${cantidadVigente(mv)} de ${mv.nombre}${mv.acta ? ` (acta ${mv.acta})` : ""}?\n\nSe descontará del stock y quedará registrado como anulación.`)) return;
  await anularIngreso(mv);
});
$("buscar-mov").addEventListener("input", pintarMovimientos);

// =====================================================================
//  DESCARGAR PDF (desde Movimientos): total general del mes o por medicamento
// =====================================================================

/**
 * Igual que historial(), pero separado por fecha de vencimiento:
 * { venc → { periodo → { ant, ing, des, exi } } }. La suma de las fechas da el total del medicamento.
 */
function historialLotes(m) {
  const actuales = new Map(lotesDe(m).map((l) => [l.venc, l.cant]));
  const porLote = new Map();
  for (const x of estado.movs) {
    if (x.medId !== m.id) continue;
    for (const l of x.lotes || []) {
      const porP = porLote.get(l.venc) || porLote.set(l.venc, {}).get(l.venc);
      const r = (porP[x.periodo] ||= { ing: 0, des: 0 });
      if (x.tipo === "ingreso") r.ing += l.cant;
      else if (x.tipo === "anulacion") r.ing -= l.cant;
      else if (x.tipo === "correccion") r.ing += l.cant; // con signo
      else r.des += l.cant;
    }
  }
  const out = {};
  for (const venc of new Set([...actuales.keys(), ...porLote.keys()])) {
    let saldo = actuales.get(venc) || 0;
    out[venc] = {};
    for (const k of periodos()) {
      const r = porLote.get(venc)?.[k] || { ing: 0, des: 0 };
      out[venc][k] = { ant: saldo - r.ing + r.des, ing: r.ing, des: r.des, exi: saldo };
      saldo = out[venc][k].ant;
    }
  }
  return out;
}

/** Fechas con algo que mostrar en el período P, la más próxima primero. */
function lotesDelPeriodo(m, P) {
  return Object.entries(historialLotes(m))
    .map(([venc, porP]) => ({ venc, ...porP[P] }))
    .filter((r) => r.ant || r.ing || r.des || r.exi)
    .sort(porVenc);
}
const sumar = (filas) => filas.reduce((s, r) => ({ ant: s.ant + r.ant, ing: s.ing + r.ing, des: s.des + r.des, exi: s.exi + r.exi }), { ant: 0, ing: 0, des: 0, exi: 0 });

const LIB_PDF = [
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
];
function cargarScript(src) {
  return new Promise((ok, mal) => {
    const s = Object.assign(document.createElement("script"), { src, onload: ok });
    s.onerror = () => mal(new Error("No se pudo cargar el generador de PDF. Revisa la conexión a internet."));
    document.head.append(s);
  });
}
async function imagenData(src) {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png");
  } catch { return null; }
}

const VERDE = [31, 61, 43];
/** Documento A4 horizontal con escudos, título y pie en cada página. */
async function nuevoPdf(titulo, subtitulo) {
  if (!window.jspdf) for (const src of LIB_PDF) await cargarScript(src);
  const pdf = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
  const [bs, ae] = await Promise.all([imagenData("img/logo-bs800.png"), imagenData("img/logo-aviacion.png")]);
  const generado = `Generado el ${new Date().toLocaleString("es-PE")} por ${estado.usuario.nombre}`;
  const cabecera = () => {
    if (bs) pdf.addImage(bs, "PNG", 12, 8, 22, 22);
    if (ae) pdf.addImage(ae, "PNG", W - 34, 8, 22, 22);
    pdf.setTextColor(...VERDE);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(15);
    pdf.text("FARMACIA DE LA AVIACIÓN DEL EJÉRCITO", W / 2, 14, { align: "center" });
    pdf.setFontSize(10); pdf.text("BS N° 800 · CIA SAN", W / 2, 20, { align: "center" });
    pdf.setTextColor(0); pdf.setFontSize(12); pdf.text(titulo, W / 2, 27, { align: "center" });
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.text(subtitulo, W / 2, 32, { align: "center" });
  };
  const pie = () => {
    pdf.setFontSize(8); pdf.setTextColor(110);
    pdf.text(generado, 12, H - 7);
    pdf.text("Derechos Reservados · Rojo - 2026 · Callao", W / 2, H - 7, { align: "center" });
    pdf.text(`Página ${pdf.getNumberOfPages()}`, W - 12, H - 7, { align: "right" });
    pdf.setTextColor(0);
  };
  const dibujadas = new Set(); // cabecera y pie una sola vez por página
  const tabla = (opciones) => pdf.autoTable({
    margin: { top: 38, left: 12, right: 12, bottom: 14 },
    styles: { fontSize: 9, cellPadding: 1.8, lineColor: [217, 222, 216], lineWidth: 0.1 },
    headStyles: { fillColor: [47, 93, 64], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: VERDE, textColor: 255, fontStyle: "bold" },
    didDrawPage: () => {
      const n = pdf.getNumberOfPages();
      if (!dibujadas.has(n)) { dibujadas.add(n); cabecera(); pie(); }
    },
    ...opciones,
  });
  return { pdf, tabla };
}

const negrita = (texto, extra = {}) => ({ content: texto, styles: { fontStyle: "bold", fillColor: [231, 239, 228], ...extra } });
const COLS_NUM = { 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } };

/** Total general del mes: todos los medicamentos, una fila por fecha de vencimiento. */
async function pdfGeneral(P) {
  const { pdf, tabla } = await nuevoPdf(`CONTROL VISIBLE - TOTAL GENERAL · ${periodoNombre(P).toUpperCase()}`,
    `Período del ${periodoRango(P)} (cierre el ${DIA_CIERRE} de cada mes)`);
  const body = [], todas = [];
  for (const m of [...estado.meds].sort(alfabetico)) {
    const lotes = lotesDelPeriodo(m, P);
    const filas = lotes.length ? lotes : [{ venc: null, ant: 0, ing: 0, des: 0, exi: 0 }];
    filas.forEach((r, i) => body.push([
      i ? "" : numeroDe(m), i ? "" : m.nombre, i ? "" : presDe(m),
      r.venc === null ? "-" : fechaCorta(r.venc), r.ant, r.ing || "", r.des || "", r.exi,
    ]));
    const s = sumar(filas);
    if (filas.length > 1) body.push(["", "", "", negrita(`Total ${m.nombre}`), negrita(s.ant), negrita(s.ing || ""), negrita(s.des || ""), negrita(s.exi)]);
    todas.push(s);
  }
  const t = sumar(todas);
  tabla({
    head: [["N°", "Medicamento", "Presentación", "F. caducidad", "Saldo anterior", "Ingresa", "Sale", "Saldo actual"]],
    body,
    foot: [["", "TOTAL GENERAL", "", "", ...[t.ant, t.ing, t.des, t.exi].map((v) => ({ content: v, styles: { halign: "right" } }))]],
    columnStyles: { 0: { halign: "right", cellWidth: 10 }, ...COLS_NUM },
  });
  pdf.save(`control-general-${P}.pdf`);
}

/** Por medicamento: el mes elegido, su historial mes a mes y sus movimientos del mes. */
async function pdfMedicamento(m, P) {
  const { pdf, tabla } = await nuevoPdf(`CONTROL VISIBLE - N° ${numeroDe(m)} ${m.nombre.toUpperCase()} · ${periodoNombre(P).toUpperCase()}`,
    `${[presDe(m), m.via].filter(Boolean).join(" · ")} - período del ${periodoRango(P)}`);
  const h = historialLotes(m);
  const body = [];
  for (const k of periodos()) {
    const lotes = Object.entries(h).map(([venc, porP]) => ({ venc, ...porP[k] })).filter((r) => r.ant || r.ing || r.des || r.exi).sort(porVenc);
    const filas = lotes.length ? lotes : [{ venc: null, ant: 0, ing: 0, des: 0, exi: 0 }];
    const resaltado = k === P ? { fillColor: [255, 244, 214] } : {};
    filas.forEach((r, i) => body.push([
      { content: i ? "" : periodoNombre(k), styles: resaltado }, { content: i ? "" : numeroDe(m), styles: resaltado },
      { content: i ? "" : m.nombre, styles: resaltado }, { content: "", styles: resaltado },
      { content: r.venc === null ? "-" : fechaCorta(r.venc), styles: resaltado },
      { content: r.ant, styles: resaltado }, { content: r.ing || "", styles: resaltado },
      { content: r.des || "", styles: resaltado }, { content: r.exi, styles: resaltado },
    ].filter((_, j) => j !== 3)));
    const s = sumar(filas);
    if (filas.length > 1) body.push(["", "", "", negrita(`Total ${periodoNombre(k)}`), negrita(s.ant), negrita(s.ing || ""), negrita(s.des || ""), negrita(s.exi)]);
  }
  tabla({
    head: [["Mes", "N°", "Medicamento", "F. caducidad", "Saldo anterior", "Ingresa", "Sale", "Saldo actual"]],
    body,
    columnStyles: { 1: { halign: "right", cellWidth: 10 }, ...COLS_NUM },
  });

  const nMov = numerarMovs(P);
  const movs = estado.movs.filter((x) => x.medId === m.id && x.periodo === P)
    .sort((a, b) => (b.fecha?.seconds ?? 9e9) - (a.fecha?.seconds ?? 9e9));
  tabla({
    startY: pdf.lastAutoTable.finalY + 10,
    head: [[{ content: `Movimientos de ${periodoNombre(P)}`, colSpan: 10, styles: { halign: "left" } }],
      ["N°", "Fecha", "Hora", "Movimiento", "F. caducidad", "Cantidad", "Saldo", "Responsable", "Paciente", "Acta de entrega"]],
    body: movs.length ? movs.map((x) => {
      const [dia, hora] = fechaHora(x);
      const ingreso = x.tipo === "ingreso";
      const tipo = { ingreso: "Ingreso", anulacion: "Anulación", correccion: "Corrección", baja: "Baja (vencido)" }[x.tipo] || "Despacho";
      return [nMov.get(x.id) ?? "", dia, hora, tipo, (x.lotes || []).map((l) => fecha6(l.venc)).join(", "),
        `${ingreso || (x.tipo === "correccion" && x.delta >= 0) ? "+" : "-"}${x.cantidad}`, x.stockNuevo ?? "", x.usuarioNombre,
        [[x.pacienteGrado, x.pacienteNombre].filter(Boolean).join(" "), x.pacienteDni && `DNI ${x.pacienteDni}`].filter(Boolean).join(" - "),
        [x.acta, x.observacion].filter(Boolean).join(" - ")];
    }) : [[{ content: "Sin movimientos en este mes", colSpan: 10, styles: { halign: "center" } }]],
    columnStyles: { 0: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
  });
  pdf.save(`control-${norm(m.nombre).replace(/[^a-z0-9]+/g, "-")}-${P}.pdf`);
}

$("btn-pdf").addEventListener("click", () => {
  const P = estado.periodoMov;
  const c = abrirModal("Descargar PDF", `
    <p class="centro nota">Mes: <b>${periodoNombre(P)}</b> (${periodoRango(P)})<br>Para otro mes, cámbialo en la lista de Movimientos.</p>
    <button id="pdf-general" class="btn primario grande">Total general del mes</button>
    <p class="subtitulo centro">o por medicamento</p>
    <input id="pdf-buscar" class="buscar" type="search" placeholder="Buscar medicamento…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div id="pdf-lista" class="lista-pdf"></div>`);
  const descargar = async (boton, fn) => {
    const texto = boton.innerHTML;
    boton.disabled = true; boton.textContent = "Generando PDF…";
    try { await fn(); cerrarModal(); toast("PDF descargado ✔"); }
    catch (err) { toast(err.message || "No se pudo generar el PDF", true); boton.disabled = false; boton.innerHTML = texto; }
  };
  const pintar = () => {
    c.querySelector("#pdf-lista").innerHTML = buscar(c.querySelector("#pdf-buscar").value).lista.map((m) =>
      `<button class="btn" data-pdf="${m.id}"><span>${esc(m.nombre)}<small>${esc(presDe(m))}</small></span><span class="ir">PDF</span></button>`).join("")
      || `<p class="nota centro">Sin resultados</p>`;
  };
  pintar();
  c.querySelector("#pdf-buscar").addEventListener("input", pintar);
  c.querySelector("#pdf-general").addEventListener("click", (e) => descargar(e.currentTarget, () => pdfGeneral(P)));
  c.querySelector("#pdf-lista").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pdf]");
    if (b) descargar(b, () => pdfMedicamento(medPorId(b.dataset.pdf), P));
  });
});

// =====================================================================
//  INICIO DE SESIÓN y SOLICITUD DE REGISTRO
// =====================================================================
document.querySelectorAll("[data-ir]").forEach((a) => a.addEventListener("click", (e) => {
  e.preventDefault();
  const ir = a.dataset.ir;
  $("form-registro").classList.toggle("oculto", ir !== "registro");
  $("form-recuperar").classList.toggle("oculto", ir !== "recuperar");
  $("form-login").classList.toggle("oculto", ir !== "login");
  $("login-error").textContent = "";
  $("registro-msg").textContent = "";
  $("rec-msg").textContent = "";
}));

// "Olvidé mi contraseña": deja una solicitud para el administrador
$("form-recuperar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("rec-msg");
  const usuario = $("rec-usuario").value.trim().toLowerCase();
  const dni = $("rec-dni").value.trim();
  msg.className = "error";
  if (!usuario) { msg.textContent = "Escribe tu usuario"; return; }
  if (!DNI_OK.test(dni)) { msg.textContent = "El DNI debe tener 8 dígitos"; return; }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await setDoc(doc(collection(db, "recuperaciones")), { usuario, dni, creado: serverTimestamp() });
    e.target.reset();
    $("form-recuperar").classList.add("oculto");
    $("form-login").classList.remove("oculto");
    $("login-usuario").value = usuario;
    $("login-error").className = "ok";
    $("login-error").textContent = "Solicitud enviada ✔. El administrador te enviará una contraseña temporal por WhatsApp.";
  } catch {
    msg.textContent = "No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.";
  } finally {
    btn.disabled = false;
  }
});

const MENSAJES_AUTH = {
  "auth/email-already-in-use": "Ese usuario ya existe, elige otro",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres",
  "auth/invalid-email": "Usuario no válido (solo letras, números, punto o guion)",
  "auth/network-request-failed": "Sin conexión a internet",
  "auth/too-many-requests": "Demasiados intentos. Espera unos minutos e inténtalo de nuevo",
  "auth/user-disabled": "Esta cuenta está desactivada",
};
/** Mensaje para el usuario; si la página no está autorizada en Firebase, lo dice claramente. */
const mensajeAuth = (err, porDefecto) =>
  /blocked|unauthorized-domain|api-key/.test(err?.code || "") ? "Esta página no está autorizada para conectarse. Avisa al administrador."
    : MENSAJES_AUTH[err?.code] || porDefecto;

$("form-registro").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("registro-msg");
  msg.className = "error";
  const nombre = $("r-nombre").value.trim().replace(/\s+/g, " ");
  const dni = $("r-dni").value.trim(), celular = $("r-celular").value.trim();
  if (!NOMBRE_OK.test(nombre)) { msg.textContent = "Escribe grado, nombres y apellidos"; return; }
  if (!DNI_OK.test(dni)) { msg.textContent = "El DNI debe tener 8 dígitos"; return; }
  if (!/^\d{9}$/.test(celular)) { msg.textContent = "El celular debe tener 9 dígitos"; return; }
  if ($("r-clave").value !== $("r-clave2").value) { msg.textContent = "Las contraseñas no coinciden"; return; }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  msg.className = "nota";
  msg.textContent = "Enviando solicitud…";
  const usuario = $("r-usuario").value.trim().toLowerCase();
  try {
    // La cuenta se crea en la instancia secundaria y escribe su propia ficha (pendiente)
    const cred = await createUserWithEmailAndPassword(authSecundaria, correoDe(usuario), $("r-clave").value);
    try {
      await setDoc(doc(dbSecundaria, "usuarios", cred.user.uid), {
        nombre, dni, celular, usuario, activo: false, pendiente: true, creado: serverTimestamp(),
      });
    } finally {
      await signOut(authSecundaria);
    }
    e.target.reset();
    $("form-registro").classList.add("oculto");
    $("form-login").classList.remove("oculto");
    $("login-usuario").value = usuario;
    $("login-error").className = "ok";
    $("login-error").textContent = "Solicitud enviada ✔. Podrás ingresar cuando el administrador la apruebe.";
  } catch (err) {
    msg.className = "error";
    msg.textContent = mensajeAuth(err, err.message);
  } finally {
    btn.disabled = false;
  }
});

$("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").className = "error";
  $("login-error").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, correoDe($("login-usuario").value), $("login-clave").value);
  } catch (err) {
    $("login-error").textContent = mensajeAuth(err, "Usuario o contraseña incorrectos");
  }
});
// 👁 muestra u oculta la contraseña
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ver-clave]");
  if (!b) return;
  const inp = b.parentElement.querySelector("input");
  const ver = inp.type === "password";
  inp.type = ver ? "text" : "password";
  b.classList.toggle("activo", ver);
  b.setAttribute("aria-label", ver ? "Ocultar contraseña" : "Mostrar contraseña");
});

$("btn-salir").addEventListener("click", () => confirm("¿Cerrar sesión?") && signOut(auth));

// =====================================================================
//  USUARIOS: datos generales (el admin ve a todos y aprueba solicitudes)
// =====================================================================
function miFoto() {
  const u = estado.usuario;
  return `<div class="mi-foto">
    <div class="avatar grande">${$("perfil-foto").innerHTML}</div>
    <div><b>${esc(u.nombre)}</b><button class="btn" data-cambiar-foto>${u.foto ? "Cambiar foto" : "Poner foto"}</button></div>
  </div>`;
}

function pintarUsuarios() {
  const u = estado.usuario;
  if (!u.admin) {
    $("lista-usuarios").innerHTML = `<div class="tarjeta datos-usuario">
      ${miFoto()}
      <h3>Mis datos</h3>
      <dl><dt>Nombre</dt><dd>${esc(u.nombre)}</dd><dt>DNI</dt><dd>${esc(u.dni) || "—"}</dd>
        <dt>Celular</dt><dd>${esc(u.celular) || "—"}</dd><dt>Usuario</dt><dd>${esc(u.usuario)}</dd></dl>
      <p class="nota">Para corregir tus datos, pídeselo al administrador.</p></div>`;
    return;
  }
  const todos = [...estado.usuarios].sort((a, b) => (b.pendiente ? 1 : 0) - (a.pendiente ? 1 : 0) || a.nombre.localeCompare(b.nombre, "es"));
  const pend = todos.filter((x) => x.pendiente).length;
  const recs = estado.recuperaciones;
  const bloqueRec = !recs.length ? "" : `<div class="tarjeta recuperaciones">
    <h3>Solicitudes de contraseña (${recs.length})</h3>
    ${recs.map((r) => {
      const u = estado.usuarios.find((x) => x.usuario === r.usuario && x.dni === r.dni);
      return `<div class="rec-fila">
        <div><b>${u ? esc(u.nombre) : esc(r.usuario)}</b>
          <small>Usuario ${esc(r.usuario)} · DNI ${esc(r.dni)}${u ? ` · Cel. ${esc(u.celular) || "—"}` : ""}</small>
          ${u ? "" : `<small class="error">El usuario y el DNI no coinciden con ninguna cuenta</small>`}</div>
        <div class="botones-fila">
          ${u && u.celular ? `<button class="btn primario" data-rec-enviar="${r.id}">Enviar contraseña</button>` : ""}
          <button class="btn" data-rec-descartar="${r.id}">Descartar</button>
        </div>
      </div>`;
    }).join("")}
  </div>`;
  $("lista-usuarios").innerHTML = `<div class="tarjeta datos-usuario">${miFoto()}</div>` + bloqueRec +
    (pend ? `<p class="aviso-caja">Tienes <b>${pend}</b> solicitud(es) de registro pendiente(s) de aprobación.</p>` : "") +
    `<div class="tabla-wrap"><table class="tabla usuarios">
      <thead><tr><th>Nombre</th><th>DNI</th><th>Celular</th><th>Usuario</th><th>Estado</th><th></th></tr></thead>
      <tbody>${todos.map((x) => {
        const esAdm = x.usuario === ADMIN_USUARIO;
        const est = esAdm ? "Administrador" : x.pendiente ? "Pendiente" : x.activo ? "Activo" : "Desactivado";
        return `<tr class="${x.pendiente ? "pendiente" : x.activo ? "" : "inactivo"}">
          <td class="nombre">${esc(x.nombre)}</td><td>${esc(x.dni) || "—"}</td><td>${esc(x.celular) || "—"}</td>
          <td>${esc(x.usuario)}</td><td><span class="etiqueta ${x.pendiente ? "pend" : x.activo ? "ing" : "des"}">${est}</span></td>
          <td class="botones-fila">
            <button class="btn" data-editar-u="${x.id}">Editar</button>
            ${esAdm ? "" : x.pendiente
              ? `<button class="btn primario" data-aprobar="${x.id}">Aprobar</button>`
              : `<button class="btn ${x.activo ? "peligro" : "primario"}" data-activo="${x.id}">${x.activo ? "Desactivar" : "Activar"}</button>`}
          </td></tr>`;
      }).join("")}</tbody>
    </table></div>`;
}

/** Contraseña temporal fácil de dictar: 3 letras y 4 números (sin letras confusas). */
function claveTemporal() {
  const letras = "abcdefghjkmnpqrstuvwxyz";
  const r = crypto.getRandomValues(new Uint32Array(7));
  return [...r.slice(0, 3)].map((n) => letras[n % letras.length]).join("") + [...r.slice(3)].map((n) => n % 10).join("");
}

/** Pone una contraseña temporal (Cloud Function) y prepara el mensaje de WhatsApp a su celular. */
async function enviarClaveTemporal(r, boton) {
  const u = r && estado.usuarios.find((x) => x.usuario === r.usuario && x.dni === r.dni);
  if (!u) return;
  if (!confirm(`¿Generar una contraseña temporal para ${u.nombre} y enviarla por WhatsApp al ${u.celular}?`)) return;
  const clave = claveTemporal();
  boton.disabled = true;
  try {
    await restablecerClave({ uid: u.id, clave });
    await deleteDoc(doc(db, "recuperaciones", r.id));
    const texto = `Hola ${u.nombre}. Tu contraseña temporal de la Farmacia BS N° 800 es: ${clave}\nUsuario: ${u.usuario}\nAl ingresar te pedirá crear una nueva.`;
    const enlace = `https://wa.me/51${u.celular}?text=${encodeURIComponent(texto)}`;
    abrirModal("Contraseña temporal", `
      <p class="centro">Para <b>${esc(u.nombre)}</b> · usuario <b>${esc(u.usuario)}</b></p>
      <p class="clave-temporal">${esc(clave)}</p>
      <a class="btn primario grande whatsapp" href="${esc(enlace)}" target="_blank" rel="noopener">Enviar por WhatsApp al ${esc(u.celular)}</a>
      <p class="nota centro">Al ingresar con esta contraseña, la app le pedirá crear una nueva.</p>`);
  } catch (err) {
    boton.disabled = false;
    toast(err.code === "functions/not-found" || err.code === "functions/internal"
      ? "Falta instalar la función del servidor (ver LEEME.md, paso 6)" : err.message || "No se pudo generar la contraseña", true);
  }
}

function pintarBadge() {
  const n = estado.usuarios.filter((u) => u.pendiente).length + estado.recuperaciones.length;
  $("badge-pendientes").textContent = n;
  $("badge-pendientes").classList.toggle("oculto", !n);
}

$("lista-usuarios").addEventListener("click", async (e) => {
  if (e.target.closest("[data-cambiar-foto]")) return $("input-foto").click();
  const recEnviar = e.target.closest("[data-rec-enviar]")?.dataset.recEnviar;
  const recDescartar = e.target.closest("[data-rec-descartar]")?.dataset.recDescartar;
  if (recDescartar) return deleteDoc(doc(db, "recuperaciones", recDescartar));
  if (recEnviar) return enviarClaveTemporal(estado.recuperaciones.find((r) => r.id === recEnviar), e.target.closest("button"));
  const b = e.target.closest("[data-editar-u],[data-aprobar],[data-activo]");
  if (!b) return;
  const id = b.dataset.editarU || b.dataset.aprobar || b.dataset.activo;
  const u = estado.usuarios.find((x) => x.id === id);
  try {
    if (b.dataset.aprobar) {
      await updateDoc(doc(db, "usuarios", id), { activo: true, pendiente: false });
      exito(`Se aprobó a ${u.nombre}`);
    } else if (b.dataset.activo) {
      await updateDoc(doc(db, "usuarios", id), { activo: !u.activo });
    } else {
      abrirEditarUsuario(u);
    }
  } catch (err) {
    toast(err.message || "Error", true);
  }
});

function abrirEditarUsuario(u) {
  const c = abrirModal("Editar usuario", `
    <form id="f-u">
      <label>Nombre completo<input name="nombre" value="${esc(u.nombre)}" required></label>
      <div class="fila">
        <label>DNI<input name="dni" class="entero" type="text" inputmode="numeric" maxlength="8" value="${esc(u.dni)}"></label>
        <label>Celular<input name="celular" class="entero" type="text" inputmode="numeric" maxlength="9" value="${esc(u.celular)}"></label>
      </div>
      <p class="nota">Usuario: <b>${esc(u.usuario)}</b></p>
      <button class="btn primario grande" type="submit">Guardar</button>
    </form>`);
  c.querySelector("#f-u").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await updateDoc(doc(db, "usuarios", u.id), { nombre: f.nombre.trim(), dni: f.dni.trim(), celular: f.celular.trim() });
    cerrarModal(); toast("Guardado");
  });
}

// =====================================================================
//  Navegación y sesión
// =====================================================================
const PINTAR = {
  despacho: pintarDespacho,
  ingreso: () => pintarTablaMeds("ingreso"),
  control: () => pintarTablaMeds("control"),
  movimientos: pintarMovimientos,
  usuarios: pintarUsuarios,
};

function irA(sec) {
  estado.seccion = sec;
  document.querySelectorAll(".seccion").forEach((s) => s.classList.toggle("oculto", s.id !== `sec-${sec}`));
  document.querySelectorAll(".menu button").forEach((b) => b.classList.toggle("activa", b.dataset.sec === sec));
  PINTAR[sec]();
  window.scrollTo(0, 0);
}
document.querySelector(".menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sec]");
  if (b) irA(b.dataset.sec);
});

/** Tras entrar con una contraseña temporal, hay que crear una nueva (la ventana no se puede cerrar). */
function pedirNuevaClave(user) {
  const ojo = `<button type="button" class="ver-clave" data-ver-clave aria-label="Mostrar contraseña">👁</button>`;
  const c = abrirModal("Crea tu nueva contraseña", `
    <p class="nota">Ingresaste con una contraseña temporal. Crea una nueva para continuar.</p>
    <form id="f-clave" novalidate>
      <label>Nueva contraseña (mín. 6)<span class="campo-clave"><input id="nc-1" type="password" autocomplete="new-password">${ojo}</span></label>
      <label>Repetir contraseña<span class="campo-clave"><input id="nc-2" type="password" autocomplete="new-password">${ojo}</span></label>
      <p id="nc-error" class="error"></p>
      <button class="btn primario grande" type="submit">Guardar contraseña</button>
    </form>`);
  $("modal").classList.add("obligatorio");
  c.querySelector("#f-clave").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = (m) => { c.querySelector("#nc-error").textContent = m; };
    const a = c.querySelector("#nc-1").value, b = c.querySelector("#nc-2").value;
    if (a.length < 6) return err("Debe tener al menos 6 caracteres");
    if (a !== b) return err("Las contraseñas no coinciden");
    try {
      await updatePassword(user, a);
      await updateDoc(doc(db, "usuarios", user.uid), { claveTemporal: false });
      cerrarModal();
      exito("Contraseña actualizada ✔");
    } catch (er) {
      err(er.code === "auth/requires-recent-login" ? "Vuelve a iniciar sesión e inténtalo de nuevo" : er.message || "No se pudo guardar");
    }
  });
}

function mostrarUsuario() {
  const u = estado.usuario;
  $("usuario-actual").textContent = u.nombre;
  $("usuario-actual").title = u.nombre;
  // Foto o, si no tiene, sus iniciales
  const iniciales = u.nombre.split(/\s+/).filter((p) => /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(p) && !/\.$/.test(p)).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  $("perfil-foto").innerHTML = u.foto ? `<img src="${esc(u.foto)}" alt="">` : `<span>${esc(iniciales)}</span>`;
}

/** Recorta la imagen al centro en cuadrado y la reduce (≈10 KB) para guardarla con el usuario. */
async function reducirImagen(file, lado = 160) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = Object.assign(document.createElement("canvas"), { width: lado, height: lado });
    c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, lado, lado);
    return c.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}
$("input-foto").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const foto = await reducirImagen(file);
    await updateDoc(doc(db, "usuarios", estado.usuario.uid), { foto });
    estado.usuario.foto = foto;
    mostrarUsuario();
    if (estado.seccion === "usuarios") pintarUsuarios();
    toast("Foto actualizada ✔");
  } catch {
    toast("No se pudo usar esa imagen. Prueba con una foto JPG o PNG.", true);
  }
});

onAuthStateChanged(auth, async (user) => {
  desuscribir.forEach((f) => f());
  desuscribir = [];
  estado.despacho = { paciente: null, items: [] };
  avisosMostrados = false;
  cargado.meds = cargado.movs = false;
  $("avisos").innerHTML = "";
  estado.usuarios = [];
  estado.recuperaciones = [];
  pintarBadge();

  if (!user) {
    estado.usuario = null;
    document.body.classList.remove("es-admin");
    $("vista-app").classList.add("oculto");
    $("vista-login").classList.remove("oculto");
    return;
  }

  const admin = user.email === correoDe(ADMIN_USUARIO);
  const ref = doc(db, "usuarios", user.uid);
  let perfil = (await getDoc(ref).catch(() => null))?.data();
  if (admin && !perfil) {
    perfil = { nombre: "Administrador", usuario: ADMIN_USUARIO, dni: "", celular: "", activo: true, pendiente: false };
    await setDoc(ref, { ...perfil, creado: serverTimestamp() });
  }
  if (!perfil || !perfil.activo) {
    $("login-error").className = "error";
    $("login-error").textContent = perfil?.pendiente
      ? "Tu solicitud de registro aún está pendiente de aprobación"
      : "Cuenta desactivada o no autorizada";
    return signOut(auth);
  }

  estado.usuario = { uid: user.uid, nombre: perfil.nombre, dni: perfil.dni || "", celular: perfil.celular || "", usuario: perfil.usuario, foto: perfil.foto || "", admin };
  document.body.classList.toggle("es-admin", admin);
  mostrarUsuario();
  $("vista-login").classList.add("oculto");
  $("vista-app").classList.remove("oculto");
  $("form-login").reset();

  const repintar = () => PINTAR[estado.seccion]();
  desuscribir.push(
    onSnapshot(collection(db, "medicamentos"), (s) => {
      estado.meds = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      renumerar();
      cargado.meds = true;
      revisarAvisos();
      if (estado.seccion !== "usuarios") repintar();
    }),
    onSnapshot(query(collection(db, "movimientos"), where("periodo", ">=", MES_INICIO)), (s) => {
      estado.movs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      cargado.movs = true;
      revisarAvisos();
      if (estado.seccion === "movimientos") pintarMovimientos();
    }),
    onSnapshot(ref, (s) => {
      if (s.exists() && !s.data().activo) return signOut(auth);
      if (s.exists()) {
        const d = s.data();
        Object.assign(estado.usuario, { nombre: d.nombre, dni: d.dni || "", celular: d.celular || "", foto: d.foto || "" });
        mostrarUsuario();
      }
    }),
  );
  if (admin) {
    desuscribir.push(onSnapshot(collection(db, "usuarios"), (s) => {
      estado.usuarios = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      pintarBadge();
      if (estado.seccion === "usuarios") pintarUsuarios();
    }), onSnapshot(collection(db, "recuperaciones"), (s) => {
      estado.recuperaciones = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      pintarBadge();
      if (estado.seccion === "usuarios") pintarUsuarios();
    }));
  }
  irA("despacho");
  if (perfil.claveTemporal) pedirNuevaClave(user);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
