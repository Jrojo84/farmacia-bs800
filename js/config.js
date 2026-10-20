// =====================================================================
//  CONFIGURACIÓN — pega aquí los datos de tu proyecto Firebase
//  (Firebase Console → Configuración del proyecto → Tus apps → Web)
// =====================================================================
export const firebaseConfig = {
  apiKey: "AIzaSyCGQ0JldvgPw6lexH3O1-LDj99c-LR2WUg",
  authDomain: "farmacia-bs800.firebaseapp.com",
  projectId: "farmacia-bs800",
  storageBucket: "farmacia-bs800.firebasestorage.app",
  messagingSenderId: "925170632967",
  appId: "1:925170632967:web:642e55a2ac54bec9265da2",
};

// App Check: clave del sitio de reCAPTCHA v3 (es pública; la secreta va solo en Firebase).
// Hace que Firebase solo acepte peticiones que vengan de esta página.
export const RECAPTCHA_V3 = "6LftkfctAAAAAOcU3Q3r78aUo3nTYFv63T7IW_xF";

// Usuario administrador (tú). Debe coincidir con firestore.rules.
export const ADMIN_USUARIO = "admin";

// Los usuarios se convierten internamente en correos: usuario@DOMINIO
export const DOMINIO = "farmacia.app";

// Primer período que se muestra en Control Visible (AAAA-MM)
export const MES_INICIO = "2026-01";

// Día de cierre mensual: el período "Febrero" va del 26 de enero al 25 de febrero
export const DIA_CIERRE = 25;

// Stock igual o menor a este número se marca en rojo
export const STOCK_BAJO = 5;

// Lotes que vencen dentro de estos días se marcan "por vencer"
export const DIAS_POR_VENCER = 90;

// ---------------------------------------------------------------------
// Listas fijas para registrar un medicamento nuevo.
// Para agregar una opción, añádela aquí (respeta las comillas y comas).
// ---------------------------------------------------------------------

// Presentaciones: [abreviatura, nombre largo]. Se muestran como "TAB - Tableta".
// El gramaje (500 mg, 120 mg/5 ml…) va en el nombre del medicamento.
export const PRESENTACIONES = [
  ["TAB", "Tableta"],
  ["CAP", "Cápsula"],
  ["GRA", "Gragea"],
  ["JBE", "Jarabe"],
  ["SUS", "Suspensión"],
  ["SOL", "Solución oral"],
  ["GTS", "Gotas"],
  ["AMP", "Ampolla"],
  ["FAM", "Frasco ampolla (vial)"],
  ["FCO", "Frasco"],
  ["CRM", "Crema"],
  ["UNG", "Ungüento"],
  ["GEL", "Gel"],
  ["LOC", "Loción"],
  ["COL", "Colirio"],
  ["INH", "Inhalador"],
  ["OVU", "Óvulo"],
  ["SUP", "Supositorio"],
  ["SOB", "Sobre"],
  ["PCH", "Parche"],
  ["TUB", "Tubo"],
  ["BOL", "Bolsa"],
  ["PAR", "Par"],
  ["ROL", "Rollo"],
  ["CJA", "Caja"],
  ["KIT", "Kit"],
  ["UND", "Unidad"],
];

// Vías de administración (opcional al registrar)
export const VIAS = [
  "Oral", "Sublingual", "Intramuscular (IM)", "Endovenosa (EV)", "IM / EV", "Subcutánea (SC)", "Intradérmica",
  "Tópica", "Oftálmica", "Ótica", "Nasal", "Inhalatoria", "Rectal", "Vaginal",
];

// Grados para el paciente en el despacho (puedes agregar o quitar)
export const GRADOS = ["Sldo.", "Cabo", "Sgto. 2do", "Sgto. 1ro", "Sgto. Reeng."];
