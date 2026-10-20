// =====================================================================
//  MODO DEMOSTRACIÓN: imita las funciones de Firebase que usa la app,
//  guardando todo en este navegador (localStorage). No aplica las reglas
//  de seguridad. Se usa solo mientras config.js tenga "PEGAR_AQUI".
// =====================================================================
import { ADMIN_USUARIO, DOMINIO, MES_INICIO, DIA_CIERRE } from "./config.js";

const CLAVE = "farmacia-demo-v6";
const nuevoId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
const error = (code) => Object.assign(new Error(code), { code });
const copia = (o) => JSON.parse(JSON.stringify(o));
const espera = () => new Promise((r) => setTimeout(r, 120)); // simula la red
const ts = (f) => ({ seconds: Math.floor(f.getTime() / 1000), nanoseconds: 0 });

let datos = cargar();

function cargar() {
  try {
    const d = JSON.parse(localStorage.getItem(CLAVE));
    if (d?.db) return d;
  } catch {}
  const d = semilla();
  try { localStorage.setItem(CLAVE, JSON.stringify(d)); } catch {}
  return d;
}
function guardar() {
  try { localStorage.setItem(CLAVE, JSON.stringify(datos)); } catch {}
}
export function reiniciarDemo() {
  try { localStorage.removeItem(CLAVE); localStorage.removeItem(CLAVE + "-sesion"); } catch {}
  location.reload();
}

// ---------------------------------------------------------------------
// App y Auth
// ---------------------------------------------------------------------
export const initializeApp = (_config, nombre = "principal") => ({ nombre });

const auths = {};
function leerSesion() {
  try { return JSON.parse(localStorage.getItem(CLAVE + "-sesion")); } catch { return null; }
}
export function getAuth(app) {
  return (auths[app.nombre] ||= { app, currentUser: app.nombre === "principal" ? leerSesion() : null, oyentes: [] });
}
function fijarUsuario(auth, user) {
  auth.currentUser = user;
  if (auth.app.nombre === "principal") try { localStorage.setItem(CLAVE + "-sesion", JSON.stringify(user)); } catch {}
  auth.oyentes.forEach((cb) => setTimeout(() => cb(user)));
}
export function onAuthStateChanged(auth, cb) {
  auth.oyentes.push(cb);
  setTimeout(() => cb(auth.currentUser));
  return () => { auth.oyentes = auth.oyentes.filter((x) => x !== cb); };
}
export async function signInWithEmailAndPassword(auth, email, clave) {
  await espera();
  const c = datos.cuentas[email];
  if (!c || c.clave !== clave) throw error("auth/invalid-credential");
  fijarUsuario(auth, { uid: c.uid, email });
}
export async function createUserWithEmailAndPassword(auth, email, clave) {
  await espera();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw error("auth/invalid-email");
  if (datos.cuentas[email]) throw error("auth/email-already-in-use");
  if (clave.length < 6) throw error("auth/weak-password");
  const user = { uid: nuevoId(), email };
  datos.cuentas[email] = { uid: user.uid, clave };
  guardar();
  fijarUsuario(auth, user);
  return { user };
}
export async function signOut(auth) {
  fijarUsuario(auth, null);
}
export async function updatePassword(user, clave) {
  await espera();
  if (clave.length < 6) throw error("auth/weak-password");
  const c = Object.values(datos.cuentas).find((x) => x.uid === user.uid);
  if (c) { c.clave = clave; guardar(); }
}

// Cloud Functions simuladas (en Firebase real viven en functions/index.js)
export const getFunctions = () => ({});
export const httpsCallable = (_f, nombre) => async (data) => {
  await espera();
  if (nombre !== "restablecerClave") throw error("functions/not-found");
  const c = Object.values(datos.cuentas).find((x) => x.uid === data.uid);
  if (!c) throw error("functions/not-found");
  c.clave = data.clave;
  Object.assign(tabla("usuarios")[data.uid] || {}, { claveTemporal: true });
  guardar();
  setTimeout(() => oyentes.forEach((o) => o()));
  return { data: { ok: true } };
};

// ---------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------
export const persistentLocalCache = () => ({});
export const initializeFirestore = (app) => ({ app });
export const getFirestore = (app) => ({ app });
export const serverTimestamp = () => ts(new Date());
export const Timestamp = { fromDate: (d) => ts(d) };

export const collection = (_db, ruta) => ({ tipo: "col", ruta });
export function doc(a, ruta, id) {
  return a.tipo === "col" ? { tipo: "doc", ruta: a.ruta, id: nuevoId() } : { tipo: "doc", ruta, id };
}
export const where = (campo, op, valor) => ({ campo, op, valor });
export const query = (col, ...filtros) => ({ ...col, filtros });

const tabla = (ruta) => (datos.db[ruta] ||= {});
function snapDoc(ref) {
  const d = tabla(ref.ruta)[ref.id];
  return { id: ref.id, exists: () => !!d, data: () => (d ? copia(d) : undefined) };
}
function snapCol(q) {
  const cumple = (d) => (q.filtros || []).every(({ campo, op, valor }) =>
    op === "==" ? d[campo] === valor : op === ">=" ? d[campo] >= valor : op === "<=" ? d[campo] <= valor : true);
  return {
    docs: Object.entries(tabla(q.ruta)).filter(([, d]) => cumple(d)).map(([id, d]) => ({ id, data: () => copia(d) })),
  };
}

const oyentes = new Set();
export function onSnapshot(ref, cb) {
  const o = () => oyentes.has(o) && cb(ref.tipo === "doc" ? snapDoc(ref) : snapCol(ref));
  oyentes.add(o);
  setTimeout(o);
  return () => oyentes.delete(o);
}

function escribir(ops) {
  for (const [op, ref, d] of ops) {
    const t = tabla(ref.ruta);
    if (op === "set") t[ref.id] = copia(d);
    else if (op === "update") {
      if (!t[ref.id]) throw error("not-found");
      Object.assign(t[ref.id], copia(d));
    } else delete t[ref.id];
  }
  guardar();
  setTimeout(() => oyentes.forEach((o) => o()));
}

export const getDoc = async (ref) => snapDoc(ref);
export const setDoc = async (ref, d) => { await espera(); escribir([["set", ref, d]]); };
export const updateDoc = async (ref, d) => { await espera(); escribir([["update", ref, d]]); };
export const deleteDoc = async (ref) => { await espera(); escribir([["delete", ref]]); };

export function writeBatch() {
  const ops = [];
  const b = {
    set: (r, d) => (ops.push(["set", r, d]), b),
    update: (r, d) => (ops.push(["update", r, d]), b),
    delete: (r) => (ops.push(["delete", r]), b),
    commit: async () => { await espera(); escribir(ops); },
  };
  return b;
}

export async function runTransaction(_db, fn) {
  const ops = [];
  const tx = {
    get: async (r) => snapDoc(r),
    set: (r, d) => (ops.push(["set", r, d]), tx),
    update: (r, d) => (ops.push(["update", r, d]), tx),
    delete: (r) => (ops.push(["delete", r]), tx),
  };
  await espera();
  const res = await fn(tx); // si fn lanza un error no se escribe nada
  escribir(ops);
  return res;
}

// ---------------------------------------------------------------------
// Datos de ejemplo: cuentas, medicamentos con lotes y movimientos
// desde MES_INICIO hasta hoy
// ---------------------------------------------------------------------
function semilla() {
  const d = { cuentas: {}, db: { usuarios: {}, medicamentos: {}, movimientos: {} } };
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const ent = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const cuenta = (usuario, clave, ficha) => {
    const uid = nuevoId();
    d.cuentas[`${usuario}@${DOMINIO}`] = { uid, clave };
    d.db.usuarios[uid] = { usuario, dni: "", celular: "", activo: true, pendiente: false, ...ficha, creado: ts(new Date(2026, 0, 2)) };
    return { uid, ...d.db.usuarios[uid] };
  };
  const admin = cuenta(ADMIN_USUARIO, "admin123", { nombre: "Administrador" });
  const tecnico = cuenta("tecnico", "demo123", { nombre: "Sgto. 2do Luis Ramos Quispe", dni: "45871236", celular: "987654321" });
  cuenta("atorres", "demo123", { nombre: "Cabo Ana Torres Díaz", dni: "72145893", celular: "956321478", activo: false, pendiente: true });

  // Paciente opcional: a veces nombre y DNI, a veces uno solo, a veces ninguno
  const pacientes = [
    ["Sgto. 1ro", "Jorge Huamán", "41236587"], ["Sldo.", "Pedro Lázaro", "70458123"], ["Cabo", "María Salas", "40125896"],
    ["Sgto. 2do", "Luis Mendoza", "73659841"], ["Sgto. Reeng.", "Rosa Quispe", "45632178"], ["Sldo.", "Kevin Rojas", "76985412"],
    ["Sgto. 2do", "Ana Torres", "72145890"], ["Cabo", "Juan Pérez", "40011223"],
  ];

  // nombre (con gramaje), presentación abreviada, vía, presentación larga, stock base, caducidad 1, caducidad 2
  const MEDS = [
    ["Paracetamol 500 mg", "TAB", "Oral", "Tableta", 300, "2026-12-31", "2027-09-30"],
    ["Paracetamol 120 mg/5 ml x 60 ml", "JBE", "Oral", "Jarabe", 24, "2027-03-31", ""],
    ["Ibuprofeno 400 mg", "TAB", "Oral", "Tableta", 200, "2027-05-31", "2028-01-31"],
    ["Amoxicilina 500 mg", "CAP", "Oral", "Cápsula", 150, "2027-02-28", ""],
    ["Diclofenaco 75 mg/3 ml", "AMP", "Intramuscular (IM)", "Ampolla", 60, "2026-09-30", "2027-08-31"],
    ["Omeprazol 20 mg", "CAP", "Oral", "Cápsula", 120, "2027-10-31", ""],
    ["Cloruro de sodio 0.9% x 1000 ml", "FCO", "Endovenosa (EV)", "Frasco", 40, "2027-06-30", "2028-03-31"],
    ["Loratadina 10 mg", "TAB", "Oral", "Tableta", 100, "2027-04-30", ""],
    ["Dexametasona 4 mg/2 ml", "AMP", "IM / EV", "Ampolla", 30, "2026-11-30", ""],
    ["Gasa estéril 10 x 10 cm", "UND", "", "Unidad", 80, "2028-12-31", ""],
    ["Metamizol 1 g/2 ml", "AMP", "IM / EV", "Ampolla", 50, "2027-01-31", "2027-12-31"],
    ["Salbutamol 100 mcg", "INH", "Inhalatoria", "Inhalador", 8, "2027-07-31", ""],
    ["Ácido acetilsalicílico 100 mg", "TAB", "Oral", "Tableta", 120, "2027-08-31", ""],
    ["Clorfenamina 4 mg", "TAB", "Oral", "Tableta", 100, "2027-05-31", ""],
    ["Ciprofloxacino 500 mg", "TAB", "Oral", "Tableta", 60, "2027-03-31", "2027-11-30"],
    ["Azitromicina 500 mg", "TAB", "Oral", "Tableta", 30, "2026-12-31", ""],
    ["Naproxeno 550 mg", "TAB", "Oral", "Tableta", 80, "2027-09-30", ""],
    ["Ketorolaco 30 mg/ml", "AMP", "IM / EV", "Ampolla", 40, "2027-02-28", ""],
    ["Metronidazol 500 mg", "TAB", "Oral", "Tableta", 60, "2027-06-30", ""],
    ["Hioscina N-butilbromuro 20 mg/ml", "AMP", "IM / EV", "Ampolla", 25, "2027-04-30", ""],
    ["Sales de rehidratación oral", "SOB", "Oral", "Sobre", 50, "2027-12-31", ""],
    ["Clotrimazol 1% x 20 g", "CRM", "Tópica", "Crema", 15, "2027-10-31", ""],
    ["Sulfadiazina de plata 1% x 50 g", "CRM", "Tópica", "Crema", 10, "2027-01-31", ""],
    ["Lágrimas artificiales x 15 ml", "COL", "Oftálmica", "Colirio", 12, "2027-03-31", ""],
    ["Enalapril 10 mg", "TAB", "Oral", "Tableta", 90, "2027-07-31", ""],
    ["Losartán 50 mg", "TAB", "Oral", "Tableta", 90, "2027-09-30", "2028-02-29"],
    ["Metformina 850 mg", "TAB", "Oral", "Tableta", 100, "2027-11-30", ""],
    ["Dimenhidrinato 50 mg", "TAB", "Oral", "Tableta", 40, "2027-02-28", ""],
    ["Bromuro de ipratropio 20 mcg", "INH", "Inhalatoria", "Inhalador", 6, "2027-05-31", ""],
    ["Esparadrapo 5 cm x 4.5 m", "ROL", "", "Rollo", 20, "2029-01-31", ""],
    ["Guantes de examen talla M", "PAR", "", "Par", 200, "2028-06-30", ""],
    ["Alcohol etílico 70% x 1 L", "FCO", "Tópica", "Frasco", 10, "2028-03-31", ""],
    ["Ceftriaxona 1 g", "FAM", "IM / EV", "Frasco ampolla (vial)", 20, "2027-04-30", ""],
    ["Tramadol 50 mg/ml", "AMP", "IM / EV", "Ampolla", 15, "2027-06-30", ""],
  ];

  // Períodos que cierran el día DIA_CIERRE, desde MES_INICIO hasta el actual
  const hoy = new Date();
  const periodos = [];
  for (let [y, m] = MES_INICIO.split("-").map(Number); ; ) {
    const inicio = new Date(y, m - 2, DIA_CIERRE + 1), fin = new Date(y, m - 1, DIA_CIERRE, 18);
    if (inicio > hoy) break;
    periodos.push({ key: `${y}-${String(m).padStart(2, "0")}`, inicio, fin: fin < hoy ? fin : hoy });
    if (++m > 12) { m = 1; y++; }
  }
  const fechaEn = (p, desde = 0) => new Date(p.inicio.getTime() + (desde + rnd() * (1 - desde)) * (p.fin - p.inicio));

  let nActa = 0;
  for (const [nombre, unidad, via, presentacion, base, venc1, venc2] of MEDS) {
    const medId = nuevoId();
    const lotes = [];
    const stock = () => lotes.reduce((t, l) => t + l.cant, 0);
    const mov = (tipo, p, fecha, cantidad, detalle, quien, antes, extra = {}) => {
      d.db.movimientos[nuevoId()] = {
        tipo, periodo: p.key, fecha: ts(fecha), medId, nombre, unidad, presentacion, cantidad, lotes: detalle,
        stockAnterior: antes, stockNuevo: stock(),
        uid: quien.uid, usuarioNombre: quien.nombre, usuarioDni: quien.dni,
        acta: "", pacienteDni: "", pacienteNombre: "", observacion: "", ...extra,
      };
    };
    const ingreso = (p, cant, venc, obs) => {
      const antes = stock();
      const l = lotes.find((x) => x.venc === venc);
      l ? (l.cant += cant) : lotes.push({ venc, cant });
      lotes.sort((a, b) => a.venc.localeCompare(b.venc));
      // El ingreso va al inicio del período, antes de los despachos
      mov("ingreso", p, new Date(p.inicio.getTime() + rnd() * 0.1 * (p.fin - p.inicio)), cant, [{ venc, cant }], admin, antes,
        { acta: `${String(++nActa).padStart(3, "0")}-2026`, observacion: obs });
    };

    periodos.forEach((p, i) => {
      if (i === 0) ingreso(p, base, venc1, "Stock inicial");
      if (i === 5) ingreso(p, Math.round(base * 0.6), venc2 || venc1, "");
      const fechas = Array.from({ length: ent(1, 3) }, () => fechaEn(p, 0.15)).sort((a, b) => a - b);
      for (const fecha of fechas) {
        const antes = stock();
        let cant = ent(1, Math.max(1, Math.round(base / 22)));
        if (cant > antes) continue;
        const detalle = [];
        for (const l of lotes) {
          if (!cant) break;
          const t = Math.min(l.cant, cant);
          if (t) { l.cant -= t; cant -= t; detalle.push({ venc: l.venc, cant: t }); }
        }
        const [pg, pn, pd] = pacientes[ent(0, pacientes.length - 1)];
        mov("despacho", p, fecha, detalle.reduce((t, x) => t + x.cant, 0), detalle,
          rnd() < 0.75 ? tecnico : admin, antes, { pacienteGrado: pg, pacienteNombre: pn, pacienteDni: pd });
      }
    });

    const finales = lotes.filter((l) => l.cant > 0);
    d.db.medicamentos[medId] = {
      nombre, unidad, via, presentacion, lotes: finales,
      stock: stock(), creado: ts(periodos[0].inicio), actualizado: ts(hoy),
    };
  }
  return d;
}
